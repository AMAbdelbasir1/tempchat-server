/**
 * TempLink – WebSocket Relay Server
 *
 * Fixes:
 *  - Backpressure handling on large binary/JSON frames
 *  - Per-client send queue — prevents TCP buffer overflow
 *  - Drain event handling — waits for buffer before next send
 *  - Binary relay for file chunks (bypass JSON stringify overhead)
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";

const PORT = parseInt(process.env.PORT || "3001", 10);

// ─── Types ───────────────────────────────────────────────────────────────────

interface Client {
  ws: WebSocket;
  id: string;
  name: string;
  room: string;
  lastSeen: number;
  // send queue for backpressure
  queue: (string | Buffer)[];
  draining: boolean;
}

// ─── State ───────────────────────────────────────────────────────────────────

const rooms = new Map<string, Map<string, Client>>();

function getRoom(code: string): Map<string, Client> {
  if (!rooms.has(code)) rooms.set(code, new Map());
  return rooms.get(code)!;
}

// ─── Queued send with backpressure ───────────────────────────────────────────
// This is the KEY fix for slow receive.
// Instead of calling ws.send() directly (which overflows TCP buffer
// when chunks are large), we queue messages and drain one at a time.

function queueSend(client: Client, data: string | Buffer) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  client.queue.push(data);
  if (!client.draining) drain(client);
}

function drain(client: Client) {
  if (client.queue.length === 0) {
    client.draining = false;
    return;
  }

  // Check if WS buffer is already full (> 1MB backlog)
  // If so, wait for 'drain' event before sending more
  if (client.ws.bufferedAmount > 1024 * 1024) {
    client.draining = true;
    client.ws.once("drain", () => drain(client));
    return;
  }

  const msg = client.queue.shift()!;
  client.draining = true;

  try {
    client.ws.send(msg, (err) => {
      if (err) {
        // Clear queue on error — client likely disconnected
        client.queue = [];
        client.draining = false;
        return;
      }
      // Immediately process next message
      drain(client);
    });
  } catch {
    client.queue = [];
    client.draining = false;
  }
}

// ─── Broadcast helpers ───────────────────────────────────────────────────────

function send(client: Client, data: unknown) {
  queueSend(client, JSON.stringify(data));
}

function broadcast(room: string, data: unknown, excludeId?: string) {
  const members = getRoom(room);
  const json = JSON.stringify(data); // stringify ONCE, reuse for all peers
  members.forEach((client) => {
    if (client.id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
      queueSend(client, json);
    }
  });
}

function broadcastBinary(room: string, data: Buffer, excludeId: string) {
  const members = getRoom(room);
  members.forEach((client) => {
    if (client.id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
      queueSend(client, data);
    }
  });
}

function broadcastPeerList(room: string) {
  const members = getRoom(room);
  const peers = Array.from(members.values()).map((c) => ({
    id: c.id,
    name: c.name,
  }));
  members.forEach((client) => {
    send(client, { type: "peers", room, peers });
  });
}

// ─── Stale client cleanup ────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  rooms.forEach((members, code) => {
    members.forEach((client, id) => {
      if (now - client.lastSeen > 120_000) {
        console.log(
          `[GC] Removing stale client "${client.name}" from room "${code}"`,
        );
        members.delete(id);
        broadcast(code, {
          type: "leave",
          id: client.id,
          name: client.name,
        });
      }
    });
    if (members.size === 0) rooms.delete(code);
  });
}, 60_000);

// ─── HTTP ────────────────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  if (req.url === "/health") {
    const roomList = Array.from(rooms.entries()).map(([code, members]) => ({
      code,
      clients: members.size,
      // show queue sizes for debugging
      queues: Array.from(members.values()).map((c) => ({
        id: c.id,
        name: c.name,
        queueSize: c.queue.length,
        buffered: c.ws.bufferedAmount,
      })),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, roomList }));
    return;
  }

  res.writeHead(404);
  res.end();
});

// ─── WebSocket ───────────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server: httpServer,
  // Increase per-message limit to 50MB (default is 100MB but be explicit)
  maxPayload: 50 * 1024 * 1024,
});

wss.on("connection", (ws: WebSocket) => {
  let clientId = "";
  let clientRoom = "";
  let clientName = "";

  // Ping to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25_000);

  ws.on("message", (raw, isBinary) => {
    // ── BINARY: audio relay ───────────────────────────────────────────────
    if (isBinary) {
      if (clientId && clientRoom) {
        broadcastBinary(clientRoom, raw as Buffer, clientId);
      }
      return;
    }

    // ── JSON ─────────────────────────────────────────────────────────────
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const type = msg.type as string;

    // ── JOIN ──────────────────────────────────────────────────────────────
    if (type === "join") {
      clientId = msg.id as string;
      clientName = msg.name as string;
      clientRoom = (msg.room as string).toUpperCase().trim();

      const room = getRoom(clientRoom);

      // Close old connection if same id reconnects
      if (room.has(clientId)) {
        const old = room.get(clientId)!;
        if (old.ws !== ws) {
          try {
            old.ws.close();
          } catch {
            /* */
          }
        }
      }

      const client: Client = {
        ws,
        id: clientId,
        name: clientName,
        room: clientRoom,
        lastSeen: Date.now(),
        queue: [],
        draining: false,
      };
      room.set(clientId, client);

      broadcast(
        clientRoom,
        { type: "join", id: clientId, name: clientName, room: clientRoom },
        clientId,
      );
      broadcastPeerList(clientRoom);

      console.log(
        `[+] "${clientName}" joined room "${clientRoom}" (${room.size} total)`,
      );
      return;
    }

    // ── RELAY ─────────────────────────────────────────────────────────────
    if (type === "relay") {
      const room = clientRoom || (msg.room as string);
      const from = msg.from as string;
      const channel = msg.channel as string;

      // Update lastSeen
      const roomMap = getRoom(room);
      const client = roomMap.get(from);
      if (client) client.lastSeen = Date.now();

      broadcast(
        room,
        { type: "relay", channel, room, from, payload: msg.payload },
        from,
      );
      return;
    }

    // ── PING (keep-alive from client) ─────────────────────────────────────
    if (type === "ping") {
      const room = getRoom(clientRoom);
      const client = room.get(clientId);
      if (client) client.lastSeen = Date.now();
      return;
    }

    // ── LEGACY: chat ──────────────────────────────────────────────────────
    if (type === "chat") {
      const room = clientRoom || (msg.room as string);
      broadcast(
        room,
        {
          type: "chat",
          id: msg.id,
          from: clientId,
          fromName: clientName,
          room,
          msgType: msg.msgType,
          content: msg.content,
          timestamp: msg.timestamp,
          file: msg.file,
        },
        clientId,
      );
      return;
    }

    // ── LEGACY: file_chunk ────────────────────────────────────────────────
    if (type === "file_chunk") {
      broadcast(
        clientRoom,
        {
          type: "file_chunk",
          from: clientId,
          fromName: clientName,
          room: clientRoom,
          transferId: msg.transferId,
          chunkIndex: msg.chunkIndex,
          totalChunks: msg.totalChunks,
          fileName: msg.fileName,
          fileType: msg.fileType,
          fileSize: msg.fileSize,
          data: msg.data,
        },
        clientId,
      );
      return;
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    if (!clientId || !clientRoom) return;

    const room = getRoom(clientRoom);
    const client = room.get(clientId);

    // Clear queue on disconnect
    if (client) {
      client.queue = [];
    }

    room.delete(clientId);

    if (room.size === 0) {
      rooms.delete(clientRoom);
    } else {
      broadcast(clientRoom, {
        type: "leave",
        id: clientId,
        name: clientName,
        room: clientRoom,
      });
      broadcastPeerList(clientRoom);
    }

    console.log(
      `[-] "${clientName}" left room "${clientRoom}" (${room.size} remaining)`,
    );
  });

  ws.on("error", (err) => {
    console.error("[WS error]", err.message);
  });

  ws.on("pong", () => {
    // Client is alive — update lastSeen
    const room = getRoom(clientRoom);
    const client = room.get(clientId);
    if (client) client.lastSeen = Date.now();
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n✅ TempLink server running`);
  console.log(`   WS     → ws://localhost:${PORT}`);
  console.log(`   Health → http://localhost:${PORT}/health\n`);
});

/**
 * TempLink – WebSocket Relay Server
 * ─────────────────────────────────
 * All clients in the same room code share messages through this server.
 * Messages are E2E encrypted client-side — server only relays opaque payloads.
 *
 * Run:  cd server && npm install && npm start
 *       (or: npx tsx server/index.ts from project root)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const PORT = parseInt(process.env.PORT || '3001', 10);

// ─── Types ───────────────────────────────────────────────────────────────────

interface Client {
  ws: WebSocket;
  id: string;
  name: string;
  room: string;
  lastSeen: number;
}

// ─── State ───────────────────────────────────────────────────────────────────

/** roomCode → Map<clientId, Client> */
const rooms = new Map<string, Map<string, Client>>();

function getRoom(code: string): Map<string, Client> {
  if (!rooms.has(code)) rooms.set(code, new Map());
  return rooms.get(code)!;
}

function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room: string, data: unknown, excludeId?: string) {
  const members = getRoom(room);
  members.forEach((client) => {
    if (client.id !== excludeId) {
      send(client.ws, data);
    }
  });
}

function broadcastPeerList(room: string) {
  const members = getRoom(room);
  const peers = Array.from(members.values()).map((c) => ({ id: c.id, name: c.name }));
  members.forEach((client) => {
    send(client.ws, { type: 'peers', room, peers });
  });
}

// ─── Cleanup stale rooms ─────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  rooms.forEach((members, code) => {
    // Remove stale clients (no heartbeat for 2 minutes)
    members.forEach((client, id) => {
      if (now - client.lastSeen > 120_000) {
        console.log(`[GC] Removing stale client "${client.name}" from room "${code}"`);
        members.delete(id);
        broadcast(code, { type: 'leave', id: client.id, name: client.name });
      }
    });
    // Delete empty rooms
    if (members.size === 0) {
      rooms.delete(code);
    }
  });
}, 60_000);

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  // CORS headers for health check
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.url === '/health') {
    const roomList = Array.from(rooms.entries()).map(([code, members]) => ({
      code,
      clients: members.size,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, roomList }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws: WebSocket) => {
  let clientId   = '';
  let clientRoom = '';
  let clientName = '';

  // Ping-pong to detect dead connections
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30_000);

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const type = msg.type as string;

    // ── JOIN ──────────────────────────────────────────────────────────────
    if (type === 'join') {
      clientId   = msg.id as string;
      clientName = msg.name as string;
      clientRoom = (msg.room as string).toUpperCase().trim();

      const room = getRoom(clientRoom);

      // If this client ID already exists (reconnect), remove old entry
      if (room.has(clientId)) {
        const old = room.get(clientId)!;
        if (old.ws !== ws) {
          try { old.ws.close(); } catch { /* */ }
        }
      }

      const client: Client = {
        ws, id: clientId, name: clientName,
        room: clientRoom, lastSeen: Date.now(),
      };
      room.set(clientId, client);

      // Tell everyone else this peer joined
      broadcast(clientRoom, {
        type: 'join', id: clientId, name: clientName, room: clientRoom,
      }, clientId);

      // Send the joining client the full peer list
      broadcastPeerList(clientRoom);

      console.log(`[+] "${clientName}" joined room "${clientRoom}" (${room.size} total)`);
      return;
    }

    // ── RELAY (chat, presence, file, call) ────────────────────────────────
    // The frontend sends { type: 'relay', channel, room, from, payload }
    // We broadcast the same structure to everyone else in the room
    if (type === 'relay') {
      const room    = clientRoom || (msg.room as string);
      const from    = msg.from as string;
      const channel = msg.channel as string;

      // Update lastSeen for heartbeat tracking
      const roomMap = getRoom(room);
      const client  = roomMap.get(from);
      if (client) client.lastSeen = Date.now();

      // Relay to all other clients in the room
      broadcast(room, {
        type:    'relay',
        channel,
        room,
        from,
        payload: msg.payload,
      }, from);
      return;
    }

    // ── LEGACY: direct chat (for backwards compat) ───────────────────────
    if (type === 'chat') {
      const room = clientRoom || (msg.room as string);
      broadcast(room, {
        type:      'chat',
        id:        msg.id,
        from:      clientId,
        fromName:  clientName,
        room,
        msgType:   msg.msgType,
        content:   msg.content,
        timestamp: msg.timestamp,
        file:      msg.file,
      }, clientId);
      return;
    }

    // ── LEGACY: file chunk ───────────────────────────────────────────────
    if (type === 'file_chunk') {
      broadcast(clientRoom, {
        type:        'file_chunk',
        from:        clientId,
        fromName:    clientName,
        room:        clientRoom,
        transferId:  msg.transferId,
        chunkIndex:  msg.chunkIndex,
        totalChunks: msg.totalChunks,
        fileName:    msg.fileName,
        fileType:    msg.fileType,
        fileSize:    msg.fileSize,
        data:        msg.data,
      }, clientId);
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);

    if (!clientId || !clientRoom) return;
    const room = getRoom(clientRoom);
    room.delete(clientId);

    if (room.size === 0) {
      rooms.delete(clientRoom);
    } else {
      broadcast(clientRoom, {
        type: 'leave', id: clientId, name: clientName, room: clientRoom,
      });
      broadcastPeerList(clientRoom);
    }

    console.log(`[-] "${clientName}" left room "${clientRoom}" (${room.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error('[WS error]', err.message);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n✅ TempLink server running`);
  console.log(`   WS  → ws://localhost:${PORT}`);
  console.log(`   Health → http://localhost:${PORT}/health\n`);
});

# TempLink – WebSocket Server

A simple WebSocket relay server for TempLink. All messages are E2E encrypted
client-side — the server only relays opaque ciphertext between peers in the
same room.

## Quick Start

```bash
cd server
npm install
npm start
```

Server starts on `ws://localhost:3001`.

## Then in the frontend:

1. Click **"Custom server"** on the Create/Join screen
2. Enter `localhost:3001`
3. Create or join a room — done!

If the server is unreachable, it **automatically falls back** to free public
MQTT brokers (no setup needed).

## Deploy to Production

Deploy this folder to any Node.js host:

### Railway (free)
```bash
cd server
railway init
railway up
```

### Render (free)
- Connect your repo
- Root directory: `server`
- Build command: `npm install`
- Start command: `npm start`

### VPS / Docker
```bash
cd server
npm install
PORT=3001 npm start
```

### Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY index.ts .
EXPOSE 3001
CMD ["npx", "tsx", "index.ts"]
```

## Health Check

```bash
curl http://localhost:3001/health
# → {"ok":true,"rooms":0,"roomList":[]}
```

## Architecture

```
Device A ──┐
           ├──► WebSocket Server (relay) ──► same room peers
Device B ──┘

Messages are AES-GCM-256 encrypted BEFORE reaching the server.
Server sees only opaque ciphertext — it cannot read anything.
```

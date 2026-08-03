import { createServer } from 'node:http';
import { Server, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { monitor } from '@colyseus/monitor';
import cors from 'cors';
import express from 'express';
import {
  MAX_CONNECTIONS_PER_ADDRESS,
  PROTOCOL_VERSION,
  generateRoomCode,
  getArena,
  normalizeRoomCode,
} from '@riftfront/shared';
import { MatchRoom } from './rooms/MatchRoom.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.use(
  cors({
    origin: config.allowedOrigins.includes('*') ? true : config.allowedOrigins,
  }),
);

const startedAt = Date.now();

/** Coarse per-address connection accounting used to bound abuse from a single host. */
const connectionsByAddress = new Map<string, number>();

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    protocolVersion: PROTOCOL_VERSION,
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    protocolVersion: PROTOCOL_VERSION,
    arenaName: getArena().name,
    rules: config.matchRules,
  });
});

/** Creates a room code that no live room is already using. */
app.post('/api/rooms', (_req, res) => {
  void (async () => {
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const code = generateRoomCode();
        const existing = await matchMaker.query({ name: 'match', roomCode: code });
        if (existing.length === 0) {
          res.json({ code });
          return;
        }
      }
      res.status(503).json({ error: 'Could not allocate a room code, please retry.' });
    } catch (error) {
      console.error('[http] room code allocation failed', error);
      res.status(500).json({ error: 'Internal error allocating a room code.' });
    }
  })();
});

/** Room lookup used by the client to give a precise "room not found" message. */
app.get('/api/rooms/:code', (req, res) => {
  void (async () => {
    const code = normalizeRoomCode(req.params.code);
    if (!code) {
      res.status(400).json({ error: 'Invalid room code.' });
      return;
    }
    try {
      const rooms = await matchMaker.query({ name: 'match', roomCode: code });
      const room = rooms[0];
      if (!room) {
        res.status(404).json({ error: 'Room not found.' });
        return;
      }
      res.json({
        code,
        roomId: room.roomId,
        clients: room.clients,
        maxClients: room.maxClients,
        locked: room.locked,
      });
    } catch (error) {
      console.error('[http] room lookup failed', error);
      res.status(500).json({ error: 'Internal error looking up the room.' });
    }
  })();
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
    // Rejects oversized frames before they reach any parser.
    maxPayload: 16 * 1024,
    verifyClient: (info, next) => {
      const address = info.req.socket.remoteAddress ?? 'unknown';
      const current = connectionsByAddress.get(address) ?? 0;
      if (current >= MAX_CONNECTIONS_PER_ADDRESS) {
        console.warn(`[ws] connection limit reached for ${address}`);
        next(false, 429, 'Too many connections');
        return;
      }
      connectionsByAddress.set(address, current + 1);
      info.req.socket.once('close', () => {
        const remaining = (connectionsByAddress.get(address) ?? 1) - 1;
        if (remaining <= 0) connectionsByAddress.delete(address);
        else connectionsByAddress.set(address, remaining);
      });
      next(true);
    },
  }),
});

// `filterBy(['roomCode'])` makes `client.join('match', { roomCode })` resolve to the
// room carrying that code, and fail cleanly when no such room exists.
gameServer.define('match', MatchRoom).filterBy(['roomCode']);

if (config.enableMonitor) {
  app.use('/colyseus', monitor());
  console.log('[server] Colyseus monitor enabled at /colyseus');
}

async function main(): Promise<void> {
  await gameServer.listen(config.port, undefined, undefined, () => {
    console.log(
      `[server] Project Riftfront listening on ${config.host}:${config.port} (protocol v${PROTOCOL_VERSION})`,
    );
    console.log(`[server] arena: ${getArena().name}, rules:`, config.matchRules);
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal} received, shutting down`);
  try {
    await gameServer.gracefullyShutdown(false);
  } catch (error) {
    console.error('[server] error during shutdown', error);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection', reason);
});

main().catch((error: unknown) => {
  console.error('[server] failed to start', error);
  process.exit(1);
});

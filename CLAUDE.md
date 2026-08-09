# Battle Royale Prototype

## Commands
- `npm run dev`   - client (Vite, :5173) + server (:8080) in parallel
- `npm run sim`   - headless simulated round with fake clients; primary test tool
- `npm run check` - tsc --noEmit + vitest across all workspaces
- `npm run build` - compile shared + server, bundle the client
- `npm start`     - production: everything on one port (PORT, default 8080)

## Architecture
- Server is authoritative, 20 Hz fixed tick. Client sends input only.
- shared/ holds everything client and server must execute bit-identically:
  movement, collision, map generation, constants. Never duplicate it, import it.
- Networking: binary deltas via DataView. Schema in shared/protocol.ts.
- All tunable numbers live in shared/constants.ts.
- One origin: the WebSocket lives at `WS_PATH` on the same HTTP server that
  serves the built client, so a deployment is a single port behind a single
  hostname. Dev keeps Vite separate and proxies `WS_PATH` through to it.
- No host, port or scheme is ever written into client code. The client calls
  `resolveServerUrl(window.location)` from shared/net.ts; anything else is a bug.

## Conventions
- No new dependencies without asking.
- No assets. Three.js primitives with flat colors only.
- Run `npm run check` and `npm run sim` after every change.
- One phase = one commit. Stop and summarize after each phase.

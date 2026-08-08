# Battle Royale Prototype

## Commands
- `npm run dev`   - client (Vite, :5173) + server (:8080) in parallel
- `npm run sim`   - headless simulated round with fake clients; primary test tool
- `npm run check` - tsc --noEmit + vitest across all workspaces

## Architecture
- Server is authoritative, 20 Hz fixed tick. Client sends input only.
- shared/ holds everything client and server must execute bit-identically:
  movement, collision, map generation, constants. Never duplicate it, import it.
- Networking: binary deltas via DataView. Schema in shared/protocol.ts.
- All tunable numbers live in shared/constants.ts.

## Conventions
- No new dependencies without asking.
- No assets. Three.js primitives with flat colors only.
- Run `npm run check` and `npm run sim` after every change.
- One phase = one commit. Stop and summarize after each phase.

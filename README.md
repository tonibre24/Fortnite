# Battle Royale Prototype

A browser battle royale built on a server-authoritative 20 Hz simulation.
Three.js primitives, flat colors, no assets.

```
npm install
npm run dev      # client on :5173, server on :8080
npm run sim      # headless simulated round — the primary test tool
npm run check    # tsc --noEmit + vitest
```

## Layout

| Workspace | Contents |
| --------- | -------- |
| `shared/` | Constants, protocol, movement, collision, map generation — everything client and server must execute identically |
| `server/` | Authoritative simulation, fixed tick loop, WebSocket transport |
| `client/` | Vite + Three.js renderer, prediction, interpolation, input |
| `tools/`  | `sim.ts` headless harness and its fake clients |
| `test/`   | vitest suites over the shared logic |

See [CLAUDE.md](CLAUDE.md) for the working agreements.

## What works today

- Server-authoritative 20 Hz simulation; clients send input only.
- Client-side prediction with server reconciliation. With no packet loss the
  prediction reproduces the server's state exactly and the correction measures
  zero — `npm run sim` reports it.
- Remote players interpolated 100 ms in the past off a drift-corrected
  snapshot clock.
- Binary delta snapshots: unchanged players are omitted, unchanged fields cost
  nothing, and velocity only goes to its owner. ~2.8 KiB/s per client at 8
  players, ~6.2 at 20.
- Seeded 500x500 map generated identically on both sides and checked with a
  hash at join: 8 towns of enterable buildings with stairwells and roofs,
  terraced hills, trees and rocks.
- First-person movement: WASD, mouse look under pointer lock, sprint, jump,
  AABB collision with wall sliding and automatic step-up.

## Sim harness knobs

`npm run sim` is configured with environment variables:

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `SIM_CLIENTS` | 8 | Number of fake clients |
| `SIM_SECONDS` | 20 | Length of the round in simulated seconds |
| `SIM_TIME_SCALE` | 4 | Wall-clock acceleration factor |
| `SIM_LATENCY_MS` | 60 | Simulated round-trip latency |
| `SIM_JITTER_MS` | 20 | Extra random one-way delay |
| `SIM_LOSS_PCT` | 0 | Packet loss percentage |
| `SIM_SEED` | — | Map/behaviour seed |
| `SIM_VERBOSE` | 0 | Set to `1` to echo server logs |

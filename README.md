# Battle Royale Prototype

A browser battle royale built on a server-authoritative 20 Hz simulation.
Three.js primitives, flat colors, no assets.

```
npm install
npm run dev      # client on :5173, server on :8080, hot reload
npm run sim      # headless simulated round — the primary test tool
npm run check    # tsc --noEmit + vitest
npm run build    # compile shared + server, bundle the client
npm start        # serve the whole game from one port (PORT, default 8080)
```

## Sharing it over the internet

`npm start` serves the built client and the WebSocket from a single port on a
single origin, which is all a tunnel needs:

```
npm run build
npm start                                   # http://localhost:8080
cloudflared tunnel --url http://localhost:8080
```

Hand out the `https://….trycloudflare.com` URL it prints. The client derives its
WebSocket URL from `window.location`, so it uses `wss://` on that https origin
and `ws://` on plain http, with no hostname or port written down anywhere. Set
`PORT` to serve somewhere else.

In dev the two processes stay split — Vite owns the page on :5173 and proxies
`/ws` through to the server on :8080 — so the page always talks to its own
origin in both modes. Note that after a `npm run build`, :8080 will also serve
the last built client; :5173 is the one with hot reload.

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
- Four weapon classes with hitscan resolved under lag compensation, five loot
  rarities, chests, a five-slot inventory, medkits and shield potions.
- Full round flow: lobby, battle bus, freefall and glide, a six-phase storm,
  victory screen and automatic restart.
- Minimap, HUD and instanced rendering — 21 draw calls with a full 20-player
  lobby.
- A player whose socket drops is removed from the world on the spot, so the
  round's alive count stays honest and a last-player-standing win still fires.

## Sim harness knobs

`npm run sim` is configured with environment variables:

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `SIM_CLIENTS` | 8 | Number of fake clients |
| `SIM_SECONDS` | one full round | Length of the round in simulated seconds |
| `SIM_TIME_SCALE` | 4 | Wall-clock acceleration factor |
| `SIM_LATENCY_MS` | 60 | Simulated round-trip latency |
| `SIM_JITTER_MS` | 20 | Extra random one-way delay |
| `SIM_LOSS_PCT` | 0 | Packet loss percentage |
| `SIM_SEED` | — | Map/behaviour seed |
| `SIM_VERBOSE` | 0 | Set to `1` to echo server logs |

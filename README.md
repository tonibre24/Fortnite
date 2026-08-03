# Project Riftfront

A browser-based multiplayer third-person shooter **vertical slice**. Two to eight players
join a room from a URL, drop into a compact arena, and fight a five-minute free-for-all
deathmatch with server-authoritative movement, shooting, damage and scoring.

This is an original game. It takes design cues from the accessibility and combat pacing of
modern arena shooters, but every asset, name, map, sound and line of code here is original
or procedurally generated. No third-party game content is used — see
[`ASSET_CREDITS.md`](ASSET_CREDITS.md).

> **Scope:** this is a vertical slice, not a finished game. It deliberately implements a
> small set of systems well rather than many partially. See
> [Known limitations](#known-limitations).

---

## Current feature set

**Multiplayer**

- Server-authoritative simulation — the server owns position, health, shield, ammunition,
  fire rate, damage, eliminations, respawns, score and the match clock
- Client-side prediction at a fixed 60 Hz with server reconciliation and input replay
- Snapshot interpolation for remote players (100 ms delay buffer)
- Lag-compensated hitscan with bounded server-side rewind (250 ms cap)
- Room creation and joining by 5-character room code, shareable via URL
- Clean disconnect handling — no ghost players

**Combat**

- Two data-driven weapons: the **RF-9 Vector** assault rifle (automatic hitscan) and the
  **CB-2 Breaker** shotgun (9 pellets, strong damage falloff)
- Deterministic spread shared by client and server, so local tracers match what the server
  resolved without waiting a round trip
- 100 health + 50 shield, shield absorbs damage first
- Headshot and body hitboxes with separate damage multipliers
- Hit markers, headshot feedback, floating damage numbers, directional damage indicators,
  tracers, muzzle flashes, impact effects, dynamic crosshair spread, kill feed

**Match flow**

- `WAITING → COUNTDOWN → PLAYING → FINISHED → RESTARTING` state machine, server-owned
- 5-minute timer, optional 20-elimination score limit, 3-second respawn with brief spawn
  protection, 10-second results screen, then automatic restart without a page reload

**Presentation**

- Original low-poly arena, "Riftfront Yard", generated procedurally from a shared
  definition used by both the renderer and the physics
- Third-person over-the-shoulder camera with wall avoidance
- Fully procedural audio (Web Audio synthesis — no audio files at all)
- Landing screen, HUD, Tab scoreboard, pause/settings menu, results screen
- Development performance panel (FPS, ping, entities, effects, prediction error)

---

## Technical stack

| Layer      | Choice                                                     |
| ---------- | ---------------------------------------------------------- |
| Language   | TypeScript, `strict` mode everywhere                       |
| Client     | Vite 6 + Babylon.js 8 (`@babylonjs/core`)                  |
| Server     | Node.js 22 + Colyseus 0.16 (`@colyseus/schema` v3)         |
| Transport  | WebSockets via `@colyseus/ws-transport`, HTTP via Express  |
| Physics    | Custom deterministic AABB controller in the shared package |
| Tests      | Vitest (unit + integration), Playwright (browser smoke)    |
| Monorepo   | pnpm workspaces                                            |
| Deployment | Docker + docker-compose                                    |

Physics is hand-written rather than Rapier-based; the reasoning is recorded in
[`docs/architecture.md`](docs/architecture.md#physics-why-not-rapier).

---

## Prerequisites

- **Node.js ≥ 20.11** (developed and tested on 22.x)
- **pnpm ≥ 10** — `corepack enable` is the easiest way to get it
- A desktop browser with WebGL: Chrome, Edge, Firefox or Safari

---

## Installation

```bash
git clone <this repository>
cd project-riftfront
pnpm install
```

No `.env` file is required. Copy [`.env.example`](.env.example) to `.env` only if you want
to change ports or match rules.

---

## Local startup

```bash
pnpm dev
```

That runs the server and the client together:

- Game server → <http://localhost:2567> (health check at `/health`)
- Game client → <http://localhost:5173>

Open <http://localhost:5173>, enter a display name, and click **Create match**.

Run them separately if you prefer:

```bash
pnpm dev:server   # Colyseus server with hot reload
pnpm dev:client   # Vite dev server (proxies /api and /matchmake to the server)
```

### Playing solo

The default rules need 2 players before a match starts. To play alone:

```bash
RIFTFRONT_MIN_PLAYERS=1 pnpm dev:server
```

---

## How to test with two players

### Two browser windows on one machine

1. `pnpm dev`
2. Open <http://localhost:5173>, enter a name, click **Create match**.
3. Note the **room code** shown in the toast (also in the URL as `?room=XXXXX`).
4. Open a **second window** — use a separate window rather than a second tab, so both keep
   rendering; background tabs are throttled by the browser.
5. Enter a different name, type the room code, click **Join match**.
6. Both players now see each other. The countdown starts automatically.

Fastest route: copy the whole URL from window 1 (it already contains `?room=XXXXX`), paste
into window 2, and the code is pre-filled.

### Two devices on the same network

1. Find your machine's LAN IP (`ipconfig` on Windows, `ip addr` / `ifconfig` elsewhere).
2. Start the server bound to all interfaces (the default) and the client with:
   ```bash
   pnpm dev:client -- --host
   ```
3. On the second device, open `http://<your-lan-ip>:5173`.
4. Set `VITE_SERVER_HTTP=http://<your-lan-ip>:2567` before starting the client so its dev
   proxy points at the right host.

### Automated

```bash
pnpm test:integration   # boots the server, connects two real clients, fights, asserts
pnpm verify:browser     # drives two real Chromium windows through a full match
```

---

## Available scripts

| Command                 | What it does                                             |
| ----------------------- | -------------------------------------------------------- |
| `pnpm dev`              | Run server + client together                             |
| `pnpm dev:server`       | Run the game server with hot reload                      |
| `pnpm dev:client`       | Run the Vite dev server                                  |
| `pnpm build`            | Production build of shared, server and client            |
| `pnpm start`            | Run the built server                                     |
| `pnpm preview`          | Serve the built client                                   |
| `pnpm test`             | Unit tests (fast, no build required)                     |
| `pnpm test:integration` | Integration test: real server process + two real clients |
| `pnpm test:all`         | Unit + integration                                       |
| `pnpm verify:browser`   | Two-Chromium end-to-end smoke check                      |
| `pnpm typecheck`        | `tsc --noEmit` across every package                      |
| `pnpm lint`             | ESLint (type-aware) across the workspace                 |
| `pnpm format`           | Prettier write                                           |
| `pnpm verify`           | lint + typecheck + all tests + build + browser check     |

---

## Environment variables

Full list with descriptions in [`.env.example`](.env.example). The ones you are most
likely to touch:

| Variable                      | Default     | Purpose                                   |
| ----------------------------- | ----------- | ----------------------------------------- |
| `PORT`                        | `2567`      | Server port                               |
| `HOST`                        | `0.0.0.0`   | Bind interface                            |
| `RIFTFRONT_MIN_PLAYERS`       | `2`         | Set to `1` for solo testing               |
| `RIFTFRONT_MAX_PLAYERS`       | `8`         | Room capacity                             |
| `RIFTFRONT_MATCH_DURATION_MS` | `300000`    | Match length                              |
| `RIFTFRONT_SCORE_LIMIT`       | `20`        | Eliminations to win; `0` disables         |
| `RIFTFRONT_ALLOWED_ORIGINS`   | `*`         | CORS allowlist                            |
| `VITE_SERVER_URL`             | page origin | Server origin, **baked in at build time** |

---

## Production build

```bash
pnpm build
```

Outputs:

- `apps/server/dist/` — compiled server, run with `node apps/server/dist/index.js`
- `apps/client/dist/` — static bundle (~1.7 MB raw, ~420 kB gzipped), serve from any
  static host or CDN

Because Vite inlines `import.meta.env` at build time, the client must know the server's
public origin **before** it is built:

```bash
VITE_SERVER_URL=https://play.example.com pnpm --filter @riftfront/client build
```

If the client and server are served from the same origin behind one reverse proxy, leave
`VITE_SERVER_URL` unset — the client falls back to `window.location.origin`.

### Docker

```bash
docker compose up --build
```

- Client → <http://localhost:8080>
- Server → <http://localhost:2567>

> **Not verified in this environment.** `docker-compose.yml` is validated
> (`docker compose config` passes), but the images could not be built here because the
> development sandbox's network policy blocks Docker Hub. The Dockerfiles are written
> against the same build and start commands the test suite exercises
> (`pnpm --filter @riftfront/server build` → `node apps/server/dist/index.js`), but treat
> the first `docker compose up --build` as unproven and expect to iterate.

---

## Server deployment requirements

- **Node.js 20.11+**, a single long-lived process. Room state lives in memory.
- **WebSocket support end to end.** Any reverse proxy must forward `Upgrade` and
  `Connection` headers and allow long-lived connections. For nginx:
  ```nginx
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 3600s;
  ```
- **TLS.** Serve the client over HTTPS and the server over WSS. A `https://` page cannot
  open a `ws://` socket — the browser will block it.
- **Single instance.** There is no Redis presence/driver configured, so rooms exist only in
  one process. Horizontal scaling needs `@colyseus/redis-presence` plus a matchmaking
  driver; not in scope for the vertical slice.
- **Resources.** ~80 MB RSS idle. One room of 8 players is a few percent of one core; the
  server is single-threaded, so plan on roughly one core per few hundred concurrent
  players and measure before assuming.
- **No database, no auth, no persistence.** Nothing is stored between restarts.
- Set `RIFTFRONT_ALLOWED_ORIGINS` to your real origin and leave
  `RIFTFRONT_ENABLE_MONITOR=false` in production.

---

## Documentation

| Document                                                       | Contents                                    |
| -------------------------------------------------------------- | ------------------------------------------- |
| [`docs/game-design.md`](docs/game-design.md)                   | Pillars, combat maths, arena, match rules   |
| [`docs/architecture.md`](docs/architecture.md)                 | Module layout, stack decisions, data flow   |
| [`docs/network-protocol.md`](docs/network-protocol.md)         | Every message, state schema, netcode timing |
| [`docs/manual-test-plan.md`](docs/manual-test-plan.md)         | QA checklist                                |
| [`docs/performance.md`](docs/performance.md)                   | Budgets, techniques, measurements           |
| [`docs/security-limitations.md`](docs/security-limitations.md) | What is protected and what is not           |
| [`docs/progress.md`](docs/progress.md)                         | Build log and decisions                     |

---

## Controls

| Action            | Key             |
| ----------------- | --------------- |
| Move              | `W` `A` `S` `D` |
| Look              | Mouse           |
| Fire              | Left click      |
| Aim               | Right click     |
| Reload            | `R`             |
| Sprint            | `Shift`         |
| Jump              | `Space`         |
| Scoreboard        | `Tab` (hold)    |
| Rifle / Shotgun   | `1` / `2`       |
| Pause & settings  | `Esc`           |
| Performance panel | `F3`            |

---

## Known limitations

Stated plainly — these are real and known, not oversights:

- **Not cheat-proof.** The server validates everything that matters, but an aimbot or a
  wallhack is not detectable by this system. See
  [`docs/security-limitations.md`](docs/security-limitations.md).
- **Single server process.** No Redis, no horizontal scaling, no matchmaking across nodes.
- **No reconnection.** A dropped connection returns you to the menu; rejoin with the room
  code. This is deliberate — reconnection windows are the usual source of ghost players.
- **Both weapons from spawn.** There are no weapon pickups; players carry the rifle and
  shotgun and switch with `1`/`2`. Pickups were cut to keep the slice focused.
- **No skeletal animation.** Characters are primitives with procedural limb motion.
- **Desktop only.** No touch controls, no mobile layout. The UI is responsive across
  common desktop resolutions only.
- **Lag compensation favours the shooter.** Standard for the technique: at high ping you
  can be hit shortly after breaking line of sight.
- **No persistence.** No accounts, no stats, no databases. Restarting the server loses
  everything.
- **Audio is synthesised, not designed.** It communicates game state clearly but it is
  placeholder-quality by intent.
- **Bundle size.** Babylon.js is ~1.5 MB raw (351 kB gzipped). Fine on desktop broadband,
  noticeable on a slow connection.

---

## Next development steps

Ordered by value to the slice:

1. **Weapon pickups and a ground-loot pass** — the arena is built for it and it completes
   the "search for weapons" beat of the core loop.
2. Reconnection with a short grace window, with explicit ghost prevention.
3. Server-side hit validation telemetry (accuracy/hit-rate outliers) as an anti-cheat
   signal.
4. Redis presence + driver for multi-process scaling.
5. A second arena, to validate that the shared arena definition really is data.

## Licence

MIT — see [`LICENSE`](LICENSE).

# Progress log

A running record of what was built, in what order, and the decisions taken along the way.

---

## Phase 0 — Repository assessment

The repository was **empty** — no commits, no files, only an initialised git repo on the
target branch. Nothing existing to preserve or migrate.

Environment: Node 22.22.2, npm 10.9.7, pnpm 10.33.0, Docker available, Chromium
pre-installed at `/opt/pw-browsers`.

**First decision — Colyseus version.** The registry offers `colyseus@0.18`, but
`colyseus.js` (the browser client) is only published up to **0.16.x**. Pinned the server to
`colyseus@0.16.5` so both sides resolve one shared `@colyseus/schema@3`. Recorded in
`docs/architecture.md`.

**Second decision — physics.** The brief suggested Rapier. Chose a purpose-built
deterministic AABB character controller in the shared package instead, because
reconciliation requires the client to replay up to ~120 steps in a single frame and to
reproduce the server's result exactly — neither is guaranteed by two independent rigid-body
worlds. Full reasoning in `docs/architecture.md#physics-why-not-rapier`.

---

## Phase 1 — Foundation

- pnpm workspace: `apps/client`, `apps/server`, `packages/shared`, `packages/config`,
  `tests`.
- Strict TypeScript everywhere, with shared tsconfig bases (`base`, `node`, `browser`).
- Shared package built first: math, constants, arena, collision, movement, weapons,
  combat, match, protocol, validation.
- Colyseus server with Express health endpoints and room-code matchmaking.
- **Verified:** server boots, `/health` returns `{status:"ok"}`, `POST /api/rooms` returns a
  code.

Schema decorators were a risk under esbuild (tsx/vitest); confirmed working before building
anything on top of them.

---

## Phase 2 — Simulation core and tests

Rather than a throwaway offline sandbox, the offline verification target became the shared
simulation itself — it is the code the real game runs, so testing it directly is worth more
than a separate mode that would then be deleted.

- 150 unit tests across weapons, combat, movement, arena, match rules, validation, player
  simulation and lag compensation.
- **Caught immediately:** the step-up test failed because the player walked _off the far
  end_ of the test platform. Test fixture bug, not controller bug — fixed the fixture and
  added a staircase test that mirrors how the arena's ramps are actually built.

---

## Phase 3 & 4 — Multiplayer movement and authoritative combat

Built together, since combat needs the movement transport to exist.

- Input batching (60 Hz commands, 30 Hz flush), server queue with per-tick and
  token-bucket caps.
- Lag-compensated hitscan with bounded rewind.
- Deterministic shared spread so local tracers match the server's rays without a round
  trip.
- Damage, eliminations, respawn, kill feed, scoring.

**Integration test** boots the real compiled server as a child process and drives two real
`colyseus.js` clients through join → move → shoot → damage → eliminate → disconnect.

Problems found and fixed here:

1. **`tsx` unresolvable from the repo root** under pnpm's isolated layout. Switched the
   integration harness to launch the _built_ server — which is also the more honest test,
   since it exercises the production artefact.
2. **Bots never landed a hit.** Instrumented a debug harness rather than guessing: the
   netcode was fine (16 hits, 2 kills, respawns all correct) — the bots were walking into
   buildings and stopping. Added a `Steerer` helper with unstick behaviour. The
   instrumentation run is what proved the whole authoritative pipeline worked end to end.
3. **`room.state` briefly undefined** after join — Colyseus builds it from reflection after
   the handshake. Added an explicit `waitUntilStateReady()`.

---

## Phase 5 — Client, match flow and polish

- Babylon.js renderer: arena built from the shared definition, merged per material into 8
  static meshes.
- Third-person camera with wall avoidance.
- Prediction/reconciliation with exponential smoothing for small corrections and hard snaps
  for teleports.
- Snapshot interpolation with hold-on-loss (no extrapolation).
- Full UI: landing, HUD, scoreboard, pause/settings, results, toasts, fatal-error screen,
  performance panel.
- Procedural Web Audio for the entire sound set.

**Crosshair convergence bug, caught during implementation:** the camera sits over the
shoulder, so firing along its forward axis would land shots beside the crosshair at close
range. `CameraRig.getAimRay()` now raycasts from the camera to find what the crosshair
covers, then fires from the player's eye towards that point.

---

## Phase 6 — Verification

### Browser verification

Added `pnpm verify:browser`: builds everything, starts the server, serves the client, and
drives **two real Chromium windows** through a full match. 22 assertions covering load,
create, join, both-players-visible, match start, HUD values, movement, scoreboard, firing,
reloading, weapon switching, pause menu, disconnect cleanup and console errors.

**First screenshot showed the arena was too dark** — surfaces facing away from the key
light went nearly black, which directly undermines the "clear silhouettes" pillar. Raised
the fill light, added a self-illumination floor to every material, and thinned the fog.
Re-verified with a second screenshot.

### Three real spawn bugs

Writing `arena.test.ts` to assert "no spawn point overlaps geometry" found **three genuine
bugs** that would have shipped:

1. Spawn at `(0, 3.1, 0)` was **inside the central obelisk** — that player would have been
   trapped for the entire match. This was the cause of an intermittent integration-test
   failure, initially mistaken for flakiness.
2. Spawn at `(23, 0.1, 23)` clipped the Foundry's north facade.
3. Spawn at `(24, 0.1, -23)` clipped two bunker walls.

The test now also asserts that every spawn lands on solid ground within a short fall, that
spawns are spread apart, and that every ramp step is climbable. This is exactly the kind of
structural invariant that is tedious to check by hand and cheap to check in code.

### Lint and types

ESLint 9 flat config with type-aware rules. The first run surfaced a real flat-config
mistake: the JS override block was replacing `languageOptions` wholesale and destroying
`parserOptions`, so the tooling files failed to parse. Restructured into properly scoped
blocks.

---

## Final verification

| Command                 | Result                                     |
| ----------------------- | ------------------------------------------ |
| `pnpm lint`             | clean, 0 problems                          |
| `pnpm typecheck`        | clean across shared, server, client, tests |
| `pnpm test`             | 150 unit tests passed                      |
| `pnpm test:integration` | 4 integration tests passed                 |
| `pnpm build`            | shared + server + client built             |
| `pnpm verify:browser`   | 22/22 browser assertions passed            |
| `docker compose config` | valid                                      |
| `docker build`          | **blocked** — see below                    |

---

## Environmental blocker: Docker images unverified

`docker-compose.yml` validates (`docker compose config` passes) and the Docker daemon
starts, but **the images could not be built in this environment**: the sandbox network
policy allows npm and a few package registries and denies Docker Hub, so
`docker.io/docker/dockerfile:1` and `node:22-alpine` cannot be pulled
(`403 Forbidden` from the gateway on the registry blob fetch).

The Dockerfiles are therefore **written and reviewed but not executed**. They invoke the
same commands the test suite does exercise — `pnpm --filter @riftfront/server build`
followed by `node apps/server/dist/index.js` — so the risk is in the image plumbing
(layer copying, pnpm workspace pruning), not the application. Expect to iterate on the
first real build. This is recorded rather than glossed over: nothing here should be
reported as verified when it was not run.

---

## Decisions worth remembering

| Decision                                | Reason                                                           |
| --------------------------------------- | ---------------------------------------------------------------- |
| Custom AABB physics, not Rapier         | Determinism and cheap replay for reconciliation                  |
| Ramps = stair colliders + sloped visual | Removes slope-sliding and prediction divergence entirely         |
| Colyseus 0.16, not 0.18                 | The browser client only exists for 0.16                          |
| Shared deterministic spread PRNG        | Instant accurate tracers without waiting a round trip            |
| Aim ray from camera → crosshair → eye   | Shots converge on the crosshair, not the camera axis             |
| Procedural audio, zero asset files      | Cannot fail to load; no licensing ambiguity                      |
| DOM UI, not in-canvas GUI               | Free text/layout/accessibility; canvas keeps its frame budget    |
| No reconnection window                  | Reconnection windows are the usual source of ghost players       |
| Both weapons carried from spawn         | Pickups cut to keep the slice focused; documented as a deviation |
| Merge arena meshes per material         | ~150 draw calls → 8                                              |

---

## Deviations from the brief

1. **Physics library.** Custom controller instead of Rapier — reasoned in
   `docs/architecture.md`, as the brief required.
2. **Weapon pickups.** The core loop mentions searching for weapons; both weapons are
   carried from spawn instead. A pickup system would have added spawn tables, replication
   and interaction UI for little benefit to the gunplay this slice is about. It is the
   recommended next milestone.
3. **Offline sandbox.** Phase 2's offline mode was replaced by direct unit testing of the
   shared simulation. The brief calls the sandbox a development aid; testing the real code
   is a better one, and avoids a second code path that must be kept in sync.

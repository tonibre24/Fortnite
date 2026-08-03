# Architecture

## Goals

1. The server is the only authority on anything that affects the outcome of a fight.
2. The client feels instant anyway, through prediction that cannot drift from the server.
3. Rendering, simulation, networking, input and UI stay separable, so any one can be
   replaced without rewriting the others.
4. The protocol lives in one place and is versioned.

---

## Repository layout

```
project-riftfront/
├── apps/
│   ├── client/                  Browser game (Vite + Babylon.js)
│   │   └── src/
│   │       ├── audio/           Procedural Web Audio synthesis
│   │       ├── core/GameApp.ts  Orchestrator: lifecycle + wiring only
│   │       ├── game/            Prediction, interpolation, weapon feel
│   │       ├── input/           Keyboard/mouse + pointer lock
│   │       ├── net/             Colyseus transport, typed messages, errors
│   │       ├── render/          Scene, avatars, camera rig, pooled effects
│   │       └── ui/              DOM screens, HUD, scoreboard, perf panel
│   └── server/                  Authoritative Colyseus server
│       └── src/
│           ├── match/           Match state machine
│           ├── rooms/           MatchRoom: message handling + tick
│           ├── schema/          Replicated Colyseus schema
│           └── sim/             Player simulation, combat, lag compensation
├── packages/
│   ├── config/                  Shared tsconfig bases
│   └── shared/                  Protocol, simulation, weapons, arena, validation
├── tests/                       Integration + browser smoke harnesses
├── docs/
└── scripts/
```

### The shared package is the contract

`@riftfront/shared` is not a utility grab-bag; it is the thing that makes prediction
work. It contains **the code both sides must execute identically**:

| Module          | Why it must be shared                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `movement.ts`   | The character controller. Client prediction and server authority run the _same function_ at the _same fixed timestep_. Any divergence here is a rubber-banding bug. |
| `collision.ts`  | AABB primitives + the broadphase grid. Camera collision, movement and hitscan all agree about geometry.                                                             |
| `arena.ts`      | Generates the arena. The renderer draws from it and the server collides against it, so a wall can never be visual-only.                                             |
| `weapons.ts`    | Weapon data plus the deterministic spread PRNG. Both sides derive the same pellet directions from `(shooterId, shotSeq)`.                                           |
| `combat.ts`     | Hitscan resolution and the shield-then-health damage rule.                                                                                                          |
| `match.ts`      | The match state machine as a pure function, plus scoreboard ranking and spawn selection.                                                                            |
| `protocol.ts`   | Every message type and payload, declared once.                                                                                                                      |
| `validation.ts` | Runtime validators for everything inbound, plus the token-bucket rate limiter.                                                                                      |
| `stateView.ts`  | Read-only structural views of the replicated schema, so clients get type safety without importing server classes.                                                   |

Client and server never redeclare a payload shape or a gameplay constant.

---

## Stack decisions

### Colyseus 0.16, not 0.17/0.18

The server packages publish 0.17 and 0.18, but `colyseus.js` — the browser client — is
only published up to **0.16.x**. Pairing a 0.17 server with a 0.16 client risks schema
encoding mismatches. The server is pinned to `colyseus@0.16.5`, which resolves a single
shared `@colyseus/schema@3` for both sides.

### Physics: why not Rapier

The brief suggested Rapier. This project uses a purpose-built axis-aligned character
controller instead, for reasons specific to netcode:

- **Determinism is the requirement, not realism.** Reconciliation only works if replaying
  input `N` on the client reproduces the server's result bit-for-bit. Two independent
  Rapier worlds — different builds, different accumulated float state, different island
  ordering — do not guarantee that. A pure function over plain floats does.
- **Replay cost.** After a correction the client re-simulates every unacknowledged
  command (up to ~2 s = 120 steps). Stepping a full rigid-body world 120 times in one
  frame is not viable; stepping this controller 120 times costs microseconds.
- **The game does not need a physics engine.** No rigid bodies, no joints, no ragdolls, no
  vehicles, no destruction. It needs a capsule that walks, jumps, climbs steps and stops
  at walls.
- **Bundle and control.** No WASM payload, and the controller is ~200 lines that can be
  tuned directly for feel.

Trade-off: no arbitrary convex collision. Every collider is an AABB. Ramps are therefore
built as a **staircase of AABBs with a sloped visual on top** — the rise per step stays
under `STEP_HEIGHT`, so the controller walks up smoothly with no slope-sliding, while the
player sees a ramp. `arena.test.ts` asserts that every ramp's step rise is climbable.

If the game later needs real physics (vehicles, destruction), the escape hatch is to
introduce Rapier _server-side only_ and switch remote entities to pure interpolation.

### DOM UI, not an in-canvas GUI

The HUD, menus and scoreboard are plain DOM + CSS. Text rendering, layout, focus handling
and accessibility are free; the canvas keeps its whole frame budget for the game. World-
anchored elements (floating damage numbers) are projected to screen space each frame.

### Procedural audio

Every sound is synthesised at runtime with the Web Audio API. This makes "the game must
work when audio assets fail to load" structurally true rather than a fallback path, keeps
the repository free of third-party licensed content, and adds nothing to the bundle.

---

## Data flow

### One client frame

```
requestAnimationFrame
├─ accumulate frame time
├─ while (accumulator >= 16.67 ms)          fixed 60 Hz
│   ├─ InputManager.sample()                consume mouse deltas, read keys
│   ├─ LocalPlayer.step()                   predict with shared stepMovement()
│   ├─ NetworkClient.queueInput()           batched, flushed at 30 Hz
│   └─ maybeFire()                          local tracers/recoil/audio immediately
├─ syncFromServer()
│   ├─ LocalPlayer.reconcile()              rewind to server truth, replay pending
│   ├─ RemotePlayerBuffer.record/sample()   interpolate at (serverTime - 100 ms)
│   └─ CameraRig.update()                   follow + wall avoidance
├─ Hud.update()                             project world-anchored elements
├─ EffectsSystem.update()                   advance pooled effects
└─ scene.render()
```

### One server tick (20 Hz)

```
setSimulationInterval
├─ for each player
│   ├─ simulate(<= 5 queued commands)       shared stepMovement(), fixed 60 Hz steps
│   ├─ finishReloadIfDue()
│   ├─ handle kill-plane / respawn timers
│   ├─ history.record()                     bounded rewind buffer
│   └─ syncTo(schema)                       project authority into replicated state
├─ MatchController.update()                 pure state machine + side effects
└─ Colyseus patches state to all clients
```

Firing is handled on message arrival rather than on tick, so a shot is resolved against
the freshest state the server has and latency is not padded by up to a tick.

---

## Prediction and reconciliation

1. Client assigns each command a monotonic `seq` and simulates it immediately.
2. Commands are retained until acknowledged (cap: 128 ≈ 2 s).
3. The server replies through replicated state: `lastProcessedInputSeq`, plus authoritative
   position, velocity and grounded flag.
4. On each state patch the client drops acknowledged commands, resets to the server's
   values, and replays everything still pending.
5. The difference between the replayed result and what was already on screen becomes a
   **smoothing offset** that decays exponentially — so a small correction is invisible,
   while a genuine teleport (respawn, anti-cheat correction) snaps immediately.

Preserved across a correction: the client's simulated clock, `lastJumpAtMs` and
`lastGroundedAtMs`. Resetting those would let a correction refresh the jump cooldown.

---

## Lag-compensated hitscan

When a fire message arrives the server rewinds every _other_ player to
`now - (RTT/2 + interpolationDelay)`, clamped to 250 ms, using a bounded position history
(1 s / 128 entries per player, hard-capped both ways).

Both sides compute pellet directions from `mulberry32(hash(shooterId, shotSeq, weaponId))`,
so the client can draw exact tracers immediately while the server independently resolves
the identical rays. The client never reports a hit; it only asks to fire in a direction.

---

## Aiming

The camera sits over the shoulder, so its own forward axis does not pass through the
player's weapon. Firing along it would make shots land beside the crosshair at close
range. `CameraRig.getAimRay()` instead raycasts from the camera along the view axis to
find what the crosshair covers, then returns the direction from the **player's eye** to
that point. Shots converge on the crosshair and originate where the server simulates them.

---

## Lifecycle and cleanup

Every subsystem owns a `dispose()`. `GameApp.teardownMatchEntities()` runs between matches
(avatars, interpolation buffers, prediction state); `GameApp.dispose()` runs on teardown
and is wired into Vite's HMR hook so a hot reload cannot leave a second render loop,
WebSocket or listener set alive.

Server-side, `MatchRoom.onLeave` removes the player's schema entry and simulation
immediately and unconditionally — no reconnection window, which is the usual cause of
ghost players.

---

## Extension points (deliberately not implemented)

- `WeaponDefinition` is data; a third weapon is a registry entry plus balance work.
- `ArenaDefinition` is generated data; a second arena is a new builder function.
- `MatchPhase` / `nextMatchPhase()` is a pure function; a new mode is a new rule set.
- `PROTOCOL_VERSION` is checked at join, so the wire format can evolve with a clean failure
  instead of a desync.

# Performance

## Targets

| Metric            | Target                   | Notes                                       |
| ----------------- | ------------------------ | ------------------------------------------- |
| Client frame rate | 60 FPS                   | Typical modern laptop, 1920×1080            |
| Server tick       | 20 Hz stable             | 8 players in one room                       |
| Simulation step   | 60 Hz fixed              | Both client prediction and server authority |
| Initial load      | < 3 s on broadband       | ~420 kB gzipped total                       |
| Client memory     | Stable over a full match | No unbounded growth                         |
| Server memory     | ~80 MB idle              | Grows only with live rooms                  |

---

## Measured

From `pnpm build`:

| Asset          | Raw          | Gzipped     |
| -------------- | ------------ | ----------- |
| `babylon-*.js` | 1490 kB      | 351 kB      |
| `index-*.js`   | 213 kB       | 68 kB       |
| `index-*.css`  | 15 kB        | 4 kB        |
| `index.html`   | 0.9 kB       | 0.5 kB      |
| **Total**      | **~1.72 MB** | **~424 kB** |

Babylon is split into its own chunk so it stays cached across deploys of the game code.

Verified by the automated suites:

- 150 unit tests, ~1.2 s
- Integration test (real server process + two real clients, full fight to an elimination),
  ~25 s
- Two-Chromium browser smoke check, 22 assertions, ~30 s including builds

The browser smoke check runs under SwiftShader (software rasterisation) in CI and still
completes a full match, which is a useful lower bound — real GPUs have far more headroom.

---

## Client techniques

### Draw calls: mesh merging

The arena is ~150 primitives. Rendering each as its own mesh would mean ~150 draw calls
before a single player is drawn. `buildArenaScenery()` groups visuals by material and
merges each group with `Mesh.MergeMeshes`, giving **8 static meshes — one per material**.

Merged meshes are then:

- `freezeWorldMatrix()` — the arena never moves
- `doNotSyncBoundingInfo = true` — no per-frame bounds recomputation
- `isPickable = false` — excluded from picking traversals
- materials `freeze()`d — no per-frame uniform rebuild

Trade-off: merging removes per-object frustum culling for arena geometry. For a 64 × 64 m
arena that is the right trade — the whole map is often in view anyway, and 8 draw calls
beat culling 150 objects.

### Object pooling

Nothing is allocated during play.

| Pool                    | Size | Lifetime |
| ----------------------- | ---- | -------- |
| Tracers                 | 64   | 70 ms    |
| Muzzle flashes          | 16   | 45 ms    |
| Impacts                 | 48   | 280 ms   |
| Damage numbers (DOM)    | 20   | 900 ms   |
| Damage arrows (DOM)     | 6    | 1400 ms  |
| Kill feed entries (DOM) | 5    | 6 s      |

Pools are allocated once at startup, meshes are toggled with `setEnabled()`, and an
exhausted pool recycles its oldest live entry. A shotgun blast is 9 tracers + 9 impacts, so
even sustained 8-player fire cannot exhaust the tracer pool for long.

### Fixed-timestep decoupling

Simulation runs at exactly 60 Hz on an accumulator; rendering runs at whatever the display
provides. A 144 Hz monitor renders more frames of the same simulation rather than
simulating faster. `MAX_STEPS_PER_FRAME = 5` prevents a backgrounded tab from replaying
hundreds of steps on return — the backlog is dropped instead.

### Pixel ratio cap

`setHardwareScalingLevel` clamps the device pixel ratio to 2. On a 4K laptop panel this
avoids rendering 4× the pixels for no readability gain.

### Broadphase

`ColliderIndex` builds a uniform 8 m grid over the XZ plane once. Movement resolution and
every hitscan ray query only the overlapping cells, so a shotgun blast tests ~9 rays
against a handful of candidates rather than all 150 colliders.

### Interpolation instead of extrapolation

Remote players are rendered 100 ms in the past and interpolated. When the buffer runs dry
(packet loss) the last known pose is **held**, not extrapolated — extrapolation produces
rubber-banding that looks worse and misleads the player's aim.

### Other

- `skipPointerMovePicking = true` — no picking traversal on mouse move
- Shadow maps omitted entirely
- No post-processing
- All UI text updates go through `setText`, which no-ops when the value is unchanged
- Avatars use flat-shaded primitives with procedural limb motion — no skeletons, no
  animation blending

---

## Server techniques

- **Bounded work per tick.** At most 5 input commands are simulated per player per tick.
  A flooding client cannot make the server do unbounded work.
- **Bounded history.** Rewind buffers are capped by age (1 s) _and_ count (128). Input
  queues are capped at 20.
- **Allocation-light hot paths.** The token-bucket limiter allocates nothing; movement
  mutates state in place.
- **Grid broadphase** shared with the client.
- **Immediate cleanup.** `onLeave` deletes the schema entry and the simulation object at
  once; `onDispose` clears the map. No reconnection window means no retained state.
- **Delta encoding.** Colyseus patches only changed schema fields at 20 Hz. Idle players
  cost almost nothing on the wire.

### Bandwidth estimate

At 20 Hz with 8 players, a full patch is roughly 8 × ~60 bytes ≈ 500 B/tick ≈ **10 kB/s
downstream** per client, before delta encoding removes unchanged fields. Upstream is
~30 messages/s carrying two ~40-byte commands ≈ **2.5 kB/s**. Combat events are small and
sporadic.

---

## Performance panel

Press **F3** in game (on by default in development builds). It reports:

| Row           | Meaning                                             |
| ------------- | --------------------------------------------------- |
| FPS           | Smoothed frame rate and average frame time          |
| Ping          | Measured round-trip time                            |
| Server tick   | Configured broadcast rate                           |
| Players       | Connected players in the room                       |
| Entities      | Avatars + tracked interpolation buffers             |
| Effects       | Live pooled effects / total capacity                |
| Draw calls    | Active meshes this frame                            |
| Pending input | Unacknowledged predicted commands                   |
| Corrections   | Reconciliation corrections and last error in metres |

**Pending input** and **Corrections** are the netcode diagnostics that matter. Pending
input should sit around 2–6; a steadily growing number means input is not reaching the
server. Corrections should be rare with a small error — a rising count with errors above
~0.5 m means prediction and authority are diverging, which is a bug, not lag.

---

## Known performance limitations

- **Babylon bundle size.** 351 kB gzipped dominates first load. Tree-shaking via
  `@babylonjs/core` side-effect imports is already used; further reduction would mean a
  custom engine build.
- **No LOD or instancing for players.** With only 8 avatars of ~10 boxes each this has not
  been necessary.
- **Merged arena geometry is not culled per-object.** Acceptable at this map size; a larger
  map would want spatial partitioning of the merged meshes.
- **Single-threaded server.** One process, one core. Rooms do not scale across cores
  without multiple processes plus Redis presence.
- **No client-side asset streaming.** Everything loads up front, which is fine because
  everything is procedural.

---

## Regression watch list

If frame rate degrades, check in this order:

1. Effect pool exhaustion (perf panel: live count pinned at capacity)
2. Draw calls climbing above ~15 — something is not being merged or pooled
3. Entity count exceeding player count — avatars not disposed on leave
4. Pending input climbing — the input flush is not running
5. Corrections climbing — prediction divergence, usually a shared/server code mismatch

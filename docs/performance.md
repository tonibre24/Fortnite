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

### Instancing

Every repeated object in the scene is drawn with Babylon thin instances — one draw call
and one buffer upload for the whole set, with a per-instance colour so a field of five
hundred does not look tiled:

| Set            | Instances | Draw calls |
| -------------- | --------- | ---------- |
| Grass, pebbles | ~700      | 2          |
| Trees, shrubs  | ~400      | 2          |
| Rocks, fences  | ~250      | 2          |
| Outbuildings   | ~16       | 1          |
| VFX (all four) | 600 slots | 4          |

Players are the other half of the story. A character is nine boxes; as a transform
hierarchy that is nine draw calls each, so twenty players would cost 180 submits in the
main pass and another 180 in the shadow pass. Skinning the same nine boxes onto an
eight-bone skeleton makes it **one draw call per player**, and the geometry is shared
across every clone.

### Object pooling

Nothing is allocated during play.

| Pool                    | Size | Lifetime |
| ----------------------- | ---- | -------- |
| Tracers                 | 160  | 75 ms    |
| Muzzle flashes          | 40   | 55 ms    |
| Impact sparks           | 256  | 320 ms   |
| Surface dust            | 144  | 550 ms   |
| Damage numbers (DOM)    | 20   | 900 ms   |
| Damage arrows (DOM)     | 6    | 1400 ms  |
| Kill feed entries (DOM) | 5    | 6 s      |

Particle state lives in structure-of-arrays `Float32Array`s and the update loop reuses
scratch `Vector3`/`Quaternion`/`Matrix` fields, so a frame constructs no object at all —
not a mesh, not a material, not a vector. Dead slots are parked with a zero-scale matrix,
which the rasteriser discards as degenerate triangles; resizing the instance buffer would
cost more than drawing them. An exhausted pool recycles its oldest live entry.

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

### Shadows fitted to the player, not the map

One 1024² shadow map, with the directional light's orthographic frustum fitted to a 44 m
box centred on the local player rather than the whole arena. Fitting to the map would
spread those texels over 64 m; fitting to the player gives about 4 cm per texel. The
frustum centre is snapped to whole texels in light space, without which the shadow edges
crawl as the player walks.

Casters are registered explicitly (arena, props, players) rather than letting the
generator walk the scene, and back faces are rendered into the depth map so the bias can
stay small enough not to detach contact shadows.

### Opaque draw order

The sky dome is the most expensive fragment shader in the scene and covers the whole
screen. Babylon renders opaque meshes in insertion order, which drew it first and then
painted the world over the top of it. `Environment` installs an opaque sort that orders
front-to-back and forces the sky last, so the depth test rejects it everywhere the world
already is. On the software rasteriser in CI that is worth about 8% of the frame; on a
fill-limited integrated GPU it is the same shape of win.

### Other

- `skipPointerMovePicking = true` — no picking traversal on mouse move
- No post-processing; the damage vignette and rift tint are CSS overlays, not passes
- All UI text updates go through `setText`, which no-ops when the value is unchanged
- The perf overlay only samples renderer counters while it is visible, and walks the
  texture list once a second rather than every frame

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

| Row            | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| FPS            | Smoothed frame rate                                            |
| Frame time     | Average frame time against the 16.67 ms budget                 |
| 1% low         | 99th percentile frame time over the last four seconds          |
| Draw calls     | Real submit count for the frame, shadow pass included          |
| Triangles      | Indices submitted this frame across every pass, divided by 3   |
| Texture memory | GPU texture allocation including mip chains, and texture count |
| Ping           | Measured round-trip time                                       |
| Server tick    | Configured broadcast rate                                      |
| Players        | Connected players in the room                                  |
| Entities       | Avatars + tracked interpolation buffers                        |
| Effects        | Live pooled particles / total capacity                         |
| Pending input  | Unacknowledged predicted commands                              |
| Corrections    | Reconciliation corrections and last error in metres            |

The panel's border turns red when the 1% low exceeds one 60 Hz frame. Frame times are
recorded even while the panel is hidden, so pressing F3 straight after a stutter shows the
1% low that caused it.

## Scripted benchmark

`pnpm bench` builds the client, opens `bench.html` in headless Chromium at 1920×1080, and
drives the **real** renderer with twenty synthetic players walking the arena and firing
continuously. It reports the frame time distribution, the CPU-only frame time, and the
structural counters.

```
pnpm bench                       # 20 players, everything on
pnpm bench -- --players 8        # fewer players
pnpm bench -- --no-shadows       # quality levers, to find what to cut
pnpm bench -- --overview         # static wide camera; nothing is culled
pnpm bench -- --boundary         # look out at the rift field
pnpm bench -- --screenshot a.png
```

The harness runs the full movement simulation for every bot. The real client only
simulates the local player and interpolates the other nineteen, so the CPU figure
over-states the real cost rather than flattering it.

**Pending input** and **Corrections** are the netcode diagnostics that matter. Pending
input should sit around 2–6; a steadily growing number means input is not reaching the
server. Corrections should be rare with a small error — a rising count with errors above
~0.5 m means prediction and authority are diverging, which is a bug, not lag.

---

## Known performance limitations

- **Babylon bundle size.** 351 kB gzipped dominates first load. Tree-shaking via
  `@babylonjs/core` side-effect imports is already used; further reduction would mean a
  custom engine build.
- **No LOD.** Everything renders at full detail at every distance. With ~65k triangles in
  the frame there is nothing to gain yet; a bigger map would need it for the outer props.
- **Outer landscape props do not cast shadows.** They sit outside the player-fitted shadow
  frustum almost all of the time, so the cost would buy nothing.
- **Merged arena geometry is not culled per-object.** Acceptable at this map size; a larger
  map would want spatial partitioning of the merged meshes.
- **Single-threaded server.** One process, one core. Rooms do not scale across cores
  without multiple processes plus Redis presence.
- **No client-side asset streaming.** Everything loads up front, which is fine because
  everything is procedural.

---

## Regression watch list

If frame rate degrades, check in this order:

1. Draw calls climbing above ~70 with a full lobby — something is not instanced, merged
   or skinned. One extra draw call per player is the classic regression here.
2. Triangles climbing above ~80k — usually a prop type added without a triangle budget
3. Effect pool exhaustion (perf panel: live count pinned at capacity)
4. Entity count exceeding player count — avatars not disposed on leave
5. Pending input climbing — the input flush is not running
6. Corrections climbing — prediction divergence, usually a shared/server code mismatch

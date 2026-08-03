# Game design — Project Riftfront

## Elevator pitch

An original browser-based third-person shooter. Drop into a compact, colourful arena with
up to seven other players and fight a five-minute free-for-all. Fast to join, fast to
understand, fast to shoot.

## Design pillars

1. **Instant to enter.** A name and a click. No install, no account, no lobby browser.
   Share a URL and a friend is in the same match.
2. **Combat is the product.** Everything else — movement, arena, UI — exists to serve
   readable gunfights. If a feature does not make shooting better, it is out of scope.
3. **Honest feedback.** The player should always know what happened and why: what hit
   them, from where, for how much, and what state they are in.
4. **Clarity over fidelity.** Flat colours, strong silhouettes, generous lighting. A player
   at 40 m must be unmistakable.
5. **Fair by construction.** The server decides. The client asks.

## Explicitly out of scope

Building, destruction, vehicles, inventory, crafting, cosmetics, battle passes, accounts,
databases, matchmaking, voice chat, battle royale, more than two weapons, skeletal
animation, photorealism.

---

## Core loop

1. Open the site → enter a display name.
2. **Create match** (get a room code) or **Join match** (enter one).
3. Spawn into Riftfront Yard. Countdown runs when the room has enough players.
4. Move, aim, shoot. Take and deal damage.
5. Die → 3-second respawn at a safe spawn point with brief protection.
6. Eliminations score points, tracked live on the HUD and Tab scoreboard.
7. Match ends at 5 minutes or 20 eliminations.
8. Results screen: winner, final scoreboard, personal stats.
9. New match starts automatically after 10 seconds — no page reload.

---

## Movement

Responsive over realistic. The controller is arcade-tuned and deterministic.

| Property            | Value   | Rationale                                     |
| ------------------- | ------- | --------------------------------------------- |
| Walk speed          | 6.2 m/s | Fast enough to reposition, slow enough to aim |
| Sprint speed        | 9.4 m/s | Forward-only, disabled while aiming           |
| Aim speed           | 3.4 m/s | Aiming is a real commitment                   |
| Ground acceleration | 70 m/s² | Near-instant response, ~0.1 s to top speed    |
| Air acceleration    | 14 m/s² | Some air control, no air-strafing exploit     |
| Gravity             | 25 m/s² | ~2.5× real, keeps jumps snappy                |
| Jump velocity       | 8.4 m/s | ~1.4 m apex — clears cover, not walls         |
| Jump cooldown       | 300 ms  | Prevents bunny-hop spam                       |
| Coyote time         | 90 ms   | Forgives a late jump at a ledge               |
| Step height         | 0.45 m  | Walks stairs and ramps without input          |

Diagonal input is normalised, so strafe-running is not faster than running.

**No slope physics.** Ramps are staircases of boxes under a sloped visual. This removes an
entire class of bug (sliding, jitter on inclines, divergent prediction) at zero cost to
how it feels.

---

## Combat

### Weapons

Two weapons, both carried from spawn, switched with `1` and `2` (350 ms cooldown).

**RF-9 Vector** — assault rifle, the default engagement tool.

| Stat               | Value                                 |
| ------------------ | ------------------------------------- |
| Damage             | 19 body / 35 head (×1.85)             |
| Fire rate          | 540 RPM (111 ms)                      |
| Magazine / reserve | 30 / 180                              |
| Reload             | 2100 ms                               |
| Range              | 120 m, falloff 32→90 m down to ×0.6   |
| Spread             | 0.045 rad hip / 0.008 rad aimed       |
| Recoil             | 0.014 rad vertical, ±0.006 horizontal |

Time-to-kill against a full 150 effective health: **8 body shots ≈ 0.78 s**, or 5
headshots. Long enough to react and take cover, short enough that mistakes cost.

**CB-2 Breaker** — shotgun, the close-quarters answer.

| Stat               | Value                                       |
| ------------------ | ------------------------------------------- |
| Damage             | 12 per pellet × 9 pellets = 108 point blank |
| Fire rate          | 78 RPM (769 ms)                             |
| Magazine / reserve | 6 / 36                                      |
| Reload             | 2600 ms                                     |
| Range              | 45 m, falloff 7→24 m down to ×0.18          |
| Spread             | 0.105 rad hip / 0.062 rad aimed             |

Two shots kill inside 7 m. Past 24 m a full-pellet hit deals ~19 — deliberately
non-viable, so the shotgun defines _where_ it wins rather than dominating everywhere.

### Health and shield

100 health, 50 shield. Shield absorbs first, overflow carries into health. Effective health
is a flat 150 — no armour multipliers, no per-limb damage beyond the head. Below 35 health
a pulsing vignette warns the player.

### Hitboxes

- **Head:** sphere, radius 0.26 m, centred 1.55 m up. Tested first.
- **Body:** vertical capsule, radius 0.4 m, height 1.8 m.

The head is roughly 8% of the frontal silhouette — rewarding without being the only shot
worth taking.

### Feedback

| Event            | Feedback                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Firing           | Muzzle flash, tracer per pellet, crosshair bloom, camera kick, aim recoil, synthesised report |
| Hitting          | Hit marker, floating damage number at the impact point, confirmation tone                     |
| Headshot         | Red hit marker, larger red number, distinct higher tone                                       |
| Taking damage    | Screen-edge vignette, directional arrow towards the attacker, camera shake, impact sound      |
| Low health       | Pulsing red vignette below 35 HP                                                              |
| Eliminating      | Kill-feed entry, rising two-note chime                                                        |
| Being eliminated | "Eliminated" banner with a live respawn countdown                                             |
| Empty magazine   | Ammo counter turns red, dry-fire click                                                        |
| Reloading        | Progress bar, "Reloading" label, two-stage sound                                              |

Crosshair spread is honest: it grows with weapon cone, movement speed, being airborne, and
recent fire — it always represents actual accuracy.

---

## Arena — "Riftfront Yard"

64 × 64 m, walled, built from ~150 axis-aligned primitives, generated in code.

| Zone                   | Role                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rift Core** (centre) | 15 × 15 m platform, 3 m up, ramps north and south. Four pillars and a glowing obelisk break sightlines so height does not equal dominance. The contested prize.   |
| **Foundry** (NE)       | Two-room interior with three doorways and a walkable roof reached by external stairs. Parapets make the roof cover, not a sniper nest. Indoor/outdoor transition. |
| **Watchtower** (SW)    | Two stacked open decks linked by ramps. The highest vantage point, but fully exposed from three sides.                                                            |
| **Crate Yard** (NW)    | Scattered crates of varying heights plus a climbable container. Chaotic, vertical, shotgun territory.                                                             |
| **Bunker** (SE)        | Walled enclosure with two entrances and internal cover. Defensible but trappable.                                                                                 |
| **Mid-field**          | Four tall blockers and low cover at the map edges, cutting every long diagonal.                                                                                   |

Design rules applied:

- **No sightline exceeds ~40 m** — mid-field blockers cut the diagonals.
- **Every zone has at least two entrances** — no single-exit death traps.
- **No position covers the whole map** — the Watchtower sees far but is visible from
  everywhere; the Core has cover on top of it.
- **10 spawn points** around the perimeter and on elevated positions. Spawn selection picks
  the point furthest from the nearest living opponent.
- **Distinct landmarks and colours per zone** so players orient without a minimap.

`arena.test.ts` enforces the structural invariants: no spawn inside geometry, every spawn
lands on solid ground within a short fall, spawns are spread out, and every ramp step is
climbable. Three genuine spawn-placement bugs were caught this way during development.

### Visual direction

Stylised, colourful, clean, low-poly, slightly exaggerated. Flat-shaded primitives with a
saturated per-zone palette, a warm key light, a strong cool fill, and light distance fog.
No shadow maps — silhouette readability matters more than realism, and the frame budget is
better spent on gameplay. Every material carries a self-illumination floor so a player is
never lost against an unlit face.

Player characters are blocky and top-heavy with a shoulder yoke and an asymmetric visor, so
both presence and facing direction read instantly. Each player's hue is derived from their
session id.

---

## Match rules

| Rule             | Default                | Configurable via                       |
| ---------------- | ---------------------- | -------------------------------------- |
| Minimum players  | 2 (1 for solo testing) | `RIFTFRONT_MIN_PLAYERS`                |
| Maximum players  | 8                      | `RIFTFRONT_MAX_PLAYERS`                |
| Countdown        | 5 s                    | `RIFTFRONT_COUNTDOWN_MS`               |
| Match duration   | 5 min                  | `RIFTFRONT_MATCH_DURATION_MS`          |
| Score limit      | 20 eliminations        | `RIFTFRONT_SCORE_LIMIT` (`0` disables) |
| Respawn delay    | 3 s                    | `RIFTFRONT_RESPAWN_DELAY_MS`           |
| Spawn protection | 1.5 s                  | shared constant                        |
| Results screen   | 10 s                   | `RIFTFRONT_RESULTS_MS`                 |

```
WAITING ──(enough players)──► COUNTDOWN ──(5 s)──► PLAYING
   ▲                              │                   │
   │                     (players leave)      (time or score limit)
   │                              │                   ▼
   └──────── RESTARTING ◄──(10 s)──────────────── FINISHED
```

Spawn protection ends the instant the protected player fires — it cannot be used as a
free-damage window.

Scoreboard ranking: eliminations, then fewest deaths, then damage dealt, then name.

---

## Accessibility

- All UI text is DOM-rendered, so it scales with browser zoom and is screen-reader visible.
- `prefers-reduced-motion` disables UI animations and transitions.
- Mouse sensitivity and vertical inversion are configurable and persisted.
- Master and effects volume are independent; the game is fully playable muted, since every
  audio cue has a visual counterpart.
- No information is conveyed by colour alone — headshots differ in size, sound and marker
  shape, not just hue.
- Focus outlines are preserved on all interactive controls.

---

## Balance notes

- The rifle is the default answer at every range; the shotgun is a deliberate trade of
  flexibility for lethality inside 7 m.
- Sprint being forward-only and disabled while aiming means repositioning and fighting are
  distinct states.
- The 300 ms jump cooldown keeps duels horizontal.
- Firing cancels a reload rather than being blocked by it — the player pressed fire, so
  they get the shot they were entitled to.

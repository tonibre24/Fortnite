# Manual test plan

Complements the automated suites (`pnpm test:all`, `pnpm verify:browser`). These are the
checks that need a human eye — feel, readability and timing.

## Setup

```bash
pnpm install
pnpm dev
```

Two browser **windows** (not tabs — background tabs are throttled) at
<http://localhost:5173>.

Legend: **P** pass · **F** fail · **N/A** not applicable

---

## 1. Boot and landing screen

| #    | Check                                                                                | Result |
| ---- | ------------------------------------------------------------------------------------ | ------ |
| 1.1  | Page loads with no console errors                                                    |        |
| 1.2  | Title, name field, room code field and both buttons are visible                      |        |
| 1.3  | Controls reference is readable                                                       |        |
| 1.4  | Connection status line shows a ready state                                           |        |
| 1.5  | Display name persists after a reload                                                 |        |
| 1.6  | Name field caps at 16 characters                                                     |        |
| 1.7  | Entering `<script>alert(1)</script>` produces a sanitised name in game, and no alert |        |
| 1.8  | Room code field forces uppercase and rejects punctuation                             |        |
| 1.9  | Joining a non-existent code shows "No match is running with code …"                  |        |
| 1.10 | Joining with a 3-character code shows a length error                                 |        |
| 1.11 | With the server stopped, Create shows "Could not reach the game server"              |        |
| 1.12 | Layout is sane at 1280×720, 1920×1080 and 2560×1440                                  |        |

---

## 2. Joining a match

| #   | Check                                                                | Result |
| --- | -------------------------------------------------------------------- | ------ |
| 2.1 | Create match enters the arena within ~2 s                            |        |
| 2.2 | A room code toast appears and the URL gains `?room=XXXXX`            |        |
| 2.3 | Pasting that URL into window 2 pre-fills the code                    |        |
| 2.4 | Window 2 joins the same room                                         |        |
| 2.5 | Both players see each other's character                              |        |
| 2.6 | Player count in the top-left reads 2 on both                         |        |
| 2.7 | Waiting banner shows the needed player count before the second joins |        |
| 2.8 | Countdown appears and ticks 5→1 with an audible tick                 |        |
| 2.9 | Match starts on both clients at the same moment                      |        |

---

## 3. Movement and camera

| #    | Check                                                                          | Result |
| ---- | ------------------------------------------------------------------------------ | ------ |
| 3.1  | WASD moves relative to camera facing                                           |        |
| 3.2  | Mouse look is smooth; pointer lock engages on click                            |        |
| 3.3  | Sensitivity slider takes effect immediately                                    |        |
| 3.4  | Shift sprints only when moving forward                                         |        |
| 3.5  | Space jumps; holding Space does not repeat-jump                                |        |
| 3.6  | Cannot jump again mid-air                                                      |        |
| 3.7  | Walking up the core ramps is smooth, no stutter or stalling                    |        |
| 3.8  | Foundry external stairs are climbable                                          |        |
| 3.9  | Cannot walk through any wall, crate or pillar                                  |        |
| 3.10 | Cannot leave the arena or climb the outer walls                                |        |
| 3.11 | Backing into a wall pulls the camera in rather than clipping through           |        |
| 3.12 | Camera does not clip inside the Foundry interior                               |        |
| 3.13 | Own character is visible and faces the aim direction                           |        |
| 3.14 | Aiming (right click) slows movement, tightens the crosshair and zooms slightly |        |
| 3.15 | Movement feels responsive, with no input delay                                 |        |

---

## 4. Remote player synchronisation

| #   | Check                                                                                  | Result |
| --- | -------------------------------------------------------------------------------------- | ------ |
| 4.1 | Remote player movement is smooth, not stepped at 20 Hz                                 |        |
| 4.2 | Remote player faces the direction they are actually looking                            |        |
| 4.3 | Remote legs animate while walking and faster while sprinting                           |        |
| 4.4 | Remote players are visible on ramps and roofs at correct heights                       |        |
| 4.5 | Positions on both clients agree (stand next to each other and compare)                 |        |
| 4.6 | Throttling window 2's network (DevTools → Slow 3G) degrades gracefully, no teleporting |        |

---

## 5. Weapons and shooting

| #    | Check                                                                   | Result |
| ---- | ----------------------------------------------------------------------- | ------ |
| 5.1  | Left click fires the rifle; holding fires automatically                 |        |
| 5.2  | Rifle cadence feels constant and matches 540 RPM                        |        |
| 5.3  | Tracers originate at the weapon and travel where the crosshair pointed  |        |
| 5.4  | Shots land on the crosshair at close range (fire at a wall 2 m away)    |        |
| 5.5  | Muzzle flash appears on every shot                                      |        |
| 5.6  | Impact effects appear on walls with a sensible orientation              |        |
| 5.7  | Crosshair spreads while moving, jumping and firing; tightens when still |        |
| 5.8  | Camera and aim kick upward under sustained fire, then settle            |        |
| 5.9  | Ammo counter decrements per shot                                        |        |
| 5.10 | Empty magazine: counter turns red, dry-fire click, no shots             |        |
| 5.11 | `R` reloads with a progress bar and "Reloading" label                   |        |
| 5.12 | Reload completes in ~2.1 s and refills from reserve                     |        |
| 5.13 | Firing during a reload cancels it and fires                             |        |
| 5.14 | `2` switches to the shotgun; name and ammo update to 6                  |        |
| 5.15 | Shotgun fires 9 visible pellets in a spread                             |        |
| 5.16 | Shotgun is lethal in ~2 hits point blank                                |        |
| 5.17 | Shotgun barely damages at 25 m+                                         |        |
| 5.18 | `1` switches back to the rifle; ammo state is preserved per weapon      |        |
| 5.19 | Rapid weapon-switch spam does not break state                           |        |

---

## 6. Damage, elimination and respawn

| #    | Check                                                             | Result |
| ---- | ----------------------------------------------------------------- | ------ |
| 6.1  | Hitting an enemy shows a hit marker and a damage number           |        |
| 6.2  | Headshots show a red marker, larger number and different sound    |        |
| 6.3  | Damage numbers appear at the impact point and float upward        |        |
| 6.4  | A shotgun blast produces **one** aggregated number, not nine      |        |
| 6.5  | Victim sees a red edge vignette and a directional arrow           |        |
| 6.6  | The arrow points at the attacker and rotates as the victim turns  |        |
| 6.7  | Shield depletes before health on both clients                     |        |
| 6.8  | Below 35 HP a pulsing warning appears                             |        |
| 6.9  | Reaching 0 HP eliminates the victim on both clients               |        |
| 6.10 | Kill feed entry appears on both clients with correct names        |        |
| 6.11 | Attacker's elimination count increments                           |        |
| 6.12 | Victim's death count increments on the scoreboard                 |        |
| 6.13 | Eliminated player cannot move or shoot                            |        |
| 6.14 | "Eliminated" banner counts down from 3                            |        |
| 6.15 | Respawn restores 100 HP / 50 shield and a full magazine           |        |
| 6.16 | Respawn point is not next to the killer when another is available |        |
| 6.17 | Spawn protection prevents damage briefly                          |        |
| 6.18 | Firing during spawn protection ends it immediately                |        |
| 6.19 | Cannot be eliminated twice by one burst (no double kill credit)   |        |

---

## 7. Match flow

| #    | Check                                                                        | Result |
| ---- | ---------------------------------------------------------------------------- | ------ |
| 7.1  | Match timer counts down and matches on both clients                          |        |
| 7.2  | Timer turns red in the last 30 s                                             |        |
| 7.3  | Reaching the time limit ends the match                                       |        |
| 7.4  | Reaching the score limit ends it early (test with `RIFTFRONT_SCORE_LIMIT=2`) |        |
| 7.5  | Results screen shows the correct winner                                      |        |
| 7.6  | Final scoreboard ranks correctly                                             |        |
| 7.7  | Personal stats (placement, elims, deaths, damage, K/D) are correct           |        |
| 7.8  | Victory and defeat sounds differ                                             |        |
| 7.9  | A new match starts automatically after ~10 s with no reload                  |        |
| 7.10 | Scores reset for the new match                                               |        |
| 7.11 | "Play again" returns to the arena                                            |        |
| 7.12 | "Return to menu" leaves cleanly and the other player sees the departure      |        |

---

## 8. HUD and UI

| #    | Check                                                         | Result |
| ---- | ------------------------------------------------------------- | ------ |
| 8.1  | Health and shield bars track actual values                    |        |
| 8.2  | Weapon name, magazine and reserve are correct                 |        |
| 8.3  | Ping indicator updates and is colour-coded                    |        |
| 8.4  | Holding Tab shows the scoreboard; releasing hides it          |        |
| 8.5  | Scoreboard shows name, elims, deaths, damage, ping, placement |        |
| 8.6  | Own row is highlighted                                        |        |
| 8.7  | Eliminated players are dimmed on the scoreboard               |        |
| 8.8  | Kill feed holds at most 5 entries and expires them            |        |
| 8.9  | Esc opens the pause menu and releases pointer lock            |        |
| 8.10 | All settings sliders work and take effect immediately         |        |
| 8.11 | Settings persist across a reload                              |        |
| 8.12 | Resume re-acquires pointer lock                               |        |
| 8.13 | F3 toggles the performance panel                              |        |
| 8.14 | Perf panel FPS is ≥ 60 during a fight                         |        |
| 8.15 | Perf panel corrections stay low with a small error            |        |

---

## 9. Error handling and resilience

| #    | Check                                                                           | Result |
| ---- | ------------------------------------------------------------------------------- | ------ |
| 9.1  | Killing the server mid-match returns the player to the menu with an explanation |        |
| 9.2  | Restarting the server allows creating a new match without a page reload         |        |
| 9.3  | Closing window 2 removes that player from window 1 within ~1 s                  |        |
| 9.4  | No ghost player remains after a disconnect                                      |        |
| 9.5  | A 9th player joining a full room gets "That match is full"                      |        |
| 9.6  | Denying pointer lock shows a helpful message rather than breaking               |        |
| 9.7  | Alt-tabbing away and back does not cause a teleport or input backlog            |        |
| 9.8  | Resizing the window keeps the HUD laid out correctly                            |        |
| 9.9  | Muting master volume leaves the game fully playable                             |        |
| 9.10 | No console errors accumulate over a full 5-minute match                         |        |

---

## 10. Stability and performance

| #    | Check                                                         | Result |
| ---- | ------------------------------------------------------------- | ------ |
| 10.1 | A full 5-minute match runs without a crash                    |        |
| 10.2 | Frame rate stays at 60 with 2 players                         |        |
| 10.3 | Frame rate stays acceptable with 4+ players                   |        |
| 10.4 | Client memory (DevTools) does not climb steadily over a match |        |
| 10.5 | Firing continuously for 60 s does not degrade frame rate      |        |
| 10.6 | Playing three consecutive matches does not degrade anything   |        |
| 10.7 | Server log shows no unhandled errors                          |        |
| 10.8 | Server memory is stable after several matches                 |        |

---

## Sign-off

| Field               | Value                          |
| ------------------- | ------------------------------ |
| Tester              |                                |
| Date                |                                |
| Build / commit      |                                |
| Browser and version |                                |
| OS                  |                                |
| Result              | Pass / Pass with issues / Fail |
| Issues found        |                                |

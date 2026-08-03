# Asset credits

## Summary

**Project Riftfront ships no third-party creative assets.** There are no image files, no
audio files, no 3D models, no fonts and no textures in this repository. Every visual and
audible element is generated at runtime from code in this project.

This is a deliberate choice: it keeps licensing unambiguous, keeps the bundle small, and
makes "the game must still work when assets fail to load" structurally true rather than a
fallback path.

---

## Visual assets

| Asset                                      | Source                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arena geometry ("Riftfront Yard")          | Generated procedurally by `packages/shared/src/arena.ts`. All ~150 primitives, their layout and the five named zones are original work created for this project. |
| Character models                           | Generated procedurally by `apps/client/src/render/Avatar.ts` from Babylon.js box primitives. Original design.                                                    |
| Weapon models                              | A single box primitive parented to the character. Original.                                                                                                      |
| Materials and palette                      | Solid colours defined in `apps/client/src/render/SceneBuilder.ts`. Original palette, no sampled or downloaded textures.                                          |
| Effects (tracers, muzzle flashes, impacts) | Babylon.js primitives with emissive materials, in `apps/client/src/render/Effects.ts`. Original.                                                                 |
| Player colours                             | Derived at runtime from a hash of the session id.                                                                                                                |
| UI iconography                             | CSS shapes only (crosshair, hit marker, damage arrows). No icon fonts, no SVG assets.                                                                            |
| Fonts                                      | System font stack (`Segoe UI`, `system-ui`, `-apple-system`, `Helvetica Neue`, Arial). No fonts are bundled or fetched.                                          |

---

## Audio assets

| Asset      | Source                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------- |
| All sounds | Synthesised at runtime with the Web Audio API in `apps/client/src/audio/AudioSystem.ts`. |

The full sound set — assault-rifle shot, shotgun shot, reload start/end, dry fire, hit
confirmation, headshot confirmation, taking damage, elimination, respawn, countdown tick,
countdown start, victory and defeat — is produced from oscillators, generated white-noise
buffers and biquad filters. No samples, no recordings, no libraries.

Because there is nothing to load, audio cannot fail to load. If the Web Audio API is
unavailable or the context cannot be resumed, `AudioSystem` disables itself and every call
becomes a no-op; the game continues silently with all visual feedback intact.

---

## Software dependencies

These are libraries, not creative assets. Each is used under its own licence.

| Package                                                                                                                  | Licence    | Role                                |
| ------------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------- |
| [Babylon.js](https://github.com/BabylonJS/Babylon.js) (`@babylonjs/core`)                                                | Apache-2.0 | 3D rendering                        |
| [Colyseus](https://github.com/colyseus/colyseus) (`colyseus`, `@colyseus/*`)                                             | MIT        | Authoritative multiplayer framework |
| [colyseus.js](https://github.com/colyseus/colyseus.js)                                                                   | MIT        | Browser client for Colyseus         |
| [Express](https://github.com/expressjs/express)                                                                          | MIT        | HTTP endpoints                      |
| [cors](https://github.com/expressjs/cors)                                                                                | MIT        | CORS middleware                     |
| [Vite](https://github.com/vitejs/vite)                                                                                   | MIT        | Client build tooling                |
| [TypeScript](https://github.com/microsoft/TypeScript)                                                                    | Apache-2.0 | Language and type checking          |
| [Vitest](https://github.com/vitest-dev/vitest)                                                                           | MIT        | Test runner                         |
| [Playwright](https://github.com/microsoft/playwright)                                                                    | Apache-2.0 | Browser smoke checks                |
| [ESLint](https://github.com/eslint/eslint) / [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) | MIT        | Linting                             |
| [Prettier](https://github.com/prettier/prettier)                                                                         | MIT        | Formatting                          |
| [tsx](https://github.com/privatenumber/tsx)                                                                              | MIT        | TypeScript execution in development |
| [concurrently](https://github.com/open-cli-tools/concurrently)                                                           | MIT        | Running dev processes together      |

Run `pnpm licenses list` for the full resolved dependency tree.

---

## Originality statement

Project Riftfront is an original work. It draws general design inspiration from the
accessibility, responsiveness and combat pacing of modern arena and battle-royale shooters,
but it contains **no** copyrighted or trademarked material from any other game:

- No characters, character names or likenesses
- No map names, layouts or recognisable locations
- No weapon names, models, textures or sounds
- No UI layouts, HUD designs, logos or brand marks
- No animations, emotes or audio cues
- No code copied from another game

All names used here — "Project Riftfront", "Riftfront Yard", "Rift Core", "Foundry",
"Watchtower", "Crate Yard", "Bunker", "RF-9 Vector", "CB-2 Breaker" — were created for this
project.

---

## Adding assets later

If external assets are introduced in future work, they must be recorded here before merge
with: the asset, its author, its source URL, its licence, and any attribution the licence
requires. Prefer CC0 / public domain, then permissive licences with attribution. Do not add
assets with a non-commercial or no-derivatives restriction without an explicit decision
recorded in `docs/progress.md`.

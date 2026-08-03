# Network protocol

Transport: WebSocket via Colyseus 0.16. Two channels are in use:

1. **Replicated state** — the Colyseus schema, patched to every client at 20 Hz. One-way,
   server → client. Clients decode it via schema reflection sent during the handshake.
2. **Messages** — discrete events in both directions, declared in
   `packages/shared/src/protocol.ts`.

`PROTOCOL_VERSION` (currently **1**) is sent in the join options and rejected server-side
on mismatch, so a stale browser tab fails with a clear message instead of desyncing.

---

## Timing

| Parameter               | Value                 | Constant                      |
| ----------------------- | --------------------- | ----------------------------- |
| Simulation step         | 60 Hz                 | `SIM_HZ` / `FIXED_DT`         |
| State broadcast / tick  | 20 Hz                 | `SERVER_TICK_HZ`              |
| Input flush             | 30 Hz                 | `INPUT_SEND_HZ`               |
| Interpolation delay     | 100 ms                | `INTERPOLATION_DELAY_MS`      |
| Max commands per batch  | 12                    | `MAX_COMMANDS_PER_BATCH`      |
| Max commands per tick   | 5                     | server-side, `MatchRoom`      |
| Lag-compensation cap    | 250 ms                | `LAG_COMPENSATION_MAX_MS`     |
| Rewind history retained | 1000 ms / 128 entries | `LAG_COMPENSATION_HISTORY_MS` |

At 60 Hz simulation and a 30 Hz flush, a typical input message carries two commands.

---

## Matchmaking (HTTP)

| Method | Path               | Purpose                                          |
| ------ | ------------------ | ------------------------------------------------ |
| `GET`  | `/health`          | `{ status, uptimeSeconds, protocolVersion }`     |
| `GET`  | `/api/config`      | Public match rules and arena name                |
| `POST` | `/api/rooms`       | Allocates an unused 5-character room code        |
| `GET`  | `/api/rooms/:code` | Room lookup; `404` if absent, `400` if malformed |

Rooms are registered with `filterBy(['roomCode'])`, so:

- **Create:** `POST /api/rooms` → `client.joinOrCreate('match', { roomCode, … })`
- **Join:** `GET /api/rooms/:code` (for a precise error) → `client.join('match', { roomCode, … })`

Room codes use the alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `O`/`0` or `I`/`1`.

### Join options

```ts
interface JoinOptions {
  displayName: string; // sanitised server-side; max 16 chars
  protocolVersion: number;
}
```

Rejected in `onAuth` on version mismatch (close code `4216`).

---

## Replicated state

### `MatchRoomState`

| Field             | Type    | Notes                                                   |
| ----------------- | ------- | ------------------------------------------------------- |
| `roomCode`        | string  | Shareable code                                          |
| `arenaName`       | string  | `"Riftfront Yard"`                                      |
| `phase`           | string  | `WAITING`/`COUNTDOWN`/`PLAYING`/`FINISHED`/`RESTARTING` |
| `phaseEndsAtMs`   | float64 | Server clock; `0` when the phase is untimed             |
| `serverTimeMs`    | float64 | Authoritative clock, drives timers + interpolation      |
| `scoreLimit`      | uint16  | `0` disables                                            |
| `maxPlayers`      | uint16  |                                                         |
| `minPlayers`      | uint16  |                                                         |
| `matchDurationMs` | float64 |                                                         |
| `winnerId`        | string  | Empty until `FINISHED`                                  |
| `winnerName`      | string  |                                                         |
| `players`         | map     | `sessionId → PlayerState`                               |

### `PlayerState`

| Field                           | Type    | Notes                                                   |
| ------------------------------- | ------- | ------------------------------------------------------- |
| `id`, `displayName`             | string  | Name is sanitised and de-duplicated                     |
| `x`, `y`, `z`                   | float32 | Feet position                                           |
| `yaw`, `pitch`                  | float32 | Radians                                                 |
| `vx`, `vy`, `vz`                | float32 | Replicated so reconciliation can replay from true state |
| `grounded`                      | boolean |                                                         |
| `health`, `shield`              | float32 | 100 / 50 at spawn                                       |
| `alive`                         | boolean |                                                         |
| `weaponId`                      | string  | `rifle` \| `shotgun`                                    |
| `magazine`, `reserve`           | uint16  | Active weapon only; per-weapon ammo is server-side      |
| `reloading`                     | boolean |                                                         |
| `reloadEndsAtMs`                | float64 | Drives the reload progress bar                          |
| `kills`, `deaths`               | uint16  |                                                         |
| `damageDealt`                   | uint32  |                                                         |
| `ping`                          | uint16  | Server-measured RTT                                     |
| `moving`, `sprinting`, `aiming` | boolean | Animation flags, avoids extra messages                  |
| `respawnAtMs`                   | float64 |                                                         |
| `spawnProtectedUntilMs`         | float64 |                                                         |
| `lastProcessedInputSeq`         | uint32  | **The reconciliation anchor**                           |

Server-only state that is deliberately **never** replicated: input queues, per-weapon
ammunition, fire-rate timers, rate-limiter buckets, position history, rejection counters.

---

## Client → server messages

### `input`

```ts
{
  commands: {
    seq: number; // monotonic, non-negative integer
    moveX: number; // clamped to [-1, 1]
    moveZ: number; // clamped to [-1, 1]
    yaw: number; // normalised to [-PI, PI]
    pitch: number; // clamped to ±(PI/2 - 0.05)
    buttons: number; // bitfield: 1 jump, 2 sprint, 4 aim
  }
  [];
  clientTimeMs: number;
}
```

Validation: batch size ≤ 12, every field finite, `buttons` ≤ 255. Sequences at or below
`lastProcessedSeq` are dropped (replay protection). Commands are consumed at ≤ 5 per tick
(100/s) and are token-bucket limited to 90/s, which is the primary anti-speedhack measure.

### `fire`

```ts
{
  shotSeq: number; // per-player, strictly increasing
  direction: Vec3; // normalised server-side
  inputSeq: number;
  aiming: boolean;
  clientTimeMs: number;
}
```

The client supplies **only a direction**. The origin is the server's own eye position, the
spread is derived deterministically from `(shooterId, shotSeq)`, and the victim is whatever
the server's rewound raycast hits. A client cannot name a target or report a hit.

Rejections (silent — replicated ammo corrects the client): `notAlive`, `matchNotRunning`,
`staleSequence`, `rateLimited`, `reloading`, `emptyMagazine`.

### `reload`, `switchWeapon`, `ping`, `requestRespawn`

- `reload` — `{}`. Ignored when dead, already reloading, magazine full or reserve empty.
- `switchWeapon` — `{ weaponId }`, validated against the registry; 350 ms cooldown.
- `ping` — `{ clientTimeMs }`, echoed in `pong` for RTT and clock offset.
- `requestRespawn` — `{}`. Only _shortens the wait_ on an already-elapsed timer; never
  skips it.

All messages share a 120/s per-connection budget. Unknown message types are answered with
a `notice` rather than throwing.

---

## Server → client messages

| Message        | Recipients | Payload summary                                                                            |
| -------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `welcome`      | joiner     | `sessionId`, `roomCode`, `protocolVersion`, `serverTimeMs`, `tickRateHz`, `arenaName`      |
| `pong`         | sender     | `clientTimeMs`, `serverTimeMs`                                                             |
| `shot`         | all        | `shooterId`, `weaponId`, `shotSeq`, `origin`, `endPoints[]`, `impactNormals[]`             |
| `hitConfirmed` | shooter    | `targetId`, `damage`, `headshot`, `killed`, `point`                                        |
| `damaged`      | victim     | `attackerId`, `attackerName`, `damage`, `headshot`, `attackerPosition`, `health`, `shield` |
| `kill`         | all        | `attackerId/Name`, `victimId/Name`, `weaponId`, `headshot`                                 |
| `respawned`    | respawner  | `position`, `yaw`, `spawnProtectionUntilMs`                                                |
| `matchStarted` | all        | `serverTimeMs`, `durationMs`                                                               |
| `matchEnded`   | all        | `winnerId/Name`, ranked `scoreboard[]`, `reason`, `restartInMs`                            |
| `reconcile`    | one player | Forced correction after respawn/teleport/anti-cheat                                        |
| `notice`       | one player | `{ level, code, message }` — validation and info                                           |

`shot` carries one end point per pellet so every client renders identical tracers. The
shooter ignores its own `shot` broadcast: it already drew the identical rays locally from
the shared deterministic spread.

---

## Damage model

```
damage = round(baseDamage × falloff(distance) × (headshot ? headshotMultiplier : 1))
```

Falloff is linear between `falloffStart` and `falloffEnd`, floored at
`falloffMinMultiplier`. Damage is applied shield-first, with overflow carrying into health,
so a large hit is not absorbed by a sliver of shield.

Shotgun pellets are **aggregated per victim** before application: one blast produces one
damage event, one hit marker and one damage number, not nine.

| Weapon       | Damage    | Headshot | RPM | Mag | Reserve | Reload  | Range | Pellets |
| ------------ | --------- | -------- | --- | --- | ------- | ------- | ----- | ------- |
| RF-9 Vector  | 19        | ×1.85    | 540 | 30  | 180     | 2100 ms | 120 m | 1       |
| CB-2 Breaker | 12/pellet | ×1.5     | 78  | 6   | 36      | 2600 ms | 45 m  | 9       |

Effective health is 150 (100 + 50 shield): 8 rifle body shots, or 5 headshots.

---

## Connection lifecycle

```
POST /api/rooms ──► code
        │
        ▼
client.joinOrCreate / join  ──► onAuth (protocol check) ──► onJoin
        │                                                      │
        │◄──────────────── welcome ────────────────────────────┘
        │◄──────────────── state patches @20 Hz ───────────────
        │───────────────── input @30 Hz ──────────────────────►
        │───────────────── fire / reload / ping ──────────────►
        │◄──────────────── shot / hit / kill / … ─────────────
        │
   room.leave()  or  socket drop
        │
        ▼
   onLeave: schema entry + simulation removed immediately
```

### Close codes handled by the client

| Code   | Meaning              | Player-facing message                                    |
| ------ | -------------------- | -------------------------------------------------------- |
| `4212` | Room not found       | "That match no longer exists."                           |
| `4213` | Room full            | "That match is full (8 players maximum)."                |
| `4216` | Auth/protocol failed | "This page is running an old version. Reload to update." |
| other  | Unexpected drop      | "Connection to the server was lost."                     |

---

## Versioning

Bump `PROTOCOL_VERSION` in `packages/shared/src/constants.ts` whenever a payload changes
shape incompatibly. Clients on the old version are rejected at `onAuth` with a clear
message rather than being allowed to connect and desync.

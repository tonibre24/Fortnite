# Security limitations

**Project Riftfront is not cheat-proof, and no claim to the contrary should be made.**

This document states exactly what the vertical slice protects against, what it does not,
and what an operator should assume when running it.

---

## Threat model

The vertical slice assumes an untrusted client — the browser code is fully visible and
modifiable, and the WebSocket can be driven by any script. It does **not** assume a
motivated adversary with a modified client and time to spend. It has no accounts, no
persistence and no economy, so the value of a successful attack is limited to spoiling one
5-minute match.

---

## What is enforced server-side

Everything below is decided by the server. Nothing the client reports about these is
trusted.

| Area                               | Enforcement                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Position**                       | The server simulates movement itself from input commands. Client positions are never accepted — there is no message that carries one.                                                                                                                       |
| **Movement speed**                 | Bounded by the shared controller's own acceleration and speed caps, plus a post-step sanity check (`SPEED_VALIDATION_TOLERANCE`, `MAX_STEP_DISTANCE`) that reverts an impossible step and forces a client correction.                                       |
| **Time acceleration / speedhacks** | Commands are consumed at ≤ 5 per tick (100/s) and token-bucket limited to 90/s. Flooding input does not advance the player's simulation faster.                                                                                                             |
| **Teleporting**                    | Any single step exceeding the distance cap is reverted and a `reconcile` is sent.                                                                                                                                                                           |
| **Fire rate**                      | Enforced against the weapon's RPM with a 25 ms jitter grace. A unit test fires once per millisecond for a simulated second and asserts the accepted count stays at the weapon's cap.                                                                        |
| **Ammunition**                     | Held only on the server, per weapon. The client's counter is a replica.                                                                                                                                                                                     |
| **Reloading**                      | Server-timed; the client cannot shorten it.                                                                                                                                                                                                                 |
| **Damage**                         | Computed server-side from the weapon table, the rewound geometry and the measured distance.                                                                                                                                                                 |
| **Victim selection**               | Structurally impossible to spoof: the `fire` message carries a _direction only_. The victim is whatever the server's own raycast hits.                                                                                                                      |
| **Duplicate eliminations**         | `applyHit()` returns null for an already-eliminated victim, and `eliminate()` early-returns unless `alive` is true.                                                                                                                                         |
| **Shot replay**                    | `shotSeq` must be strictly increasing per player; replayed or reordered fire messages are dropped.                                                                                                                                                          |
| **Input replay**                   | Commands at or below `lastProcessedSeq` are dropped.                                                                                                                                                                                                        |
| **Spawn protection**               | Server-timed, and cancelled the instant the protected player fires.                                                                                                                                                                                         |
| **Match state**                    | Every transition, the clock and the score are server-owned.                                                                                                                                                                                                 |
| **Message schemas**                | Every inbound payload is re-validated at runtime (`packages/shared/src/validation.ts`). Malformed messages are rejected with a notice, never thrown.                                                                                                        |
| **Unknown messages**               | Caught by a wildcard handler and answered with a notice instead of crashing the room.                                                                                                                                                                       |
| **Display names**                  | Stripped of control characters, zero-width and bidi-override characters, and markup-significant characters; length-capped at 16; empty results fall back to a safe default; duplicates get a numeric suffix. Rendered via `textContent`, never `innerHTML`. |
| **Message flood**                  | 120 messages/s per connection, token-bucket.                                                                                                                                                                                                                |
| **Connection flood**               | 12 concurrent WebSocket connections per remote address, rejected at `verifyClient` with HTTP 429.                                                                                                                                                           |
| **Oversized frames**               | `maxPayload` of 16 KB at the transport, before any parser sees the data.                                                                                                                                                                                    |
| **Protocol drift**                 | `PROTOCOL_VERSION` is checked in `onAuth`; mismatched clients are rejected.                                                                                                                                                                                 |
| **Memory growth**                  | Rewind history is capped by both age (1 s) and count (128) per player; input queues are capped; effect and DOM pools are fixed-size.                                                                                                                        |
| **Secrets in the bundle**          | There are none. The client has no credentials; the only configuration it carries is the server's public origin.                                                                                                                                             |

---

## What is **not** protected against

These are real, known gaps. They are inherent to a browser client with no anti-cheat
runtime, not oversights.

### 1. Aimbots

**Not detectable.** A modified client can compute a perfect aim direction from the
replicated positions and send it. Since the server accepts a direction as the player's
intent, a perfectly-aimed shot is indistinguishable from a skilled one.

_Mitigation path:_ server-side statistical analysis (hit rate, time-to-target, snap
angles) as a signal, not a block.

### 2. Wallhacks / ESP

**Not preventable in this design.** Every player's position is replicated to every client,
because that is what interpolation and prediction need. A modified client can render them
through walls.

_Mitigation path:_ server-side visibility culling (potentially-visible sets, or occlusion
checks per client before patching). This is a significant change: Colyseus supports
per-client state filtering, but it costs CPU and would need care not to break
interpolation when a player re-enters view.

### 3. Trigger bots and macro assistance

The server enforces the _rate_ of fire but cannot tell an automated trigger from a human
one.

### 4. Recoil neutralisation

Recoil is applied client-side to the aim angles for feel. A modified client can simply not
apply it. The server does not verify that a submitted direction reflects accumulated
recoil — doing so would require replaying the client's recoil state, which is possible but
was out of scope.

### 5. Lag switching / latency abuse

Lag compensation is capped at 250 ms, which bounds the abuse, but a player with
artificially inflated latency still gains the standard "favour the shooter" advantage: they
can be hit shortly after breaking line of sight.

### 6. Room squatting and match griefing

There is no authentication. Anyone with a room code can join. Anyone can spam room
creation via `POST /api/rooms` — that endpoint is **not rate limited**.

_Mitigation path:_ per-IP rate limiting on the HTTP matchmaking endpoints, and optionally
a room password.

### 7. Denial of service

- `POST /api/rooms` has no rate limit and each call performs a matchmaker query.
- The per-address connection cap uses `socket.remoteAddress`, which behind a reverse proxy
  is the proxy's address — so **the cap is ineffective behind a proxy** unless the proxy
  enforces its own limits or the code is changed to trust `X-Forwarded-For`.
- Nothing bounds total rooms or total memory.

_Mitigation path:_ an edge rate limiter/WAF, a global room cap, and proxy-aware client-IP
resolution.

### 8. No transport security by default

The server speaks plain HTTP and `ws://`. TLS must be terminated by a reverse proxy in
front of it. Without that, traffic is readable and modifiable in transit.

### 9. The Colyseus monitor

`RIFTFRONT_ENABLE_MONITOR=true` exposes an **unauthenticated** dashboard at `/colyseus`
revealing rooms, clients and state. It defaults to off and must stay off in production, or
be placed behind authentication.

### 10. CORS defaults to permissive

`RIFTFRONT_ALLOWED_ORIGINS` defaults to `*` for local development convenience. Set it to
your real origin in production. Note that CORS does not protect the WebSocket endpoint —
browsers do not apply the same-origin policy to WebSockets, so origin checking there would
need to be explicit.

### 11. No audit trail

Rejections are counted per connection and optionally logged, but nothing is persisted.
There is no way to review an incident after the process restarts.

---

## Operator recommendations

If you deploy this beyond a friendly test:

1. Terminate TLS in front of the server; serve the client over HTTPS and connect over WSS.
2. Set `RIFTFRONT_ALLOWED_ORIGINS` to your real origin.
3. Keep `RIFTFRONT_ENABLE_MONITOR=false`.
4. Put an edge rate limiter in front of `/api/rooms`.
5. Make the per-address connection cap proxy-aware, or enforce connection limits at the
   proxy.
6. Assume any competitive result is unverified. This is not a ranked platform and must not
   be presented as one.

---

## Reporting

There is no security contact configured for this vertical slice, and no bug bounty. If you
are running it publicly, add your own disclosure path.

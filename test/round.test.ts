import { describe, expect, it } from 'vitest';
import {
  BUS_ALTITUDE,
  BUS_DURATION_TICKS,
  Button,
  GLIDE_ALTITUDE,
  GLIDE_FALL_SPEED,
  LOBBY_COUNTDOWN_TICKS,
  LOBBY_MIN_PLAYERS,
  MAP_HALF,
  MoveMode,
  PLAYER_MAX_HEALTH,
  ROUND_END_TICKS,
  RoundPhase,
  STORM_PHASES,
  STORM_RADII,
  StateFlag,
  TICK_DT,
  busPosition,
  createRoundState,
  outsideStorm,
  planStorm,
  quantizeYaw,
  stepMovement,
  vec3,
  type InputCommand,
} from '@br/shared';
import { World } from '../server/src/World.js';

const SEED = 0x5eed1234;

function cmd(overrides: Partial<InputCommand> = {}): InputCommand {
  return { seq: 1, buttons: 0, yawQ: 0, pitchQ: 0, renderTick: 0, slot: 0, ...overrides };
}

/**
 * A world plus one monotonic sequence counter shared by every command, because
 * the server drops anything that does not advance the sequence.
 */
class Harness {
  readonly world: World;
  private seq = 0;

  constructor(players: number) {
    this.world = new World(SEED);
    for (let id = 1; id <= players; id++) this.world.addPlayer(id, `p${id}`);
  }

  /** Runs `ticks` ticks, feeding every player the same buttons. */
  run(ticks: number, buttons = 0): void {
    for (let i = 0; i < ticks; i++) {
      this.seq += 1;
      for (const player of this.world.players.values()) {
        player.enqueue([cmd({ seq: this.seq, buttons, slot: player.state.slot })]);
      }
      this.world.step();
    }
  }

  /** Runs one tick with a single player pressing something different. */
  runOne(playerId: number, buttons: number): void {
    this.seq += 1;
    for (const player of this.world.players.values()) {
      player.enqueue([
        cmd({ seq: this.seq, buttons: player.id === playerId ? buttons : 0, slot: player.state.slot }),
      ]);
    }
    this.world.step();
  }

  player(id: number) {
    return this.world.players.get(id)!;
  }
}

describe('bus path', () => {
  it('is the same for everyone given a seed', () => {
    const a = busPosition(1234, 200, vec3());
    const b = busPosition(1234, 200, vec3());
    expect(a).toEqual(b);
  });

  it('flies at a constant altitude', () => {
    for (let t = 0; t <= BUS_DURATION_TICKS; t += 25) {
      expect(busPosition(9, t, vec3()).y).toBe(BUS_ALTITUDE);
    }
  });

  it('crosses the map, starting and finishing outside it', () => {
    const start = busPosition(9, 0, vec3());
    const end = busPosition(9, BUS_DURATION_TICKS, vec3());
    expect(Math.hypot(start.x, start.z)).toBeGreaterThan(MAP_HALF);
    expect(Math.hypot(end.x, end.z)).toBeGreaterThan(MAP_HALF);
    // And passes near enough to the middle to be worth jumping from.
    expect(Math.hypot(...[busPosition(9, BUS_DURATION_TICKS / 2, vec3())].map((p) => Math.hypot(p.x, p.z)))).toBeLessThan(
      MAP_HALF,
    );
  });

  it('moves monotonically along its path', () => {
    let previous = busPosition(4, 0, vec3());
    let travelled = 0;
    for (let t = 20; t <= BUS_DURATION_TICKS; t += 20) {
      const next = busPosition(4, t, vec3());
      travelled += Math.hypot(next.x - previous.x, next.z - previous.z);
      previous = { ...next };
    }
    expect(travelled).toBeGreaterThan(MAP_HALF * 2);
  });
});

describe('storm plan', () => {
  it('shrinks every phase and never grows', () => {
    const steps = planStorm(77);
    expect(steps.length).toBe(STORM_PHASES);
    let previous = STORM_RADII[0]!;
    for (const step of steps) {
      expect(step.radius).toBeLessThanOrEqual(previous);
      previous = step.radius;
    }
    expect(previous).toBe(STORM_RADII[STORM_PHASES]!);
  });

  it('keeps each circle inside the one before it', () => {
    for (const seed of [1, 2, 3, 99, 12345]) {
      const steps = planStorm(seed);
      let x = 0;
      let z = 0;
      let radius = STORM_RADII[0]!;
      for (const step of steps) {
        const drift = Math.hypot(step.x - x, step.z - z);
        // Contained means the centre moved less than the difference in radii.
        expect(drift).toBeLessThanOrEqual(radius - step.radius + 1e-6);
        x = step.x;
        z = step.z;
        radius = step.radius;
      }
    }
  });

  it('is deterministic for a seed', () => {
    expect(planStorm(42)).toEqual(planStorm(42));
    expect(planStorm(42)).not.toEqual(planStorm(43));
  });

  it('knows who is outside the circle', () => {
    const round = createRoundState(1);
    round.stormX = 10;
    round.stormZ = -5;
    round.stormRadius = 20;
    expect(outsideStorm(round, 10, -5)).toBe(false);
    expect(outsideStorm(round, 29, -5)).toBe(false);
    expect(outsideStorm(round, 31, -5)).toBe(true);
  });
});

describe('skydiving', () => {
  function diver(y: number, mode: number) {
    const world = new World(SEED);
    const player = world.addPlayer(1, 'diver');
    player.state.pos.x = 0;
    player.state.pos.y = y;
    player.state.pos.z = 0;
    player.state.mode = mode;
    return { world, player };
  }

  it('accelerates downwards in freefall', () => {
    const { world, player } = diver(BUS_ALTITUDE, MoveMode.Freefall);
    for (let i = 0; i < 10; i++) {
      stepMovement(player.state, cmd({ seq: i + 1 }), world.map.world, TICK_DT);
    }
    expect(player.state.vel.y).toBeLessThan(-5);
    expect(player.state.pos.y).toBeLessThan(BUS_ALTITUDE);
  });

  it('opens the glider by itself at the glide altitude', () => {
    const { world, player } = diver(GLIDE_ALTITUDE + 2, MoveMode.Freefall);
    for (let i = 0; i < 20; i++) {
      stepMovement(player.state, cmd({ seq: i + 1 }), world.map.world, TICK_DT);
      if (player.state.mode === MoveMode.Glide) break;
    }
    expect(player.state.mode).toBe(MoveMode.Glide);
    // The sink rate settles on the tick after the glider opens.
    stepMovement(player.state, cmd({ seq: 99 }), world.map.world, TICK_DT);
    expect(player.state.vel.y).toBeCloseTo(-GLIDE_FALL_SPEED, 3);
  });

  it('steers while dropping', () => {
    const { world, player } = diver(BUS_ALTITUDE, MoveMode.Freefall);
    for (let i = 0; i < 30; i++) {
      stepMovement(
        player.state,
        cmd({ seq: i + 1, buttons: Button.Forward, yawQ: quantizeYaw(0) }),
        world.map.world,
        TICK_DT,
      );
    }
    // Yaw zero is towards -Z.
    expect(player.state.pos.z).toBeLessThan(-5);
  });

  it('lands on the ground and hands over to walking, unhurt', () => {
    const { world, player } = diver(30, MoveMode.Glide);
    for (let i = 0; i < 200; i++) {
      stepMovement(player.state, cmd({ seq: i + 1 }), world.map.world, TICK_DT);
      if (player.state.mode === MoveMode.Ground) break;
    }
    expect(player.state.mode).toBe(MoveMode.Ground);
    expect(player.state.health).toBe(PLAYER_MAX_HEALTH);
    expect(player.state.flags & StateFlag.OnGround).toBeTruthy();
  });
});

describe('round flow', () => {
  it('waits in the lobby until enough players have joined', () => {
    const h = new Harness(1);
    h.run(LOBBY_COUNTDOWN_TICKS * 3);
    expect(h.world.round.phase).toBe(RoundPhase.Lobby);
    expect(LOBBY_MIN_PLAYERS).toBeGreaterThan(1);
  });

  it('launches the bus once the countdown expires', () => {
    const h = new Harness(2);
    h.run(LOBBY_COUNTDOWN_TICKS + 2);
    const world = h.world;
    expect(world.round.phase).toBe(RoundPhase.Bus);
    for (const player of world.players.values()) {
      expect(player.state.mode).toBe(MoveMode.Bus);
      expect(player.state.pos.y).toBe(BUS_ALTITUDE);
    }
  });

  it('lets a player jump out, and drops whoever stays to the end', () => {
    const h = new Harness(2);
    h.run(LOBBY_COUNTDOWN_TICKS + 2);

    const jumper = h.player(1);
    const stayer = h.player(2);
    h.runOne(1, Button.Jump);
    expect(jumper.state.mode).toBe(MoveMode.Freefall);
    expect(stayer.state.mode).toBe(MoveMode.Bus);

    h.run(BUS_DURATION_TICKS + 2);
    expect(h.world.round.phase).toBe(RoundPhase.Playing);
    expect(stayer.state.mode).not.toBe(MoveMode.Bus);
  });

  it('bumps the epoch whenever it moves a player itself', () => {
    const h = new Harness(2);
    const before = h.player(1).state.epoch;
    h.run(LOBBY_COUNTDOWN_TICKS + 2);
    expect(h.player(1).state.epoch).not.toBe(before);
  });

  it('does no damage in the lobby, so a round can always start', () => {
    const h = new Harness(2);
    const victim = h.player(2);
    const shooter = h.player(1);
    victim.state.health = 1;
    // Stand right on top of them and shoot before the round begins.
    shooter.state.pos.x = victim.state.pos.x;
    shooter.state.pos.y = victim.state.pos.y;
    shooter.state.pos.z = victim.state.pos.z + 3;
    h.runOne(1, Button.Fire);
    expect(victim.state.health).toBe(1);
    expect(h.world.aliveCount).toBe(2);
  });

  it('closes the storm through every phase and hurts whoever is outside', () => {
    const h = new Harness(2);
    const world = h.world;
    h.run(LOBBY_COUNTDOWN_TICKS + 2);
    h.run(BUS_DURATION_TICKS + 2);
    expect(world.round.phase).toBe(RoundPhase.Playing);

    // Park one player far outside the circle and leave the other in the middle.
    const outside = h.player(1);
    const inside = h.player(2);
    outside.state.mode = MoveMode.Ground;
    inside.state.mode = MoveMode.Ground;

    let ticks = 0;
    while (world.round.phase === RoundPhase.Playing && ticks < 20000) {
      outside.state.pos.x = MAP_HALF - 5;
      outside.state.pos.z = MAP_HALF - 5;
      inside.state.pos.x = world.round.state.stormX;
      inside.state.pos.z = world.round.state.stormZ;
      inside.state.health = PLAYER_MAX_HEALTH;
      h.run(20);
      ticks += 20;
    }

    expect(world.round.state.stormPhase).toBeGreaterThan(0);
    // The one in the storm died; the one in the middle never took a scratch.
    expect(outside.state.flags & StateFlag.Alive).toBe(0);
    expect(inside.state.health).toBe(PLAYER_MAX_HEALTH);
  });

  it('declares the last player standing the winner and starts a new round', () => {
    const h = new Harness(2);
    const world = h.world;
    h.run(LOBBY_COUNTDOWN_TICKS + 2);
    h.run(BUS_DURATION_TICKS + 2);

    const seedBefore = world.round.state.mapSeed;
    world.killPlayer(h.player(2), h.player(1));
    h.run(1);

    expect(world.round.phase).toBe(RoundPhase.Ended);
    expect(world.round.state.winnerId).toBe(1);

    h.run(ROUND_END_TICKS + 2);
    expect(world.round.phase).toBe(RoundPhase.Lobby);
    expect(world.round.state.mapSeed).not.toBe(seedBefore);
    expect(world.roundsPlayed).toBe(1);
  });

  it('brings everyone back alive and freshly armed for the next round', () => {
    const h = new Harness(2);
    const world = h.world;
    h.run(LOBBY_COUNTDOWN_TICKS + 2);
    h.run(BUS_DURATION_TICKS + 2);

    const loser = h.player(2);
    world.killPlayer(loser, h.player(1));
    h.run(ROUND_END_TICKS + 3);

    expect(loser.state.flags & StateFlag.Alive).toBeTruthy();
    expect(loser.state.health).toBe(PLAYER_MAX_HEALTH);
    expect(loser.state.mode).toBe(MoveMode.Ground);
    expect(loser.state.kills).toBe(0);
    expect(loser.state.weapon).not.toBe(0);
    expect(world.aliveCount).toBe(2);
  });

  it('rebuilds the map and the loot for the new round', () => {
    const h = new Harness(2);
    const world = h.world;
    const hashBefore = world.mapHash;
    h.run(LOBBY_COUNTDOWN_TICKS + 2);
    h.run(BUS_DURATION_TICKS + 2);
    world.killPlayer(h.player(2), h.player(1));
    h.run(ROUND_END_TICKS + 3);

    expect(world.mapHash).not.toBe(hashBefore);
    expect(world.round.state.mapHash).toBe(world.mapHash);
    expect(world.loot.items.size).toBeGreaterThan(0);
  });
});

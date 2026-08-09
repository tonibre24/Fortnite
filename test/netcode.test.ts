import { describe, expect, it } from 'vitest';
import {
  Button,
  INPUT_STARVE_GRACE_TICKS,
  RECONCILE_EPSILON,
  Rng,
  StateFlag,
  decodeSnapshot,
  encodeSnapshot,
  quantizePitch,
  quantizeYaw,
  type InputCommand,
  type PlayerState,
} from '@br/shared';
import { Predictor } from '../client/src/game/Predictor.js';
import { World } from '../server/src/World.js';

const SEED = 0xbeef;

function randomCommand(rng: Rng, seq: number): InputCommand {
  let buttons = 0;
  if (rng.bool(0.8)) buttons |= rng.bool(0.7) ? Button.Forward : Button.Back;
  if (rng.bool(0.5)) buttons |= rng.bool() ? Button.Left : Button.Right;
  if (rng.bool(0.4)) buttons |= Button.Sprint;
  if (rng.bool(0.12)) buttons |= Button.Jump;
  return {
    seq,
    buttons,
    yawQ: quantizeYaw(rng.range(-Math.PI, Math.PI)),
    pitchQ: quantizePitch(rng.range(-1, 1)),
    renderTick: 0,
    slot: 0,
  };
}

/** Sends the server's state through the real wire format and back. */
function roundTrip(
  world: World,
  playerId: number,
  lastProcessedSeq: number,
): PlayerState {
  const states = new Map<number, PlayerState>();
  for (const [id, p] of world.players) states.set(id, p.state);
  const buffer = encodeSnapshot(world.tick, states, null, playerId, lastProcessedSeq);
  const decoded = decodeSnapshot(buffer, () => null);
  expect(decoded).not.toBeNull();
  return decoded!.players.get(playerId)!;
}

describe('prediction and reconciliation', () => {
  /**
   * The important property of the whole netcode: a client that predicts ahead
   * and then replays its unacknowledged input onto the server's state must land
   * exactly where it already was. Anything else shows up in game as rubber
   * banding, so this asserts on exact equality rather than a tolerance.
   */
  it('corrects by exactly zero when no input is lost', () => {
    const world = new World(SEED);
    const player = world.addPlayer(1, 'test');
    const predictor = new Predictor();
    predictor.reset(player.state);

    const rng = new Rng(SEED);
    let seq = 0;
    // The client runs ahead by a few ticks, which is what latency looks like.
    const inFlight: InputCommand[] = [];

    for (let tick = 0; tick < 400; tick++) {
      seq += 1;
      const cmd = randomCommand(rng, seq);
      predictor.applyCommand(cmd, world.map.world);
      inFlight.push(cmd);

      // Commands arrive at the server three ticks later.
      if (inFlight.length > 3) player.enqueue([inFlight.shift()!]);
      world.step();

      const authoritative = roundTrip(world, 1, player.lastProcessedSeq);
      predictor.reconcile(authoritative, player.lastProcessedSeq, world.map.world);
      expect(predictor.lastError).toBe(0);
    }

    expect(predictor.maxError).toBe(0);
    expect(predictor.correctionCount).toBe(0);
  });

  it('stays exact when the server batches several commands into one tick', () => {
    const world = new World(SEED);
    const player = world.addPlayer(1, 'test');
    const predictor = new Predictor();
    predictor.reset(player.state);

    const rng = new Rng(SEED + 1);
    let seq = 0;

    for (let round = 0; round < 120; round++) {
      // Three ticks of client input arrive in a single burst, as they would
      // after a jitter spike.
      const burst: InputCommand[] = [];
      for (let i = 0; i < 3; i++) {
        seq += 1;
        const cmd = randomCommand(rng, seq);
        predictor.applyCommand(cmd, world.map.world);
        burst.push(cmd);
      }
      player.enqueue(burst);

      // The credit budget lets at most INPUT_CREDIT_MAX through per tick, so
      // give the server enough ticks to drain the burst.
      for (let i = 0; i < 3; i++) world.step();

      const authoritative = roundTrip(world, 1, player.lastProcessedSeq);
      predictor.reconcile(authoritative, player.lastProcessedSeq, world.map.world);
      expect(predictor.lastError).toBe(0);
    }

    expect(predictor.maxError).toBe(0);
  });

  /**
   * A spawn point is a pose sitting exactly on the terrain, not a state the
   * movement code ever produces. If the server hands that out and only settles
   * it onto the ground on its first simulated step, a joining client predicts
   * from an unsettled base - accelerating as if airborne - and eats a
   * correction it had no way to see coming. So the join state has to be a fixed
   * point already: idle ticks must not move it, and prediction from it must be
   * exact.
   */
  it('hands a joining client a spawn state it can predict from', () => {
    const world = new World(SEED);
    const player = world.addPlayer(1, 'test');
    const predictor = new Predictor();
    // What the client really initialises from is the first snapshot it decodes.
    predictor.reset(roundTrip(world, 1, 0));

    const spawn = { ...player.state.pos };
    // Long enough without input that the server gives up waiting and starts
    // simulating the player idle - the step that used to settle them.
    for (let i = 0; i < INPUT_STARVE_GRACE_TICKS + 2; i++) world.step();
    expect(world.starvationSteps).toBeGreaterThan(0);
    // An idle tick on a settled, stationary player has to be a no-op, or the
    // client's base silently stops matching the server's.
    expect(player.state.pos).toEqual(spawn);
    expect(player.state.flags & StateFlag.OnGround).not.toBe(0);

    const rng = new Rng(SEED + 7);
    const inFlight: InputCommand[] = [];
    // The client runs ahead while its first commands are still in the air.
    for (let seq = 1; seq <= 8; seq++) {
      const cmd = randomCommand(rng, seq);
      predictor.applyCommand(cmd, world.map.world);
      inFlight.push(cmd);
    }

    for (const cmd of inFlight) {
      player.enqueue([cmd]);
      world.step();
      const authoritative = roundTrip(world, 1, player.lastProcessedSeq);
      predictor.reconcile(authoritative, player.lastProcessedSeq, world.map.world);
      expect(predictor.lastError).toBe(0);
    }

    expect(predictor.correctionCount).toBe(0);
  });

  it('corrects the client when a command never reaches the server', () => {
    const world = new World(SEED);
    const player = world.addPlayer(1, 'test');
    const predictor = new Predictor();
    predictor.reset(player.state);

    const rng = new Rng(SEED + 2);
    const forward = (seq: number): InputCommand => ({
      seq,
      buttons: Button.Forward | Button.Sprint,
      yawQ: quantizeYaw(0),
      pitchQ: quantizePitch(0),
      renderTick: 0,
      slot: 0,
    });

    for (let tick = 1; tick <= 30; tick++) {
      const cmd = forward(tick);
      predictor.applyCommand(cmd, world.map.world);
      // Command 15 is lost in transit and never resent.
      if (tick !== 15) player.enqueue([cmd]);
      world.step();
      const authoritative = roundTrip(world, 1, player.lastProcessedSeq);
      predictor.reconcile(authoritative, player.lastProcessedSeq, world.map.world);
    }

    // The client mispredicted by one tick of sprinting and had to be pulled back.
    expect(predictor.correctionCount).toBeGreaterThan(0);
    expect(predictor.maxError).toBeGreaterThan(RECONCILE_EPSILON);
    expect(predictor.maxError).toBeLessThan(1);
    expect(rng.next()).toBeGreaterThanOrEqual(0);
  });

  it('drops acknowledged commands so replay work stays bounded', () => {
    const world = new World(SEED);
    const player = world.addPlayer(1, 'test');
    const predictor = new Predictor();
    predictor.reset(player.state);

    for (let tick = 1; tick <= 100; tick++) {
      const cmd: InputCommand = { seq: tick, buttons: Button.Forward, yawQ: 0, pitchQ: 0, renderTick: 0, slot: 0 };
      predictor.applyCommand(cmd, world.map.world);
      player.enqueue([cmd]);
      world.step();
      predictor.reconcile(
        roundTrip(world, 1, player.lastProcessedSeq),
        player.lastProcessedSeq,
        world.map.world,
      );
    }

    expect(predictor.pending.length).toBe(0);
  });
});

describe('server input handling', () => {
  it('ignores redundant resends of commands it already has', () => {
    const world = new World(SEED);
    const player = world.addPlayer(1, 'test');
    const commands: InputCommand[] = [1, 2, 3].map((seq) => ({
      seq,
      buttons: Button.Forward,
      yawQ: 0,
      pitchQ: 0,
      renderTick: 0,
      slot: 0,
    }));

    player.enqueue(commands);
    player.enqueue(commands);
    player.enqueue([...commands, { seq: 4, buttons: 0, yawQ: 0, pitchQ: 0, renderTick: 0, slot: 0 }]);

    expect(player.queue.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
  });

  it('caps how much input one player may spend per tick', () => {
    const world = new World(SEED);
    const player = world.addPlayer(1, 'test');
    const flood: InputCommand[] = [];
    for (let seq = 1; seq <= 30; seq++) {
      flood.push({ seq, buttons: Button.Forward | Button.Sprint, yawQ: 0, pitchQ: 0, renderTick: 0, slot: 0 });
    }
    player.enqueue(flood);

    world.step();
    // Credit starts at one and refills one per tick, so a single tick can never
    // consume the whole flood no matter how much the client sent.
    expect(player.lastProcessedSeq).toBeLessThanOrEqual(3);
    expect(player.queue.length).toBeGreaterThan(20);
  });

  it('holds a starved player still rather than guessing at their input', () => {
    const world = new World(SEED);
    const player = world.addPlayer(1, 'test');
    player.enqueue([{ seq: 1, buttons: Button.Forward, yawQ: 0, pitchQ: 0, renderTick: 0, slot: 0 }]);
    world.step();

    const settled = { ...player.state.pos };
    // A couple of ticks of silence must not move them at all - that is what
    // keeps the absent client's prediction valid when it catches up.
    world.step();
    world.step();
    expect(player.state.pos).toEqual(settled);
    expect(world.starvationSteps).toBe(0);
  });

  it('eventually simulates a long-silent player instead of freezing them mid-air', () => {
    const world = new World(SEED);
    const player = world.addPlayer(1, 'test');
    player.state.pos.y = 30;
    player.enqueue([{ seq: 1, buttons: 0, yawQ: 0, pitchQ: 0, renderTick: 0, slot: 0 }]);

    for (let i = 0; i < 60; i++) world.step();

    expect(world.starvationSteps).toBeGreaterThan(0);
    expect(player.state.pos.y).toBeLessThan(30);
  });
});

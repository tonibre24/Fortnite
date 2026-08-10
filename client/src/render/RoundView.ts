import * as THREE from 'three';
import { StormWall } from './StormWall.js';
import {
  BUS_SIZE_X,
  BUS_SIZE_Y,
  BUS_SIZE_Z,
  RoundPhase,
  busHeading,
  busPosition,
  vec3,
  type RoundState,
} from '@br/shared';

const BUS_COLOR = 0xe8c46e;

/**
 * The two things that belong to the round rather than to any player: the bus
 * on its way across the map, and the wall of storm closing in.
 *
 * The bus is a pure function of the seed and the phase clock, so it is drawn
 * from those rather than replicated. The storm circle is replicated, because
 * nothing about it depends on local input and guessing at it would only risk
 * showing a player as safe when the server disagrees.
 */
export class RoundView {
  private readonly bus: THREE.Mesh;
  private readonly storm: StormWall;
  private readonly busPos = vec3();

  constructor(scene: THREE.Scene) {
    this.bus = new THREE.Mesh(
      new THREE.BoxGeometry(BUS_SIZE_X, BUS_SIZE_Y, BUS_SIZE_Z),
      new THREE.MeshLambertMaterial({ color: BUS_COLOR }),
    );
    this.bus.visible = false;
    scene.add(this.bus);

    this.storm = new StormWall(scene);
  }

  update(round: RoundState, seconds: number): void {
    const flying = round.phase === RoundPhase.Bus;
    this.bus.visible = flying;
    if (flying) {
      busPosition(round.mapSeed, round.phaseTick, this.busPos);
      this.bus.position.set(this.busPos.x, this.busPos.y, this.busPos.z);
      this.bus.rotation.y = busHeading(round.mapSeed);
    }

    const showStorm = round.phase === RoundPhase.Playing && round.stormRadius > 0;
    this.storm.update(showStorm, round.stormX, round.stormZ, round.stormRadius, seconds);
  }
}

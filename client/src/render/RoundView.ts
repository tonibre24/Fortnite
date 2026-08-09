import * as THREE from 'three';
import {
  BUS_SIZE_X,
  BUS_SIZE_Y,
  BUS_SIZE_Z,
  COLOR_STORM,
  MAP_HALF,
  RoundPhase,
  STORM_WALL_HEIGHT,
  busHeading,
  busPosition,
  vec3,
  type RoundState,
} from '@br/shared';

const BUS_COLOR = 0xe8c46e;
const STORM_SEGMENTS = 96;

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
  private readonly storm: THREE.Mesh;
  private readonly busPos = vec3();

  constructor(scene: THREE.Scene) {
    this.bus = new THREE.Mesh(
      new THREE.BoxGeometry(BUS_SIZE_X, BUS_SIZE_Y, BUS_SIZE_Z),
      new THREE.MeshLambertMaterial({ color: BUS_COLOR }),
    );
    this.bus.visible = false;
    scene.add(this.bus);

    // An open-ended cylinder drawn from both sides is the wall of the circle.
    this.storm = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, STORM_WALL_HEIGHT, STORM_SEGMENTS, 1, true),
      new THREE.MeshBasicMaterial({
        color: COLOR_STORM,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.storm.visible = false;
    scene.add(this.storm);
  }

  update(round: RoundState): void {
    const flying = round.phase === RoundPhase.Bus;
    this.bus.visible = flying;
    if (flying) {
      busPosition(round.mapSeed, round.phaseTick, this.busPos);
      this.bus.position.set(this.busPos.x, this.busPos.y, this.busPos.z);
      this.bus.rotation.y = busHeading(round.mapSeed);
    }

    const showStorm = round.phase === RoundPhase.Playing && round.stormRadius > 0;
    this.storm.visible = showStorm;
    if (showStorm) {
      // The cylinder is built at unit radius, so scaling is all it takes.
      const radius = Math.min(round.stormRadius, MAP_HALF * 2);
      this.storm.scale.set(radius, 1, radius);
      this.storm.position.set(round.stormX, STORM_WALL_HEIGHT / 2, round.stormZ);
    }
  }
}

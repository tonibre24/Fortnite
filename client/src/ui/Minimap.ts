import {
  COLOR_HILL,
  COLOR_ROOF,
  COLOR_STORM,
  MAP_HALF,
  MINIMAP_PADDING,
  MINIMAP_PLAYER_SIZE,
  MINIMAP_SIZE,
  RoundPhase,
  busPosition,
  vec3,
  type GameMap,
  type RoundState,
} from '@br/shared';

const BACKGROUND = '#2d4426';
const SELF = '#ffffff';
const TARGET = 'rgba(255,255,255,0.75)';

/**
 * Top-down map with the storm on it.
 *
 * The terrain never changes within a round, so it is drawn once into an
 * offscreen canvas and blitted; only the circles and the player marker are
 * redrawn per frame.
 */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly terrain: HTMLCanvasElement;
  private terrainVersion = -1;
  private readonly busPos = vec3();

  constructor() {
    const canvas = document.getElementById('minimap');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing #minimap canvas');
    const ratio = Math.min(window.devicePixelRatio, 2);
    canvas.width = MINIMAP_SIZE * ratio;
    canvas.height = MINIMAP_SIZE * ratio;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('minimap needs a 2d context');
    ctx.scale(ratio, ratio);
    this.ctx = ctx;

    this.terrain = document.createElement('canvas');
    this.terrain.width = MINIMAP_SIZE;
    this.terrain.height = MINIMAP_SIZE;
  }

  /** World units to minimap pixels. */
  private project(v: number): number {
    const usable = MINIMAP_SIZE - MINIMAP_PADDING * 2;
    return MINIMAP_PADDING + ((v + MAP_HALF) / (MAP_HALF * 2)) * usable;
  }

  private scale(units: number): number {
    return (units / (MAP_HALF * 2)) * (MINIMAP_SIZE - MINIMAP_PADDING * 2);
  }

  private drawTerrain(map: GameMap): void {
    const ctx = this.terrain.getContext('2d');
    if (ctx === null) return;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

    ctx.fillStyle = `#${COLOR_HILL.toString(16).padStart(6, '0')}`;
    for (const hill of map.hills) {
      const size = this.scale(hill.radius * 2);
      ctx.fillRect(this.project(hill.x) - size / 2, this.project(hill.z) - size / 2, size, size);
    }

    ctx.fillStyle = `#${COLOR_ROOF.toString(16).padStart(6, '0')}`;
    for (const b of map.buildings) {
      ctx.fillRect(
        this.project(b.minX),
        this.project(b.minZ),
        Math.max(1, this.scale(b.maxX - b.minX)),
        Math.max(1, this.scale(b.maxZ - b.minZ)),
      );
    }
  }

  draw(map: GameMap | null, mapVersion: number, round: RoundState, x: number, z: number, yaw: number): void {
    if (map === null) return;
    if (this.terrainVersion !== mapVersion) {
      this.drawTerrain(map);
      this.terrainVersion = mapVersion;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    ctx.drawImage(this.terrain, 0, 0);

    if (round.phase === RoundPhase.Playing && round.stormRadius > 0) {
      // Where it is heading, then where it is now.
      ctx.strokeStyle = TARGET;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.project(round.targetX), this.project(round.targetZ), this.scale(round.targetRadius), 0, Math.PI * 2);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.strokeStyle = `#${COLOR_STORM.toString(16).padStart(6, '0')}`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.project(round.stormX), this.project(round.stormZ), this.scale(round.stormRadius), 0, Math.PI * 2);
      ctx.stroke();
    }

    if (round.phase === RoundPhase.Bus) {
      busPosition(round.mapSeed, round.phaseTick, this.busPos);
      ctx.fillStyle = '#e8c46e';
      ctx.fillRect(this.project(this.busPos.x) - 2, this.project(this.busPos.z) - 2, 4, 4);
    }

    // A triangle pointing the way the player is facing.
    const px = this.project(x);
    const pz = this.project(z);
    const size = MINIMAP_PLAYER_SIZE;
    ctx.save();
    ctx.translate(px, pz);
    // Forward is (-sin, -cos) in world space, which is up-left on this canvas.
    ctx.rotate(-yaw);
    ctx.fillStyle = SELF;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.7, size * 0.7);
    ctx.lineTo(-size * 0.7, size * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

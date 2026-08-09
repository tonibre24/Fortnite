import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture';
import type { Scene } from '@babylonjs/core/scene';

/**
 * Renderer counters for the F3 overlay and the scripted benchmark.
 *
 * These are the four numbers that actually predict whether the frame budget holds on
 * integrated graphics: draw calls (CPU submit cost), triangles (vertex cost), texture
 * memory (VRAM pressure, which on integrated parts is system memory bandwidth) and the
 * frame time itself. Everything else is diagnostics.
 *
 * The instrumentation object is created once. Texture memory is a genuinely expensive
 * walk over every texture, so it is recomputed on a slow cadence rather than per frame.
 */

const TEXTURE_MEMORY_INTERVAL_MS = 1000;

export interface RenderCounters {
  drawCalls: number;
  triangles: number;
  activeMeshes: number;
  /** Total GPU-side texture allocation in bytes, including mip chains. */
  textureBytes: number;
  textureCount: number;
}

/** Bytes per texel for the formats this game actually allocates. */
function bytesPerTexel(texture: InternalTexture): number {
  // 0 = UNSIGNED_BYTE (RGBA8), 1 = FLOAT, 2 = HALF_FLOAT.
  switch (texture.type) {
    case 1:
      return 16;
    case 2:
      return 8;
    default:
      return 4;
  }
}

export class RenderStats {
  private readonly instrumentation: SceneInstrumentation;
  private cachedTextureBytes = 0;
  private cachedTextureCount = 0;
  private textureSampledAtMs = -Infinity;

  private readonly counters: RenderCounters = {
    drawCalls: 0,
    triangles: 0,
    activeMeshes: 0,
    textureBytes: 0,
    textureCount: 0,
  };

  constructor(private readonly scene: Scene) {
    this.instrumentation = new SceneInstrumentation(scene);
    this.instrumentation.captureFrameTime = false;
    this.instrumentation.captureRenderTime = false;
  }

  /** Samples the current frame. Returns a reused object — never retain it. */
  sample(nowMs: number): RenderCounters {
    const counters = this.counters;
    counters.drawCalls = this.instrumentation.drawCallsCounter.current;
    // `getActiveIndices` counts the indices submitted this frame across every pass,
    // shadow map included, which is exactly the number the budget cares about.
    counters.triangles = Math.round(this.scene.getActiveIndices() / 3);
    counters.activeMeshes = this.scene.getActiveMeshes().length;

    if (nowMs - this.textureSampledAtMs >= TEXTURE_MEMORY_INTERVAL_MS) {
      this.textureSampledAtMs = nowMs;
      this.measureTextureMemory();
    }
    counters.textureBytes = this.cachedTextureBytes;
    counters.textureCount = this.cachedTextureCount;

    return counters;
  }

  private measureTextureMemory(): void {
    const internals = this.scene.getEngine()._internalTexturesCache;
    let bytes = 0;
    for (const texture of internals) {
      const layers = Math.max(1, texture.depth || 1) * (texture.isCube ? 6 : 1);
      const base = texture.width * texture.height * layers * bytesPerTexel(texture);
      // A full mip chain adds a third again on top of the base level.
      bytes += texture.generateMipMaps ? base * (4 / 3) : base;
    }
    this.cachedTextureBytes = Math.round(bytes);
    this.cachedTextureCount = internals.length;
  }

  dispose(): void {
    this.instrumentation.dispose();
  }
}

/** Formats a byte count for the overlay: "12.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

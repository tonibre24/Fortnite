/**
 * Quality tiers.
 *
 * Purely a client rendering concern - the server has no interest in how
 * something is drawn - so unlike the numeric tunables in shared/constants.ts
 * this table lives entirely on the client and is never imported by shared/ or
 * server/.
 *
 * Each tier is a complete, self-contained set of knobs rather than a
 * multiplier against a baseline: it is easier to reason about "what does Low
 * actually do" from one row than from a shared number times a per-tier
 * fraction scattered across the file.
 */

export const QualityTier = {
  Low: 0,
  Medium: 1,
  High: 2,
  Ultra: 3,
} as const;

export type QualityTierId = (typeof QualityTier)[keyof typeof QualityTier];

export const QUALITY_TIER_NAMES = ['Low', 'Medium', 'High', 'Ultra'] as const;

export interface QualitySettings {
  /** Shadows entirely off is the single biggest saving available. */
  shadows: boolean;
  /** Cascaded shadow map count when shadows are on. */
  cascades: number;
  shadowMapSize: number;
  /** Soft VSM shadows cost a blur pass; PCF is the cheap fallback. */
  softShadows: boolean;
  ssao: boolean;
  bloom: boolean;
  /** Vignette and grain are cheap enough to always leave on when post-processing runs at all. */
  postProcessing: boolean;
  fxaa: boolean;
  /** Fraction of canvas resolution actually rendered, then upscaled. */
  renderScale: number;
  /** Fraction of the seeded scenery instances actually placed. */
  vegetationDensity: number;
  /** Multiplies fog far / prop culling distance. */
  drawDistanceScale: number;
  /** Canvas-texture resolution for procedural materials. */
  textureSize: number;
  /**
   * Anisotropic filtering samples. The ground is almost always seen at a
   * grazing angle in a first-person game, which is precisely the case
   * isotropic mipmapping handles worst - it picks a mip for the shortest
   * texture axis and blurs the long one to mush. This is the cheapest
   * quality setting available: it costs texture-sampling bandwidth only,
   * no extra geometry, draw calls or passes. Clamped at runtime against
   * `renderer.capabilities.getMaxAnisotropy()`.
   */
  anisotropy: number;
}

const TIERS: Record<QualityTierId, QualitySettings> = {
  [QualityTier.Low]: {
    shadows: false,
    cascades: 1,
    shadowMapSize: 512,
    softShadows: false,
    ssao: false,
    bloom: false,
    postProcessing: false,
    fxaa: false,
    renderScale: 0.75,
    vegetationDensity: 0.18,
    drawDistanceScale: 0.55,
    textureSize: 128,
    anisotropy: 1,
  },
  [QualityTier.Medium]: {
    shadows: true,
    // Tested at 2 (see git history/PR notes): +38% draw calls (76→105),
    // +29% triangles (209k→269k), +45% worst-case CPU time per frame
    // (1.10ms→1.60ms p99) for a smoother mid-distance shadow transition that
    // is hard to even see against this game's flat-shaded low-poly look.
    // Medium is the tier carrying the widest range of modest hardware; that
    // cost is not worth it there. High and Ultra already run more cascades.
    cascades: 1,
    shadowMapSize: 1024,
    softShadows: false,
    ssao: false,
    bloom: false,
    postProcessing: true,
    fxaa: true,
    renderScale: 0.9,
    vegetationDensity: 0.45,
    drawDistanceScale: 0.75,
    textureSize: 256,
    anisotropy: 4,
  },
  [QualityTier.High]: {
    shadows: true,
    cascades: 3,
    shadowMapSize: 1536,
    softShadows: true,
    ssao: true,
    bloom: true,
    postProcessing: true,
    fxaa: true,
    renderScale: 1,
    vegetationDensity: 0.75,
    drawDistanceScale: 0.9,
    textureSize: 512,
    anisotropy: 8,
  },
  [QualityTier.Ultra]: {
    shadows: true,
    cascades: 4,
    shadowMapSize: 2048,
    softShadows: true,
    ssao: true,
    bloom: true,
    postProcessing: true,
    fxaa: true,
    renderScale: 1,
    vegetationDensity: 1,
    drawDistanceScale: 1,
    textureSize: 1024,
    anisotropy: 16,
  },
};

export function qualitySettings(tier: QualityTierId): QualitySettings {
  return TIERS[tier];
}

const STORAGE_KEY = 'br.quality.tier';

export function loadStoredTier(): QualityTierId | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return value === 0 || value === 1 || value === 2 || value === 3 ? (value as QualityTierId) : null;
  } catch {
    return null;
  }
}

export function storeTier(tier: QualityTierId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(tier));
  } catch {
    // Private browsing or disabled storage: the tier still applies for this
    // session, it just will not be remembered.
  }
}

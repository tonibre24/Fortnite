import type { MaterialKey } from '@riftfront/shared';

/**
 * The single source of truth for the game's art direction.
 *
 * Everything visual — arena surfaces, props, characters, VFX, sky and fog — reads its
 * colours from here so the palette stays coherent instead of drifting per module. No
 * texture or model files are involved anywhere: surfaces are flat-shaded colour, and any
 * texture the renderer needs is generated in code.
 *
 * Direction: stylised low-poly, flat shaded, late afternoon. A warm low sun against cool
 * slate and teal so silhouettes stay readable, with one saturated violet reserved for
 * the rift so the map's focal point is never ambiguous.
 */

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

/**
 * Late afternoon, sun low in the west-north-west.
 *
 * The 21° elevation is the whole reason the scene reads as "designed": it throws shadows
 * roughly 2.6x an object's height, which is what lets a player judge the height of a
 * crate or a ledge from its shadow alone.
 */
export const SUN_DIRECTION = { x: 0.8, y: -0.36, z: -0.48 } as const;

export interface SkyPalette {
  zenith: string;
  horizon: string;
  /** Below the horizon line — the haze the outer terrain dissolves into. */
  ground: string;
  /** The warm band drawn tight to the horizon line. */
  band: string;
  sun: string;
}

export const SKY: SkyPalette = {
  zenith: '#2c5f92',
  horizon: '#e9b184',
  ground: '#6a5a55',
  band: '#ffcf9a',
  sun: '#ffdba6',
};

/**
 * Fog is the sky's horizon colour so geometry at the far edge of the world dissolves
 * into the sky rather than ending on a visible line. Linear rather than exponential: it
 * keeps the whole 64 m arena essentially fog-free (an enemy at 45 m must stay readable)
 * and spends the entire fade on the decorative terrain beyond the walls.
 */
export const FOG = {
  colour: SKY.horizon,
  start: 68,
  end: 178,
} as const;

export const LIGHTING = {
  sunColour: '#ffe3ba',
  sunIntensity: 1.05,
  /** Sky-side hemispheric fill. */
  fillSky: '#a9cdf0',
  /** Bounce colour from the dusty ground. */
  fillGround: '#7a6144',
  fillIntensity: 0.42,
  /** 0 = black shadows, 1 = no shadow. Soft rather than crushed. */
  shadowDarkness: 0.34,
} as const;

// ---------------------------------------------------------------------------
// Arena surfaces
// ---------------------------------------------------------------------------

export interface SurfaceSpec {
  /** Base albedo. */
  diffuse: string;
  /** Self-illumination floor; keeps unlit faces readable without washing them out. */
  emissive?: string;
  /** Colour of the dust kicked up when a bullet hits this surface. */
  dust: string;
  /** Spark colour for impacts on this surface. */
  spark: string;
}

/**
 * Arena material palette.
 *
 * High contrast on purpose: warm bone concrete and burnt orange for the structures a
 * player fights over, cool slate for the perimeter that should recede, and teal/coral
 * accents that stay distinct from every generated player colour.
 */
export const SURFACES: Record<MaterialKey, SurfaceSpec> = {
  ground: { diffuse: '#93a066', dust: '#c8bc8e', spark: '#ffd9a0' },
  wall: { diffuse: '#46526a', dust: '#8e97ad', spark: '#cfe0ff' },
  structure: { diffuse: '#c6bfae', dust: '#e6dfcd', spark: '#fff0c8' },
  platform: { diffuse: '#cf8845', dust: '#e7c193', spark: '#ffcf8a' },
  accent: { diffuse: '#37b49d', emissive: '#0d3a33', dust: '#a7e2d7', spark: '#8ffbe4' },
  accentAlt: { diffuse: '#dd5560', emissive: '#3a1016', dust: '#f0a9ae', spark: '#ffb0b6' },
  metal: { diffuse: '#8b96a9', dust: '#c3ccda', spark: '#e6f2ff' },
  core: { diffuse: '#8a6bff', emissive: '#3b2a9e', dust: '#c3b2ff', spark: '#d9ccff' },
};

/** Decoration-only colours. None of these correspond to a collider. */
export const DECOR = {
  /** Recessed window glass, catching the low sun. */
  windowGlass: '#242a38',
  windowGlow: '#ffb765',
  windowFrame: '#8d8577',
  trim: '#e4dcc6',
  cornice: '#a89e88',
  interiorFloor: '#6f6558',
  doorFrame: '#3f4757',

  rock: '#7d7f7a',
  rockAlt: '#8f8b7d',
  grass: '#7f9b4e',
  grassDry: '#a8a55c',
  /** Arena floor: the base green, the sun-bleached patches and the worn fighting ring. */
  groundBase: '#7c9450',
  groundDry: '#a39c52',
  groundWorn: '#94805a',
  shrub: '#4f7a44',
  treeTrunk: '#6b4f38',
  treeCanopy: '#4e7f4a',
  fence: '#7a6247',
  outbuildingWall: '#b7ad98',
  outbuildingRoof: '#a8564a',
  terrain: '#7c8a55',
} as const;

// ---------------------------------------------------------------------------
// Storm / rift boundary
// ---------------------------------------------------------------------------

export const RIFT = {
  inner: '#8a6bff',
  outer: '#40d7ff',
  edge: '#dcd2ff',
  /** Full-screen tint applied while the camera is inside the field. */
  screenTint: '#8a6bff',
} as const;

// ---------------------------------------------------------------------------
// Combat VFX
// ---------------------------------------------------------------------------

export const VFX = {
  muzzleCore: '#fff6d2',
  muzzleFlare: '#ffb648',
  tracerNear: '#fff0b4',
  tracerFar: '#ff9d4a',
  bloodSpark: '#ff6b78',
  bloodDust: '#a32c3c',
} as const;

/** Parses `#rrggbb` into 0..1 components without allocating a Babylon Color3. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
  };
}

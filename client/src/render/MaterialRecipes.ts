import {
  COLOR_DAMP_PLASTER,
  COLOR_DAMP_SOIL,
  COLOR_DAMP_WOOD,
  COLOR_GRASS_A,
  COLOR_GRASS_B,
  COLOR_GROUND,
  COLOR_ROOF,
  COLOR_TRIM,
  COLOR_WALL,
  COLOR_WALL_ALT,
} from '@br/shared';
import type { MaterialRecipe } from './ProceduralTexture.js';

/**
 * Named PBR recipes standing in for the ambientCG/Poly Haven texture sets the
 * brief names, blocked in this environment (see ASSET_CREDITS.md). Roughness
 * variance is deliberately generous on every recipe here - "everything is
 * slightly damp" was a specific instruction, and this is where it lives:
 * higher variance means the low, shaded parts of the noise read distinctly
 * smoother and darker, the way a real wet surface does next to a dry one.
 */

/** Farmland soil and grass, for the ground tiles. */
export const GROUND_RECIPE: MaterialRecipe = {
  colorA: COLOR_GRASS_A,
  colorB: COLOR_GRASS_B,
  colorLow: COLOR_DAMP_SOIL,
  baseRoughness: 0.88,
  roughnessVariance: 0.3,
  normalStrength: 2.2,
};

/** Weathered painted plaster over brick, for building walls. */
export const WALL_RECIPE: MaterialRecipe = {
  colorA: COLOR_WALL,
  colorB: COLOR_WALL_ALT,
  colorLow: COLOR_DAMP_PLASTER,
  baseRoughness: 0.8,
  roughnessVariance: 0.35,
  normalStrength: 1.4,
};

/** Weathered wood and rust-streaked roofing, for eaves and trim. */
export const ROOF_RECIPE: MaterialRecipe = {
  colorA: COLOR_ROOF,
  colorB: COLOR_TRIM,
  colorLow: COLOR_DAMP_WOOD,
  baseRoughness: 0.7,
  roughnessVariance: 0.4,
  normalStrength: 1.8,
};

/** Which box colour (from map generation) gets which recipe. Anything not listed keeps a flat tinted material. */
export const RECIPE_BY_COLOR: ReadonlyMap<number, MaterialRecipe> = new Map([
  [COLOR_WALL, WALL_RECIPE],
  [COLOR_WALL_ALT, WALL_RECIPE],
  [COLOR_ROOF, ROOF_RECIPE],
  [COLOR_GROUND, GROUND_RECIPE],
]);

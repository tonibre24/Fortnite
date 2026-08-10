# Asset credits

There are none to credit yet, and this file explains why rather than leaving
that unstated.

## What was asked

The photorealism brief named ambientCG and Poly Haven as CC0 sources: an
overcast HDRI for image-based lighting, and PBR texture sets (albedo, normal,
roughness, AO) for wet asphalt, gravel, farmland soil, grass, concrete,
weathered brick, painted plaster, corrugated metal, rusted metal, weathered
wood and roof tile.

## What actually happened

This session's network egress is blocked to both hosts. Verified twice,
independently, before writing any pipeline code:

```
$ curl -sS -o /dev/null -w "%{http_code}\n" --max-time 10 https://polyhaven.com/
curl: (56) CONNECT tunnel failed, response 403

$ curl -sS --max-time 10 https://api.polyhaven.com/assets?t=hdris
curl: (56) CONNECT tunnel failed, response 403

$ curl -sS -o /dev/null -w "%{http_code}\n" --max-time 10 https://ambientcg.com/
curl: (56) CONNECT tunnel failed, response 403
```

and via the session's own web-fetch tool:

```
WebFetch https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky
→ {"error_type":"EGRESS_BLOCKED","domain":"polyhaven.com", ...}
```

There is also no `basisu`/`toktx` binary in this environment, so even a
downloaded texture set could not have been produced as KTX2/Basis here.

What this file will **not** do is list ambientCG/Poly Haven URLs next to
textures that were never actually fetched from them. A credits file that
claims a sourcing that did not happen is a fabricated provenance record, and
that is worse than an honest gap.

## What is in the build instead

Every material, the sky, and the environment map are generated in code at
load time - Canvas2D and GLSL, no binary files:

- **Sky / IBL** - `client/src/render/Sky.ts` is a shader on a backside
  sphere (fbm cloud noise, a soft glow toward the light direction, no HDRI).
  `client/src/render/Renderer.ts` runs this through `THREE.PMREMGenerator`
  exactly as the brief specifies for image-based lighting - `fromScene()`
  rather than `fromEquirectangular()`, since the source image is generated
  rather than loaded. `scene.environment` is what it produces.
- **Terrain / walls / roofs** - `client/src/render/ProceduralTexture.ts`
  generates a full albedo/normal/roughness set per material recipe on
  Canvas2D at load time: seeded multi-octave value noise rasterised to a
  height field, then albedo (colour mixed by height, with a separate
  damp/crevice tone blended into the lowest band), roughness (damp reads
  smoother and darker, dry rougher - "everything is slightly damp" from the
  brief lives here) and a tangent-space normal map (finite-differenced from
  the same height field, so the dents in the normal map line up with the
  dark patches in the albedo) are all derived from that one field.
  `client/src/render/MaterialRecipes.ts` defines the three recipes actually
  used - farmland soil/grass for the ground, weathered plaster-over-brick for
  walls, weathered wood/roofing for roofs - and maps them onto the box
  colours map generation already produces. `WorldView.ts` builds one texture
  set per recipe (not per box - a wall and its alt-colour twin share a set)
  and wires it into both the per-colour box batches and the tiled ground.
  Ground tiles are uniform size, so a plain repeat-1 box UV never stretches;
  each tile also gets a random 0/90/180/270 degree turn on its own instance
  matrix so 1936 tiles sampling one texture do not read as a grid - this is
  the "world-space UVs" half of the brief's "triplanar or world-space UVs"
  allowance, chosen over a triplanar shader as materially lower-risk to get
  right without WebGL to screenshot against. Non-ground boxes vary in size
  but get a fixed moderate repeat rather than a per-box one, a deliberate,
  documented approximation given the same constraint.
- **Not textured** - `Decor.ts`'s fence posts/rails, window frames and
  eaves stay flat-tinted `MeshStandardMaterial`. They are thin trim geometry
  where a full PBR set would cost another texture-set build (and its own
  slice of the texture-memory budget) for detail that reads as a few pixels
  at typical view distance; the brief's own material list is dominated by
  ground, wall and roof surfaces, which is where the budget went instead.
- **Categories the brief names that do not apply here** - wet asphalt,
  gravel, concrete, corrugated and rusted metal have no corresponding
  geometry in this map generator (no roads, no metal props), so there is
  nothing for those recipes to attach to. Recorded here rather than silently
  dropped.

Every texture is generated at its quality tier's resolution (128 to 1024px
depending on Low through Ultra) straight into a `THREE.CanvasTexture` - there
is no download, no disk file and no KTX2/Basis step, because there is nothing
to compress: the "asset" only ever exists as pixels already resident on the
GPU. See the final report for the per-tier texture-memory estimate this
produces; the brief's 25MB *payload* budget does not have an analogue to
apply to zero downloaded bytes, which is stated plainly rather than
papered over with an unrelated number.

## Rural dressing

Also code-generated, also client-side, also decorative-only:

- **Shrubs and hedgerows** - `client/src/render/Vegetation.ts`. Each plant
  is two crossed unit cards (an instanced "cross-billboard", not a
  camera-facing sprite - it is placed once and never re-oriented per frame),
  textured with a small alpha-cutout foliage clump rendered to Canvas2D as a
  handful of overlapping soft-edged blobs. The material is an ordinary
  `MeshStandardMaterial` - full CSM shadows and the baked sky IBL apply
  exactly as they do to every other surface - with a small `onBeforeCompile`
  patch adding the one thing a stock material can't: wind sway, keyed off
  each vertex's height on its own billboard so the sway grows toward the top
  and the root stays planted. Scatter probability falls off with distance
  from the nearest POI (`VEGETATION_FALLOFF_RADIUS`), reading as busiest near
  the farmsteads it borders and thinning into open field beyond them - the
  brief's "distance-based density falloff," applied at placement time rather
  than as a per-frame camera-distance fade, which is not a difference a
  player can tell apart in a mostly-static scatter. The same billboard is
  packed at hedge density along the map's field-boundary lines.
- **Field boundaries** - `client/src/render/fieldBoundaries.ts` divides the
  map into a grid of straight interior lines and commits each one to either a
  hedge (above) or a low fence, by a hash of the map seed and the line's own
  index rather than a shared RNG draw - Vegetation and FarmDressing each call
  it independently at their own instance spacing and still agree on which
  lines are which.
- **Dirt tracks, power poles, hay bales** - `client/src/render/FarmDressing.ts`.
  Tracks are instanced ground-hugging segments linking the POIs along a
  simple nearest-earlier-neighbour spanning tree, following terrain height as
  they go. A subset of poles walks the same tracks at fixed spacing; the
  sagging cable between each consecutive pair is a handful of straight
  sub-segments approximating a catenary, drawn as one `THREE.LineSegments`
  for every span in the map rather than per-pole geometry. Hay bales are
  cylinders rotated onto their side, scattered with the same POI-distance
  falloff as open-field shrubs.
- **Not attempted** - wet asphalt has no analogue here either, for the same
  reason as the wall/roof categories above: this generator has no roads, only
  the dirt tracks described above.

If this project is later run somewhere with unrestricted egress, or the
textures are supplied directly, this file is where their source URLs and
licences belong - added at that point, not invented now.

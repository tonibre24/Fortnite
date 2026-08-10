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
- **Terrain / props / materials** - `client/src/render/*.ts` build
  `MeshStandardMaterial`s with procedural roughness/normal variation and
  per-instance HSL tint jitter, so repeated geometry does not read as tiled.

This section is updated as further procedural work lands - materials proper
(Canvas2D-generated albedo/normal/roughness/AO, triplanar terrain UVs) and the
rural environment dressing are still in progress at the time of writing.

If this project is later run somewhere with unrestricted egress, or the
textures are supplied directly, this file is where their source URLs and
licences belong - added at that point, not invented now.

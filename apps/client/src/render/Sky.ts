import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import type { Scene } from '@babylonjs/core/scene';
import { SKY, SUN_DIRECTION } from './palette.js';

/**
 * Procedural sky dome.
 *
 * One 288-triangle sphere pinned to the camera with a gradient evaluated per pixel: a
 * three-stop vertical ramp, a tight warm band on the horizon line, and a two-lobe sun
 * glow. There is no texture and no cubemap — the whole sky is eight uniforms and about
 * twenty instructions, which is what keeps it free on integrated graphics.
 *
 * The horizon colour here is also the scene's fog colour, so distant geometry fades into
 * exactly the sky it is silhouetted against and the world has no visible edge.
 */

const VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDirection;

void main() {
  // The dome is centred on the camera, so the local position *is* the view direction.
  vDirection = position;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vDirection;

uniform vec3 zenithColour;
uniform vec3 horizonColour;
uniform vec3 groundColour;
uniform vec3 bandColour;
uniform vec3 sunColour;
uniform vec3 sunDirection;

/**
 * An 8-bit framebuffer cannot hold a smooth 200-pixel gradient without banding, so a
 * sub-LSB ordered dither is added. It is invisible on its own and removes every band.
 */
float dither(vec2 fragment) {
  return fract(sin(dot(fragment, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}

void main() {
  vec3 direction = normalize(vDirection);
  float height = direction.y;

  vec3 upper = mix(horizonColour, zenithColour, pow(clamp(height, 0.0, 1.0), 0.42));
  vec3 lower = mix(horizonColour, groundColour, pow(clamp(-height, 0.0, 1.0), 0.55));
  vec3 colour = height >= 0.0 ? upper : lower;

  // Two sun lobes: a small bright core and a wide warm bloom that tints half the sky.
  float toSun = max(dot(direction, -sunDirection), 0.0);
  colour += sunColour * pow(toSun, 220.0) * 1.35;
  colour += sunColour * pow(toSun, 5.0) * 0.30;

  // The horizon band. Deliberately crisp: it is the line the arena silhouettes read against.
  float band = 1.0 - smoothstep(0.0, 0.045, abs(height));
  colour = mix(colour, bandColour, band * 0.8);

  colour += dither(gl_FragCoord.xy) * (1.0 / 255.0);
  gl_FragColor = vec4(colour, 1.0);
}
`;

export interface ProceduralSky {
  mesh: Mesh;
  material: ShaderMaterial;
  dispose: () => void;
}

export function buildSky(scene: Scene, radius = 220): ProceduralSky {
  const material = new ShaderMaterial(
    'sky',
    scene,
    { vertexSource: VERTEX, fragmentSource: FRAGMENT },
    {
      attributes: ['position'],
      uniforms: [
        'worldViewProjection',
        'zenithColour',
        'horizonColour',
        'groundColour',
        'bandColour',
        'sunColour',
        'sunDirection',
      ],
      needAlphaBlending: false,
      needAlphaTesting: false,
    },
  );

  material.setColor3('zenithColour', Color3.FromHexString(SKY.zenith));
  material.setColor3('horizonColour', Color3.FromHexString(SKY.horizon));
  material.setColor3('groundColour', Color3.FromHexString(SKY.ground));
  material.setColor3('bandColour', Color3.FromHexString(SKY.band));
  material.setColor3('sunColour', Color3.FromHexString(SKY.sun));
  material.setVector3(
    'sunDirection',
    new Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize(),
  );

  // Seen from the inside, and it must never occlude anything or write depth.
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.disableColorWrite = false;
  material.freeze();

  const mesh = MeshBuilder.CreateSphere('sky', { diameter: radius * 2, segments: 12 }, scene);
  mesh.material = material;
  mesh.infiniteDistance = true;
  mesh.applyFog = false;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  // Always drawn, never culled, never contributes to scene bounds.
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.doNotSyncBoundingInfo = true;
  mesh.renderingGroupId = 0;

  return {
    mesh,
    material,
    dispose: () => {
      mesh.dispose(false, false);
      material.unfreeze();
      material.dispose();
    },
  };
}

import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import type { Vec3 } from '@riftfront/shared';
import { RIFT } from './palette.js';

/**
 * The rift boundary — a shader-driven energy wall around the arena.
 *
 * ## What this is, and what it is not
 *
 * Riftfront is a five-minute arena deathmatch: it has no shrinking play area and no
 * storm damage, and adding one would be a *gameplay* change that the server would have
 * to own. This is the storm's rendering, applied to the boundary the arena already has.
 * Everything the effect needs is here and driven — scrolling noise, a soft leading edge,
 * fresnel at grazing angles, and a screen tint that ramps as the camera crosses the
 * boundary. Wiring it to a real closing storm later is a matter of animating `radius`
 * from replicated state; nothing else about the module has to change.
 *
 * ## How it is drawn
 *
 * One open-ended cylinder, double-sided, additive and depth-tested but not depth-written,
 * so it sits behind the arena and in front of the landscape it is dissolving. It is a
 * single draw call and about 250 triangles; the whole look comes out of the fragment
 * shader.
 */

const VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 world;
uniform mat4 viewProjection;

varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUv;

void main() {
  vec4 worldPosition = world * vec4(position, 1.0);
  vPositionW = worldPosition.xyz;
  vNormalW = normalize(mat3(world[0].xyz, world[1].xyz, world[2].xyz) * normal);
  vUv = uv;
  gl_Position = viewProjection * worldPosition;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUv;

uniform vec3 cameraPosition;
uniform vec3 innerColour;
uniform vec3 outerColour;
uniform vec3 edgeColour;
uniform float time;
uniform float intensity;
/** Height of the soft leading edge band, in UV units. */
uniform float edgeWidth;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

/** Smooth value noise; two calls at different scales is enough for a churning wall. */
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  // Three layers: two broad fields scrolling in opposite directions, plus fine vertical
  // striations. One layer reads as a sliding texture; the combination reads as something
  // churning, and the striations are what make it a *wall* rather than a fog bank.
  vec2 slow = vec2(vUv.x * 26.0 + time * 0.05, vUv.y * 7.0 - time * 0.14);
  vec2 fast = vec2(vUv.x * 54.0 - time * 0.11, vUv.y * 15.0 - time * 0.31);
  float streaks = noise(vec2(vUv.x * 150.0, time * 0.22));
  float churn = noise(slow) * 0.5 + noise(fast) * 0.28 + streaks * 0.22;
  // Contrast: without this the noise averages out to a flat wash at any distance.
  float density = smoothstep(0.24, 0.88, churn);

  // Fresnel: the wall is nearly transparent seen head-on and glows at grazing angles,
  // which is what makes a flat cylinder read as a volume.
  vec3 toEye = normalize(cameraPosition - vPositionW);
  float facing = abs(dot(normalize(vNormalW), toEye));
  float fresnel = pow(1.0 - facing, 2.6);

  // The soft leading edge: a bright, unstable band at the base of the wall that fades
  // upward, so the boundary has a front rather than a hard line on the ground.
  float fromBase = vUv.y;
  float edge = 1.0 - smoothstep(0.0, edgeWidth, fromBase - churn * edgeWidth * 0.6);
  float body = smoothstep(0.95, 0.1, fromBase) * (0.1 + density * 0.9);

  // The far side of the ring is over a hundred metres away; without this it would be as
  // bright as the wall two metres from your face and the whole screen would wash out.
  float distanceFade = 1.0 - smoothstep(95.0, 190.0, length(cameraPosition - vPositionW));

  vec3 colour = mix(innerColour, outerColour, density);
  colour = mix(colour, edgeColour, edge * 0.7);

  // Fresnel *boosts* the wall at grazing angles rather than gating it: seen square-on
  // from inside the arena the fresnel term is ~0, and gating on it made the whole
  // boundary disappear from the one viewpoint players actually have.
  float alpha = clamp(body * 0.62 + edge * 0.9, 0.0, 1.0) * (0.5 + fresnel * 1.0);
  alpha *= intensity * distanceFade;

  gl_FragColor = vec4(colour * alpha, alpha);
}
`;

export interface RiftFieldOptions {
  /** Distance from the centre to the wall, in metres. */
  radius?: number;
  height?: number;
  centre?: Vec3;
}

export class RiftField {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly centre: Vec3;
  private radius: number;
  private elapsed = 0;
  private tint = 0;
  private disposed = false;

  constructor(scene: Scene, options: RiftFieldOptions = {}) {
    // Just outside the perimeter walls: far enough not to crowd the arena, close
    // enough that the leading-edge band clears the outer hills instead of hiding behind
    // them, and tall enough to rise well above the 9 m wall from anywhere inside.
    this.radius = options.radius ?? 46;
    const height = options.height ?? 30;
    this.centre = options.centre ?? { x: 0, y: 0, z: 0 };

    this.material = new ShaderMaterial(
      'rift-field',
      scene,
      { vertexSource: VERTEX, fragmentSource: FRAGMENT },
      {
        attributes: ['position', 'normal', 'uv'],
        uniforms: [
          'world',
          'viewProjection',
          'cameraPosition',
          'innerColour',
          'outerColour',
          'edgeColour',
          'time',
          'intensity',
          'edgeWidth',
        ],
        needAlphaBlending: true,
        needAlphaTesting: false,
      },
    );
    this.material.setColor3('innerColour', Color3.FromHexString(RIFT.inner));
    this.material.setColor3('outerColour', Color3.FromHexString(RIFT.outer));
    this.material.setColor3('edgeColour', Color3.FromHexString(RIFT.edge));
    this.material.setFloat('intensity', 1.35);
    this.material.setFloat('edgeWidth', 0.14);
    this.material.setFloat('time', 0);
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = true;
    // Premultiplied output, matching the VFX convention.
    this.material.alphaMode = Constants.ALPHA_ONEONE;

    this.mesh = MeshBuilder.CreateCylinder(
      'rift-field',
      {
        diameter: this.radius * 2,
        height,
        tessellation: 64,
        // Open-ended: the caps would be a bright disc over the sky and the ground.
        cap: 0,
        sideOrientation: 2,
      },
      scene,
    );
    this.mesh.material = this.material;
    // Sunk two metres so the leading-edge band sits on the ground rather than above it.
    this.mesh.position.set(this.centre.x, this.centre.y + height / 2 - 2, this.centre.z);
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = false;
    this.mesh.applyFog = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;
    this.mesh.freezeWorldMatrix();
  }

  /** Moves the boundary. The hook a shrinking storm would drive. */
  setRadius(radius: number): void {
    if (this.disposed || radius <= 0) return;
    const scale = radius / this.radius;
    this.radius = radius;
    this.mesh.scaling.x *= scale;
    this.mesh.scaling.z *= scale;
    this.mesh.unfreezeWorldMatrix();
    this.mesh.computeWorldMatrix(true);
    this.mesh.freezeWorldMatrix();
  }

  /**
   * Advances the effect and recomputes how far inside the field the viewer is.
   *
   * The tint is a smooth band rather than a step, so crossing the boundary reads as
   * walking into weather instead of a switch being flipped.
   */
  update(dtSeconds: number, viewer: Vec3): void {
    if (this.disposed) return;
    this.elapsed += dtSeconds;
    this.material.setFloat('time', this.elapsed);

    const distance = Math.hypot(viewer.x - this.centre.x, viewer.z - this.centre.z);
    const penetration = distance - this.radius;
    // Fully tinted 8 m past the boundary; nothing at all 2 m short of it.
    const target = Math.max(0, Math.min(1, (penetration + 2) / 10));
    // Ease towards the target so a camera skimming the boundary does not strobe.
    this.tint += (target - this.tint) * Math.min(1, dtSeconds * 6);
  }

  /** 0 outside the field, 1 deep inside it. Drives the HUD's screen tint. */
  get screenTint(): number {
    return this.tint;
  }

  setVisible(visible: boolean): void {
    this.mesh.setEnabled(visible);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.dispose(false, false);
    this.material.dispose();
  }
}

import * as THREE from 'three';
import {
  COLOR_STORM_WALL,
  COLOR_STORM_WALL_EDGE,
  FOG_FAR,
  FOG_NEAR,
  FOG_TINT,
  MAP_HALF,
  STORM_WALL_HEIGHT,
} from '@br/shared';

/**
 * The storm as a shader rather than a flat translucent cylinder.
 *
 * The flat version gave no sense of depth or motion, and at grazing angles it
 * simply vanished - exactly when a player most needs to see where the edge is.
 * This scrolls two layers of value noise, keeps a soft bright leading edge at
 * the bottom where the wall meets the ground, and uses a fresnel term so the
 * wall glows more the more edge-on it is seen.
 *
 * All procedural: the noise is computed in the fragment shader, so there is no
 * texture to generate or upload.
 */
const VERTEX = /* glsl */ `
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    // The cylinder is scaled non-uniformly, so the normal needs the inverse
    // transpose; normalMatrix is exactly that.
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying vec2 vUv;

  uniform vec3 stormColor;
  uniform vec3 edgeColor;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  uniform float time;
  uniform float opacity;

  // Cheap hash-based value noise. Two octaves is enough for a moving wall and
  // costs a handful of instructions rather than a texture fetch.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  void main() {
    // Two layers drifting at different speeds and scales, which reads as
    // turbulence rather than as a texture sliding past.
    vec2 uvA = vec2(vUv.x * 14.0 + time * 0.05, vUv.y * 3.0 - time * 0.10);
    vec2 uvB = vec2(vUv.x * 27.0 - time * 0.08, vUv.y * 6.0 - time * 0.17);
    float n = noise(uvA) * 0.62 + noise(uvB) * 0.38;

    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    // Two-sided: the wall is visible from inside the circle too, and there the
    // geometric normal points away from the viewer.
    vec3 normal = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    float facing = abs(dot(normal, viewDirection));
    // Grazing angles glow: the wall should get stronger as it turns edge-on,
    // not disappear.
    float fresnel = pow(1.0 - facing, 2.2);

    // A bright band along the bottom, where the wall meets the ground - that
    // line is what tells a player exactly where the boundary is.
    float lead = smoothstep(0.22, 0.0, vUv.y);

    vec3 color = mix(stormColor, edgeColor, fresnel * 0.7 + lead * 0.6);
    color += edgeColor * n * 0.25;

    // The same linear distance fog the rest of the scene uses, applied by
    // hand since this is a raw ShaderMaterial - without it the wall was a
    // flat, saturated cutout at any range, instead of the softened, hazy
    // front a real distant storm would read as.
    float fogFactor = clamp((length(cameraPosition - vWorldPosition) - fogNear) / (fogFar - fogNear), 0.0, 1.0);
    color = mix(color, fogColor, fogFactor * 0.7);

    // Fades out towards the top so the wall has no hard upper edge against sky.
    float height = 1.0 - smoothstep(0.45, 1.0, vUv.y);
    float alpha = opacity * (0.30 + n * 0.35 + fresnel * 0.5 + lead * 0.55) * height;
    alpha *= 1.0 - fogFactor * 0.45;

    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

const STORM_SEGMENTS = 96;

export class StormWall {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.CylinderGeometry;

  constructor(scene: THREE.Scene) {
    this.geometry = new THREE.CylinderGeometry(1, 1, STORM_WALL_HEIGHT, STORM_SEGMENTS, 1, true);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        stormColor: { value: new THREE.Color(COLOR_STORM_WALL) },
        edgeColor: { value: new THREE.Color(COLOR_STORM_WALL_EDGE) },
        fogColor: { value: new THREE.Color(FOG_TINT) },
        fogNear: { value: FOG_NEAR },
        fogFar: { value: FOG_FAR },
        time: { value: 0 },
        opacity: { value: 1 },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  update(visible: boolean, x: number, z: number, radius: number, seconds: number): void {
    this.mesh.visible = visible;
    if (!visible) return;
    this.material.uniforms.time!.value = seconds;
    const clamped = Math.min(radius, MAP_HALF * 2);
    this.mesh.scale.set(clamped, 1, clamped);
    this.mesh.position.set(x, STORM_WALL_HEIGHT / 2, z);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

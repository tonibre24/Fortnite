import * as THREE from 'three';
import {
  SKY_CLOUD_SCALE,
  SKY_GLOW_COLOR,
  SKY_HAZE_WIDTH,
  SKY_HORIZON_COLOR,
  SKY_HORIZON_HEIGHT,
  SKY_TOP_COLOR,
} from '@br/shared';

/**
 * The sky, as a shader on a backside sphere.
 *
 * A fully overcast day has almost no visible sun and no blue-sky gradient in
 * the usual sense - it is a soft grey-white dome, slightly brighter where the
 * sun sits behind the cloud layer, mottled with texture from the cloud
 * structure itself. That mottling is not decoration: PMREMGenerator bakes this
 * sky into the environment map every material samples, and a perfectly flat
 * sphere would make every wet or metal surface reflect a flat grey nothing.
 * The noise is what gives specular reflections something to show.
 */
const VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vDirection;
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 glowColor;
  uniform float horizonHeight;
  uniform float hazeWidth;
  uniform float cloudScale;
  uniform vec3 sunDirection;

  // Cheap hash-based value noise, and a small fbm on top of it for the
  // impression of cloud structure without any texture upload.
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
          mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
          mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z
    );
  }

  float fbm(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      sum += noise(p) * amp;
      p *= 2.02;
      amp *= 0.5;
    }
    return sum;
  }

  void main() {
    vec3 dir = normalize(vDirection);
    float h = dir.y * 0.5 + 0.5;

    // Mostly-uniform grey dome, a little brighter at the zenith than at the
    // horizon where haze thickens the apparent cloud layer.
    float t = smoothstep(horizonHeight - 0.5, horizonHeight + 0.6, h);
    vec3 color = mix(horizonColor, topColor, t);

    // Cloud structure, sampled on the sky sphere itself so it stays fixed to
    // world direction rather than swimming as the camera turns.
    float clouds = fbm(dir * cloudScale);
    color = mix(color, color * 1.08 + glowColor * 0.02, clouds);

    // A soft brighter patch where the sun sits behind the cloud layer - no
    // disc, just enough to give the light a direction the way an overcast sky
    // actually shows one.
    float towardsSun = max(dot(dir, normalize(sunDirection)), 0.0);
    float glow = pow(towardsSun, 3.0) * (0.7 + clouds * 0.3);
    color = mix(color, glowColor, glow * hazeWidth);

    gl_FragColor = vec4(color, 1.0);
  }
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.SphereGeometry;

  constructor(sunDirection: THREE.Vector3) {
    this.geometry = new THREE.SphereGeometry(1, 48, 32);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(SKY_TOP_COLOR) },
        horizonColor: { value: new THREE.Color(SKY_HORIZON_COLOR) },
        glowColor: { value: new THREE.Color(SKY_GLOW_COLOR) },
        horizonHeight: { value: SKY_HORIZON_HEIGHT },
        hazeWidth: { value: SKY_HAZE_WIDTH },
        cloudScale: { value: SKY_CLOUD_SCALE },
        sunDirection: { value: sunDirection.clone() },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // Rendered first and never depth-tested against, so it can be tiny and
    // simply ride along with the camera.
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.scale.setScalar(10);
  }

  /** Keeps the dome centred on the camera so it never clips or parallaxes. */
  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
  }

  /** The horizon colour, so fog can be matched to it exactly. */
  static horizonColor(): THREE.Color {
    return new THREE.Color(SKY_HORIZON_COLOR);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

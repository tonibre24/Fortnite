import * as THREE from 'three';
import {
  SKY_HAZE_COLOR,
  SKY_HAZE_WIDTH,
  SKY_HORIZON_COLOR,
  SKY_HORIZON_HEIGHT,
  SKY_TOP_COLOR,
} from '@br/shared';

/**
 * The sky, as a shader on a backside sphere.
 *
 * A flat background colour makes the map edge obvious and the lighting look
 * arbitrary. A gradient with a warm band at the horizon gives the scene a
 * direction and a time of day, and costs one draw of a low-poly sphere - no
 * texture to generate, upload or keep in memory.
 */
const VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    // World-space direction is all the fragment stage needs; the sphere is
    // pinned to the camera so its own position carries no information.
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vDirection;
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 hazeColor;
  uniform float horizonHeight;
  uniform float hazeWidth;
  uniform vec3 sunDirection;

  void main() {
    float h = vDirection.y * 0.5 + 0.5;
    // Biased so the gradient compresses near the horizon, which is where the
    // eye expects the change to happen.
    float t = smoothstep(horizonHeight - 0.45, horizonHeight + 0.55, h);
    vec3 color = mix(horizonColor, topColor, t);

    // A warm band hugging the horizon, brightest towards the sun.
    float band = 1.0 - smoothstep(0.0, hazeWidth, abs(h - horizonHeight));
    float towardsSun = max(dot(normalize(vDirection), normalize(sunDirection)), 0.0);
    color = mix(color, hazeColor, band * (0.35 + 0.65 * pow(towardsSun, 2.0)));

    // A soft glow where the sun actually is, without drawing a disc.
    color += hazeColor * pow(towardsSun, 12.0) * 0.35;

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
        hazeColor: { value: new THREE.Color(SKY_HAZE_COLOR) },
        horizonHeight: { value: SKY_HORIZON_HEIGHT },
        hazeWidth: { value: SKY_HAZE_WIDTH },
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

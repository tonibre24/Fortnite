import * as THREE from 'three';
import {
  FOG_FAR,
  FOG_NEAR,
  HEMI_GROUND_COLOR,
  HEMI_INTENSITY,
  HEMI_SKY_COLOR,
  PLAYER_EYE_HEIGHT,
  SHADOW_BIAS,
  SHADOW_DEPTH,
  SHADOW_MAP_SIZE,
  SHADOW_NORMAL_BIAS,
  SHADOW_RADIUS,
  SUN_AZIMUTH,
  SUN_COLOR,
  SUN_ELEVATION,
  SUN_INTENSITY,
} from '@br/shared';
import { Sky } from './Sky.js';

/** Owns the WebGL context, the scene graph root, the camera and the lighting. */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sunDirection = new THREE.Vector3();

  private readonly renderer: THREE.WebGLRenderer;
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: Sky;
  /** Shadow quality is the first thing cut when the frame budget is missed. */
  private shadowsEnabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    // PCF soft is the cheapest filtering that still hides the texel grid at
    // this map size; VSM costs a blur pass we cannot afford on integrated parts.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;

    // Late afternoon: low in the sky, so shadows are long and directional.
    this.sunDirection
      .set(
        Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH),
        Math.sin(SUN_ELEVATION),
        Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
      )
      .normalize();

    this.sky = new Sky(this.sunDirection);
    this.scene.add(this.sky.mesh);

    // Fog matched to the horizon, so distance dissolves into sky rather than
    // ending at a visible edge where the ground slab stops.
    const horizon = Sky.horizonColor();
    this.scene.fog = new THREE.Fog(horizon.getHex(), FOG_NEAR, FOG_FAR);

    this.sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sun.shadow.bias = SHADOW_BIAS;
    this.sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.left = -SHADOW_RADIUS;
    shadowCamera.right = SHADOW_RADIUS;
    shadowCamera.top = SHADOW_RADIUS;
    shadowCamera.bottom = -SHADOW_RADIUS;
    shadowCamera.near = 1;
    shadowCamera.far = SHADOW_DEPTH;
    shadowCamera.updateProjectionMatrix();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.scene.add(new THREE.HemisphereLight(HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY));

    this.camera = new THREE.PerspectiveCamera(80, 1, 0.1, FOG_FAR + 40);
    this.camera.position.set(0, PLAYER_EYE_HEIGHT, 0);
    this.camera.rotation.order = 'YXZ';

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Re-centres the shadow frustum on a point each frame.
   *
   * A single map covering 500x500 would give roughly 25cm texels at 2k, which
   * turns every shadow edge into a staircase. Fitting it around the player
   * instead buys about 5cm texels, at the cost of shadows only existing near
   * the viewer - which is the only place they are legible anyway.
   */
  focusShadows(target: THREE.Vector3): void {
    if (!this.shadowsEnabled) return;
    // Snapped to the texel grid, otherwise the whole shadow shimmers as the
    // frustum slides under sub-texel camera motion.
    const texel = (SHADOW_RADIUS * 2) / SHADOW_MAP_SIZE;
    const x = Math.round(target.x / texel) * texel;
    const z = Math.round(target.z / texel) * texel;
    this.sun.target.position.set(x, target.y, z);
    this.sun.position.set(
      x + this.sunDirection.x * (SHADOW_DEPTH * 0.5),
      target.y + this.sunDirection.y * (SHADOW_DEPTH * 0.5),
      z + this.sunDirection.z * (SHADOW_DEPTH * 0.5),
    );
    this.sun.target.updateMatrixWorld();
  }

  /** Turns shadows off wholesale; the fallback when the budget is missed. */
  setShadowsEnabled(enabled: boolean): void {
    this.shadowsEnabled = enabled;
    this.sun.castShadow = enabled;
    this.renderer.shadowMap.enabled = enabled;
    this.renderer.shadowMap.needsUpdate = true;
  }

  get shadows(): boolean {
    return this.shadowsEnabled;
  }

  render(): void {
    this.sky.follow(this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  /** Draw calls and triangles for the frame just rendered. */
  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  get triangles(): number {
    return this.renderer.info.render.triangles;
  }

  /** Live GPU resource counts, for the perf overlay. */
  get textureCount(): number {
    return this.renderer.info.memory.textures;
  }

  get geometryCount(): number {
    return this.renderer.info.memory.geometries;
  }

  get programCount(): number {
    return this.renderer.info.programs?.length ?? 0;
  }
}

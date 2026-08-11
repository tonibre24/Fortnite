import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import {
  BLOOM_RADIUS,
  BLOOM_STRENGTH,
  BLOOM_THRESHOLD,
  ENVIRONMENT_INTENSITY,
  EXPOSURE,
  FILL_LIGHT_COLOR,
  FILL_LIGHT_INTENSITY,
  FOG_FAR,
  FOG_NEAR,
  FOG_TINT,
  HEMI_GROUND_COLOR,
  HEMI_INTENSITY,
  HEMI_SKY_COLOR,
  PLAYER_EYE_HEIGHT,
  SHADOW_BIAS,
  SHADOW_DEPTH,
  SHADOW_NORMAL_BIAS,
  SHADOW_SOFT_RADIUS,
  SSAO_MAX_DISTANCE,
  SSAO_MIN_DISTANCE,
  SSAO_RADIUS,
  SSAO_RESOLUTION_SCALE,
  SUN_AZIMUTH,
  SUN_COLOR,
  SUN_ELEVATION,
  SUN_INTENSITY,
  VIGNETTE_STRENGTH,
  FILM_GRAIN_STRENGTH,
} from '@br/shared';
import { Sky } from './Sky.js';
import { VignetteGrainShader } from './VignetteGrainShader.js';
import { qualitySettings, type QualitySettings, type QualityTierId } from './Quality.js';

/**
 * Owns the WebGL context, the scene graph root, the camera, lighting and the
 * post-processing chain.
 *
 * Image-based lighting is baked once from the procedural sky rather than
 * loaded from a downloaded HDRI - this environment's network policy blocks
 * the CC0 sources the brief names (ambientCG, Poly Haven), verified before
 * writing this file. PMREMGenerator is still exactly the mechanism requested;
 * only the image it convolves is generated in code instead of fetched.
 */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sunDirection = new THREE.Vector3();

  private readonly renderer: THREE.WebGLRenderer;
  private readonly sky: Sky;
  private readonly hemi: THREE.HemisphereLight;
  private readonly fill: THREE.DirectionalLight;
  private readonly pmrem: THREE.PMREMGenerator;
  private csm: CSM;
  private composer: EffectComposer;
  private fxaaPass: ShaderPass | null = null;
  private vignettePass: ShaderPass | null = null;
  private ssaoPass: SSAOPass | null = null;
  private settings: QualitySettings;
  private tier: QualityTierId;
  /** Bumped every time materials need csm.setupMaterial() called again. */
  private cascadeVersion = 0;

  constructor(canvas: HTMLCanvasElement, initialTier: QualityTierId) {
    this.tier = initialTier;
    this.settings = qualitySettings(initialTier);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // EffectComposer issues several internal renderer.render() calls per
    // frame - one per pass. Autoreset would zero the counters at the start of
    // each of those, leaving info.render holding only the final pass's tally
    // (typically the last full-screen blit: one draw, one triangle) instead
    // of the whole frame's. Reset is done by hand, once, at the top of our
    // own render() below.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;

    this.sunDirection
      .set(
        Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH),
        Math.sin(SUN_ELEVATION),
        Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
      )
      .normalize();

    this.sky = new Sky(this.sunDirection);
    this.scene.add(this.sky.mesh);

    const horizon = Sky.horizonColor();
    this.scene.fog = new THREE.Fog(new THREE.Color(FOG_TINT).lerp(horizon, 0.5).getHex(), FOG_NEAR, FOG_FAR);

    this.hemi = new THREE.HemisphereLight(HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY);
    this.scene.add(this.hemi);

    // Stands in for bounce light off the ground: HemisphereLight's
    // groundColor term barely touches an upward-facing normal (see
    // FILL_LIGHT_COLOR's doc comment), so flat ground stayed dark at wide
    // angles even with the sky lights raised. three.js DirectionalLight
    // shines from (position - target), so the light must sit above the
    // target to illuminate an upward-facing normal - no shadows, it is a
    // fill, not a second sun.
    this.fill = new THREE.DirectionalLight(FILL_LIGHT_COLOR, FILL_LIGHT_INTENSITY);
    this.fill.position.set(0, 1, 0);
    this.fill.target.position.set(0, 0, 0);
    this.fill.castShadow = false;
    this.scene.add(this.fill);
    this.scene.add(this.fill.target);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.bakeEnvironment();

    this.camera = new THREE.PerspectiveCamera(80, 1, 0.1, FOG_FAR + 40);
    this.camera.position.set(0, PLAYER_EYE_HEIGHT, 0);
    this.camera.rotation.order = 'YXZ';

    this.csm = this.buildCsm();
    this.composer = this.buildComposer();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Renders the sky to a cubemap and runs it through PMREMGenerator, so every
   * MeshStandardMaterial in the scene picks up ambient sky light and soft
   * reflections without a single extra light. On an overcast day this is
   * doing most of the actual lighting work.
   */
  private bakeEnvironment(): void {
    const bakeScene = new THREE.Scene();
    const bakeMesh = this.sky.mesh.clone();
    bakeMesh.position.set(0, 0, 0);
    bakeScene.add(bakeMesh);
    const rendered = this.pmrem.fromScene(bakeScene, 0, 0.1, 2000);
    this.scene.environment = rendered.texture;
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    bakeMesh.geometry.dispose();
    bakeScene.remove(bakeMesh);
  }

  private buildCsm(): CSM {
    const csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: this.settings.cascades,
      maxFar: FOG_FAR,
      mode: 'practical',
      shadowMapSize: this.settings.shadowMapSize,
      lightDirection: this.sunDirection.clone().negate(),
      lightIntensity: SUN_INTENSITY,
      lightNear: 1,
      lightFar: SHADOW_DEPTH,
      lightMargin: 30,
    });

    // CSM.js always creates plain white lights; the overcast tint is ours to add.
    for (const light of csm.lights) {
      light.color.set(SUN_COLOR);
      light.castShadow = this.settings.shadows;
      light.shadow.bias = SHADOW_BIAS;
      light.shadow.normalBias = SHADOW_NORMAL_BIAS;
      if (this.settings.softShadows) light.shadow.radius = SHADOW_SOFT_RADIUS;
    }
    this.renderer.shadowMap.type = this.settings.softShadows ? THREE.VSMShadowMap : THREE.PCFShadowMap;
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.cascadeVersion += 1;
    return csm;
  }

  private buildComposer(): EffectComposer {
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));

    this.fxaaPass = null;
    this.vignettePass = null;
    this.ssaoPass = null;

    if (this.settings.postProcessing) {
      if (this.settings.ssao) {
        const ssao = new SSAOPass(this.scene, this.camera);
        ssao.kernelRadius = SSAO_RADIUS;
        ssao.minDistance = SSAO_MIN_DISTANCE;
        ssao.maxDistance = SSAO_MAX_DISTANCE;
        ssao.output = SSAOPass.OUTPUT.Default;
        composer.addPass(ssao);
        this.ssaoPass = ssao;
      }

      if (this.settings.bloom) {
        const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
        composer.addPass(bloom);
      }

      const vignette = new ShaderPass(VignetteGrainShader);
      vignette.uniforms.vignetteStrength.value = VIGNETTE_STRENGTH;
      vignette.uniforms.grainStrength.value = FILM_GRAIN_STRENGTH;
      composer.addPass(vignette);
      this.vignettePass = vignette;

      if (this.settings.fxaa) {
        const fxaa = new ShaderPass(FXAAShader);
        composer.addPass(fxaa);
        this.fxaaPass = fxaa;
      }

      // EffectComposer's intermediate targets render every pass in raw linear
      // space on purpose (so bloom etc. operate on correct HDR values) - only
      // the direct-to-canvas path applies tone mapping and sRGB encoding
      // automatically. Without this as the final pass, the composer's output
      // goes to the screen still linear, which the browser then displays as
      // if it were already sRGB: mid-tones and shadows read far too dark
      // while only near-white values look plausible. This is what made the
      // ground read near-black regardless of how far ambient light was
      // pushed up - the light was landing, the encode to display it was not.
      composer.addPass(new OutputPass());
    }

    return composer;
  }

  /** Tears down and rebuilds the shadow rig and post-processing stack for a new tier. */
  setQualityTier(tier: QualityTierId): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.settings = qualitySettings(tier);

    this.csm.dispose();
    this.csm = this.buildCsm();
    // EffectComposer.dispose() only frees its own ping-pong render targets -
    // SSAOPass, UnrealBloomPass, ShaderPass and OutputPass each own further
    // render targets/materials of their own (SSAO alone holds three) that it
    // never reaches, so every tier switch was leaking them.
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.composer = this.buildComposer();
    this.resize();
  }

  get quality(): QualitySettings {
    return this.settings;
  }

  get qualityTier(): QualityTierId {
    return this.tier;
  }

  /**
   * Every opaque, lit material must be registered once to receive the
   * cascaded shadows correctly - without this a material still picks up light
   * from all of CSM's underlying DirectionalLights, just summed instead of
   * blended, which double-brightens wherever two cascades overlap. Views hold
   * this callback rather than importing Renderer directly, so a view stays
   * constructible and testable without a full renderer behind it.
   */
  readonly setupCascadeMaterial = (material: THREE.Material): void => {
    this.csm.setupMaterial(material);
  };

  /** Bumped on every tier change; views compare it to know their materials are stale. */
  get cascadeSetupVersion(): number {
    return this.cascadeVersion;
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const scale = this.settings.renderScale;
    this.renderer.setSize(width, height);
    this.renderer.setDrawingBufferSize(Math.round(width * scale), Math.round(height * scale), this.renderer.getPixelRatio());
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.composer.setSize(Math.round(width * scale), Math.round(height * scale));
    if (this.fxaaPass) {
      const ratio = this.renderer.getPixelRatio();
      this.fxaaPass.uniforms.resolution.value.set(1 / (width * scale * ratio), 1 / (height * scale * ratio));
    }
    if (this.ssaoPass) {
      // composer.setSize() just forced every pass - this one included - back
      // up to full resolution; pull SSAO's own render targets back down.
      this.ssaoPass.setSize(
        Math.round(width * scale * SSAO_RESOLUTION_SCALE),
        Math.round(height * scale * SSAO_RESOLUTION_SCALE),
      );
    }
    this.csm.updateFrustums();
  }

  /**
   * Repositions the cascades for this frame. Must run after the camera's
   * position/rotation are set for the frame and before render() - CSM reads
   * camera.matrixWorld directly, which the renderer would otherwise only
   * refresh internally during the draw itself, one frame too late.
   */
  updateShadows(): void {
    this.camera.updateMatrixWorld();
    this.csm.update();
  }

  /**
   * `viewmodelCamera` is a second pass, depth-cleared and drawn straight to
   * the screen after post-processing: its own near plane (not the world's)
   * is what stops the weapon poking through a wall the player stands close
   * to, and clearing only depth - not colour - is what lets it draw over the
   * already-composited world instead of erasing it.
   */
  render(now: number, viewmodelCamera?: THREE.PerspectiveCamera): void {
    this.renderer.info.reset();
    this.sky.follow(this.camera);
    if (this.vignettePass) this.vignettePass.uniforms.time.value = now / 1000;
    if (this.settings.postProcessing) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    if (viewmodelCamera !== undefined) {
      viewmodelCamera.aspect = this.camera.aspect;
      viewmodelCamera.updateProjectionMatrix();
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.scene, viewmodelCamera);
      this.renderer.autoClear = true;
    }
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

  /** Bytes of GPU texture memory currently resident, for the perf overlay. */
  estimateTextureMemory(textures: readonly (THREE.Texture | null)[]): number {
    let bytes = 0;
    for (const texture of textures) {
      const image = texture?.image as { width?: number; height?: number } | undefined;
      if (image?.width === undefined || image.height === undefined) continue;
      // 4 bytes/texel plus a third again for the mip chain - close enough for
      // an overlay reading, not a billing system.
      bytes += image.width * image.height * 4 * 1.33;
    }
    return bytes;
  }
}

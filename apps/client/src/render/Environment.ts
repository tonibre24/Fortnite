import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Scene } from '@babylonjs/core/scene';
import type { Vec3 } from '@riftfront/shared';
import { buildSky, type ProceduralSky } from './Sky.js';
import { FOG, LIGHTING, SKY, SUN_DIRECTION } from './palette.js';

/**
 * Lighting, sky and atmosphere.
 *
 * Three things carry the whole look:
 *
 *  - **One directional sun** at a late-afternoon elevation, with a shadow map whose
 *    orthographic frustum is fitted around the *local player* rather than the arena.
 *    Fitting to the map would spread 1024 texels over 64 m (6 cm/texel); fitting to a
 *    22 m box around the player gives 2 cm/texel, which is the difference between a
 *    crate casting a recognisable shadow and casting a grey smear.
 *  - **A hemispheric fill** so nothing in shadow goes black. Readability beats mood in a
 *    shooter: a player standing in the tower's shadow must still be identifiable at 40 m.
 *  - **Fog matched to the sky's horizon colour**, so the decorative terrain outside the
 *    walls dissolves instead of ending on a hard line.
 */

/** Half-width of the shadow frustum, in metres, centred on the local player. */
const SHADOW_RADIUS = 22;
/** How far back along the light direction the shadow camera sits. */
const SHADOW_PULLBACK = 55;
const SHADOW_MAP_SIZE = 1024;

export class Environment {
  readonly sun: DirectionalLight;
  readonly fill: HemisphericLight;
  readonly shadows: ShadowGenerator;
  private readonly sky: ProceduralSky;

  /** Light-space basis, used to snap the shadow frustum to whole texels. */
  private readonly lightForward = new Vector3();
  private readonly lightRight = new Vector3();
  private readonly lightUp = new Vector3();
  private readonly focusPoint = new Vector3();

  private disposed = false;

  constructor(private readonly scene: Scene) {
    const horizon = Color3.FromHexString(SKY.horizon);

    scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1);
    // Ambient is delivered by the hemispheric fill and the per-material emissive floor,
    // never by a flat scene-wide term, which would kill every shadow.
    scene.ambientColor = Color3.Black();

    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogColor = horizon;
    scene.fogStart = FOG.start;
    scene.fogEnd = FOG.end;

    const direction = new Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize();
    this.sun = new DirectionalLight('sun', direction, scene);
    this.sun.intensity = LIGHTING.sunIntensity;
    this.sun.diffuse = Color3.FromHexString(LIGHTING.sunColour);
    this.sun.specular = Color3.FromHexString(LIGHTING.sunColour).scale(0.25);

    // Manual frustum control: Babylon's automatic fit would grow to contain every caster.
    this.sun.autoUpdateExtends = false;
    this.sun.autoCalcShadowZBounds = false;
    this.sun.orthoLeft = -SHADOW_RADIUS;
    this.sun.orthoRight = SHADOW_RADIUS;
    this.sun.orthoBottom = -SHADOW_RADIUS;
    this.sun.orthoTop = SHADOW_RADIUS;
    this.sun.shadowMinZ = 1;
    this.sun.shadowMaxZ = SHADOW_PULLBACK * 2;

    this.fill = new HemisphericLight('fill', new Vector3(0.15, 1, -0.2), scene);
    this.fill.intensity = LIGHTING.fillIntensity;
    this.fill.diffuse = Color3.FromHexString(LIGHTING.fillSky);
    this.fill.groundColor = Color3.FromHexString(LIGHTING.fillGround);
    this.fill.specular = Color3.Black();

    this.shadows = new ShadowGenerator(SHADOW_MAP_SIZE, this.sun);
    // PCF at the lowest quality is a 1-tap 3x3 gather: soft enough for the stylised look,
    // and roughly a third of the cost of the blurred exponential variants.
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.filteringQuality = ShadowGenerator.QUALITY_LOW;
    this.shadows.darkness = LIGHTING.shadowDarkness;
    // Every caster in this scene is a closed box, so rendering back faces into the depth
    // map moves the depth comparison to the far side of the geometry. That removes shadow
    // acne outright and lets the bias stay small enough not to detach contact shadows.
    this.shadows.forceBackFacesOnly = true;
    this.shadows.bias = 0.0008;
    this.shadows.normalBias = 0.006;
    // Fades the shadow out at the edge of the frustum instead of cutting it off, which is
    // what hides the boundary of the player-fitted box.
    this.shadows.frustumEdgeFalloff = 0.25;
    this.shadows.transparencyShadow = false;

    const shadowMap = this.shadows.getShadowMap();
    if (shadowMap) {
      // Casters are registered explicitly, so the map never needs a scene-wide traversal.
      shadowMap.refreshRate = 1;
    }

    this.sky = buildSky(scene);

    // Build the light-space basis once; the sun never moves.
    this.lightForward.copyFrom(direction);
    Vector3.CrossToRef(Vector3.UpReadOnly, this.lightForward, this.lightRight);
    this.lightRight.normalize();
    Vector3.CrossToRef(this.lightForward, this.lightRight, this.lightUp);
    this.lightUp.normalize();

    this.focus({ x: 0, y: 0, z: 0 });
  }

  /** Registers a mesh as a shadow caster. Safe to call for meshes that come and go. */
  addShadowCaster(mesh: AbstractMesh): void {
    if (this.disposed) return;
    this.shadows.addShadowCaster(mesh, false);
  }

  removeShadowCaster(mesh: AbstractMesh): void {
    if (this.disposed) return;
    this.shadows.removeShadowCaster(mesh, false);
  }

  /**
   * Re-centres the shadow frustum on a world point (the local player).
   *
   * The centre is snapped to whole shadow-map texels in light space. Without that snap
   * the shadow edges crawl by up to a texel every time the player moves, which reads as
   * shimmering on every static edge in the scene — the classic tell of a fitted map.
   */
  focus(point: Vec3): void {
    if (this.disposed) return;

    const texel = (SHADOW_RADIUS * 2) / SHADOW_MAP_SIZE;
    this.focusPoint.set(point.x, point.y, point.z);

    const alongRight = Vector3.Dot(this.focusPoint, this.lightRight);
    const alongUp = Vector3.Dot(this.focusPoint, this.lightUp);
    const alongForward = Vector3.Dot(this.focusPoint, this.lightForward);
    const snappedRight = Math.round(alongRight / texel) * texel;
    const snappedUp = Math.round(alongUp / texel) * texel;

    // Rebuild the snapped focus point, then step back along the light to place the camera.
    this.sun.position.set(
      this.lightRight.x * snappedRight +
        this.lightUp.x * snappedUp +
        this.lightForward.x * alongForward -
        this.lightForward.x * SHADOW_PULLBACK,
      this.lightRight.y * snappedRight +
        this.lightUp.y * snappedUp +
        this.lightForward.y * alongForward -
        this.lightForward.y * SHADOW_PULLBACK,
      this.lightRight.z * snappedRight +
        this.lightUp.z * snappedUp +
        this.lightForward.z * alongForward -
        this.lightForward.z * SHADOW_PULLBACK,
    );
  }

  /** Turns shadows off entirely — the first quality lever the benchmark can pull. */
  setShadowsEnabled(enabled: boolean): void {
    const shadowMap = this.shadows.getShadowMap();
    if (shadowMap) shadowMap.refreshRate = enabled ? 1 : 0;
    this.sun.shadowEnabled = enabled;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sky.dispose();
    this.shadows.dispose();
    this.sun.dispose();
    this.fill.dispose();
    void this.scene;
  }
}

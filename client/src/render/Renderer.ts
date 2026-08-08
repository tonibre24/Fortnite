import * as THREE from 'three';
import { COLOR_SKY, PLAYER_EYE_HEIGHT } from '@br/shared';

/** Owns the WebGL context, the scene graph root and the camera. */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.background = new THREE.Color(COLOR_SKY);

    this.camera = new THREE.PerspectiveCamera(80, 1, 0.1, 2000);
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

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}

import * as THREE from 'three';

/**
 * A restrained screen-space finishing pass: a soft vignette and a little film
 * grain. Both are subtle by design - the brief is explicit that heavy camera
 * or screen effects read as "video game", not "real", so this stays a light
 * touch rather than a look of its own. No chromatic aberration, no motion
 * blur - neither is in this shader at all, so there is nothing to accidentally
 * leave enabled.
 */
export const VignetteGrainShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignetteStrength: { value: 0.28 },
    grainStrength: { value: 0.035 },
    time: { value: 0 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignetteStrength;
    uniform float grainStrength;
    uniform float time;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(41.3, 289.1)) + time * 61.7) * 43758.5453123);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);

      vec2 centered = vUv - 0.5;
      float vignette = 1.0 - dot(centered, centered) * vignetteStrength * 2.2;
      color.rgb *= clamp(vignette, 0.0, 1.0);

      float grain = (hash(vUv) - 0.5) * grainStrength;
      color.rgb += grain;

      gl_FragColor = color;
    }
  `,
};

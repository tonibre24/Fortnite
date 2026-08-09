import {
  Button,
  MAX_PITCH,
  MOUSE_SENSITIVITY,
  clamp,
  dequantizePitch,
  dequantizeYaw,
  quantizePitch,
  quantizeYaw,
} from '@br/shared';
import type { InputSample, InputSource } from '../game/GameClient.js';

const KEY_BUTTONS: Record<string, number> = {
  KeyW: Button.Forward,
  ArrowUp: Button.Forward,
  KeyS: Button.Back,
  ArrowDown: Button.Back,
  KeyA: Button.Left,
  ArrowLeft: Button.Left,
  KeyD: Button.Right,
  ArrowRight: Button.Right,
  Space: Button.Jump,
  ShiftLeft: Button.Sprint,
  ShiftRight: Button.Sprint,
  ControlLeft: Button.Crouch,
  KeyC: Button.Crouch,
  KeyR: Button.Reload,
  KeyE: Button.Interact,
};

/** Number keys pick the slot in hand. */
const SLOT_KEYS: Record<string, number> = {
  Digit1: 0,
  Digit2: 1,
  Digit3: 2,
  Digit4: 3,
  Digit5: 4,
};

/**
 * Keyboard and pointer-lock mouse input.
 *
 * Look angles are quantized to their wire representation the moment they are
 * sampled, and everything downstream - prediction, camera, the packet - uses
 * the quantized value. If the client predicted from a finer angle than it sent,
 * the server would simulate a slightly different direction and prediction would
 * drift on every turn.
 */
export class InputSampler implements InputSource {
  private readonly held = new Set<string>();
  private firing = false;
  private yaw = 0;
  private pitch = 0;
  private slot = 0;
  locked = false;

  /** Whether the trigger is down right now, for local HUD feedback. */
  get firingNow(): boolean {
    return this.locked && this.firing;
  }

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code in KEY_BUTTONS) e.preventDefault();
      const slot = SLOT_KEYS[e.code];
      if (slot !== undefined) {
        this.slot = slot;
        e.preventDefault();
      }
      this.held.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => {
      this.held.clear();
      this.firing = false;
    });

    canvas.addEventListener('click', () => {
      if (!this.locked) void canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) {
        this.held.clear();
        this.firing = false;
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * MOUSE_SENSITIVITY;
      this.pitch = clamp(this.pitch - e.movementY * MOUSE_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
    });
    canvas.addEventListener('mousedown', (e) => {
      if (this.locked && e.button === 0) this.firing = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false;
    });
  }

  adoptLook(yawQ: number, pitchQ: number): void {
    this.yaw = dequantizeYaw(yawQ);
    this.pitch = dequantizePitch(pitchQ);
  }

  sample(): InputSample {
    let buttons = 0;
    for (const code of this.held) {
      const bit = KEY_BUTTONS[code];
      if (bit !== undefined) buttons |= bit;
    }
    if (this.firing) buttons |= Button.Fire;
    // Only the locked pointer drives the game; an unlocked cursor means the
    // player is looking at something else and should stand still.
    if (!this.locked) buttons = 0;

    return {
      buttons,
      yawQ: quantizeYaw(this.yaw),
      pitchQ: quantizePitch(this.pitch),
      slot: this.slot,
    };
  }
}

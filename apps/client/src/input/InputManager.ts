import {
  INPUT_AIM,
  INPUT_JUMP,
  INPUT_SPRINT,
  MAX_MOUSE_SENSITIVITY,
  MIN_MOUSE_SENSITIVITY,
  clamp,
  clampPitch,
} from '@riftfront/shared';

/**
 * Keyboard/mouse input with pointer lock.
 *
 * Physical key codes (`event.code`) are used rather than `event.key`, so the layout is
 * WASD-shaped on AZERTY and QWERTZ keyboards too. Mouse deltas accumulate between
 * simulation steps so a 240 Hz mouse is not down-sampled to the frame rate.
 */

export interface InputSnapshot {
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  buttons: number;
  firePressed: boolean;
  fireHeld: boolean;
}

export type PointerLockState = 'locked' | 'unlocked' | 'denied';

export interface InputManagerEvents {
  onReload?: () => void;
  onScoreboard?: (visible: boolean) => void;
  onPause?: () => void;
  onSwitchWeapon?: (slot: number) => void;
  onPointerLockChange?: (state: PointerLockState) => void;
  onTogglePerf?: () => void;
}

const MOVEMENT_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);

export class InputManager {
  private readonly held = new Set<string>();
  private pendingYawDelta = 0;
  private pendingPitchDelta = 0;

  private yawValue = 0;
  private pitchValue = 0;

  private mouseLeftDown = false;
  private mouseRightDown = false;
  private firePressedLatch = false;
  private scoreboardVisible = false;

  private sensitivity: number;
  private invertY: boolean;
  private locked = false;
  private disposed = false;

  private readonly listeners: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: InputManagerEvents,
    options: { sensitivity: number; invertY: boolean },
  ) {
    this.sensitivity = clamp(options.sensitivity, MIN_MOUSE_SENSITIVITY, MAX_MOUSE_SENSITIVITY);
    this.invertY = options.invertY;
    this.attach();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get isLocked(): boolean {
    return this.locked;
  }

  get yaw(): number {
    return this.yawValue;
  }

  get pitch(): number {
    return this.pitchValue;
  }

  setSensitivity(value: number): void {
    this.sensitivity = clamp(value, MIN_MOUSE_SENSITIVITY, MAX_MOUSE_SENSITIVITY);
  }

  setInvertY(value: boolean): void {
    this.invertY = value;
  }

  /** Sets the look angles directly (used on spawn to face the spawn direction). */
  setOrientation(yaw: number, pitch: number): void {
    this.yawValue = yaw;
    this.pitchValue = clampPitch(pitch);
    this.pendingYawDelta = 0;
    this.pendingPitchDelta = 0;
  }

  /** Applies weapon recoil to the look angles, exactly as if the player had aimed up. */
  applyRecoil(vertical: number, horizontal: number): void {
    this.pitchValue = clampPitch(this.pitchValue - vertical);
    this.yawValue += horizontal;
  }

  requestPointerLock(): void {
    if (this.locked || this.disposed) return;
    try {
      const result = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (result && typeof result.catch === 'function') {
        result.catch(() => this.events.onPointerLockChange?.('denied'));
      }
    } catch {
      // Some browsers throw synchronously when the gesture requirement is not met.
      this.events.onPointerLockChange?.('denied');
    }
  }

  releasePointerLock(): void {
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
  }

  /**
   * Consumes accumulated mouse motion and returns the current input state.
   * Called once per fixed simulation step.
   */
  sample(): InputSnapshot {
    this.yawValue += this.pendingYawDelta;
    this.pitchValue = clampPitch(this.pitchValue + this.pendingPitchDelta);
    this.pendingYawDelta = 0;
    this.pendingPitchDelta = 0;

    const forward =
      (this.isDown('KeyW') || this.isDown('ArrowUp') ? 1 : 0) -
      (this.isDown('KeyS') || this.isDown('ArrowDown') ? 1 : 0);
    const strafe =
      (this.isDown('KeyD') || this.isDown('ArrowRight') ? 1 : 0) -
      (this.isDown('KeyA') || this.isDown('ArrowLeft') ? 1 : 0);

    let buttons = 0;
    if (this.isDown('Space')) buttons |= INPUT_JUMP;
    if (this.isDown('ShiftLeft') || this.isDown('ShiftRight')) buttons |= INPUT_SPRINT;
    if (this.mouseRightDown) buttons |= INPUT_AIM;

    const firePressed = this.firePressedLatch;
    this.firePressedLatch = false;

    return {
      moveX: strafe,
      moveZ: forward,
      yaw: this.yawValue,
      pitch: this.pitchValue,
      buttons,
      firePressed,
      fireHeld: this.mouseLeftDown,
    };
  }

  /** Clears held keys, e.g. when the window loses focus or the player dies. */
  clearHeldKeys(): void {
    this.held.clear();
    this.mouseLeftDown = false;
    this.mouseRightDown = false;
    this.firePressedLatch = false;
    if (this.scoreboardVisible) {
      this.scoreboardVisible = false;
      this.events.onScoreboard?.(false);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releasePointerLock();
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
    this.held.clear();
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private isDown(code: string): boolean {
    return this.held.has(code);
  }

  private on<K extends keyof WindowEventMap>(
    target: Window | Document | HTMLElement,
    type: K | string,
    handler: (event: never) => void,
    options?: AddEventListenerOptions,
  ): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, options);
    this.listeners.push(() => target.removeEventListener(type, listener, options));
  }

  private attach(): void {
    this.on(window, 'keydown', (event: KeyboardEvent) => this.handleKeyDown(event));
    this.on(window, 'keyup', (event: KeyboardEvent) => this.handleKeyUp(event));
    this.on(window, 'blur', () => this.clearHeldKeys());
    this.on(document, 'visibilitychange', () => {
      if (document.hidden) this.clearHeldKeys();
    });

    this.on(this.canvas, 'mousedown', (event: MouseEvent) => {
      if (!this.locked) return;
      if (event.button === 0) {
        this.mouseLeftDown = true;
        this.firePressedLatch = true;
      }
      if (event.button === 2) this.mouseRightDown = true;
    });

    this.on(window, 'mouseup', (event: MouseEvent) => {
      if (event.button === 0) this.mouseLeftDown = false;
      if (event.button === 2) this.mouseRightDown = false;
    });

    this.on(this.canvas, 'contextmenu', (event: MouseEvent) => event.preventDefault());

    this.on(document, 'mousemove', (event: MouseEvent) => {
      if (!this.locked) return;
      this.pendingYawDelta += event.movementX * this.sensitivity;
      this.pendingPitchDelta +=
        (this.invertY ? -event.movementY : event.movementY) * this.sensitivity;
    });

    this.on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.clearHeldKeys();
      this.events.onPointerLockChange?.(this.locked ? 'locked' : 'unlocked');
    });

    this.on(document, 'pointerlockerror', () => {
      this.locked = false;
      this.events.onPointerLockChange?.('denied');
    });
  }

  private handleKeyDown(event: KeyboardEvent): void {
    // Never swallow keystrokes aimed at a text field on the menu screens.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    if (event.code === 'Escape') {
      this.events.onPause?.();
      return;
    }

    if (event.repeat) {
      if (MOVEMENT_KEYS.has(event.code)) event.preventDefault();
      return;
    }

    this.held.add(event.code);

    switch (event.code) {
      case 'KeyR':
        this.events.onReload?.();
        break;
      case 'Tab':
        event.preventDefault();
        if (!this.scoreboardVisible) {
          this.scoreboardVisible = true;
          this.events.onScoreboard?.(true);
        }
        break;
      case 'Digit1':
        this.events.onSwitchWeapon?.(1);
        break;
      case 'Digit2':
        this.events.onSwitchWeapon?.(2);
        break;
      case 'F3':
        event.preventDefault();
        this.events.onTogglePerf?.();
        break;
      default:
        break;
    }

    // Space would otherwise scroll the page, arrows would move focus.
    if (MOVEMENT_KEYS.has(event.code)) event.preventDefault();
  }

  private handleKeyUp(event: KeyboardEvent): void {
    this.held.delete(event.code);
    if (event.code === 'Tab' && this.scoreboardVisible) {
      this.scoreboardVisible = false;
      this.events.onScoreboard?.(false);
    }
  }
}

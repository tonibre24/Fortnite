import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import '@babylonjs/core/Materials/standardMaterial';
import '@babylonjs/core/Meshes/Builders/boxBuilder';
import '@babylonjs/core/Meshes/Builders/sphereBuilder';

import {
  ColliderIndex,
  DEFAULT_WEAPON_ID,
  FIXED_DT_MS,
  MATCH_DURATION_MS,
  SERVER_TICK_MS,
  clamp,
  getArena,
  getWeapon,
  isWeaponId,
  rankScoreboard,
  type DamagedPayload,
  type HitConfirmedPayload,
  type HitscanTarget,
  type KillPayload,
  type MatchEndedPayload,
  type MatchStateView,
  type NoticePayload,
  type PlayerView,
  type ReconcilePayload,
  type RespawnedPayload,
  type ShotPayload,
  type Vec3,
  type WeaponId,
} from '@riftfront/shared';

import { AudioSystem } from '../audio/AudioSystem.js';
import { CameraRig } from '../render/CameraRig.js';
import { EffectsSystem } from '../render/Effects.js';
import { InputManager, type PointerLockState } from '../input/InputManager.js';
import { LocalPlayer } from '../game/LocalPlayer.js';
import { RemotePlayerBuffer } from '../game/RemotePlayers.js';
import { WeaponController } from '../game/WeaponController.js';
import { Avatar } from '../render/Avatar.js';
import { Environment } from '../render/Environment.js';
import { buildArenaScenery } from '../render/SceneBuilder.js';
import { ConnectionError, NetworkClient } from '../net/NetworkClient.js';
import { Hud } from '../ui/Hud.js';
import { LandingScreen } from '../ui/LandingScreen.js';
import { Notifications } from '../ui/Notifications.js';
import { PauseMenu } from '../ui/PauseMenu.js';
import { PerfPanel } from '../ui/PerfPanel.js';
import { ResultsScreen } from '../ui/ResultsScreen.js';
import { Scoreboard } from '../ui/Scoreboard.js';
import { loadSettings, resolveServerUrl, saveSettings, type UserSettings } from '../config.js';

/**
 * Application orchestrator.
 *
 * Owns the lifecycle and wires the independent subsystems together — rendering, input,
 * prediction, networking and UI — without absorbing their responsibilities. The fixed
 * simulation step runs on an accumulator so prediction stays at exactly 60 Hz regardless
 * of the display's refresh rate.
 */

type AppPhase = 'menu' | 'connecting' | 'playing';

/** Prevents a long stall (tab in background) from being replayed as hundreds of steps. */
const MAX_STEPS_PER_FRAME = 5;

export class GameApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly uiRoot: HTMLElement;
  private readonly colliders = new ColliderIndex(getArena().colliders);

  private engine: Engine | null = null;
  private scene: Scene | null = null;
  private cameraRig: CameraRig | null = null;
  private effects: EffectsSystem | null = null;
  private scenery: ReturnType<typeof buildArenaScenery> | null = null;
  private environment: Environment | null = null;

  private readonly avatars = new Map<string, Avatar>();
  private readonly remotes = new RemotePlayerBuffer();
  private localPlayer: LocalPlayer | null = null;
  private weapons: WeaponController;

  private input: InputManager | null = null;
  private network: NetworkClient | null = null;
  private readonly audio: AudioSystem;

  private readonly landing: LandingScreen;
  private readonly hud: Hud;
  private readonly scoreboard: Scoreboard;
  private readonly results: ResultsScreen;
  private readonly pause: PauseMenu;
  private readonly perf: PerfPanel;
  private readonly notifications: Notifications;

  private settings: UserSettings;
  private phase: AppPhase = 'menu';
  private accumulatorMs = 0;
  private lastFrameMs = 0;
  private roomCode = '';
  private lastCountdownSecond = -1;
  private matchOverShown = false;
  private disposed = false;

  private readonly onResize = (): void => this.engine?.resize();
  private readonly onBeforeUnload = (): void => {
    void this.network?.leave();
  };

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.settings = loadSettings();

    this.weapons = new WeaponController(this.colliders);
    this.audio = new AudioSystem({
      masterVolume: this.settings.masterVolume,
      effectsVolume: this.settings.effectsVolume,
    });

    const sessionId = (): string => this.network?.sessionId ?? '';

    this.notifications = new Notifications();
    this.landing = new LandingScreen({
      onCreate: (name) => void this.handleCreate(name),
      onJoin: (name, code) => void this.handleJoin(name, code),
    });
    this.hud = new Hud(sessionId);
    this.scoreboard = new Scoreboard(sessionId);
    this.results = new ResultsScreen(sessionId, {
      onPlayAgain: () => this.handlePlayAgain(),
      onReturnToMenu: () => void this.handleReturnToMenu(),
    });
    this.pause = new PauseMenu(this.settings, {
      onResume: () => this.closePauseMenu(),
      onLeaveMatch: () => void this.handleReturnToMenu(),
      onSettingsChanged: (settings) => this.applySettings(settings),
    });
    this.perf = new PerfPanel(this.settings.showPerfPanel);

    this.uiRoot.append(
      this.hud.root,
      this.perf.root,
      this.scoreboard.root,
      this.landing.root,
      this.pause.root,
      this.results.root,
      this.notifications.root,
    );

    this.landing.setDisplayName(this.settings.displayName);
    this.prefillRoomCodeFromUrl();
  }

  // -------------------------------------------------------------------------
  // Bootstrapping
  // -------------------------------------------------------------------------

  /** Creates the renderer. Returns false when WebGL is unavailable. */
  start(): boolean {
    try {
      this.engine = new Engine(this.canvas, true, {
        antialias: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
        stencil: false,
        failIfMajorPerformanceCaveat: false,
      });
    } catch (error) {
      console.error('[render] WebGL initialisation failed', error);
      return false;
    }

    if (!this.engine.getCaps()) {
      return false;
    }

    // Cap the device pixel ratio: a 4K laptop display otherwise renders 4x the pixels
    // for no readability gain and halves the frame rate.
    this.engine.setHardwareScalingLevel(1 / clamp(window.devicePixelRatio, 1, 2));

    const scene = new Scene(this.engine);
    scene.skipPointerMovePicking = true;
    scene.autoClear = true;
    scene.autoClearDepthAndStencil = true;
    // Nothing in the arena needs picking; disabling it removes a per-frame traversal.
    scene.skipFrustumClipping = false;
    this.scene = scene;

    this.environment = new Environment(scene);
    this.scenery = buildArenaScenery(scene, getArena(), { environment: this.environment });
    this.effects = new EffectsSystem(scene);
    this.cameraRig = new CameraRig(scene, this.colliders);

    this.input = new InputManager(
      this.canvas,
      {
        onReload: () => this.handleReloadRequest(),
        onScoreboard: (visible) => this.scoreboard.setVisible(visible && this.phase === 'playing'),
        onPause: () => this.togglePauseMenu(),
        onSwitchWeapon: (slot) => this.handleWeaponSwitch(slot),
        onPointerLockChange: (state) => this.handlePointerLockChange(state),
        onTogglePerf: () => this.togglePerfPanel(),
      },
      { sensitivity: this.settings.mouseSensitivity, invertY: this.settings.invertY },
    );

    window.addEventListener('resize', this.onResize);
    window.addEventListener('beforeunload', this.onBeforeUnload);

    this.lastFrameMs = performance.now();
    this.engine.runRenderLoop(() => this.frame());

    this.landing.show();
    this.landing.setStatus('Ready. Create a match or join with a room code.', 'idle');
    return true;
  }

  private prefillRoomCodeFromUrl(): void {
    const code = new URLSearchParams(window.location.search).get('room');
    if (code) this.landing.prefillRoomCode(code.toUpperCase());
  }

  // -------------------------------------------------------------------------
  // Connection flow
  // -------------------------------------------------------------------------

  private async handleCreate(displayName: string): Promise<void> {
    await this.connect(displayName, null);
  }

  private async handleJoin(displayName: string, code: string): Promise<void> {
    await this.connect(displayName, code);
  }

  private async connect(displayName: string, code: string | null): Promise<void> {
    if (this.phase !== 'menu') return;

    this.phase = 'connecting';
    this.landing.setBusy(true);
    this.landing.setStatus(code ? `Joining ${code}…` : 'Creating a match…', 'busy');

    // Audio must be unlocked from a user gesture; this click is that gesture.
    await this.audio.unlock();

    this.settings = { ...this.settings, displayName };
    saveSettings(this.settings);

    const network = new NetworkClient(resolveServerUrl(), {
      onWelcome: (payload) => {
        this.roomCode = payload.roomCode;
        this.pause.setRoomCode(payload.roomCode);
        this.updateShareableUrl(payload.roomCode);
      },
      onShot: (payload) => this.handleRemoteShot(payload),
      onHitConfirmed: (payload) => this.handleHitConfirmed(payload),
      onDamaged: (payload) => this.handleDamaged(payload),
      onKill: (payload) => this.handleKill(payload),
      onRespawned: (payload) => this.handleRespawned(payload),
      onMatchStarted: () => this.handleMatchStarted(),
      onMatchEnded: (payload) => this.handleMatchEnded(payload),
      onReconcile: (payload) => this.handleForcedReconcile(payload),
      onNotice: (payload) => this.handleNotice(payload),
      onLeave: (leaveCode) => this.handleDisconnected(leaveCode),
      onError: (errorCode, message) => {
        console.error('[net] room error', errorCode, message);
        this.notifications.show('The server reported an error. Returning to the menu.', 'error');
      },
    });

    try {
      const joined = code
        ? await network.joinRoom(displayName, code)
        : await network.createRoom(displayName);

      this.network = network;
      this.roomCode = joined;
      this.enterMatch();
    } catch (error) {
      await network.dispose();
      this.phase = 'menu';
      this.landing.setBusy(false);

      const message =
        error instanceof ConnectionError
          ? error.message
          : 'Could not join the match. Please try again.';
      this.landing.setStatus(message, 'error');
      console.error('[net] connection failed', error);
    }
  }

  private enterMatch(): void {
    this.phase = 'playing';
    this.landing.setBusy(false);
    this.landing.hide();
    this.results.hide();
    this.hud.show();
    this.hud.resetTransient();
    this.matchOverShown = false;
    this.lastCountdownSecond = -1;

    const self = this.network?.state?.players.get(this.network.sessionId);
    const spawn: Vec3 = self ? { x: self.x, y: self.y, z: self.z } : { x: 0, y: 2, z: -20 };

    this.localPlayer = new LocalPlayer(this.colliders, spawn);
    this.weapons.reset();
    this.remotes.clear();
    this.input?.setOrientation(self?.yaw ?? 0, 0);

    this.notifications.show(
      `Room code ${this.roomCode} — share it to invite a friend.`,
      'info',
      6000,
    );
    this.input?.requestPointerLock();
  }

  private updateShareableUrl(code: string): void {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('room', code);
      window.history.replaceState(null, '', url.toString());
    } catch {
      // A non-standard URL (file://) — not worth surfacing to the player.
    }
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private frame(): void {
    if (this.disposed || !this.scene || !this.engine) return;

    const nowMs = performance.now();
    const frameMs = Math.min(250, nowMs - this.lastFrameMs);
    this.lastFrameMs = nowMs;
    const dtSeconds = frameMs / 1000;

    if (this.phase === 'playing') {
      this.stepSimulation(nowMs, frameMs);
      this.syncFromServer(dtSeconds);
      this.updateHud(nowMs);
    }

    this.effects?.update(dtSeconds);
    this.weapons.update(dtSeconds);
    this.updatePerfPanel(frameMs);

    this.scene.render();
  }

  /** Fixed-timestep prediction, decoupled from the render rate. */
  private stepSimulation(nowMs: number, frameMs: number): void {
    const network = this.network;
    const local = this.localPlayer;
    const input = this.input;
    if (!network || !local || !input) return;

    const state = network.state;
    const self = state?.players.get(network.sessionId);

    this.accumulatorMs += frameMs;
    let steps = 0;

    while (this.accumulatorMs >= FIXED_DT_MS && steps < MAX_STEPS_PER_FRAME) {
      this.accumulatorMs -= FIXED_DT_MS;
      steps += 1;

      const sample = input.sample();
      const frozen = self ? !self.alive : false;

      const command = local.step(
        {
          moveX: frozen ? 0 : sample.moveX,
          moveZ: frozen ? 0 : sample.moveZ,
          yaw: sample.yaw,
          pitch: sample.pitch,
          buttons: frozen ? 0 : sample.buttons,
        },
        frozen,
      );
      network.queueInput(command, nowMs);

      this.maybeFire(sample, self, nowMs, command.seq);
    }

    if (steps >= MAX_STEPS_PER_FRAME) {
      // The tab was throttled; drop the backlog rather than fast-forwarding the player.
      this.accumulatorMs = 0;
    }

    network.flushInput(nowMs);
  }

  private maybeFire(
    sample: { firePressed: boolean; fireHeld: boolean; buttons: number },
    self: PlayerView | undefined,
    nowMs: number,
    inputSeq: number,
  ): void {
    const network = this.network;
    const local = this.localPlayer;
    const rig = this.cameraRig;
    const state = network?.state;
    if (!network || !local || !rig || !self || !state) return;

    const aiming = (sample.buttons & 4) !== 0;
    const matchRunning = state.phase === 'PLAYING';

    if (
      this.weapons.isDryFire({
        firePressed: sample.firePressed,
        alive: self.alive,
        reloading: self.reloading,
        magazine: self.magazine,
      })
    ) {
      this.audio.play('dryFire');
      return;
    }

    const shouldFire = this.weapons.shouldFire({
      firePressed: sample.firePressed,
      fireHeld: sample.fireHeld,
      nowMs,
      alive: self.alive,
      reloading: self.reloading,
      magazine: self.magazine,
      matchRunning,
    });
    if (!shouldFire) return;

    const target = {
      position: local.simulatedPosition,
      yaw: this.input?.yaw ?? 0,
      pitch: this.input?.pitch ?? 0,
      aiming,
    };
    const weapon = this.weapons.weapon;
    const ray = rig.getAimRay(target, weapon.range);

    const shotSeq = network.sendFire(ray.direction, aiming, inputSeq);
    if (shotSeq < 0) return;

    const visual = this.weapons.registerShot({
      shotSeq,
      sessionId: network.sessionId,
      origin: ray.origin,
      direction: ray.direction,
      aiming,
      nowMs,
      targets: this.buildLocalHitscanTargets(state, network.sessionId),
    });

    this.renderShot(visual.origin, visual.endPoints, visual.impactNormals, visual.hitPlayer, true);

    const recoil = this.weapons.recoilForShot(aiming);
    this.input?.applyRecoil(recoil.vertical, recoil.horizontal);
    rig.addRecoilKick(recoil.vertical * 0.8, recoil.horizontal * 0.6);

    this.audio.play(weapon.id === 'shotgun' ? 'shotgunShot' : 'rifleShot');
  }

  /**
   * Remote player positions for the client's own tracer raycast, taken from the
   * interpolated render state so tracers stop where the player sees the enemy.
   */
  private buildLocalHitscanTargets(state: MatchStateView, selfId: string): HitscanTarget[] {
    const targets: HitscanTarget[] = [];
    state.players.forEach((player, id) => {
      if (id === selfId || !player.alive) return;
      const interpolated = this.remotes.sample(id);
      const position = interpolated?.position ?? { x: player.x, y: player.y, z: player.z };
      targets.push({ id, position });
    });
    return targets;
  }

  // -------------------------------------------------------------------------
  // State synchronisation
  // -------------------------------------------------------------------------

  private syncFromServer(dtSeconds: number): void {
    const network = this.network;
    const local = this.localPlayer;
    const scene = this.scene;
    if (!network || !local || !scene) return;

    const state = network.state;
    if (!state) return;

    const selfId = network.sessionId;
    const serverTimeMs = state.serverTimeMs;

    // Feed remote history and reconcile the local player.
    const seen = new Set<string>();
    state.players.forEach((player, id) => {
      seen.add(id);
      if (id === selfId) {
        this.weapons.syncWeapon(player.weaponId);
        local.reconcile({
          position: { x: player.x, y: player.y, z: player.z },
          velocity: { x: player.vx, y: player.vy, z: player.vz },
          grounded: player.grounded,
          lastProcessedSeq: player.lastProcessedInputSeq,
          frozen: !player.alive,
        });
        return;
      }
      this.remotes.record(id, player, serverTimeMs);
    });

    // Remove avatars for players who have left; this is what prevents ghosts.
    for (const [id, avatar] of this.avatars) {
      if (seen.has(id)) continue;
      avatar.dispose();
      this.avatars.delete(id);
      this.remotes.remove(id);
    }

    local.updateSmoothing(dtSeconds);

    // Local avatar.
    const self = state.players.get(selfId);
    const localAvatar = this.ensureAvatar(selfId, true);
    const localPosition = local.renderPosition;
    localAvatar.update({
      position: localPosition,
      yaw: this.input?.yaw ?? 0,
      pitch: this.input?.pitch ?? 0,
      moving: Math.hypot(local.velocity.x, local.velocity.z) > 0.4,
      sprinting: self?.sprinting ?? false,
      aiming: self?.aiming ?? false,
      alive: self?.alive ?? true,
      dtSeconds,
    });

    // Remote avatars, rendered on the interpolation delay.
    state.players.forEach((_player, id) => {
      if (id === selfId) return;
      const transform = this.remotes.sample(id);
      if (!transform) return;
      const avatar = this.ensureAvatar(id, false);
      avatar.update({ ...transform, dtSeconds });
    });

    // The shadow frustum is fitted around the local player, so it has to be re-centred
    // before the camera renders.
    this.environment?.focus(localPosition);

    // Camera follows the smoothed local position.
    this.cameraRig?.update(
      {
        position: localPosition,
        yaw: this.input?.yaw ?? 0,
        pitch: this.input?.pitch ?? 0,
        aiming: self?.aiming ?? false,
      },
      dtSeconds,
    );
  }

  private ensureAvatar(playerId: string, isLocal: boolean): Avatar {
    const existing = this.avatars.get(playerId);
    if (existing) return existing;

    const avatar = new Avatar(this.scene!, playerId, {
      isLocal,
      environment: this.environment ?? undefined,
    });
    this.avatars.set(playerId, avatar);
    return avatar;
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  private updateHud(nowMs: number): void {
    const network = this.network;
    const state = network?.state;
    const local = this.localPlayer;
    if (!network || !state || !local || !this.scene || !this.cameraRig) return;

    const self = state.players.get(network.sessionId);
    const speed = Math.hypot(local.velocity.x, local.velocity.z);

    this.hud.setCrosshairGap(
      this.weapons.crosshairGap({
        aiming: self?.aiming ?? false,
        speed,
        grounded: local.grounded,
      }),
      false,
    );

    if (self) {
      this.hud.setVitals({ health: self.health, shield: self.shield, alive: self.alive });

      const weapon = isWeaponId(self.weaponId)
        ? getWeapon(self.weaponId)
        : getWeapon(DEFAULT_WEAPON_ID);
      const reloadProgress = self.reloading
        ? clamp(1 - (self.reloadEndsAtMs - state.serverTimeMs) / weapon.reloadDurationMs, 0, 1)
        : 0;

      this.hud.setWeapon({
        weaponId: isWeaponId(self.weaponId) ? self.weaponId : DEFAULT_WEAPON_ID,
        magazine: self.magazine,
        reserve: self.reserve,
        reloading: self.reloading,
        reloadProgress,
      });
    }

    const players: PlayerView[] = [];
    state.players.forEach((player) => players.push(player));
    const ranked = rankScoreboard(
      players.map((player) => ({
        id: player.id,
        displayName: player.displayName,
        kills: player.kills,
        deaths: player.deaths,
        damageDealt: player.damageDealt,
        ping: player.ping,
      })),
    );
    const placement = ranked.findIndex((entry) => entry.id === network.sessionId) + 1;

    const timeRemaining = Math.max(0, state.phaseEndsAtMs - state.serverTimeMs);
    this.hud.setMatch({
      phase: state.phase,
      timeRemainingMs: state.phase === 'WAITING' ? MATCH_DURATION_MS : timeRemaining,
      score: self?.kills ?? 0,
      placement,
      playerCount: players.length,
      scoreLimit: state.scoreLimit,
    });

    this.hud.setNetStats(network.roundTripMs, players.length);
    this.updateBanner(state, self, timeRemaining);

    if (this.scoreboard.isVisible) {
      this.scoreboard.update(players, { roomCode: state.roomCode, phase: state.phase });
    }

    this.hud.update({
      nowMs,
      scene: this.scene,
      camera: this.cameraRig.camera,
      viewportWidth: this.engine?.getRenderWidth() ?? window.innerWidth,
      viewportHeight: this.engine?.getRenderHeight() ?? window.innerHeight,
      playerYaw: this.input?.yaw ?? 0,
    });
  }

  private updateBanner(
    state: MatchStateView,
    self: PlayerView | undefined,
    timeRemainingMs: number,
  ): void {
    if (state.phase === 'WAITING') {
      this.hud.showBanner(
        'Waiting for players',
        `${state.players.size} of ${state.minPlayers} needed — room code ${state.roomCode}`,
        'info',
      );
      return;
    }

    if (state.phase === 'COUNTDOWN') {
      const seconds = Math.ceil(timeRemainingMs / 1000);
      this.hud.showBanner(String(Math.max(1, seconds)), 'Get ready', 'countdown');
      if (seconds !== this.lastCountdownSecond && seconds > 0) {
        this.lastCountdownSecond = seconds;
        this.audio.play('countdownTick');
      }
      return;
    }

    if (self && !self.alive && state.phase === 'PLAYING') {
      const respawnIn = Math.max(0, self.respawnAtMs - state.serverTimeMs);
      this.hud.showBanner(
        'Eliminated',
        `Respawning in ${Math.ceil(respawnIn / 1000)}…`,
        'eliminated',
      );
      return;
    }

    this.hud.hideBanner();
  }

  // -------------------------------------------------------------------------
  // Server events
  // -------------------------------------------------------------------------

  private handleRemoteShot(payload: ShotPayload): void {
    // The local player's own shots were already drawn immediately from the identical
    // deterministic spread, so replaying the broadcast would double them up.
    if (payload.shooterId === this.network?.sessionId) return;

    const hitPlayer = payload.impactNormals.map((normal) => normal === null);
    this.renderShot(payload.origin, payload.endPoints, payload.impactNormals, hitPlayer, false);

    const avatar = this.avatars.get(payload.shooterId);
    if (avatar) this.effects?.spawnMuzzleFlash(avatar.getMuzzleWorldPosition());

    // Distance attenuation so a firefight across the arena is not deafening.
    const listener = this.localPlayer?.renderPosition;
    if (listener) {
      const distance = Math.hypot(
        payload.origin.x - listener.x,
        payload.origin.y - listener.y,
        payload.origin.z - listener.z,
      );
      const intensity = clamp(1 - distance / 55, 0.05, 1);
      this.audio.play(payload.weaponId === 'shotgun' ? 'shotgunShot' : 'rifleShot', intensity);
    }
  }

  private renderShot(
    origin: Vec3,
    endPoints: readonly Vec3[],
    normals: readonly (Vec3 | null)[],
    hitPlayer: readonly boolean[],
    isLocal: boolean,
  ): void {
    const effects = this.effects;
    if (!effects) return;

    for (let i = 0; i < endPoints.length; i++) {
      const end = endPoints[i];
      effects.spawnTracer(origin, end);
      const normal = normals[i] ?? null;
      effects.spawnImpact(end, normal, hitPlayer[i] ? 'player' : 'world');
    }

    if (isLocal) {
      const avatar = this.avatars.get(this.network?.sessionId ?? '');
      if (avatar) effects.spawnMuzzleFlash(avatar.getMuzzleWorldPosition());
      else effects.spawnMuzzleFlash(new Vector3(origin.x, origin.y, origin.z));
    }
  }

  private handleHitConfirmed(payload: HitConfirmedPayload): void {
    this.hud.showHitMarker(payload.headshot);
    this.hud.showDamageNumber(payload.point, payload.damage, payload.headshot, performance.now());
    this.audio.play(payload.headshot ? 'headshotConfirm' : 'hitConfirm');
  }

  private handleDamaged(payload: DamagedPayload): void {
    const local = this.localPlayer?.renderPosition;
    if (local) {
      const yaw = Math.atan2(
        payload.attackerPosition.x - local.x,
        payload.attackerPosition.z - local.z,
      );
      this.hud.showDamageDirection(yaw, performance.now());
    }
    this.hud.flashDamage();
    this.cameraRig?.addShake(Math.min(0.16, payload.damage / 260));
    this.audio.play('takeDamage');
  }

  private handleKill(payload: KillPayload): void {
    this.hud.addKillFeedEntry(payload, performance.now());

    const sessionId = this.network?.sessionId;
    if (payload.attackerId === sessionId) {
      this.audio.play('elimination');
    } else if (payload.victimId === sessionId) {
      this.input?.clearHeldKeys();
    }
  }

  private handleRespawned(payload: RespawnedPayload): void {
    if (payload.playerId !== this.network?.sessionId) return;
    this.localPlayer?.teleport(payload.position);
    this.input?.setOrientation(payload.yaw, 0);
    this.weapons.reset();
    this.hud.hideBanner();
    this.audio.play('respawn');
  }

  private handleMatchStarted(): void {
    this.matchOverShown = false;
    this.results.hide();
    this.hud.resetTransient();
    this.audio.play('countdownGo');
    if (!this.pause.isVisible) this.input?.requestPointerLock();
  }

  private handleMatchEnded(payload: MatchEndedPayload): void {
    if (this.matchOverShown) return;
    this.matchOverShown = true;

    this.input?.releasePointerLock();
    this.scoreboard.setVisible(false);
    this.results.show(payload);

    const won = payload.winnerId !== null && payload.winnerId === this.network?.sessionId;
    this.audio.play(won ? 'matchWin' : 'matchLose');
  }

  /** Server-forced correction (respawn, teleport, anti-cheat). */
  private handleForcedReconcile(payload: ReconcilePayload): void {
    this.localPlayer?.reconcile({
      position: payload.position,
      velocity: payload.velocity,
      grounded: payload.grounded,
      lastProcessedSeq: payload.lastProcessedSeq,
      frozen: false,
    });
  }

  private handleNotice(payload: NoticePayload): void {
    if (payload.code === 'emptyMagazine') {
      this.audio.play('dryFire');
      return;
    }
    // Validation warnings are logged rather than shown: they are developer signals, and
    // surfacing every one would spam the player during ordinary packet loss.
    if (payload.level === 'warning') {
      console.warn('[server notice]', payload.code, payload.message);
      return;
    }
    this.notifications.show(payload.message, payload.level === 'error' ? 'error' : 'info');
  }

  private handleDisconnected(code: number): void {
    if (this.phase === 'menu') return;

    console.warn('[net] disconnected with code', code);
    const consented = code === 4000 || code === 1000;
    void this.returnToMenu(
      consented ? null : 'Connection to the server was lost. Returning to the menu.',
    );
  }

  // -------------------------------------------------------------------------
  // Player actions
  // -------------------------------------------------------------------------

  private handleReloadRequest(): void {
    if (this.phase !== 'playing') return;
    const self = this.network?.state?.players.get(this.network.sessionId);
    if (!self || !self.alive || self.reloading) return;

    const weapon = isWeaponId(self.weaponId)
      ? getWeapon(self.weaponId)
      : getWeapon(DEFAULT_WEAPON_ID);
    if (self.magazine >= weapon.magazineSize || self.reserve <= 0) return;

    this.network?.sendReload();
    this.audio.play('reloadStart');
  }

  private handleWeaponSwitch(slot: number): void {
    if (this.phase !== 'playing') return;
    const weaponId: WeaponId = slot === 2 ? 'shotgun' : 'rifle';
    this.network?.sendSwitchWeapon(weaponId);
  }

  private handlePointerLockChange(state: PointerLockState): void {
    if (state === 'denied') {
      this.notifications.show(
        'The browser blocked mouse capture. Click the game view to enable aiming.',
        'warning',
        5000,
      );
      return;
    }

    if (state === 'unlocked' && this.phase === 'playing' && !this.results.isVisible) {
      // Escape released the pointer: show the pause menu so the player is not stranded.
      if (!this.pause.isVisible) this.pause.show();
    }
  }

  private togglePauseMenu(): void {
    if (this.phase !== 'playing') return;
    if (this.pause.isVisible) this.closePauseMenu();
    else {
      this.pause.show();
      this.input?.releasePointerLock();
    }
  }

  private closePauseMenu(): void {
    this.pause.hide();
    if (this.phase === 'playing' && !this.results.isVisible) {
      this.input?.requestPointerLock();
    }
  }

  private togglePerfPanel(): void {
    const visible = this.perf.toggle();
    this.settings = { ...this.settings, showPerfPanel: visible };
    saveSettings(this.settings);
  }

  private applySettings(settings: UserSettings): void {
    this.settings = { ...this.settings, ...settings };
    saveSettings(this.settings);
    this.input?.setSensitivity(this.settings.mouseSensitivity);
    this.input?.setInvertY(this.settings.invertY);
    this.audio.setVolumes(this.settings.masterVolume, this.settings.effectsVolume);
    this.perf.setVisible(this.settings.showPerfPanel);
  }

  private handlePlayAgain(): void {
    // The server restarts the match on its own; the client just re-enters the arena.
    this.results.hide();
    this.matchOverShown = false;
    this.hud.resetTransient();
    this.input?.requestPointerLock();
  }

  private async handleReturnToMenu(): Promise<void> {
    await this.returnToMenu(null);
  }

  private async returnToMenu(message: string | null): Promise<void> {
    this.phase = 'menu';
    this.pause.hide();
    this.results.hide();
    this.scoreboard.setVisible(false);
    this.hud.hide();
    this.hud.resetTransient();
    this.input?.releasePointerLock();
    this.input?.clearHeldKeys();

    const network = this.network;
    this.network = null;
    if (network) await network.dispose();

    this.teardownMatchEntities();

    this.landing.setBusy(false);
    this.landing.show();
    this.landing.setStatus(
      message ?? 'Ready. Create a match or join with a room code.',
      message ? 'error' : 'idle',
    );
    if (message) this.notifications.show(message, 'error', 5000);
  }

  /** Disposes everything that belongs to a single match. */
  private teardownMatchEntities(): void {
    for (const avatar of this.avatars.values()) avatar.dispose();
    this.avatars.clear();
    this.remotes.clear();
    this.localPlayer = null;
    this.weapons.reset();
    this.accumulatorMs = 0;
    this.roomCode = '';
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  private updatePerfPanel(frameMs: number): void {
    if (!this.perf.isVisible) return;

    const stats = this.localPlayer?.stats;
    this.perf.update(frameMs, {
      pingMs: this.network?.roundTripMs ?? 0,
      players: this.network?.state?.players.size ?? 0,
      entities: this.avatars.size + this.remotes.trackedCount,
      activeEffects: this.effects?.activeCount ?? 0,
      pooledEffects: this.effects?.pooledCapacity ?? 0,
      serverTickHz: 1000 / SERVER_TICK_MS,
      pendingInputs: stats?.pendingCommands ?? 0,
      reconcileCorrections: stats?.corrections ?? 0,
      lastReconcileError: stats?.lastError ?? 0,
      drawCalls: this.scene?.getActiveMeshes().length ?? 0,
    });
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('beforeunload', this.onBeforeUnload);

    await this.network?.dispose();
    this.network = null;

    this.teardownMatchEntities();

    this.input?.dispose();
    this.audio.dispose();
    this.effects?.dispose();
    this.scenery?.dispose();
    this.environment?.dispose();
    this.cameraRig?.dispose();

    this.hud.dispose();
    this.scoreboard.dispose();
    this.results.dispose();
    this.pause.dispose();
    this.perf.dispose();
    this.landing.dispose();
    this.notifications.dispose();

    this.scene?.dispose();
    this.engine?.stopRenderLoop();
    this.engine?.dispose();
    this.scene = null;
    this.engine = null;
  }
}

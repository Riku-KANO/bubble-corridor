// アプリ本体（統合担当）。各担当の部品を契約どおりにつなぐ。
// 進行の時計は楽曲の再生時刻。ゴンドラの位置・演出・画面効果は、すべて時刻から計算する（ずれない、巻き戻せる）。
import * as THREE from 'three/webgpu';
import type { Cue, RideEvents, Vec3Tuple } from '../contracts/events';
import type { DoorChoice, Lang, SectionId, ShotId } from '../contracts/ids';
import { DEFAULT_DOOR, ROOM_OF_SECTION } from '../contracts/ids';
import type { RideClock } from '../contracts/clock';
import type { RidePose } from '../contracts/ride';
import type { RoomContext, RoomFrame, RoomModule } from '../contracts/room';
import type { PhotoRecord } from '../contracts/photo';
import type { Progress, Settings, UiCommands, UiState } from '../contracts/ui';
import {
  CAMERA,
  CELESTIAL_BLACKOUT_SEC,
  HIDDEN_BUBBLE_SECTIONS,
  PHOTO,
  RIDE_DURATION,
  SEC_PER_BAR,
  SECTIONS,
  TRANSITION_SEC,
} from '../config';
import { createBus } from '../core/events';
import { smoothstep } from '../core/easing';
import { DynamicResolution, detectTier, presetFor, type DeviceHints, type QualityPreset } from '../core/quality';
import { createAudioEngine } from '../audio';
import { createScreenFx } from '../fx';
import { createGondola } from '../gondola';
import { createLookControl, createTouchInput } from '../input';
import { capturePhoto, createPhotoStore, composePhoto, downloadPhoto, photoFileName, sharePhoto, stampText } from '../photo';
import { buildCueSheet, createCueDispatcher, createRide, createWallClock, generateRideData, streamingPlan } from '../ride';
import { ROOM_FACTORIES } from '../rooms';
import { loadProgress as readProgress, loadSettings, mountUi, saveProgress, saveSettings } from '../ui';
import { createXRSystem } from '../xr';
import { createDebugOverlay } from './debug';
import { INITIAL_FLOW, reduceFlow, type FlowAction, type FlowState } from './flow';
import { parseParams } from './params';
import { RoomManager } from './rooms';
import { loadRideData } from './ride-data';

const BOARD_START = 0.5; // 殻が閉じ始める乗車の秒（ゴンドラが浮かび上がった後）

export async function startApp(root: HTMLElement): Promise<void> {
  const params = parseParams(location.search);
  const isMobile = matchMedia('(pointer: coarse)').matches;

  // ── 設定と記録 ──
  let settings: Settings = loadSettings();
  const lang: Lang = params.lang ?? settings.lang;
  if (lang !== settings.lang) settings = { ...settings, lang };
  let progress: Progress = readProgress();

  // ── 描画 ──
  // VR で乗れる端末（ヘッドセットのブラウザ）では最初から WebGL2 の経路で描く（ADR-0001。VR は WebGL2 の経路）
  const xrCapable = await isImmersiveVrSupported();
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.webgl || xrCapable });
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.className = 'stage';
  root.append(canvas);

  const hints: DeviceHints = {
    isMobile,
    isXR: false,
    hardwareConcurrency: navigator.hardwareConcurrency,
    screenPixels: screen.width * screen.height * devicePixelRatio * devicePixelRatio,
  };
  const qualitySetting = params.quality ?? settings.quality;
  const quality: QualityPreset = presetFor(qualitySetting === 'auto' ? detectTier(hints) : qualitySetting, hints);
  const dynRes = new DynamicResolution(quality);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14181f);
  const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.05, 2000);
  const gondola = createGondola();
  scene.add(gondola.root);
  gondola.seat.add(camera);
  // 焼き込み前提で動く光源は持たない。仮の部屋のために弱い環境光だけ置く
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30302a, 1.2));

  const fx = createScreenFx(renderer);
  fx.setEnabled(quality.postFx && !params.nofx);

  // ── 進行 ──
  const bus = createBus<RideEvents>();
  const audio = createAudioEngine(bus);
  // ?t（途中から）や ?rate（早送り）の確認では音を使わない時計で進める
  const devClock = params.t !== null || params.rate !== 1;
  const clock: RideClock = devClock ? createWallClock({ rate: params.rate }) : audio.clock;
  const ride = createRide((await loadRideData()) ?? generateRideData());
  const cues = buildCueSheet();
  const dispatcher = createCueDispatcher(cues, bus);
  const membraneTimes = cues.filter((c) => c.name === 'membrane').map((c) => c.t);

  // ── 乗車ごとの状態 ──
  let door: DoorChoice | null = params.door;
  let doorDecided = false;
  let touches = 0;
  let constellations = 0;
  let hiddenThisRide: SectionId[] = [];
  let shots: { shot: ShotId; image: Blob }[] = [];
  let latestPhoto: PhotoRecord | null = null;
  let shelf: PhotoRecord[] = [];
  let hintShown = false;
  const photoStore = createPhotoStore();
  void photoStore.list().then((list) => {
    shelf = list;
    refreshUi();
  });

  // ── 部屋 ──
  const roomCtx: RoomContext = {
    ride,
    events: bus,
    quality,
    comfort: () => settings.comfort,
    reducedFlash: () => settings.reducedFlash,
    suggestedDoor: progress.lastDoor === null ? null : progress.lastDoor === 'amber' ? 'lapis' : 'amber',
    hiddenAlreadyFound: false,
  };
  const rooms = new RoomManager(ROOM_FACTORIES, roomCtx, scene);

  // ── 入力 ──
  const inputDeps = { element: canvas, events: bus, now: () => clock.time };
  const look = createLookControl(inputDeps, { mode: settings.lookMode, gyro: settings.gyro });
  const touch = createTouchInput(inputDeps);
  touch.setGazeDwell(settings.gazeDwellSec);
  touch.onIdleChime((t) => audio.chime({ id: t.id, kind: t.kind, section: t.section, position: worldPos(t.object) }));
  const xr = createXRSystem(renderer, { scene, camera, events: bus, now: () => clock.time });
  let xrSupported = false;
  void xr.isSupported().then((ok) => {
    xrSupported = ok;
    refreshUi();
  });

  // ── 画面の流れ ──
  let flow: FlowState = INITIAL_FLOW;
  const dispatch = (action: FlowAction) => {
    const prev = flow;
    flow = reduceFlow(flow, action, { seenGuide: progress.seenGuide });
    if (flow !== prev) onScreenChange(prev, flow);
    refreshUi();
  };

  const debug = params.debug ? createDebugOverlay(root, backend) : null;
  let xrFrames = 0;

  const commands: UiCommands = {
    enterHome() {
      void audio.unlock().then(() => audio.playLobby());
      audio.sfx('door.open');
      dispatch({ type: 'enterHome' });
    },
    ride(mode) {
      audio.sfx('ticket.punch');
      if (mode === 'vr') {
        audio.sfx('vr.fog');
        void xr.enter(settings.xrPosture).then(
          () => dispatch({ type: 'ride', mode }),
          (err) => console.error('[xr] VR を始められませんでした', err),
        );
        return;
      }
      dispatch({ type: 'ride', mode });
    },
    skipGuide: () => dispatch({ type: 'guideDone' }),
    pause: () => dispatch({ type: 'pause' }),
    resume: () => dispatch({ type: 'resume' }),
    alight: () => dispatch({ type: 'alight' }),
    rideAgain: () => dispatch({ type: 'rideAgain' }),
    toHome: () => dispatch({ type: 'toHome' }),
    open: (screen) => dispatch({ type: 'open', screen }),
    back: () => dispatch({ type: 'back' }),
    setSettings(patch) {
      settings = { ...settings, ...patch };
      saveSettings(settings);
      applySettings();
      refreshUi();
    },
    async requestGyro() {
      const D = globalThis.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
      if (!D?.requestPermission) return true;
      try {
        return (await D.requestPermission()) === 'granted';
      } catch {
        return false;
      }
    },
    async savePhoto(record, format) {
      const shot = record.shots.find((s) => s.shot === record.chosen) ?? record.shots[0];
      if (!shot) return;
      const blob = await composePhoto(shot.image, record.meta, format);
      downloadPhoto(blob, photoFileName(record.meta, shot.shot, format));
    },
    async sharePhoto(record, format) {
      const shot = record.shots.find((s) => s.shot === record.chosen) ?? record.shots[0];
      if (!shot) return;
      const blob = await composePhoto(shot.image, record.meta, format);
      const ok = await sharePhoto(blob, photoFileName(record.meta, shot.shot, format), stampText(record.meta, settings.lang));
      if (!ok) downloadPhoto(blob, photoFileName(record.meta, shot.shot, format));
    },
    choosePhoto(record, shot) {
      const next: PhotoRecord = { ...record, chosen: shot };
      if (latestPhoto?.id === record.id) latestPhoto = next;
      shelf = shelf.map((r) => (r.id === record.id ? next : r));
      void photoStore.put(next);
      refreshUi();
    },
    async deletePhoto(id) {
      await photoStore.remove(id);
      shelf = await photoStore.list();
      refreshUi();
    },
  };

  const ui = mountUi(root, commands);
  // e2e と snap が操作するための口（?debug のときだけ）
  debug?.expose({ commands, xr: () => xr.active, xrFrames: () => xrFrames, xrSupported: () => xrSupported, xrExit: () => () => xr.exit() });
  const uiState = (): UiState => ({
    screen: flow.screen,
    loadProgress,
    settings,
    progress,
    xrSupported,
    gyroNeedsPermission: typeof (globalThis.DeviceOrientationEvent as unknown as { requestPermission?: unknown })?.requestPermission === 'function',
    isMobile,
    record: lastRecord,
    latestPhoto,
    shelf,
  });
  let lastRecord: UiState['record'] = null;
  let loadProgress = 0;
  function refreshUi() {
    ui.render(uiState());
  }

  function applySettings() {
    camera.fov = settings.fov;
    camera.updateProjectionMatrix();
    look.setOptions({ mode: settings.lookMode, gyro: settings.gyro });
    touch.setGazeDwell(settings.gazeDwellSec);
    audio.setVolumes(settings.volumes);
    xr.setVignette(settings.vignette);
    document.documentElement.style.setProperty('--text-scale', String(settings.textScale));
    document.documentElement.lang = settings.lang;
  }
  applySettings();

  // ── 遷移の副作用 ──
  function onScreenChange(prev: FlowState, next: FlowState) {
    if (next.screen === 'riding' && (prev.screen === 'guide' || prev.screen === 'home' || prev.screen === 'photo')) beginRide();
    if (next.screen === 'guide') {
      // 案内は6秒で自動的に進む。クリックで飛ばせる。2回目以降は出さない
      progress = { ...progress, seenGuide: true };
      saveProgress(progress);
      window.setTimeout(() => dispatch({ type: 'guideDone' }), 6000);
    }
    if (next.screen === 'pause' && prev.screen === 'riding') {
      clock.pause();
      bus.emit('pause', {});
      audio.sfx('pause');
    }
    if (next.screen === 'riding' && prev.screen === 'pause') {
      clock.resume();
      bus.emit('resume', {});
      audio.sfx('resume');
    }
    if (next.screen === 'home' && (prev.screen === 'pause' || prev.screen === 'photo')) {
      clock.pause();
      clock.seek(0);
      audio.playLobby();
      if (xr.active) void xr.exit();
    }
    look.setEnabled(next.screen === 'riding');
    touch.setEnabled(next.screen === 'riding');
  }

  function beginRide() {
    door = params.door;
    doorDecided = false;
    touches = 0;
    constellations = 0;
    hiddenThisRide = [];
    shots = [];
    hintShown = false;
    audio.stopLobby();
    audio.setDoor(door ?? DEFAULT_DOOR);
    const t0 = params.t ?? 0;
    dispatcher.reset(t0);
    rooms.forEachReady((m) => m.setDoor?.(door ?? DEFAULT_DOOR));
    clock.start(t0);
    look.recenter();
  }

  async function endRide() {
    const finalDoor = door ?? DEFAULT_DOOR;
    const hiddenAll = [...new Set([...progress.hiddenFound, ...hiddenThisRide])];
    const rideNo = progress.rideCount + 1;
    const date = localDate();
    progress = { ...progress, rideCount: rideNo, hiddenFound: hiddenAll, lastDoor: finalDoor };
    saveProgress(progress);
    lastRecord = { rideNo, date, touches, door: finalDoor, constellations, hiddenFound: hiddenThisRide };
    bus.emit('rideEnd', lastRecord);
    dispatch({ type: 'rideEnd' });
    if (shots.length > 0) {
      const record: PhotoRecord = {
        id: `ride-${rideNo}-${Date.now()}`,
        createdAt: Date.now(),
        meta: { rideNo, date, door: finalDoor, hiddenTotal: hiddenAll.length, constellations, lang: settings.lang },
        shots,
        chosen: shots.some((s) => s.shot === 'constellation') ? 'constellation' : shots[0].shot,
      };
      latestPhoto = record;
      await photoStore.put(record);
      shelf = await photoStore.list();
      refreshUi();
    }
  }

  // ── 出来事 ──
  bus.on('cue', (cue) => {
    rooms.onCue(cue);
    onCue(cue);
  });
  bus.on('touch', (e) => {
    touches++;
    audio.touch({ id: e.touchableId, kind: e.kind, section: e.section, position: e.position });
  });
  bus.on('doorChosen', (e) => {
    if (doorDecided) return;
    door = e.door;
    audio.setDoor(e.door);
    rooms.forEachReady((m) => m.setDoor?.(e.door));
  });
  bus.on('hiddenFound', (e) => {
    if (hiddenThisRide.includes(e.section)) return;
    hiddenThisRide.push(e.section);
    // 見つけた泡は次の乗車でも残る（降車を待たずに保存する）
    if (!progress.hiddenFound.includes(e.section)) {
      progress = { ...progress, hiddenFound: [...progress.hiddenFound, e.section].filter((s) => HIDDEN_BUBBLE_SECTIONS.includes(s)) };
      saveProgress(progress);
    }
  });
  bus.on('constellationLinked', () => {
    constellations++;
  });

  function onCue(cue: Cue) {
    switch (cue.name) {
      case 'hint.touch':
        if (!hintShown && flow.viewMode === 'screen') {
          hintShown = true;
          ui.showRideHint();
        }
        break;
      case 'lure': {
        const room = rooms.get(ROOM_OF_SECTION[cue.section]);
        const focus = cue.data?.target ? room?.focusPoint(cue.data.target) : null;
        if (!focus) break;
        audio.lure(focus);
        // PC とスマートフォンでは、正面から大きく外れているときだけやさしく正面へ戻す。VR ではしない
        if (flow.viewMode === 'screen' && settings.autoRecenter) {
          const deviation = Math.hypot(look.look.yaw, look.look.pitch);
          if (deviation > THREE.MathUtils.degToRad(CAMERA.recenterThresholdDeg)) look.recenter(undefined, CAMERA.recenterSec);
        }
        break;
      }
      case 'branch.decide':
        if (door === null) {
          door = DEFAULT_DOOR;
          bus.emit('doorChosen', { door, by: 'default' });
        }
        doorDecided = true;
        break;
      case 'photo.capture':
        if (cue.data?.shot) void takeShot(cue.data.shot);
        break;
      case 'ride.end':
        void endRide();
        break;
      default:
        break;
    }
  }

  async function takeShot(shot: ShotId) {
    try {
      const size = isMobile ? PHOTO.captureMobile : PHOTO.captureDesktop;
      const image = await capturePhoto(renderer, scene, camera, size);
      shots.push({ shot, image });
      bus.emit('photoCaptured', { shot });
    } catch (err) {
      console.error('[photo] 撮影に失敗', err);
    }
  }

  // ── 読み込み（待ち列の灯り） ──
  const initialRooms = ['lobby', 'platform', 'greenhouse'] as const;
  let readyCount = 0;
  for (const id of initialRooms) {
    void rooms.ensure(id).then(() => {
      readyCount++;
      loadProgress = readyCount / initialRooms.length;
      if (readyCount === initialRooms.length) dispatch({ type: 'loaded' });
      refreshUi();
    });
  }
  rooms.sync({ visible: ['lobby', 'platform'], keep: [...initialRooms] });

  // 確認用: ?t や ?screen で途中から始める
  if (params.t !== null || params.screen) {
    await Promise.all(initialRooms.map((id) => rooms.ensure(id)));
    dispatch({ type: 'loaded' });
    dispatch({ type: 'enterHome' });
    if (params.t !== null) {
      progress = { ...progress, seenGuide: true };
      dispatch({ type: 'ride', mode: 'screen' });
    }
  }

  // ── 毎フレーム ──
  const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
  const camWorld = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  const camEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  let lastNow = performance.now();
  let lastT = 0;
  let currentAtmosphere: RoomModule['atmosphere'] | null = null;

  function onResize() {
    const w = innerWidth;
    const h = innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio, quality.maxPixelRatio) * dynRes.scale);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fx.setSize(w, h, renderer.getPixelRatio());
  }
  addEventListener('resize', onResize);
  onResize();

  renderer.setAnimationLoop(() => {
    const nowMs = performance.now();
    const frameMs = nowMs - lastNow;
    lastNow = nowMs;
    const riding = flow.screen === 'riding' || flow.screen === 'pause';
    const t = riding ? clock.time : 0;
    const dt = riding ? Math.max(0, t - lastT) : 0;
    lastT = t;

    ride.poseAt(t, settings.comfort, pose);
    gondola.root.position.set(pose.x, pose.y, pose.z);
    gondola.root.rotation.set(0, pose.yaw, 0);
    // 殻: 乗車の頭で下から上へ閉じ、降車で上から下へ開く
    const departT0 = sectionStart('departure');
    const shell = riding ? smoothstep(BOARD_START, BOARD_START + TRANSITION_SEC.boarding, t) * (1 - smoothstep(departT0, departT0 + TRANSITION_SEC.boarding, t)) : 0;
    gondola.setShell(shell);
    gondola.update(nowMs / 1000, frameMs / 1000);

    if (!xr.active) {
      look.update(frameMs / 1000);
      camera.rotation.set(look.look.pitch, look.look.yaw, 0, 'YXZ');
    } else {
      xr.update(t, dt, pose);
    }

    if (riding) {
      dispatcher.update(t);
      if (t >= RIDE_DURATION && flow.screen === 'riding' && !cues.some((c) => c.name === 'ride.end')) void endRide();
    }

    // 部屋の先読みと表示
    if (riding) rooms.sync(streamingPlan(t, ride));
    if (rooms.consumeTouchChange()) {
      touch.setTouchables(rooms.touchables());
      xr.setTouchables(rooms.touchables());
    }
    const frame: RoomFrame = { t, dt, pose, camera, comfort: settings.comfort, reducedFlash: settings.reducedFlash };
    rooms.update(frame);
    if (riding && !xr.active) touch.update(t, dt, camera, [pose.x, pose.y, pose.z]);

    // 部屋の空気（膜を通る瞬間に切り替える。部屋が時刻で差し替えたときも反映する）
    const roomId = riding ? ROOM_OF_SECTION[pose.section] : 'lobby';
    const atmosphere = rooms.get(roomId)?.atmosphere ?? null;
    if (atmosphere && atmosphere !== currentAtmosphere) {
      {
        currentAtmosphere = atmosphere;
        const a = atmosphere;
        scene.background = new THREE.Color(a.background);
        scene.fog = a.fog ? new THREE.Fog(a.fog.color, a.fog.near, a.fog.far) : null;
        renderer.toneMappingExposure = a.exposure;
        scene.environment = a.environment ?? null;
      }
    }

    // 画面効果（すべて時刻から決める）
    fx.state.bubble = shell;
    fx.state.membrane = membraneAt(t);
    fx.state.brightness = riding ? blackoutBrightness(t) : 1;
    fx.state.kaleidoscope = riding ? kaleidoscopeAmount(t) : 0;
    if (settings.comfort === 'standard' && riding) fx.state.kaleidoscopeAngle += dt * 0.15;

    // 音の聞き手
    camera.getWorldPosition(camWorld);
    camera.getWorldQuaternion(camQuat);
    camEuler.setFromQuaternion(camQuat, 'YXZ');
    audio.setListener({ x: camWorld.x, y: camWorld.y, z: camWorld.z, yaw: camEuler.y, pitch: camEuler.x });

    if (xr.active) {
      xrFrames++;
      renderer.render(scene, camera);
    }
    else fx.render(scene, camera);

    // 動的な解像度
    const prevScale = dynRes.scale;
    if (dynRes.sample(frameMs) !== prevScale) onResize();
    debug?.update({ frameMs, t, section: pose.section, info: renderer.info, screen: flow.screen, scale: dynRes.scale });
  });

  // ポーズ: Esc、雫、画面の長押し
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (flow.screen === 'riding') commands.pause();
      else if (flow.screen === 'pause') commands.resume();
    }
  });
  addEventListener('pointermove', () => {
    if (flow.screen === 'riding') ui.flashPauseDrop();
  });
  xr.onSessionEnd(() => dispatch({ type: 'xrEnded' }));

  refreshUi();

  function membraneAt(t: number): number {
    const half = TRANSITION_SEC.membrane / 2;
    let m = 0;
    for (const tm of membraneTimes) {
      const d = Math.abs(t - tm);
      if (d < half) m = Math.max(m, 1 - d / half);
    }
    return m;
  }

  function blackoutBrightness(t: number): number {
    const t0 = sectionStart('celestial');
    if (t < t0 || t > t0 + 30) return 1;
    // 唯一の暗闇。光の点滅を抑えるモードでは点灯をゆっくりにする
    const ramp = settings.reducedFlash ? 6 : 2.5;
    return smoothstep(t0 + CELESTIAL_BLACKOUT_SEC, t0 + CELESTIAL_BLACKOUT_SEC + ramp, t);
  }

  function kaleidoscopeAmount(t: number): number {
    const t0 = sectionStart('kaleidoscope');
    const t1 = sectionStart('celestial');
    return smoothstep(t0, t0 + 6, t) * (1 - smoothstep(t1 - 8, t1, t));
  }

}

async function isImmersiveVrSupported(): Promise<boolean> {
  try {
    return (await navigator.xr?.isSessionSupported('immersive-vr')) ?? false;
  } catch {
    return false;
  }
}

function sectionStart(id: SectionId): number {
  const s = SECTIONS.find((x) => x.id === id);
  return s ? s.startBar * SEC_PER_BAR : 0;
}

function worldPos(o: THREE.Object3D): Vec3Tuple {
  const v = o.getWorldPosition(new THREE.Vector3());
  return [v.x, v.y, v.z];
}

function localDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

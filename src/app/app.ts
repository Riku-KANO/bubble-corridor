// アプリ本体（統合担当）。各担当の部品を契約どおりにつなぐ。
// 進行の時計は楽曲の再生時刻。ゴンドラの位置・演出・画面効果は、すべて時刻から計算する（ずれない、巻き戻せる）。
import * as THREE from 'three/webgpu';
import type { Cue, RideEvents, Vec3Tuple } from '../contracts/events';
import type { DoorChoice, Lang, SectionId, ShotId } from '../contracts/ids';
import { DEFAULT_DOOR, ROOM_OF_SECTION } from '../contracts/ids';
import type { ListenerPose } from '../contracts/audio';
import type { RideClock } from '../contracts/clock';
import type { RidePose } from '../contracts/ride';
import type { RoomContext, RoomFrame, RoomModule } from '../contracts/room';
import type { PhotoRecord } from '../contracts/photo';
import type { Progress, QualitySetting, Settings, UiCommands, UiState } from '../contracts/ui';
import { CAMERA, HIDDEN_BUBBLE_SECTIONS, PHOTO, RIDE_DURATION, TRANSITION_SEC, UI } from '../config';
import { createBus } from '../core/events';
import { easeGlass, lerp } from '../core/easing';
import { setDefaultGlassTier, setGlassFlashScale, setGlassLighting } from '../core/materials/glass';
import { DynamicResolution, detectTier, presetFor, type TierPreset } from '../core/quality-tier';
import { createAudioEngine } from '../audio';
import { createScreenFx, REDUCED_FLASH_SCALE } from '../fx';
import { createGondola } from '../gondola';
import { createLookControl, createTouchInput } from '../input';
import { capturePhoto, captureToPrepare, createPhotoStore, composePhoto, downloadPhoto, photoFileName, prepareCapture, sharePhoto, stampText, warmUpCapture } from '../photo';
import { buildCueSheet, createCueDispatcher, createRide, createWallClock, generateRideData } from '../ride';
import { ROOM_FACTORIES } from '../rooms';
import { loadProgress as readProgress, loadSettings, mountUi, saveProgress, saveSettings } from '../ui';
import { createXRSystem } from '../xr';
import { createAssetLoader } from './assets';
import { createDebugOverlay, type DebugSample } from './debug';
import { deviceHints } from './device';
import { INITIAL_FLOW, reduceFlow, type FlowAction, type FlowState } from './flow';
import { glassLightingFor } from './glass-lighting';
import { createIdleChimer } from './idle-chime';
import { parseParams } from './params';
import { createRiseSounder } from './rise-sound';
import { HOME_PLAN, atmosphereRoomFor, homePlanFor, planFor, sceneTimeFor, type RoomPlan } from './room-plan';
import { RoomManager } from './rooms';
import { loadRideData } from './ride-data';
import { BOARD_START_SEC, fxAt, type FxTimeline, type FxTimelineOptions } from './timeline';
import { createXRDarkness } from './xr-darkness';

/** 書き換えて使い回す入れ物（毎フレームの確保を避ける）の型 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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

  // 起動時の手がかり。一体型のヘッドセット（Quest・Pico）は最初から VR 向けの低めの品質にする（PC に VR 機器をつないだだけでは変えない）
  const hints = deviceHints({
    userAgent: navigator.userAgent,
    coarsePointer: isMobile,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    screenPixels: screen.width * screen.height * devicePixelRatio * devicePixelRatio,
    xrCapable,
  });
  // 品質は設定で変わる（即時に反映する）。?quality があればそれを優先する
  const wantedQuality = (): QualitySetting => params.quality ?? settings.quality;
  const presetOf = (setting: QualitySetting): TierPreset => presetFor(setting === 'auto' ? detectTier(hints) : setting, hints);
  let appliedQuality = wantedQuality();
  let quality: TierPreset = presetOf(appliedQuality);
  // 画面（2D のウィンドウ）の動的な解像度は、画面の目標の fps で動かす。一体型のヘッドセットの preset は VR の 72fps だが、
  // 2D のブラウザが 60Hz だと届かずに倍率が最小まで下がり続ける（VR の間は動的な解像度を止める）
  const screenDynRes = (q: TierPreset): DynamicResolution =>
    new DynamicResolution(hints.isXR ? { ...q, targetFps: presetFor(q.tier, { ...hints, isXR: false }).targetFps } : q);
  let dynRes = screenDynRes(quality);
  // ガラスの既定の品質は、最初の材質（ゴンドラの殻）を作る前に決める
  setDefaultGlassTier(quality.tier);

  const scene = new THREE.Scene();
  // 背景色と霧の物は 1 つずつ作って使い回し、空気が変わるときは値だけ書き換える。霧の物を作り直すと、three は霧のノードも作り直し、
  // 見えている材質すべてのシェーダーを作り直す（40 個ほどで WebGPU 約 220ms、WebGL2・VR で約 1.7 秒。温室の暗さの 12 段が引っかかっていた）
  const backgroundColor = new THREE.Color(0x14181f);
  const sceneFog = new THREE.Fog(0xffffff, 1, 1000);
  scene.background = backgroundColor;
  const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.05, 2000);
  const gondola = createGondola();
  scene.add(gondola.root);
  gondola.seat.add(camera);
  // 焼き込み前提で動く光源は持たない。仮の部屋のために弱い環境光だけ置く
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30302a, 1.2));

  // ブルームは解像度を落として計算する（スマートフォンは更に小さく）。光の点滅を抑えるモードは設定から毎フレーム読む
  const fx = createScreenFx(renderer, { reducedFlash: () => settings.reducedFlash, bloomResolution: isMobile ? 0.25 : 0.5 });

  // ── 進行 ──
  const bus = createBus<RideEvents>();
  const audio = createAudioEngine(bus);
  // ?t（途中から）や ?rate（早送り）の確認では音を使わない時計で進める
  const devClock = params.t !== null || params.rate !== 1;
  const clock: RideClock = devClock ? createWallClock({ rate: params.rate }) : audio.clock;
  const ride = createRide((await loadRideData()) ?? generateRideData());
  const cues = buildCueSheet();
  const dispatcher = createCueDispatcher(cues, bus);

  // ── 乗車ごとの状態 ──
  let door: DoorChoice | null = params.door;
  let doorDecided = false;
  let touches = 0;
  let constellations = 0;
  let hiddenThisRide: SectionId[] = [];
  let shots: { shot: ShotId; image: Blob }[] = [];
  /** 下ごしらえを始めた撮影のキュー（乗車ごとに空にする） */
  const preparedShots = new Set<string>();
  let latestPhoto: PhotoRecord | null = null;
  let shelf: PhotoRecord[] = [];
  let hintShown = false;
  /** 殻が閉じる音を鳴らしたか。時刻（BOARD_START_SEC）を越えたときに一度だけ。?t で越えた後から始めたら鳴らさない */
  let shellCloseSounded = true;
  /** 水面からゴンドラが浮かぶ音。乗るたびに一度、案内の頭（案内の画面が現れてから）か乗車の頭（いつ鳴らすかは rise-sound.ts） */
  const riseSound = createRiseSounder(() => audio.sfx('gondola.rise'), TRANSITION_SEC.homeToGuide);
  /** 前のフレームの乗車の秒（dt を出す）。新しい乗車の最初のフレームで、?t の位置まで飛んだ長さを dt にしないよう beginRide で合わせる */
  let lastT = 0;
  const photoStore = createPhotoStore();
  void photoStore.list().then((list) => {
    shelf = list;
    refreshUi();
  });

  // ── 部屋 ──
  // quality は設定で変わるので書き換えられる型にしておく。作り直さず差し替えるだけなので、読み込み済みの部屋は前の品質のまま、
  // 次に読み込む部屋から新しい品質が効く（部屋は load の時点で品質を読む）
  const roomCtx: Mutable<RoomContext> = {
    ride,
    assets: createAssetLoader(),
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
  const look = createLookControl(inputDeps, { mode: settings.lookMode, gyro: settings.gyro, fovDeg: settings.fov });
  const touch = createTouchInput(inputDeps);
  touch.setGazeDwell(settings.gazeDwellSec);
  // 自分で鳴る合図（INT-4）は画面でも VR でも同じ物差しなので、入力の側ではなくここで持つ（touch.onIdleChime は使わない）
  const chimer = createIdleChimer((t) => audio.chime({ id: t.id, kind: t.kind, section: t.section, position: worldPos(t.object) }));
  const xr = createXRSystem(renderer, { scene, camera, events: bus, now: () => clock.time });
  // 画面効果を使うか: 品質が許し、VR でないとき。VR は renderer.render で直接描く（速さを優先、カメラを演出で動かさない）
  const applyFxEnabled = () => fx.setEnabled(!xr.active && quality.postFx && !params.nofx);
  applyFxEnabled();
  // VR は後処理を使わないので、天球の暗転（入りも点灯も）は頭に付けた黒い球で出す。VR でないときは描かない（明るさ 1）
  const darkness = createXRDarkness();
  camera.add(darkness.object);
  // 画面 → VR の白い霧。乗車の時計の外の遷移なので壁時計で進める（満ちるのは TRANSITION_SEC.screenToVR）
  const fog = { from: 0, to: 0, startMs: 0 };
  // 満ちる曲線もガラスの曲線（動きの曲線は作品で1つ。ADR-0011）
  const fogAt = (nowMs: number): number => lerp(fog.from, fog.to, easeGlass((nowMs - fog.startMs) / (TRANSITION_SEC.screenToVR * 1000)));
  const fogTo = (to: number, instant = false) => {
    const nowMs = performance.now();
    fog.from = instant ? to : fogAt(nowMs);
    fog.to = to;
    fog.startMs = nowMs;
  };
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
      // 入口から直接始めた確認用の経路（?screen=home&t=）では、ここがユーザー操作の最初。音の有効化がまだなら、この操作の中で行う
      if (!audio.unlocked) void audio.unlock();
      audio.sfx('ticket.punch');
      if (mode === 'vr') {
        audio.sfx('vr.fog');
        // ブラウザの規則で、VR のセッションはこの操作の中で要求する。画面の霧は同時に始めてよい（満ちる間に VR の準備が進む）
        fogTo(1);
        void xr.enter(settings.xrPosture).then(
          () => {
            applyFxEnabled(); // VR の間は後処理を使わない（VR の中の霧は xr が引き継ぐ）
            // 始まった直後にセッションが終わっていたら（すぐにヘッドセットを外した）、乗車へ進まず霧を晴らす
            if (xr.active) {
              fogTo(0, true);
              dispatch({ type: 'ride', mode });
            } else fogTo(0);
          },
          (err) => {
            console.error('[xr] VR を始められませんでした', err);
            fogTo(0);
          },
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
  debug?.expose({
    commands,
    xr: () => xr.active,
    xrFrames: () => xrFrames,
    xrSupported: () => xrSupported,
    xrExit: () => () => xr.exit(),
    /** この乗車で撮った写真の枚数 */
    photos: () => shots.length,
  });
  const uiState = (): UiState => ({
    screen: flow.screen,
    viewMode: flow.viewMode,
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
    look.setOptions({ mode: settings.lookMode, gyro: settings.gyro, fovDeg: settings.fov });
    touch.setGazeDwell(settings.gazeDwellSec);
    xr.setGazeDwell(settings.gazeDwellSec);
    audio.setVolumes(settings.volumes);
    xr.setVignette(settings.vignette);
    document.documentElement.style.setProperty('--text-scale', String(settings.textScale));
    document.documentElement.lang = settings.lang;
    // ガラスの材質: 品質と、点滅を抑えるモードでの波紋の閃光の弱め（fx の縞とブルームと同じ倍率）。tier は材質を作るときに読まれるので、
    // 変えたときは次に作る材質（次に読み込む部屋）から効く
    setGlassFlashScale(settings.reducedFlash ? REDUCED_FLASH_SCALE : 1);
    // 品質の即時反映: 目標・画素比・後処理の有無・動的な解像度を作り直す（アンチエイリアスは描画器の作成時に決まるので次の起動から）
    const wanted = wantedQuality();
    if (wanted !== appliedQuality) {
      appliedQuality = wanted;
      quality = presetOf(wanted);
      roomCtx.quality = quality;
      dynRes = screenDynRes(quality);
      applyFxEnabled();
      onResize();
    }
    setDefaultGlassTier(quality.tier);
  }
  applySettings();

  // ── 遷移の副作用 ──
  let guideTimer = 0;
  function onScreenChange(prev: FlowState, next: FlowState) {
    if (next.screen === 'riding' && (prev.screen === 'guide' || prev.screen === 'home' || prev.screen === 'photo')) beginRide();
    // 案内を出ている間だけ自動進行の見張りを持つ（飛ばしたら止める）
    if (prev.screen === 'guide' && next.screen !== 'guide') window.clearTimeout(guideTimer);
    if (next.screen === 'guide') {
      riseSound.guideStarted(next.viewMode);
      // 案内は UI.preRideGuideSec 秒で自動的に進む。クリックで飛ばせる。2回目以降は出さない
      progress = { ...progress, seenGuide: true };
      saveProgress(progress);
      window.clearTimeout(guideTimer);
      guideTimer = window.setTimeout(() => dispatch({ type: 'guideDone' }), UI.preRideGuideSec * 1000);
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
    preparedShots.clear();
    debug?.clearCaptures();
    hintShown = false;
    chimer.reset();
    audio.stopLobby();
    audio.setDoor(door ?? DEFAULT_DOOR);
    const t0 = params.t ?? 0;
    riseSound.rideStarted(t0);
    // 殻が閉じる音は時刻から一度だけ。?t で閉じ始めの後から始めたときに、過ぎた分を鳴らさない
    shellCloseSounded = t0 > BOARD_START_SEC;
    lastT = t0;
    dispatcher.reset(t0);
    rooms.setDoor(door ?? DEFAULT_DOOR);
    clock.start(t0);
    // 乗車の頭は即座に正面へ（前の乗車の向きを引きずらない）
    look.recenter(undefined, 0);
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
    chimer.touched(e.touchableId);
    audio.touch({ id: e.touchableId, kind: e.kind, section: e.section, position: e.position });
  });
  bus.on('doorChosen', (e) => {
    if (doorDecided) return;
    door = e.door;
    audio.setDoor(e.door);
    rooms.setDoor(e.door);
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
      case 'departure.open':
        // 配信は時刻順に一度だけで、?t で過ぎた分は流れない（過去の分を鳴らさない）
        audio.sfx('gondola.open');
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

  /** 撮影の大きさ（画面ごとに決まる） */
  const captureSize = () => (isMobile ? PHOTO.captureMobile : PHOTO.captureDesktop);
  /** 撮影のキューの部屋が読み込み済みで見えているか（毎フレームの確保を避けるため、関数は 1 つだけ作る） */
  const shotRoomReady = (c: Cue) => rooms.isReady(ROOM_OF_SECTION[c.section]);

  /** 撮影の少し前に、撮影の描画に要るシェーダーを先に作る（撮影の最中に画面が止まらないように。capture.ts） */
  function prepareShots(t: number) {
    const cue = captureToPrepare(cues, t, preparedShots, shotRoomReady);
    if (!cue) return;
    preparedShots.add(cue.id);
    // 撮影の部屋の下は、いま隠れている物（見どころで現れる物）も準備する
    const room = rooms.get(ROOM_OF_SECTION[cue.section]);
    void prepareCapture(renderer, scene, camera, captureSize(), { rooms: room ? [room.root] : [] });
  }

  /** 直近のフレームで描いた場面の乗車の秒（撮影が描いた場面の確認用。?debug の captures に足す） */
  let frameT = 0;
  const noteCapture = () => debug?.recordCapture(frameT);

  async function takeShot(shot: ShotId) {
    try {
      const size = captureSize();
      const image = await capturePhoto(renderer, scene, camera, size, { onRender: noteCapture });
      shots.push({ shot, image });
      bus.emit('photoCaptured', { shot });
    } catch (err) {
      console.error('[photo] 撮影に失敗', err);
    }
  }

  // ── 読み込み（待ち列の灯り） ──
  // 乗車の外の部屋の計画（画面ごと。乗車の中は時刻から）。?screen=home&t= で入口に止まる確認用は、乗る時刻の部屋も持っておく
  const stopAtHome = params.screen === 'home' && params.t !== null;
  const homePlan = homePlanFor(stopAtHome ? params.t : null, ride);
  const planOf = (screen: FlowState['screen'], t: number): RoomPlan => {
    const plan = planFor(screen, t, ride);
    return plan === HOME_PLAN ? homePlan : plan;
  };
  // 起動時に読み込む部屋 = 入口の計画の部屋
  const initialRooms = HOME_PLAN.keep;
  let readyCount = 0;
  let captureWarmed = false;
  for (const id of initialRooms) {
    void rooms.ensure(id).then(() => {
      readyCount++;
      loadProgress = readyCount / initialRooms.length;
      if (readyCount === initialRooms.length) {
        dispatch({ type: 'loaded' });
        // 読み込みが終わった直後（待ち列 → 入口の頃）に、初回の撮影が重いぶんを先に済ませる。乗車中の撮影で画面が詰まらないように
        if (!captureWarmed) {
          captureWarmed = true;
          void warmUpCapture(renderer, scene, camera);
        }
      }
      refreshUi();
    });
  }
  rooms.sync(homePlan);

  // 確認用: ?t や ?screen で途中から始める。?screen=home と ?t が両方あれば入口で止まり、
  // 「乗る」「VRで乗る」で ?t の時刻から乗る（Quest 3 で天球から VR を確かめるため）
  if (params.t !== null || params.screen) {
    // 入口で止まる間に、乗る時刻の部屋も読み込んでおく（乗った直後に空の景色を見せない。homePlan がその部屋も持つ）
    await Promise.all(homePlan.keep.map((id) => rooms.ensure(id)));
    dispatch({ type: 'loaded' });
    dispatch({ type: 'enterHome' });
    if (params.t !== null) {
      progress = { ...progress, seenGuide: true }; // 途中から乗るので案内は出さない
      if (!stopAtHome) dispatch({ type: 'ride', mode: 'screen' });
    }
  }

  // ── 毎フレーム ──
  const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
  const camWorld = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  const camEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  // 毎フレーム渡す入れ物（書き換えて使い回す。音と部屋は受け取った場でだけ読む）
  const listenerPose: Mutable<ListenerPose> = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  const roomFrame: Mutable<RoomFrame> = { t: 0, dt: 0, pose, camera, comfort: settings.comfort, reducedFlash: settings.reducedFlash };
  const debugSample: Mutable<DebugSample> = { frameMs: 0, frameAt: 0, t: 0, section: '', info: renderer.info, screen: '', scale: 1 };
  /** キューシートに乗車の終わりがあれば、降車は cue が行う。なければ時刻が尽きたときに終える（起動時に一度だけ調べる） */
  const hasRideEndCue = cues.some((c) => c.name === 'ride.end');
  let lastNow = performance.now();
  const gondolaPos: [number, number, number] = [0, 0, 0];
  const fxOptions: Mutable<FxTimelineOptions> = { comfort: 'standard', reducedFlash: false, riding: false };
  const fxTimeline: FxTimeline = { bubble: 0, membrane: 0, brightness: 1, kaleidoscope: 0, kaleidoscopeAngle: 0, bloom: 0 };
  let currentAtmosphere: RoomModule['atmosphere'] | null = null;

  function onResize() {
    // VR の描画は描画器の大きさに依らない。VR の間は触らず、終わったときに合わせ直す
    if (xr.active) return;
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
    const rideT = riding ? clock.time : 0;
    const dt = riding ? Math.max(0, rideT - lastT) : 0;
    lastT = rideT;
    // 場面の時刻: ゴンドラの位置・部屋・画面効果を決める。乗車の外でも、降車の後（ライドフォト）は降車の時刻のまま
    // （0 にすると、降車の瞬間にゴンドラが乗り場の向きへ回る。VR では世界が回る）。待ち列・入口などは乗車の頭
    const t = sceneTimeFor(flow.screen, rideT);
    frameT = t;

    ride.poseAt(t, settings.comfort, pose);
    gondola.root.position.set(pose.x, pose.y, pose.z);
    gondola.root.rotation.set(0, pose.yaw, 0);
    gondolaPos[0] = pose.x;
    gondolaPos[1] = pose.y;
    gondolaPos[2] = pose.z;

    // 殻と画面効果はすべて乗車の時刻から決める（乗車の頭で殻が下から上へ閉じ、降車で上から下へ開く）
    fxOptions.comfort = settings.comfort;
    fxOptions.reducedFlash = settings.reducedFlash;
    fxOptions.riding = riding;
    fxAt(t, cues, fxOptions, fxTimeline);
    gondola.setShell(fxTimeline.bubble);
    gondola.update(nowMs / 1000, frameMs / 1000);
    if (riding && !shellCloseSounded && t >= BOARD_START_SEC) {
      shellCloseSounded = true;
      audio.sfx('gondola.close');
    }

    if (!xr.active) {
      look.update(frameMs / 1000);
      camera.rotation.set(look.look.pitch, look.look.yaw, 0, 'YXZ');
    } else {
      xr.update(t, dt, pose);
    }

    if (riding) {
      dispatcher.update(t);
      if (t >= RIDE_DURATION && flow.screen === 'riding' && !hasRideEndCue) void endRide();
    }

    // 部屋の先読みと表示（乗車の外でも画面に応じて渡す。同じ計画は参照で見分けて何もしない）
    rooms.sync(planOf(flow.screen, t));
    if (rooms.consumeTouchChange()) {
      touch.setTouchables(rooms.touchables());
      xr.setTouchables(rooms.touchables());
    }
    roomFrame.t = t;
    roomFrame.dt = dt;
    roomFrame.comfort = settings.comfort;
    roomFrame.reducedFlash = settings.reducedFlash;
    rooms.update(roomFrame);
    if (riding && !xr.active) touch.update(t, dt, camera, gondolaPos);

    // 部屋の空気（膜を通る瞬間に切り替える。部屋が時刻で差し替えたときも反映する）。ゴンドラのいる部屋の空気 = 今の区間の部屋。
    // 乗車の外は入口の部屋、ライドフォトは降車の乗り場。ガラスの擬似照明（縁の反射の色・ハイライト）も、空気が変わったときだけ部屋に合わせる
    const roomId = atmosphereRoomFor(flow.screen, pose.section);
    const atmosphere = rooms.get(roomId)?.atmosphere ?? null;
    if (atmosphere && atmosphere !== currentAtmosphere) {
      currentAtmosphere = atmosphere;
      backgroundColor.set(atmosphere.background);
      if (atmosphere.fog) {
        sceneFog.color.set(atmosphere.fog.color);
        sceneFog.near = atmosphere.fog.near;
        sceneFog.far = atmosphere.fog.far;
        scene.fog = sceneFog;
      } else {
        scene.fog = null;
      }
      renderer.toneMappingExposure = atmosphere.exposure;
      scene.environment = atmosphere.environment ?? null;
      setGlassLighting(glassLightingFor(atmosphere));
    }

    // 画面効果（乗車の時刻から決めた値をそのまま渡す。白い霧だけは乗車の外の遷移なので壁時計）
    const state = fx.state;
    state.bubble = fxTimeline.bubble;
    state.membrane = fxTimeline.membrane;
    state.brightness = fxTimeline.brightness;
    state.kaleidoscope = fxTimeline.kaleidoscope;
    state.kaleidoscopeAngle = fxTimeline.kaleidoscopeAngle;
    state.bloom = fxTimeline.bloom;
    state.whiteFog = fogAt(nowMs);
    // VR の暗転: VR の間だけ、時刻から決めた明るさを頭の球に渡す（VR でないときは画面効果が暗くする）
    darkness.set(xr.active ? fxTimeline.brightness : 1);

    // 音の聞き手
    camera.getWorldPosition(camWorld);
    camera.getWorldQuaternion(camQuat);
    camEuler.setFromQuaternion(camQuat, 'YXZ');
    listenerPose.x = camWorld.x;
    listenerPose.y = camWorld.y;
    listenerPose.z = camWorld.z;
    listenerPose.yaw = camEuler.y;
    listenerPose.pitch = camEuler.x;
    audio.setListener(listenerPose);

    if (xr.active) {
      xrFrames++;
      renderer.render(scene, camera);
    }
    else fx.render(scene, camera);

    // 触れられないまま近づいた物が一度だけ自分で鳴る（画面でも VR でも）。描画の後に調べる: 表示し始めたばかりの部屋の物は、
    // 描画で初めて位置（matrixWorld）が決まる（その前は原点にいる）ので、描画の前に読むと原点の近くにいる乗り場で誤って鳴る
    if (riding) chimer.update(gondolaPos, rooms.touchables());
    // 撮影の下ごしらえ: 部屋を見せ終えた（描いた）後に始める。始めた時点で見えている物のシェーダーを先に作る
    if (riding) prepareShots(t);

    // 動的な解像度（VR の描画は描画器の大きさに依らないので調整しない）
    if (!xr.active) {
      const prevScale = dynRes.scale;
      if (dynRes.sample(frameMs) !== prevScale) onResize();
    }
    if (debug) {
      debugSample.frameMs = frameMs;
      debugSample.frameAt = nowMs;
      debugSample.t = t;
      debugSample.section = pose.section;
      debugSample.screen = flow.screen;
      debugSample.scale = dynRes.scale;
      debug.update(debugSample);
    }
  });

  // ポーズ: Esc、雫、画面の長押し
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (flow.screen === 'riding') commands.pause();
      else if (flow.screen === 'pause') commands.resume();
    }
  });
  // 雫（ポーズ）はマウスを動かしたときだけ。タッチのドラッグ（見回し）では出さない
  addEventListener('pointermove', (e) => {
    if (flow.screen === 'riding' && e.pointerType === 'mouse') ui.flashPauseDrop();
  });
  xr.onSessionEnd(() => {
    // VR が終わった: 画面の品質に戻す（後処理・画素比）。霧は残さない
    fogTo(0, true);
    applyFxEnabled();
    onResize();
    dispatch({ type: 'xrEnded' });
  });

  refreshUi();
}

async function isImmersiveVrSupported(): Promise<boolean> {
  try {
    return (await navigator.xr?.isSessionSupported('immersive-vr')) ?? false;
  } catch {
    return false;
  }
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

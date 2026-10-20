// 音楽と音（楽曲の構成データ、演奏、触れた音、環境音、効果音）。
//
// 楽曲は構成データ（score.json）から、その場でガラスの音とシンセサイザーで演奏する。
// 進行の時計は AudioContext の時刻から進め（clock.ts）、25ms ごとに約0.2秒先までの予定（conductor）を
// 予約して鳴らす。描画が重くなっても、予約した音は音のスレッドが鳴らすので遅れない。
//
// ポーズは「門」（graph.ts）で乗車中の音を止める。AudioContext 自体は止めない
// （ポーズの項目を触る音が鳴るため）。再開は止めた位置から、鳴っていた持続音も含めてやり直す。
import type { AudioEngine, ListenerPose, SfxId, Volumes } from '../contracts/audio';
import type { Cue, EventBus, Vec3Tuple } from '../contracts/events';
import type { DoorChoice, SectionId, TouchKind } from '../contracts/ids';
import { DEFAULT_DOOR } from '../contracts/ids';
import { RIDE_DURATION, SEC_PER_BEAT } from '../config';
import { setListenerPose } from '../core/sound/space';
import type { ReverbSize } from '../core/sound/space';
import { playGlass, playPad } from '../core/sound/voices';
import { createBed } from './ambient';
import type { BedNode } from './ambient';
import { createAudioClock } from './clock';
import type { AudioClock } from './clock';
import { LOBBY_SECONDS, planLobby, planNotes } from './conductor';
import type { PlannedNote } from './conductor';
import { cueEffect, lureEffect, playEvents, SFX } from './effects';
import { createGraph } from './graph';
import type { Graph } from './graph';
import { isPad, performNotes, SpatialPool, VoiceSet } from './performer';
import type { AmbientBed } from './score';
import { ambientKeys, ambientLevelAt, harmonyAt, lobbyHarmonyAt, sectionScore } from './score';
import { createTouchGate, planHiddenChord, planTouch } from './touch';
import type { TouchNote } from './touch';

export interface AudioEngineOptions {
  /** テストや確認ページで AudioContext を差し替える */
  readonly context?: AudioContext;
  /** 先読みの長さ（秒）。既定 0.2 */
  readonly lookahead?: number;
  /** 楽曲の音の同時発音の目安（これを超えたら小さなきらめきから見送る）。既定 72 */
  readonly maxVoices?: number;
}

/** 先読みを進める間隔（ミリ秒） */
const TICK_MS = 25;
const LOOKAHEAD = 0.2;
/** タブが隠れて setInterval が間引かれても音が切れないよう、そのときは長く先読みする */
const LOOKAHEAD_HIDDEN = 1.4;
/** シークや再開のとき、鳴っていたはずの持続音を探す範囲（秒）。長い和音（4小節）より長く */
const CATCH_UP_SEC = 16;
/** 環境音の折れ線を先まで予約する長さ（秒） */
const AMBIENT_AHEAD = 20;
const BEDS: readonly AmbientBed[] = ['water', 'air', 'rain', 'prism', 'space', 'waves'];
/** この長さ以上待ち続けて AudioContext が走らなければ、あきらめて操作での再開に任せる（ミリ秒） */
const RESUME_WAIT_MS = 1500;

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

interface BedEntry {
  readonly node: BedNode;
  /** ここまでの折れ線は予約済み（乗車の秒） */
  scheduledUntil: number;
}

export function createAudioEngine(bus: EventBus, opts: AudioEngineOptions = {}): AudioEngine {
  let ctx: AudioContext | null = opts.context ?? null;
  let graph: Graph | null = null;
  let door: DoorChoice = DEFAULT_DOOR;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let volumes: Volumes = { master: 0.85, music: 0.85, sfx: 0.9, ambient: 0.8 };
  let pose: ListenerPose | null = null;
  const maxVoices = opts.maxVoices ?? 72;

  // ── 時計 ──
  // AudioContext が走っている間はその時刻で進める。走っていない間（音を有効にする前、ブラウザに止められた間）は
  // 実時間で進め、音が使えなくても乗車は進む。切り替わるときは位置が飛ばないよう差を引き継ぐ。
  let offset = 0;
  let usingCtx = false;
  let lastNow = 0;
  let started = false;
  const timeSource = {
    get currentTime(): number {
      const useCtx = ctx !== null && ctx.state === 'running';
      const raw = useCtx ? ctx!.currentTime : performance.now() / 1000;
      if (!started) {
        started = true;
        usingCtx = useCtx;
      } else if (useCtx !== usingCtx) {
        usingCtx = useCtx;
        offset = lastNow - raw;
      }
      lastNow = raw + offset;
      return lastNow;
    },
  };
  const clock: AudioClock = createAudioClock(timeSource, { contextNow: () => (ctx ? ctx.currentTime : 0) });

  // ── 鳴っている音 ──
  const voices = new VoiceSet();
  const spatial = new SpatialPool();
  const gate = createTouchGate();
  const beds = new Map<AmbientBed, BedEntry>();
  const sfxBuses = new Map<ReverbSize, GainNode>();
  let lastJumps = clock.jumps;
  let lastRunning = false;
  let needsRestart = true;
  let cursor = 0;
  let lastAmbientCheck = -1;

  // ── 入口の音楽 ──
  let lobbyWanted = false;
  let lobby: { anchor: number; cursor: number; gate: GainNode; voices: VoiceSet } | null = null;

  const lookahead = () => (opts.lookahead ?? (typeof document !== 'undefined' && document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD));
  /** AudioContext が音を出している（状態は変わるので、そのつど読み直す） */
  const running = (): boolean => ctx !== null && ctx.state === 'running';
  const ready = (): boolean => ctx !== null && graph !== null && ctx.state === 'running' && !disposed;

  /** 効果音の出口（乾いた音は効果音の門へ、響きは区間の広さの残響へ少し送る）。広さごとに1つ */
  function sfxBus(size: ReverbSize): GainNode {
    let b = sfxBuses.get(size);
    if (!b) {
      b = ctx!.createGain();
      b.connect(graph!.sfxGate);
      const send = ctx!.createGain();
      send.gain.value = 0.5;
      b.connect(send).connect(graph!.reverbs[size].send);
      sfxBuses.set(size, b);
    }
    return b;
  }

  function reverbOf(section: SectionId): ReverbSize {
    return sectionScore(section, door).reverb;
  }

  /** 位置があれば立体音響の出口、なければ中央の出口 */
  function outlet(position: Vec3Tuple | undefined, section: SectionId, until: number): AudioNode {
    const size = reverbOf(section);
    if (!position) return sfxBus(size);
    return spatial.create(ctx!, position, graph!.sfxGate, graph!.reverbs[size].send, 0.5, until);
  }

  // ── AudioContext の用意 ──
  function build(): void {
    if (ctx === null) {
      const Ctor = audioContextCtor();
      if (!Ctor) return;
      ctx = new Ctor({ latencyHint: 'interactive' });
    }
    if (graph) return;
    graph = createGraph(ctx);
    graph.mixer.setVolumes(volumes, 0.001);
    // 区間ごとの演奏の予定を先に作っておく（途中で作ると、その区間の頭で描画が止まる）
    planNotes(0, RIDE_DURATION, 'amber');
    planNotes(0, RIDE_DURATION, 'lapis');
    if (pose) setListenerPose(ctx.listener, pose);
    timer = setInterval(tick, TICK_MS);
    ctx.addEventListener('statechange', () => {
      if (ctx && ctx.state !== 'running') needsRestart = true;
    });
  }

  /** 操作（クリック・キー・タッチ）の中で止まっている AudioContext を動かす。ブラウザの自動再生の規則 */
  function resumeOnGesture(): void {
    if (typeof document === 'undefined') return;
    const events = ['pointerdown', 'keydown', 'touchend'] as const;
    const handler = () => {
      if (!ctx || ctx.state === 'running') {
        for (const e of events) document.removeEventListener(e, handler, true);
        return;
      }
      void ctx.resume().then(() => {
        if (ctx && ctx.state === 'running') {
          for (const e of events) document.removeEventListener(e, handler, true);
          afterUnlocked();
        }
      });
    };
    for (const e of events) document.addEventListener(e, handler, true);
  }

  function afterUnlocked(): void {
    if (lobbyWanted && !lobby) startLobby();
  }

  // ── 先読み ──
  function tick(): void {
    if (!ctx || !graph || disposed) return;
    const now = ctx.currentTime;
    spatial.sweep(now);
    if (lobby) lobbyTick(now);
    if (ctx.state !== 'running') {
      needsRestart = true;
      return;
    }
    const playing = clock.running;
    if (!playing) {
      if (lastRunning) pauseRide(now);
      lastRunning = false;
      return;
    }
    if (!lastRunning || needsRestart || clock.jumps !== lastJumps) {
      lastRunning = true;
      lastJumps = clock.jumps;
      needsRestart = false;
      restart(now);
    }
    const t = clock.time;
    if (t - cursor > 1) restart(now); // 1 秒以上遅れた（長い停止）。聞こえなかった所は飛ばして今から
    const horizon = Math.min(RIDE_DURATION, t + lookahead());
    if (horizon > cursor) {
      perform(planNotes(cursor, horizon, door), now);
      cursor = horizon;
    }
    voices.prune(now);
    ambientTick(now, t);
  }

  function perform(notes: readonly PlannedNote[], now: number): void {
    if (notes.length === 0) return;
    performNotes(ctx!, notes, (n) => graph!.reverbs[reverbOf(n.section)].input, (t) => clock.toContextTime(t), voices, maxVoices, now + 0.005);
  }

  /** ポーズ: 乗車中の音を滑らかに止める（鳴っていた音は再開のときに作り直す） */
  function pauseRide(now: number): void {
    graph!.setGates(false, now, 0.025);
    voices.releaseAll(now + 0.12);
    for (const [, e] of beds) {
      e.node.gain.gain.cancelScheduledValues(now);
    }
  }

  /** 開始・シーク・再開: 今の位置から演奏をやり直す。鳴っているはずの持続音も、途中から入れる */
  function restart(now: number): void {
    voices.releaseAll(now + 0.03);
    const t = clock.time;
    cursor = t;
    graph!.setGates(true, now, 0.03);
    // 区間をまたいで鳴り続けているはずの持続音（和音）を、残りの長さで入れ直す
    const caught: PlannedNote[] = [];
    for (const n of planNotes(Math.max(0, t - CATCH_UP_SEC), t, door)) {
      const remain = n.t + n.duration - t;
      if (remain < 0.5) continue;
      if (!(isPad(n.timbre) || (n.timbre === 'harp' && n.layer === 'drone'))) continue;
      caught.push({ ...n, t, duration: remain });
    }
    perform(caught, now);
    for (const [bed, e] of beds) resetBed(bed, e, t, now);
    lastAmbientCheck = -1;
  }

  // ── 環境音 ──
  function resetBed(bed: AmbientBed, e: BedEntry, t: number, now: number): void {
    const g = e.node.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(ambientLevelAt(ambientKeys(door)[bed], t), now);
    e.scheduledUntil = t;
  }

  function ambientTick(now: number, t: number): void {
    const all = ambientKeys(door);
    // 床の出し入れの判断は 0.5 秒に1回で足りる
    const check = t - lastAmbientCheck > 0.5 || t < lastAmbientCheck;
    if (check) lastAmbientCheck = t;
    for (const bed of BEDS) {
      const keys = all[bed];
      let entry = beds.get(bed);
      if (check) {
        const wanted = keys.some((k) => k.t >= t - 0.5 && k.t <= t + AMBIENT_AHEAD + 5 && k.v > 0) || ambientLevelAt(keys, t) > 0;
        if (wanted && !entry) {
          entry = { node: createBed(ctx!, bed, graph!.ambientGate), scheduledUntil: t };
          beds.set(bed, entry);
          resetBed(bed, entry, t, now);
        } else if (!wanted && entry) {
          entry.node.stop();
          beds.delete(bed);
          entry = undefined;
        }
      }
      if (!entry) continue;
      const until = t + AMBIENT_AHEAD;
      for (const k of keys) {
        if (k.t <= entry.scheduledUntil || k.t > until) continue;
        entry.node.gain.gain.linearRampToValueAtTime(k.v, Math.max(now, clock.toContextTime(k.t)));
        entry.scheduledUntil = k.t;
      }
    }
  }

  // ── 入口の音楽 ──
  function startLobby(): void {
    if (!ready() || lobby) return;
    const now = ctx!.currentTime;
    const g = ctx!.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + 2.5);
    g.connect(graph!.reverbs.large.input);
    lobby = { anchor: now + 0.15, cursor: 0, gate: g, voices: new VoiceSet() };
  }

  function lobbyTick(now: number): void {
    if (!lobby || !ready()) return;
    const horizon = now - lobby.anchor + lookahead();
    if (horizon <= lobby.cursor) return;
    const notes = planLobby(lobby.cursor, horizon);
    if (notes.length > 0) {
      const l = lobby;
      performNotes(ctx!, notes, () => l.gate, (t) => l.anchor + t, l.voices, 32, now + 0.005);
    }
    lobby.cursor = horizon;
    lobby.voices.prune(now);
  }

  // ── 触れた音 ──
  type TouchEvent = { readonly id: string; readonly kind: TouchKind; readonly section: SectionId; readonly position: Vec3Tuple };

  /** 触れた音の予定を立てる。乗車中は乗車の時刻、乗車の外（入口の音楽の上）は音楽の時刻で。鳴らせなければ null */
  function playTouch(e: TouchEvent, soft: boolean): number | null {
    if (!ready()) return null;
    const c = ctx!;
    let notes: TouchNote[];
    let toCtx: (t: number) => number;
    if (clock.running) {
      const now = clock.time;
      toCtx = (t) => clock.toContextTime(t);
      notes = e.kind === 'hidden-bubble' && !soft ? planHiddenChord(e.section, now, door) : [planTouch(e, now, door)];
    } else if (lobby && !soft) {
      const now = (((c.currentTime - lobby.anchor) % LOBBY_SECONDS) + LOBBY_SECONDS) % LOBBY_SECONDS;
      toCtx = (t) => c.currentTime + (t - now);
      notes = e.kind === 'hidden-bubble' ? planHiddenChord(e.section, now, door, lobbyHarmonyAt) : [planTouch(e, now, door, lobbyHarmonyAt)];
    } else {
      return null;
    }
    const first = notes[0];
    const when = toCtx(first.at);
    const longest = Math.max(...notes.map((n) => n.duration));
    if (!gate.tryAcquire(soft ? `${e.id}#chime` : e.id, when, longest)) return null;
    const out = outlet(e.position, e.section, when + longest + 2);
    const scale = soft ? 0.4 : 1;
    for (const n of notes) playGlass(c, out, n.timbre, { midi: n.midi, when: toCtx(n.at), velocity: n.velocity * scale, duration: n.duration });
    if (!soft && e.kind === 'shard' && e.section === 'kaleidoscope') {
      // 万華鏡のガラス片: 模様の繰り返しに合わせて、1拍ごとにこだまする
      for (let k = 1; k <= 2; k++) playGlass(c, out, 'bottle', { midi: first.midi, when: when + k * SEC_PER_BEAT, velocity: first.velocity * (k === 1 ? 0.5 : 0.28) });
    }
    if (!soft && e.kind === 'hidden-bubble') {
      // 見つけたことが分かるよう、和音の下にやわらかい持続音を敷く
      const root = Math.min(...notes.map((n) => n.midi)) - 12;
      playPad(c, out, 'air', { midis: [root, root + 7], when, duration: 2.4, velocity: 0.5 });
    }
    return first.at;
  }

  // ── 出来事 ──
  const offCue = bus.on('cue', onCue);
  function onCue(cue: Cue): void {
    if (!ready()) return;
    const evs = cueEffect(cue, harmonyAt(cue.t + 0.01, door));
    if (!evs) return;
    const c = ctx!;
    let when = c.currentTime + 0.01;
    if (clock.running) {
      // 時計に合わせる。かなり遅れて届いた出来事（フレームの停止など）は鳴らさない
      if (clock.time - cue.t > 1.5) return;
      when = Math.max(when, clock.toContextTime(cue.t));
    }
    playEvents(c, sfxBus('large'), evs, when);
  }

  return {
    clock,
    get unlocked() {
      return running();
    },
    async unlock() {
      if (disposed) return;
      build();
      if (!ctx) return; // AudioContext のない環境（テスト・古いブラウザ）。乗車は実時間の時計で進む
      if (!running()) {
        // ユーザー操作の中なら、ここですぐ動く。そうでなければ待たずに、次の操作で動かす
        await Promise.race([ctx.resume().catch(() => undefined), new Promise<void>((r) => setTimeout(r, RESUME_WAIT_MS))]);
        if (!running()) resumeOnGesture();
      }
      if (running()) afterUnlocked();
    },
    setDoor(d) {
      door = d;
    },
    touch(e) {
      return playTouch(e, false);
    },
    chime(e) {
      void playTouch(e, true);
    },
    lure(position) {
      if (!ready() || !clock.running) return;
      const c = ctx!;
      const evs = lureEffect(harmonyAt(clock.time, door));
      const section = harmonyAt(clock.time, door).section;
      const out = outlet(position, section, c.currentTime + 4);
      playEvents(c, out, evs, c.currentTime + 0.02);
    },
    sfx(id: SfxId, position?: Vec3Tuple) {
      if (!ready()) return;
      const c = ctx!;
      const evs = SFX[id];
      let out: AudioNode = graph!.ui;
      if (position) out = spatial.create(c, position, graph!.ui, null, 0, c.currentTime + 6);
      playEvents(c, out, evs, c.currentTime + 0.01);
    },
    setListener(p) {
      pose = p;
      if (ctx && graph) setListenerPose(ctx.listener, p);
    },
    setVolumes(v) {
      volumes = v;
      graph?.mixer.setVolumes(v);
    },
    playLobby() {
      lobbyWanted = true;
      if (ready() && !lobby) startLobby();
    },
    stopLobby() {
      lobbyWanted = false;
      if (!lobby || !ctx) return;
      const now = ctx.currentTime;
      lobby.gate.gain.cancelScheduledValues(now);
      lobby.gate.gain.setTargetAtTime(0, now, 0.35);
      lobby.voices.releaseAll(now + 1.8);
      const g = lobby.gate;
      lobby = null;
      setTimeout(() => g.disconnect(), 3000);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      offCue();
      if (timer !== null) clearInterval(timer);
      voices.releaseAll(0);
      spatial.dispose();
      for (const [, e] of beds) e.node.stop();
      beds.clear();
      if (ctx && !opts.context) void ctx.close().catch(() => undefined);
    },
  };
}

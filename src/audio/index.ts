// 音楽と音（楽曲の構成データ、演奏、触れた音、環境音、効果音）。
//
// 楽曲は構成データ（score.json）から、その場でガラスの音とシンセサイザーで演奏する。
// 進行の時計は、耳に届いている音の位置（heard.ts。出力の遅延を引いた、滑らかで単調な時刻）から進め、
// 25ms ごとに先読み（既定 0.8 秒）の分の予定（conductor）と、見どころ・膜の効果音（cues）を予約して鳴らす。
// 描画が重くなってメインスレッドが止まっても、予約した音は音のスレッドが鳴らすので遅れない。
//
// ポーズは「門」（graph.ts）で乗車中の音を止める。AudioContext 自体は止めない
// （ポーズの項目を触る音が鳴るため）。再開は止めた位置から、鳴っていた持続音も含めてやり直す。
import type { AudioEngine, ListenerPose, SfxId, Volumes } from '../contracts/audio';
import type { Cue, EventBus, Vec3Tuple } from '../contracts/events';
import type { DoorChoice, SectionId, TouchKind } from '../contracts/ids';
import { DEFAULT_DOOR, SECTION_IDS } from '../contracts/ids';
import { BPM, INTERACTION, RIDE_DURATION, SECTIONS, SEC_PER_BAR, SEC_PER_BEAT, TOUCH_GRID_BEATS } from '../config';
import { nextGridTime } from '../core/sound/grid';
import { setListenerPose } from '../core/sound/space';
import type { ReverbSize } from '../core/sound/space';
import { playGlass, playPad, prepareVoices } from '../core/sound/voices';
import { createBed, sharedNoise } from './ambient';
import type { BedNode } from './ambient';
import { createAudioClock } from './clock';
import type { AudioClock } from './clock';
import { LOBBY_SECONDS, planLobby, planNotes } from './conductor';
import type { PlannedNote } from './conductor';
import { audioCues, inQuietMoment, isAudioCue, QUIET_MAX_VOICES } from './cues';
import { cueEffect, lureEffect, playEvents, SFX } from './effects';
import { createGraph, holdParam } from './graph';
import type { Graph } from './graph';
import { createHeardTime } from './heard';
import { isPad, performNotes, SpatialPool, VoiceSet } from './performer';
import type { AmbientBed } from './score';
import { ambientKeys, ambientLevelAt, harmonyAt, lobbyHarmonyAt, sectionScore } from './score';
import type { AmbientKey } from './score';
import { createTouchGate, planHiddenChord, planTouch } from './touch';
import type { TouchNote } from './touch';

export interface AudioEngineOptions {
  /** テストや確認ページで AudioContext を差し替える */
  readonly context?: AudioContext;
  /** 先読みの長さ（秒）。既定 0.8。出力の遅延（Bluetooth で 0.2 秒を超える）と、メインスレッドの停止に耐える長さ */
  readonly lookahead?: number;
  /**
   * 楽曲の同時発音の予算（鳴っているオシレーターなど音源の数）。超えたら、きらめきから、さらに超えたら小さな分散和音・
   * リズムも見送る。スマートフォン・VR では下げる。既定は端末から決める（スマートフォン 80、4コア以下 110、それ以外 150）
   */
  readonly maxSources?: number;
}

/** 先読みを進める間隔（ミリ秒） */
const TICK_MS = 25;
const LOOKAHEAD = 0.8;
/** タブが隠れて setInterval が1秒ごとに間引かれても音が切れないよう、そのときは長く先読みする */
const LOOKAHEAD_HIDDEN = 2.0;
/** 効果音の前ぶれ（dt が負の風切りなど）が始まるぶん、出来事は先読みよりこれだけ先まで予約する */
const CUE_PREROLL = 0.6;
/** シークや再開のとき、鳴っていたはずの持続音を探す範囲（秒）。長い和音（4小節）より長く */
const CATCH_UP_SEC = 16;
/** 環境音の折れ線を先まで予約する長さ（秒） */
const AMBIENT_AHEAD = 20;
/** ポーズがこれより長く続いたら、環境音の床を止める（秒） */
const BED_IDLE_SEC = 3;
const BEDS: readonly AmbientBed[] = ['water', 'air', 'rain', 'prism', 'space', 'waves'];
/** この長さ以上待ち続けて AudioContext が走らなければ、あきらめて操作での再開に任せる（ミリ秒） */
const RESUME_WAIT_MS = 1500;
/** 乗る人の触れた音のために、このぶんの枠は触れた音の上限から空けておき、自分で鳴る小さな音（chime）には使わせない */
const CHIME_RESERVE = 2;
/** 自分で鳴る小さな音（chime）が同時に使える数 */
const CHIME_VOICES = 3;

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function defaultMaxSources(): number {
  if (typeof navigator === 'undefined') return 150;
  if (/Android|iPhone|iPad|Mobile|Quest/i.test(navigator.userAgent)) return 80;
  return (navigator.hardwareConcurrency || 4) <= 4 ? 110 : 150;
}

interface BedEntry {
  readonly node: BedNode;
  /** ここまでの折れ線は予約済み（乗車の秒） */
  scheduledUntil: number;
}

/** 予約済みの効果音を、ポーズ・シークで止められるようにまとめる入れ物 */
interface CueVoice {
  readonly gain: GainNode;
  readonly until: number;
}

/** 折れ線に、from〜to の間で正の強さの点があるか */
function hasPositive(keys: readonly AmbientKey[], from: number, to: number): boolean {
  for (let i = 0; i < keys.length; i++) if (keys[i].t >= from && keys[i].t <= to && keys[i].v > 0) return true;
  return false;
}

const KALEIDOSCOPE_START = (SECTIONS.find((s) => s.id === 'kaleidoscope')?.startBar ?? 0) * SEC_PER_BAR;

/** 確認ページ用: エンジンの内側で、出来事の効果音をいますぐ鳴らす（乗車中は先読みが鳴らすので、bus の cue は無視される） */
const auditions = new WeakMap<AudioEngine, (cue: Cue) => void>();
export function auditionCue(engine: AudioEngine, cue: Cue): void {
  auditions.get(engine)?.(cue);
}

export function createAudioEngine(bus: EventBus, opts: AudioEngineOptions = {}): AudioEngine {
  let ctx: AudioContext | null = opts.context ?? null;
  let graph: Graph | null = null;
  let door: DoorChoice = DEFAULT_DOOR;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let volumes: Volumes = { master: 0.85, music: 0.85, sfx: 0.9, ambient: 0.8 };
  let pose: ListenerPose | null = null;
  const maxSources = opts.maxSources ?? defaultMaxSources();
  const onState = () => {
    if (ctx && ctx.state !== 'running') needsRestart = true;
  };

  // ── 時計 ──
  // 耳に届いている位置（出力の遅延を引いた、滑らかで単調な時刻）から進める。AudioContext が走っていない間
  // （音を有効にする前、ブラウザに止められた間）は実時間で進め、音が使えなくても乗車は進む。
  const heard = createHeardTime({ perfNow: () => performance.now(), context: () => ctx });
  const clock: AudioClock = createAudioClock(heard.source, { contextNow: () => heard.contextNow() });

  // ── 鳴っている音 ──
  const voices = new VoiceSet();
  const spatial = new SpatialPool();
  const gate = createTouchGate();
  /** 自分で鳴る小さな音（chime）の枠。乗る人の触れた音の枠（gate）とは別に数える */
  const chimeGate = createTouchGate({ maxVoices: CHIME_VOICES });
  const beds = new Map<AmbientBed, BedEntry>();
  const sfxBuses = new Map<ReverbSize, GainNode>();
  const cueVoices: CueVoice[] = [];
  const scratch: PlannedNote[] = [];
  /** 区間 → 残響の広さ（扉で万華鏡だけ変わる）。ノートごとに引き直さない */
  const reverbBySection = {} as Record<SectionId, ReverbSize>;
  let lastJumps = clock.jumps;
  let lastRunning = false;
  let needsRestart = true;
  let cursor = 0;
  let cueCursor = 0;
  let lastAmbientCheck = -1;
  let pausedAt = 0;

  // ── 入口の音楽 ──
  let lobbyWanted = false;
  let lobby: { anchor: number; cursor: number; gate: GainNode; voices: VoiceSet } | null = null;

  const lookahead = (): number => opts.lookahead ?? (typeof document !== 'undefined' && document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD);
  /** AudioContext が音を出している（状態は変わるので、そのつど読み直す） */
  const running = (): boolean => ctx !== null && ctx.state === 'running';
  const ready = (): boolean => ctx !== null && graph !== null && ctx.state === 'running' && !disposed;

  function refreshReverbs(): void {
    for (const id of SECTION_IDS) reverbBySection[id] = sectionScore(id, door).reverb;
  }
  refreshReverbs();

  /** 先読みのたびに関数を作らないよう、使い回す */
  const destOf = (n: PlannedNote): AudioNode => graph!.reverb(reverbBySection[n.section]).input;
  const whenOf = (t: number): number => clock.toContextTime(t);

  /** 効果音の出口（乾いた音は効果音の門へ、響きは区間の広さの残響へ少し送る）。広さごとに1つ */
  function sfxBus(size: ReverbSize): GainNode {
    let b = sfxBuses.get(size);
    if (!b) {
      b = ctx!.createGain();
      b.connect(graph!.sfxGate);
      const send = ctx!.createGain();
      send.gain.value = 0.5;
      b.connect(send).connect(graph!.reverb(size).send);
      sfxBuses.set(size, b);
    }
    return b;
  }

  /** 位置があれば立体音響の出口、なければ中央の出口。鳴らし終わったら spatial.extend で外す時刻を延ばす */
  function outlet(position: Vec3Tuple | undefined, section: SectionId, until: number): AudioNode {
    const size = reverbBySection[section];
    if (!position) return sfxBus(size);
    return spatial.create(ctx!, position, graph!.sfxGate, graph!.reverb(size).send, 0.5, until);
  }

  // ── AudioContext の用意 ──
  /** クリックの中で呼ぶ。AudioContext を作るだけ（重い準備は buildGraph と warm で後回し） */
  function ensureContext(): AudioContext | null {
    if (ctx === null) {
      const Ctor = audioContextCtor();
      if (!Ctor) return null;
      try {
        ctx = new Ctor({ latencyHint: 'interactive' });
      } catch {
        return null;
      }
    }
    return ctx;
  }

  /** 配線の骨組み。残響の応答と演奏の予定は、使うときか warm で作る（作るのに数十ミリ秒かかる） */
  function buildGraph(): void {
    if (!ctx || graph || disposed) return;
    graph = createGraph(ctx);
    graph.mixer.setVolumes(volumes, 0.001);
    if (pose) setListenerPose(ctx.listener, pose);
    timer = setInterval(tick, TICK_MS);
    ctx.addEventListener('statechange', onState);
  }

  /** 必要になる前に、重い準備を1つずつ、間を空けて済ませる（クリックの応答や描画を止めない） */
  const warmJobs: (() => void)[] = [];
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  function warm(): void {
    if (warmTimer !== null || disposed) return;
    for (const size of ['large', 'small', 'medium', 'huge', 'dry'] as const) {
      warmJobs.push(() => {
        graph?.reverb(size);
      });
    }
    warmJobs.push(() => {
      if (ctx) {
        prepareVoices(ctx);
        sharedNoise(ctx);
      }
    });
    warmJobs.push(() => {
      planNotes(0, RIDE_DURATION, 'amber');
      planNotes(0, RIDE_DURATION, 'lapis');
    });
    const step = () => {
      warmTimer = null;
      const job = warmJobs.shift();
      if (!job || disposed) return;
      job();
      warmTimer = setTimeout(step, 20);
    };
    warmTimer = setTimeout(step, 0);
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
    sweepCueVoices(now);
    if (lobby) lobbyTick(now);
    if (ctx.state !== 'running') {
      needsRestart = true;
      return;
    }
    if (!clock.running) {
      if (lastRunning) {
        pauseRide(now);
        pausedAt = now;
      }
      lastRunning = false;
      // 長いポーズでは、聞こえない環境音の床を止めて CPU を使わない
      if (beds.size > 0 && now - pausedAt > BED_IDLE_SEC) stopBeds();
      return;
    }
    if (!lastRunning || needsRestart || clock.jumps !== lastJumps) {
      lastRunning = true;
      lastJumps = clock.jumps;
      needsRestart = false;
      restart(now);
    }
    // 先読みの終わりより時計が先へ進んだ（長い停止）。間に合わなかった所は飛ばして、今から
    if (clock.time - cursor > 0.25) restart(now);
    const t = clock.time;
    const horizon = Math.min(RIDE_DURATION, t + lookahead());
    if (horizon > cursor) {
      perform(planNotes(cursor, horizon, door, scratch), now);
      cursor = horizon;
    }
    const cueTo = Math.min(RIDE_DURATION + 1, horizon + CUE_PREROLL);
    if (cueTo > cueCursor) {
      scheduleCues(now, cueCursor, cueTo);
      cueCursor = cueTo;
    }
    voices.prune(now);
    ambientTick(now, t);
  }

  function perform(notes: readonly PlannedNote[], now: number): void {
    if (notes.length === 0) return;
    performNotes(ctx!, notes, destOf, whenOf, voices, maxSources, now + 0.005);
  }

  /** 先読みの窓 [from, to) に時刻がある見どころ・膜の効果音を、乗車の秒から予約する（bus の cue を待たない） */
  function scheduleCues(now: number, from: number, to: number): void {
    const list = audioCues();
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.t < from) continue;
      if (c.t >= to) break;
      playCue(c, whenOf(c.t), now + 0.005);
    }
  }

  function playCue(cue: Cue, when: number, minWhen: number): void {
    const evs = cueEffect(cue, harmonyAt(cue.t + 0.01, door));
    if (!evs) return;
    const c = ctx!;
    // 効果音ごとに専用の門を挟む。ポーズ・シークのとき、予約済みで鳴り始めていない音も止められる
    const g = c.createGain();
    g.connect(sfxBus(reverbBySection[cue.section]));
    const until = playEvents(c, g, evs, when, minWhen);
    cueVoices.push({ gain: g, until });
  }

  function sweepCueVoices(now: number): void {
    let j = 0;
    for (let i = 0; i < cueVoices.length; i++) {
      const v = cueVoices[i];
      if (v.until > now) cueVoices[j++] = v;
      else v.gain.disconnect();
    }
    cueVoices.length = j;
  }

  function muteCueVoices(now: number): void {
    for (let i = 0; i < cueVoices.length; i++) {
      holdParam(cueVoices[i].gain.gain, now);
      cueVoices[i].gain.gain.setTargetAtTime(0, now, 0.02);
    }
    cueVoices.length = 0;
  }

  /** ポーズ: 乗車中の音を滑らかに止める（鳴っていた音は再開のときに作り直す） */
  function pauseRide(now: number): void {
    graph!.setGates(false, now, 0.025);
    voices.releaseAll(now + 0.12);
    muteCueVoices(now);
    for (const [, e] of beds) holdParam(e.node.gain.gain, now);
  }

  /** 開始・シーク・再開: 今の位置から演奏をやり直す。鳴っているはずの持続音も、途中から入れる */
  function restart(now: number): void {
    voices.releaseAll(now + 0.03);
    muteCueVoices(now);
    const t = clock.time;
    cursor = t;
    cueCursor = t;
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

  function stopBeds(): void {
    for (const [, e] of beds) e.node.stop();
    beds.clear();
  }

  function ambientTick(now: number, t: number): void {
    const all = ambientKeys(door);
    // 床の出し入れの判断は 0.5 秒に1回で足りる
    const check = t - lastAmbientCheck > 0.5 || t < lastAmbientCheck;
    if (check) lastAmbientCheck = t;
    for (let b = 0; b < BEDS.length; b++) {
      const bed = BEDS[b];
      const keys = all[bed];
      let entry = beds.get(bed);
      if (check) {
        const wanted = hasPositive(keys, t - 0.5, t + AMBIENT_AHEAD + 5) || ambientLevelAt(keys, t) > 0;
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
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.t <= entry.scheduledUntil || k.t > until) continue;
        entry.node.gain.gain.linearRampToValueAtTime(k.v, Math.max(now, whenOf(k.t)));
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
    g.connect(graph!.reverb('large').input);
    lobby = { anchor: now + 0.15, cursor: 0, gate: g, voices: new VoiceSet() };
  }

  function lobbyTick(now: number): void {
    if (!lobby || !ready()) return;
    const horizon = now - lobby.anchor + lookahead();
    if (horizon <= lobby.cursor) return;
    const notes = planLobby(lobby.cursor, horizon);
    if (notes.length > 0) {
      const l = lobby;
      performNotes(ctx!, notes, () => l.gate, (t) => l.anchor + t, l.voices, 60, now + 0.005);
    }
    lobby.cursor = horizon;
    lobby.voices.prune(now);
  }

  // ── 触れた音 ──
  type TouchEvent = { readonly id: string; readonly kind: TouchKind; readonly section: SectionId; readonly position: Vec3Tuple };

  /**
   * 触れた音の予定を立てて鳴らす。乗車中は乗車の時刻、乗車の外（入口の音楽の上）は音楽の時刻で。鳴らせなければ null。
   * soft は触れられないまま自分で鳴る小さな音（chime）で、乗る人の触れた音の枠を食わない。
   */
  function playTouch(e: TouchEvent, soft: boolean): number | null {
    if (!ready()) return null;
    const c = ctx!;
    let notes: TouchNote[];
    let toCtx: (t: number) => number;
    let outside = false;
    if (clock.running) {
      // 時計は聞こえている位置。予約できるのは currentTime より先なので、出力の遅延ぶん先の格子から選ぶ
      const now = clock.time + heard.lag();
      toCtx = whenOf;
      notes = e.kind === 'hidden-bubble' && !soft ? planHiddenChord(e.section, now, door) : [planTouch(e, now, door)];
    } else if (lobby && !soft) {
      outside = true;
      const now = (((c.currentTime - lobby.anchor) % LOBBY_SECONDS) + LOBBY_SECONDS) % LOBBY_SECONDS;
      toCtx = (t) => c.currentTime + (t - now);
      notes = e.kind === 'hidden-bubble' ? planHiddenChord(e.section, now, door, lobbyHarmonyAt) : [planTouch(e, now, door, lobbyHarmonyAt)];
    } else {
      return null;
    }
    const first = notes[0];
    const when = toCtx(first.at);
    // ゲートには「鳴っている」と数える長さ（物の種類ごとの目安）を渡す。音そのものの鳴り終わりは下で voice から得る
    const counted = Math.max(...notes.map((n) => n.duration));
    if (soft) {
      // 乗る人の触れた音を優先する。枠が詰まっていたら、自分で鳴る音は鳴らさない
      if (gate.busy(when) >= INTERACTION.maxTouchVoices - CHIME_RESERVE) return null;
      if (!chimeGate.tryAcquire(e.id, when, counted)) return null;
    } else if (!gate.tryAcquire(e.id, when, counted, !outside && inQuietMoment(first.at) ? QUIET_MAX_VOICES : undefined)) {
      return null;
    }
    const out = outlet(e.position, e.section, when + 1);
    const scale = soft ? 0.4 : 1;
    let endsAt = when;
    for (const n of notes) {
      const v = playGlass(c, out, n.timbre, { midi: n.midi, when: toCtx(n.at), velocity: n.velocity * scale, duration: n.duration });
      if (v.endsAt > endsAt) endsAt = v.endsAt;
    }
    if (!soft && e.kind === 'shard' && e.section === 'kaleidoscope') {
      // 万華鏡のガラス片: 模様の繰り返しに合わせて、1拍ごとにこだまする
      for (let k = 1; k <= 2; k++) {
        const v = playGlass(c, out, 'bottle', { midi: first.midi, when: when + k * SEC_PER_BEAT, velocity: first.velocity * (k === 1 ? 0.5 : 0.28) });
        if (v.endsAt > endsAt) endsAt = v.endsAt;
      }
    }
    if (!soft && e.kind === 'hidden-bubble') {
      // 見つけたことが分かるよう、和音の下にやわらかい持続音を敷く
      const root = Math.min(...notes.map((n) => n.midi)) - 12;
      const v = playPad(c, out, 'air', { midis: [root, root + 7], when, duration: 2.4, velocity: 0.5 });
      if (v.endsAt > endsAt) endsAt = v.endsAt;
    }
    // 立体音響の出口は、鳴らした音がすべて鳴り終わるまで外さない（途中で外すと、減衰の途中でぶつっと切れる）。
    // 残響の尾は畳み込みの中で続くので、出口の外には出ない
    spatial.extend(out, endsAt + 0.5);
    // 乗車の外では時計が止まっているので、止まった位置から鳴るまでの秒を足した値を返す
    return outside ? clock.time + (when - c.currentTime) : first.at;
  }

  // ── 出来事 ──
  const offCue = bus.on('cue', onCue);
  /**
   * bus の cue。乗車中の見どころ・膜の効果音は、先読みがすでに乗車の秒から予約しているので、ここでは鳴らさない
   * （cue を待つと、1フレームぶん遅れて小節の頭に合わない）。時計が動いていないとき（確認ページ、?t= の早送り）や、
   * 先読みの対象でない出来事だけ、届いた時点で鳴らす。
   */
  function onCue(cue: Cue): void {
    if (!ready()) return;
    if (clock.running && isAudioCue(cue.name)) return;
    const now = ctx!.currentTime;
    playCue(cue, now + 0.01, now);
  }

  const engine: AudioEngine = {
    clock,
    get unlocked() {
      return running();
    },
    async unlock() {
      if (disposed) return;
      const c = ensureContext();
      if (!c) return; // AudioContext のない環境（テスト・古いブラウザ）。乗車は実時間の時計で進む
      // クリックの中でやるのは、AudioContext を作って resume() を呼ぶところまで（自動再生の規則）
      const resumed = c.state === 'running' ? Promise.resolve() : c.resume().catch(() => undefined);
      await Promise.race([resumed, new Promise<void>((r) => setTimeout(r, RESUME_WAIT_MS))]);
      if (disposed) return;
      buildGraph();
      if (!running()) resumeOnGesture();
      if (running()) afterUnlocked();
      warm();
    },
    setDoor(d) {
      if (d === door) return;
      door = d;
      refreshReverbs();
      if (!ready() || !clock.running) return;
      const t = clock.time;
      // 先読みがもう万華鏡に届いていたら、予約した音を作り直す。届いていなければ環境音の予約だけ入れ直す
      if (t + lookahead() + CUE_PREROLL >= KALEIDOSCOPE_START) needsRestart = true;
      else for (const [bed, e] of beds) resetBed(bed, e, t, ctx!.currentTime);
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
      // 誘導音も、拍（8分音符）の格子に揃えて鳴らす
      const at = nextGridTime(clock.time + heard.lag(), 0, BPM, TOUCH_GRID_BEATS, 0.03);
      const h = harmonyAt(at, door);
      const out = outlet(position, h.section, whenOf(at) + 1);
      const endsAt = playEvents(c, out, lureEffect(h), whenOf(at), c.currentTime + 0.005);
      spatial.extend(out, endsAt + 0.5);
    },
    sfx(id: SfxId, position?: Vec3Tuple) {
      if (!ready()) return;
      const c = ctx!;
      let out: AudioNode = graph!.ui;
      if (position) out = spatial.create(c, position, graph!.ui, null, 0, c.currentTime + 1);
      const endsAt = playEvents(c, out, SFX[id], c.currentTime + 0.01);
      if (position) spatial.extend(out, endsAt + 0.5);
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
      if (warmTimer !== null) clearTimeout(warmTimer);
      voices.releaseAll(0);
      spatial.dispose();
      for (let i = 0; i < cueVoices.length; i++) cueVoices[i].gain.disconnect();
      cueVoices.length = 0;
      stopBeds();
      if (lobby) lobby.gate.disconnect();
      lobby = null;
      if (ctx) {
        ctx.removeEventListener('statechange', onState);
        // 外から渡された AudioContext は閉じない。使い終わった配線だけ出力から外して、別の用途へ返す
        graph?.dispose();
        if (!opts.context) void ctx.close().catch(() => undefined);
      }
      graph = null;
    },
  };
  auditions.set(engine, (cue) => {
    if (!ready()) return;
    const now = ctx!.currentTime;
    playCue(cue, now + 0.01, now);
  });
  return engine;
}

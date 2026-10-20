// ガラスの音源。案1と共有する。
// 設計書ではガラスの実録音（ワイングラス、ガラス瓶、風鈴、ガラスの器）を音程ごとに揃えるが、
// 録音が揃うまでは Web Audio の合成で作る（ADR-0003）。音色の名前と引数は録音に差し替えても変えない。
//
// 合成の方針（どれも「その場で鳴らす」ので、音ごとにノードを作って鳴り終われば捨てる）:
//   harp   擦ったワイングラス。ゆっくり立ち上がる正弦波の束に、ごく遅いビブラートと二重のうなり
//   bell   ガラスの鐘。非整数倍音（1 : 2.76 : 5.40 : 8.93）が、高いものほど早く消える
//   chime  風鈴。倍音は鐘より少なく明るく、打たれた直後に音程がわずかに高い
//   bottle ガラス瓶のマリンバ風。基音の短い減衰に4倍音とマレットの打音（雑音）
//   drop   露・雨粒。音程が一瞬で上がる水滴の「ぷ」に、ガラスに当たる高い「ちん」
//   bowl   ガラスの器。低くて長い。わずかにずれた2本の基音がゆっくりうなる
//   tap    ガラスを叩く打楽器。低い音は音程が落ちる胴鳴り、高い音は雑音の「ちっ」
//   pad    strings / choir / warm / air はシンセ（のこぎり波＋フィルター、母音の共鳴、など）

import { midiToHz } from './scale';

export type GlassTimbre =
  | 'harp' // グラスハープ（ワイングラスを擦った音。持続する）
  | 'bell' // ガラスの鐘
  | 'chime' // 風鈴
  | 'bottle' // ガラス瓶のマリンバ風の音
  | 'drop' // 露・雨粒の落ちる音
  | 'bowl' // ガラスの器（低く長い）
  | 'tap'; // ガラスを叩いた打楽器

export type PadTimbre = 'strings' | 'choir' | 'warm' | 'air';

export interface NoteParams {
  /** MIDI ノート番号 */
  readonly midi: number;
  /** 鳴らし始める時刻（AudioContext の秒） */
  readonly when: number;
  /** 0〜1 */
  readonly velocity: number;
  /** 持続する音色の長さ（秒）。減衰する音色では無視してよい */
  readonly duration?: number;
}

export interface Voice {
  /** 鳴り終わる時刻（AudioContext の秒） */
  readonly endsAt: number;
  /** 早めに止める（滑らかに消す） */
  release(when: number): void;
  /** now（AudioContext の秒）の時点でまだ鳴っている音源（オシレーターなど）の数。同時発音の予算の数え方に使う */
  liveSources(now: number): number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 決定的な乱数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 雨・波・風などの環境音の元になる雑音（決定的な乱数で作る） */
export function noiseBuffer(ctx: BaseAudioContext, seconds: number, seed = 1): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rnd = rng(seed * 2654435761);
  for (let i = 0; i < data.length; i++) data[i] = rnd() * 2 - 1;
  return buffer;
}

/** 打音（マレットや爪のあたる音）に使う短い雑音。コンテキストごとに1つだけ作って使い回す */
const clickNoise = new WeakMap<BaseAudioContext, AudioBuffer>();
function clickBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = clickNoise.get(ctx);
  if (!b) {
    b = noiseBuffer(ctx, 2, 41);
    clickNoise.set(ctx, b);
  }
  return b;
}

/** 音を鳴らす前に、使い回す雑音を作っておく（最初の1音の発音で、雑音の生成のぶん止まらないように） */
export function prepareVoices(ctx: BaseAudioContext): void {
  clickBuffer(ctx);
}

/** これより小さい倍音は作らない（出力が約 -42dB 以下で、曲の中ではほかの音に隠れて聞こえない。音源の数を減らす） */
const MIN_AMP = 0.008;
/** 減衰する倍音は、時定数の何倍で止めるか（e^-5 = 約 -43dB まで下がってから止める。止める瞬間の段差は -60dBFS 以下で聞こえない） */
const STOP_TAUS = 5;

/** 1つの音を作るための入れ物。音源 → 包絡線の出口（out）→ 出力先。解除用の門は、止めるときに初めて挟む */
class Rig {
  readonly ctx: BaseAudioContext;
  readonly out: GainNode;
  private readonly dest: AudioNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  /** sources と同じ並びの、止める時刻。まだ決まっていないもの（finish で一括）は Infinity */
  private readonly stops: number[] = [];
  private latestStop = 0;

  // Node で直接読めるよう、TypeScript のパラメータプロパティ（constructor(readonly x)）は使わない
  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.dest = dest;
    this.out = ctx.createGain();
    this.out.connect(dest);
  }

  private add<T extends AudioScheduledSourceNode>(s: T, stopAt = Infinity): T {
    this.sources.push(s);
    this.stops.push(stopAt);
    if (stopAt !== Infinity && stopAt > this.latestStop) this.latestStop = stopAt;
    return s;
  }

  osc(type: OscillatorType, freq: number, when: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.start(when);
    return this.add(o);
  }

  /** 雑音の短い打音（start の offset を音ごとに変えて、毎回同じ波形にならないようにする） */
  click(when: number, seconds: number, offset: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = clickBuffer(this.ctx);
    s.start(when, offset % 1.5, seconds);
    return this.add(s, when + seconds + 0.01);
  }

  /** 鳴っている間ずっと続く雑音（繰り返し再生する） */
  hiss(when: number, offset: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = clickBuffer(this.ctx);
    s.loop = true;
    s.start(when, offset % 1.5);
    return this.add(s);
  }

  /**
   * 減衰する倍音 1 本: 発音 → 急な立ち上がり → 指数的に減衰し、減衰し切る頃（tau の7倍）に自分で止まる。
   * 小さすぎて聞こえない倍音は作らず null を返す。
   */
  partial(type: OscillatorType, freq: number, when: number, amp: number, tau: number, attack = 0.003): OscillatorNode | null {
    if (amp < MIN_AMP) return null;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.start(when);
    const stopAt = when + attack + tau * STOP_TAUS;
    o.stop(stopAt);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(amp, when + attack);
    g.gain.setTargetAtTime(0, when + attack, tau);
    // 止める直前の 60ms でさらに絞る（残っている音を止める段差を、静かな場所でも聞こえない大きさにする）
    g.gain.setTargetAtTime(0, stopAt - 0.06, 0.012);
    o.connect(g).connect(this.out);
    return this.add(o, stopAt);
  }

  /** 止まる時刻が決まっていない音源（LFO、持続する雑音など）を stopAt に止めて、Voice を返す。endsAt は最も遅い音源が止まる時刻 */
  finish(stopAt: number, minEndsAt = 0): Voice {
    for (let i = 0; i < this.sources.length; i++) {
      if (this.stops[i] === Infinity) {
        this.sources[i].stop(stopAt);
        this.stops[i] = stopAt;
        if (stopAt > this.latestStop) this.latestStop = stopAt;
      }
    }
    const { ctx, out, dest, sources, stops } = this;
    let released = false;
    return {
      endsAt: Math.max(this.latestStop, minEndsAt),
      release(when) {
        if (released) return;
        released = true;
        const t = Math.max(when, ctx.currentTime);
        // 止めるときだけ門を挟んで滑らかに消す（ふだんは門を持たず、ノードが1つ少ない）
        const gate = ctx.createGain();
        out.disconnect();
        out.connect(gate).connect(dest);
        gate.gain.setTargetAtTime(0, t, 0.02);
        for (let i = 0; i < sources.length; i++) {
          // 0.02 秒の時定数で消え切るまで待って止める（まだ始まっていない音源は、始まらない）
          if (stops[i] > t + 0.15) {
            try {
              sources[i].stop(t + 0.15);
              stops[i] = t + 0.15;
            } catch {
              // すでに止まっている音源
            }
          }
        }
      },
      liveSources(now) {
        let n = 0;
        for (let i = 0; i < stops.length; i++) if (stops[i] > now) n++;
        return n;
      },
    };
  }
}

/** 音が高いほど短く消える（実際のガラスや金属の減衰に合わせる） */
const pitchDecay = (midi: number, exponent = 1): number => Math.pow(60 / Math.max(24, midi), exponent);

/** 音色ごとの最大音量。velocity 1 のときの目安（確認ページで RMS を測って揃える） */
const GLASS_LEVEL: Readonly<Record<GlassTimbre, number>> = {
  harp: 0.27,
  bell: 0.34,
  chime: 0.34,
  bottle: 0.5,
  drop: 0.65,
  bowl: 0.3,
  tap: 0.62,
};

export function playGlass(ctx: BaseAudioContext, dest: AudioNode, timbre: GlassTimbre, p: NoteParams): Voice {
  const f = midiToHz(p.midi);
  const v = clamp01(p.velocity);
  const level = v * GLASS_LEVEL[timbre];
  // 高すぎる倍音は聞こえないうえ、サンプルレートの半分を超えると使えないので作らない
  const maxHz = Math.min(14000, ctx.sampleRate * 0.45);
  const rig = new Rig(ctx, dest);
  const t0 = p.when;
  switch (timbre) {
    case 'harp': {
      // 擦ったワイングラス: ゆっくり立ち上がり、鳴っている間わずかに揺れ、止めるとすぐ消える
      const dur = Math.max(0.4, p.duration ?? 2.5);
      const attack = Math.min(0.5, dur * 0.45);
      const end = t0 + dur;
      const release = 0.7;
      rig.out.gain.setValueAtTime(0, t0);
      rig.out.gain.linearRampToValueAtTime(level, t0 + attack);
      rig.out.gain.setValueAtTime(level, end);
      rig.out.gain.setTargetAtTime(0, end, release / 4);
      const lfo = rig.osc('sine', 4.7 + (p.midi % 5) * 0.12, t0);
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.setValueAtTime(0, t0);
      lfoDepth.gain.linearRampToValueAtTime(5, t0 + attack + 0.6);
      lfo.connect(lfoDepth);
      const partials: [number, number, number][] = [
        [1, 1, 0],
        [1, 0.7, 4], // 少しずれた同じ音: うなりがグラスの震えになる
        [2, 0.24, -2],
        [3, 0.09, 3],
      ];
      for (const [ratio, amp, cents] of partials) {
        if (f * ratio > maxHz || level * amp < MIN_AMP * 1.5) continue;
        const o = rig.osc('sine', f * ratio, t0);
        o.detune.value = cents;
        lfoDepth.connect(o.detune);
        const g = ctx.createGain();
        g.gain.value = amp;
        o.connect(g).connect(rig.out);
      }
      return rig.finish(end + release * 2.2);
    }
    case 'bell': {
      const tau = 1.4 * pitchDecay(p.midi, 1.1) * (0.7 + 0.3 * v);
      const ratios = [1, 2.756, 5.404, 8.933];
      const amps = [1, 0.5 * (0.5 + 0.5 * v), 0.24 * (0.4 + 0.6 * v), 0.1 * v];
      const taus = [1, 0.55, 0.3, 0.16];
      for (let i = 0; i < ratios.length; i++) {
        if (f * ratios[i] > maxHz) continue;
        rig.partial('sine', f * ratios[i], t0, level * amps[i], tau * taus[i]);
      }
      return rig.finish(t0);
    }
    case 'chime': {
      // 風鈴: 打たれた瞬間は音程がわずかに高く、すぐに落ち着く
      const tau = 0.9 * pitchDecay(p.midi, 0.8) * (0.7 + 0.3 * v);
      const ratios = [1, 2.4, 4.3, 6.7];
      const amps = [1, 0.6, 0.34, 0.18];
      const taus = [1, 0.6, 0.34, 0.2];
      for (let i = 0; i < ratios.length; i++) {
        const fr = f * ratios[i];
        if (fr > maxHz) continue;
        const o = rig.partial('sine', fr, t0, level * amps[i], tau * taus[i]);
        if (!o) continue;
        o.frequency.setValueAtTime(fr * 1.012, t0);
        o.frequency.exponentialRampToValueAtTime(fr, t0 + 0.02);
      }
      return rig.finish(t0);
    }
    case 'bottle': {
      // 瓶をマレットで叩いたような、丸くて少しこもった音
      const tau = 0.34 * pitchDecay(p.midi, 0.6);
      rig.partial('sine', f, t0, level, tau, 0.004);
      if (f * 4 < maxHz) rig.partial('sine', f * 4, t0, level * 0.3, tau * 0.18, 0.002);
      rig.partial('triangle', f * 0.5, t0, level * 0.16, tau * 0.6, 0.004);
      const click = rig.click(t0, 0.05, p.midi * 0.37);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = Math.min(9000, f * 3);
      bp.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level * 0.55, t0);
      g.gain.setTargetAtTime(0, t0 + 0.002, 0.012);
      click.connect(bp).connect(g).connect(rig.out);
      return rig.finish(t0);
    }
    case 'drop': {
      // 水滴: 音程が一瞬で上がり、ガラスに当たる高い音が重なる
      const tau = 0.13 * pitchDecay(p.midi, 0.5);
      const body = rig.partial('sine', f, t0, level, tau, 0.002);
      if (body) {
        body.frequency.setValueAtTime(f * 0.78, t0);
        body.frequency.exponentialRampToValueAtTime(f, t0 + 0.035);
      }
      if (f * 2.5 < maxHz) rig.partial('sine', f * 2.5, t0, level * 0.26, tau * 0.45, 0.002);
      if (f * 4.3 < maxHz) rig.partial('sine', f * 4.3, t0, level * 0.12, tau * 0.25, 0.001);
      return rig.finish(t0);
    }
    case 'bowl': {
      // 低い音ほど長く響くが、3 秒を超えると次の和音の低音と重なって濁り、音源も長く残る
      const tau = Math.min(3, 3.6 * pitchDecay(p.midi, 0.4));
      const attack = 0.04;
      const ratios = [1, 1.004, 2.71, 5.18];
      const amps = [1, 0.8, 0.26, 0.08];
      const taus = [1, 1, 0.55, 0.25];
      for (let i = 0; i < ratios.length; i++) {
        if (f * ratios[i] > maxHz) continue;
        rig.partial('sine', f * ratios[i], t0, level * amps[i] * 0.7, tau * taus[i], attack);
      }
      return rig.finish(t0);
    }
    case 'tap': {
      const low = p.midi < 60;
      const tau = low ? 0.16 : 0.05;
      // 高い音は「ちっ」という雑音だけで足りる（胴鳴りの音程は聞こえない）ので、オシレーターを作らない
      const body = low ? rig.partial('sine', f, t0, level, tau, 0.001) : null;
      if (body) {
        body.frequency.setValueAtTime(f * 2.2, t0);
        body.frequency.exponentialRampToValueAtTime(f, t0 + 0.045);
      }
      const click = rig.click(t0, 0.08, p.midi * 0.53);
      const filter = ctx.createBiquadFilter();
      filter.type = low ? 'bandpass' : 'highpass';
      filter.frequency.value = low ? Math.min(6000, f * 5) : 5500;
      filter.Q.value = low ? 1.2 : 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level * (low ? 0.4 : 0.9), t0);
      g.gain.setTargetAtTime(0, t0 + 0.001, low ? 0.01 : 0.022);
      click.connect(filter).connect(g).connect(rig.out);
      return rig.finish(t0);
    }
  }
}

interface PadConfig {
  readonly attack: number;
  readonly release: number;
  readonly level: number;
}

const PAD: Readonly<Record<PadTimbre, PadConfig>> = {
  strings: { attack: 0.9, release: 1.3, level: 0.42 },
  choir: { attack: 1.1, release: 1.5, level: 0.85 },
  warm: { attack: 1.4, release: 1.8, level: 0.34 },
  air: { attack: 1.8, release: 2.0, level: 0.3 },
};

export function playPad(
  ctx: BaseAudioContext,
  dest: AudioNode,
  timbre: PadTimbre,
  p: { readonly midis: readonly number[]; readonly when: number; readonly duration: number; readonly velocity: number; readonly attack?: number; readonly release?: number },
): Voice {
  const cfg = PAD[timbre];
  const t0 = p.when;
  const duration = Math.max(0.2, p.duration);
  const attack = Math.min(p.attack ?? cfg.attack, duration * 0.85);
  const release = p.release ?? cfg.release;
  const end = t0 + duration;
  const v = clamp01(p.velocity);
  // 和音の音数が増えても全体の大きさが大きく変わらないようにする
  const peak = (v * cfg.level) / Math.sqrt(Math.max(1, p.midis.length));
  const rig = new Rig(ctx, dest);
  rig.out.gain.setValueAtTime(0, t0);
  rig.out.gain.linearRampToValueAtTime(peak, t0 + attack);
  rig.out.gain.setValueAtTime(peak, end);
  rig.out.gain.setTargetAtTime(0, end, release / 3);

  // 全部の音をまとめて揺らすゆっくりしたビブラート（弦と合唱）
  let vib: GainNode | null = null;
  if (timbre === 'strings' || timbre === 'choir') {
    const lfo = rig.osc('sine', timbre === 'strings' ? 5.2 : 5.7, t0);
    vib = ctx.createGain();
    vib.gain.setValueAtTime(0, t0);
    vib.gain.linearRampToValueAtTime(timbre === 'strings' ? 5 : 8, t0 + attack + 0.8);
    lfo.connect(vib);
  }
  const voiceOsc = (type: OscillatorType, freq: number, cents: number, amp: number, to: AudioNode, vibrato = false) => {
    const o = rig.osc(type, freq, t0);
    o.detune.value = cents;
    if (vibrato && vib) vib.connect(o.detune);
    const g = ctx.createGain();
    g.gain.value = amp;
    o.connect(g).connect(to);
  };

  switch (timbre) {
    case 'strings': {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400 + 2400 * v;
      lp.Q.value = 0.6;
      lp.connect(rig.out);
      for (const m of p.midis) {
        const f = midiToHz(m);
        voiceOsc('sawtooth', f, -7, 0.5, lp, true);
        voiceOsc('sawtooth', f, 7, 0.5, lp, true);
      }
      break;
    }
    case 'choir': {
      // 母音「あ」の共鳴（フォルマント）を、のこぎり波の和に通す
      const sum = ctx.createGain();
      sum.gain.value = 0.5;
      const formants: [number, number, number][] = [
        [730, 6, 1],
        [1090, 7, 0.6],
      ];
      for (const [fc, q, amp] of formants) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = fc;
        bp.Q.value = q;
        const g = ctx.createGain();
        g.gain.value = amp * 2.6;
        sum.connect(bp).connect(g).connect(rig.out);
      }
      for (const m of p.midis) {
        const f = midiToHz(m);
        voiceOsc('sawtooth', f, -9, 0.5, sum, true);
        voiceOsc('sawtooth', f, 9, 0.5, sum, true);
      }
      break;
    }
    case 'warm': {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700 + 1100 * v;
      lp.Q.value = 0.5;
      lp.connect(rig.out);
      for (const m of p.midis) {
        const f = midiToHz(m);
        voiceOsc('triangle', f, -3, 0.6, lp);
        voiceOsc('triangle', f, 3, 0.6, lp);
        voiceOsc('sine', f * 2, 0, 0.18, lp);
      }
      break;
    }
    case 'air': {
      for (const m of p.midis) {
        const f = midiToHz(m);
        voiceOsc('sine', f, -4, 0.5, rig.out);
        voiceOsc('sine', f * 2, 5, 0.22, rig.out);
        if (f * 3 < 9000) voiceOsc('sine', f * 3, -2, 0.08, rig.out);
      }
      // 息のような雑音を、和音の高さの帯域だけ通す
      const noise = rig.hiss(t0, p.midis[0] * 0.21);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = Math.min(7000, midiToHz(p.midis[p.midis.length - 1]) * 3);
      bp.Q.value = 1.6;
      const g = ctx.createGain();
      g.gain.value = 0.1;
      noise.connect(bp).connect(g).connect(rig.out);
      break;
    }
  }
  return rig.finish(end + release * 2.4);
}

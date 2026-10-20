// 確認ページ用の測定。OfflineAudioContext で曲を描き、音の大きさ（RMS）と割れ（ピーク）を数える。
// 耳で確かめられない代わりに、音色の釣り合いと曲の盛り上がり（天球の頂点が最も大きいか、雨が止まる所が静かか）を数字で見る。
import { RIDE_DURATION, SECTIONS, SEC_PER_BAR } from '../../config';
import type { DoorChoice } from '../../contracts/ids';
import { createBed } from '../../audio/ambient';
import { planNotes } from '../../audio/conductor';
import { createGraph } from '../../audio/graph';
import { performNotes, SpatialPool, VoiceSet } from '../../audio/performer';
import { ambientKeys, ambientLevelAt, sectionScore } from '../../audio/score';
import type { AmbientBed } from '../../audio/score';
import { playGlass, playPad } from '../../core/sound/voices';
import type { GlassTimbre, PadTimbre } from '../../core/sound/voices';

export interface LevelRow {
  readonly label: string;
  readonly rmsDb: number;
  readonly peak: number;
}

const db = (x: number) => 20 * Math.log10(Math.max(1e-9, x));

function levels(buf: AudioBuffer, from: number, to: number): { rmsDb: number; peak: number } {
  const a = Math.max(0, Math.floor(from * buf.sampleRate));
  const b = Math.min(buf.length, Math.floor(to * buf.sampleRate));
  let sum = 0;
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = a; i < b; i++) {
      sum += d[i] * d[i];
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  return { rmsDb: db(Math.sqrt(sum / Math.max(1, (b - a) * buf.numberOfChannels))), peak };
}

/** 音色を1つずつ単独で鳴らして大きさを測る（反響なし）。LAYER_TRIM / GLASS_LEVEL の釣り合いを見る */
export async function measureTimbres(): Promise<LevelRow[]> {
  const sr = 44100;
  const rows: LevelRow[] = [];
  const glass: GlassTimbre[] = ['harp', 'bell', 'chime', 'bottle', 'drop', 'bowl', 'tap'];
  for (const timbre of glass) {
    for (const midi of timbre === 'bowl' ? [45, 57] : timbre === 'tap' ? [42, 72, 96] : [60, 72, 90]) {
      const ctx = new OfflineAudioContext(1, sr * 4, sr);
      playGlass(ctx, ctx.destination, timbre, { midi, when: 0.05, velocity: 0.7, duration: 2 });
      const buf = await ctx.startRendering();
      const l = levels(buf, 0.05, 1.05);
      rows.push({ label: `${timbre} ${midi}`, ...l });
    }
  }
  const pads: PadTimbre[] = ['strings', 'choir', 'warm', 'air'];
  for (const timbre of pads) {
    const ctx = new OfflineAudioContext(1, sr * 6, sr);
    playPad(ctx, ctx.destination, timbre, { midis: [57, 64, 69], when: 0.05, duration: 4, velocity: 0.5 });
    const buf = await ctx.startRendering();
    rows.push({ label: `${timbre} [57 64 69]`, ...levels(buf, 2, 4) });
  }
  return rows;
}

/**
 * 乗車全体を区間ごとに描いて、5 秒ごとの大きさを返す。
 * 区間の前に 16 秒の助走を置き（長い和音と残響を拾う）、測るのは区間の中だけ。
 */
export async function measureRide(door: DoorChoice, onProgress?: (done: number, total: number) => void): Promise<LevelRow[]> {
  const sr = 24000;
  const PRE = 16;
  const rows: LevelRow[] = [];
  const chunks: { t0: number; t1: number }[] = [];
  for (let t = 0; t < RIDE_DURATION; t += 60) chunks.push({ t0: t, t1: Math.min(RIDE_DURATION, t + 60) });
  let done = 0;
  for (const { t0, t1 } of chunks) {
    const start = Math.max(0, t0 - PRE);
    const ctx = new OfflineAudioContext(2, Math.ceil((t1 - start + 4) * sr), sr);
    const graph = createGraph(ctx);
    const voices = new VoiceSet();
    const notes = planNotes(start, t1, door);
    performNotes(
      ctx,
      notes,
      (n) => graph.reverb(sectionScore(n.section, door).reverb).input,
      (t) => t - start,
      voices,
      100000,
      0,
    );
    const keys = ambientKeys(door);
    for (const bed of Object.keys(keys) as AmbientBed[]) {
      const k = keys[bed];
      if (!k.some((x) => x.t >= start && x.t <= t1 && x.v > 0) && ambientLevelAt(k, start) === 0) continue;
      const node = createBed(ctx, bed, graph.ambientGate);
      node.gain.gain.setValueAtTime(ambientLevelAt(k, start), 0);
      for (const x of k) if (x.t > start && x.t <= t1 + 4) node.gain.gain.linearRampToValueAtTime(x.v, x.t - start);
    }
    const buf = await ctx.startRendering();
    for (let a = t0; a < t1; a += 5) {
      const b = Math.min(t1, a + 5);
      const bar = a / SEC_PER_BAR;
      const sec = SECTIONS.find((s) => bar >= s.startBar && bar < s.startBar + s.bars)?.id ?? '';
      rows.push({ label: `${String(Math.floor(a / 60)).padStart(2, '0')}:${String(Math.floor(a % 60)).padStart(2, '0')} ${sec}`, ...levels(buf, a - start, b - start) });
    }
    onProgress?.(++done, chunks.length);
  }
  return rows;
}

/**
 * 吊られた泡に触れた音（bowl、鳴り終わりは約 15 秒後）を立体音響の出口に通して鳴らし、出口を外す時刻の前後の大きさを測る。
 * 旧: 出口を「鳴っていると数える長さ（3秒）+ 2 秒」で外していた → 減衰の途中でぶつっと切れる。
 * 新: 出口は鳴らした音の鳴り終わり（Voice.endsAt）+ 0.5 秒まで外さない。
 */
export async function measureTouchTail(): Promise<LevelRow[]> {
  const sr = 44100;
  const rows: LevelRow[] = [];
  for (const mode of ['旧（3 + 2 秒で外す）', '新（Voice.endsAt + 0.5 秒で外す）'] as const) {
    const ctx = new OfflineAudioContext(2, sr * 30, sr);
    const pool = new SpatialPool();
    const out = pool.create(ctx, [1, 0, -2], ctx.destination, null, 0, 0.1 + 3 + 2);
    const voice = playGlass(ctx, out, 'bowl', { midi: 55, when: 0.1, velocity: 0.75, duration: 3 });
    if (mode.startsWith('新')) pool.extend(out, voice.endsAt + 0.5);
    // 出口を外す時刻（エンジンでは tick の sweep が行う）まで描いて、そこで止めて sweep を呼ぶ
    const cutAt = mode.startsWith('新') ? voice.endsAt + 0.5 : 0.1 + 3 + 2;
    const sweepAt = Math.ceil(cutAt * sr / 128) * 128 / sr + 0.01;
    ctx.suspend(sweepAt).then(() => {
      pool.sweep(ctx.currentTime);
      return ctx.resume();
    });
    const buf = await ctx.startRendering();
    rows.push({ label: `${mode} 外す時刻 ${sweepAt.toFixed(2)}s`, rmsDb: 0, peak: 0 });
    const at = 0.1 + 3 + 2;
    rows.push({ label: `  ${(at - 0.5).toFixed(1)}〜${at.toFixed(1)}s（旧の切れる直前）`, ...levels(buf, at - 0.5, at) });
    rows.push({ label: `  ${at.toFixed(1)}〜${(at + 0.5).toFixed(1)}s（旧の切れた直後）`, ...levels(buf, at, at + 0.5) });
    rows.push({ label: `  ${(at + 4).toFixed(1)}〜${(at + 4.5).toFixed(1)}s`, ...levels(buf, at + 4, at + 4.5) });
    rows.push({ label: `  鳴り終わり ${voice.endsAt.toFixed(1)}s の直前 0.5s`, ...levels(buf, Math.max(0, voice.endsAt - 0.5), voice.endsAt) });
  }
  return rows;
}

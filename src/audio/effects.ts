// 効果音。UI・遷移の音と、見どころ・膜の通過音を、短い出来事の並び（dt 秒後に何を鳴らすか）で書く。
// 音色はすべて core/sound の合成。UI の音は乗り場の調（A 短調のペンタトニック: A C D E G）に揃える。
import type { Cue } from '../contracts/events';
import type { SfxId } from '../contracts/audio';
import { SECTION_IDS } from '../contracts/ids';
import type { Chord } from '../core/sound/scale';
import { nearestPitch, touchCandidates } from '../core/sound/scale';
import { playGlass, playPad } from '../core/sound/voices';
import type { GlassTimbre, PadTimbre } from '../core/sound/voices';
import { sharedNoise } from './ambient';
import { chordLadder, hash01 } from './conductor';
import type { Harmony } from './score';
import { membranePitch } from './score';

export type Ev =
  | { readonly dt: number; readonly glass: GlassTimbre; readonly midi: number; readonly vel: number; readonly dur?: number; readonly pan?: number }
  | { readonly dt: number; readonly pad: PadTimbre; readonly midis: readonly number[]; readonly vel: number; readonly dur: number }
  | { readonly dt: number; readonly sweep: { readonly dur: number; readonly f0: number; readonly f1: number; readonly q: number; readonly gain: number } };

/** 出来事を when（AudioContext の秒）から鳴らす */
export function playEvents(ctx: BaseAudioContext, dest: AudioNode, evs: readonly Ev[], when: number): void {
  for (const ev of evs) {
    const t = when + ev.dt;
    if ('glass' in ev) {
      let out: AudioNode = dest;
      if (ev.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
        const p = ctx.createStereoPanner();
        p.pan.value = ev.pan;
        p.connect(dest);
        out = p;
      }
      playGlass(ctx, out, ev.glass, { midi: ev.midi, when: t, velocity: ev.vel, duration: ev.dur });
    } else if ('pad' in ev) {
      playPad(ctx, dest, ev.pad, { midis: ev.midis, when: t, duration: ev.dur, velocity: ev.vel });
    } else {
      const { dur, f0, f1, q, gain } = ev.sweep;
      const src = ctx.createBufferSource();
      src.buffer = sharedNoise(ctx);
      src.loop = true;
      src.start(t, Math.abs(ev.dt * 1.7 + f0 * 0.001) % 6);
      src.stop(t + dur + 0.1);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = q;
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + dur * 0.4);
      g.gain.linearRampToValueAtTime(0, t + dur);
      src.connect(f).connect(g).connect(dest);
    }
  }
}

const g = (dt: number, glass: GlassTimbre, midi: number, vel: number, dur?: number, pan?: number): Ev => ({ dt, glass, midi, vel, dur, pan });
const pad = (dt: number, p: PadTimbre, midis: number[], vel: number, dur: number): Ev => ({ dt, pad: p, midis, vel, dur });
const sweep = (dt: number, dur: number, f0: number, f1: number, gain: number, q = 1.2): Ev => ({ dt, sweep: { dur, f0, f1, q, gain } });

/** UI・遷移の音。A 短調のペンタトニック（A C D E G）の音だけを使う */
export const SFX: Readonly<Record<SfxId, readonly Ev[]>> = {
  'ui.hover': [g(0, 'chime', 88, 0.22)],
  'ui.select': [g(0, 'chime', 79, 0.5), g(0.08, 'bell', 86, 0.42)],
  'ui.back': [g(0, 'drop', 74, 0.5), g(0.09, 'drop', 67, 0.42)],
  lamp: [g(0, 'bell', 88, 0.45), g(0.04, 'chime', 95, 0.18)],
  'door.open': [sweep(0, 1.3, 300, 2600, 0.22), g(0.05, 'harp', 57, 0.4, 2.2), g(0.12, 'harp', 64, 0.36, 2.2), g(0.2, 'harp', 69, 0.34, 2.2), g(0.3, 'harp', 72, 0.3, 2.2)],
  'ticket.punch': [g(0, 'tap', 84, 0.55), g(0.05, 'bell', 93, 0.42), g(0.11, 'chime', 100, 0.22)],
  'gondola.rise': [sweep(0, 1.8, 200, 1200, 0.14, 0.8), g(0.1, 'harp', 57, 0.3, 1.8), g(0.45, 'harp', 64, 0.34, 1.7), g(0.8, 'harp', 69, 0.38, 1.6), g(1.15, 'harp', 76, 0.42, 1.5)],
  'gondola.close': [sweep(0, 0.9, 800, 5200, 0.16), g(0, 'bell', 72, 0.4), g(0.08, 'bell', 76, 0.4), g(0.16, 'bell', 79, 0.4), g(0.24, 'bell', 84, 0.42), g(0.1, 'harp', 57, 0.3, 2.2), g(0.18, 'harp', 64, 0.28, 2.2)],
  'gondola.open': [sweep(0, 1.1, 5000, 600, 0.14), g(0, 'bell', 84, 0.35), g(0.1, 'bell', 79, 0.35), g(0.2, 'bell', 76, 0.35), g(0.3, 'bell', 72, 0.36)],
  pause: [sweep(0, 0.45, 1500, 300, 0.14, 0.8), g(0, 'bowl', 57, 0.42)],
  resume: [sweep(0, 0.35, 300, 2200, 0.13, 0.8), g(0, 'bell', 81, 0.4), g(0.08, 'chime', 88, 0.3)],
  'photo.receive': [g(0, 'bell', 84, 0.36), g(0.12, 'bell', 88, 0.34), g(0.24, 'bell', 91, 0.34), g(0.36, 'bell', 96, 0.3), g(0.1, 'harp', 69, 0.26, 2.4)],
  'vr.fog': [sweep(0, 1.2, 200, 3000, 0.22, 0.7), pad(0, 'warm', [57, 64, 69], 0.5, 1.5)],
};

/** 和音の構成音を base 以上から積んだ MIDI の並び */
function run(chord: Chord, base: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => chordLadder(chord, base, i));
}

/** 調の5音と和音の共通部分から、高さ around に近い音を選ぶ */
function pick(h: Harmony, around: number, low: number, high: number): number {
  return nearestPitch(touchCandidates(h.key, h.chord), around, low, high);
}

/**
 * 出来事（キュー）に合わせた効果音。t0 はキューの時刻の和音。見どころの効果音（花・露・雨が止まる・扉・模様・暗転・星・星座・朝日）と、
 * 膜の通過音。それ以外の出来事は鳴らさない（null）。
 */
export function cueEffect(cue: Cue, h: Harmony): readonly Ev[] | null {
  switch (cue.name) {
    case 'membrane': {
      const to = cue.data?.to;
      const i = Math.max(0, (to ? SECTION_IDS.indexOf(to) : 1) - 1);
      const m = membranePitch(i);
      // 膜を抜ける虹色の風切りと、次の区間の調の高い音。つなぎ目を覆う
      return [sweep(-0.1, 0.8, 900, 7000, 0.16, 1.4), g(0, 'harp', m, 0.5, 1.6), g(0.02, 'bell', m + 12, 0.34), g(0.12, 'chime', m + 7, 0.2)];
    }
    case 'hint.touch':
      return [g(0, 'chime', 86, 0.22), g(0.14, 'chime', 93, 0.2)];
    case 'greenhouse.bloom': {
      // 花が光を集めて開く: 上へ駆け上がる音と、開いた瞬間の鐘
      const notes = run(h.chord, 60, 7);
      return [
        sweep(-0.3, 1.6, 600, 4200, 0.1, 0.9),
        ...notes.map((m, i) => g(i * 0.11, 'harp', m, 0.34 + i * 0.015, 2.4)),
        g(0.8, 'bell', notes[4] + 12, 0.42),
        g(0.86, 'bell', notes[2] + 12, 0.38),
        g(0.92, 'bell', notes[6], 0.36),
      ];
    }
    case 'greenhouse.dewfall': {
      // 露が一斉に落ちて床で鳴る: 1.8 秒にばらけた水滴
      const evs: Ev[] = [];
      for (let k = 0; k < 18; k++) {
        const dt = 0.05 + hash01(k, 91) * 1.75;
        const midi = pick(h, 80 + hash01(k, 92) * 18, 76, 100);
        evs.push(g(dt, 'drop', midi, 0.22 + hash01(k, 93) * 0.2, undefined, (hash01(k, 94) * 2 - 1) * 0.85));
      }
      return evs;
    }
    case 'rain.freeze':
      // 雨粒がガラス玉に変わって止まる: ほぼ無音の中に、小さな澄んだ音が一つ
      return [g(0.05, 'bell', pick(h, 93, 88, 100), 0.2), g(0.12, 'chime', pick(h, 100, 95, 105), 0.09)];
    case 'rain.doors':
      // 琥珀（左・低く暖かい）と瑠璃（右・高く冷たい）の二つの扉
      return [g(0, 'bell', pick(h, 64, 60, 70), 0.5, undefined, -0.55), g(0.34, 'chime', pick(h, 79, 74, 86), 0.42, undefined, 0.55)];
    case 'kaleidoscope.flower': {
      const notes = run(h.chord, 62, 8);
      return [sweep(-0.2, 1.5, 1500, 8000, 0.1, 1.5), ...notes.map((m, i) => g(i * 0.08, 'bottle', m, 0.42)), g(0.7, 'bell', notes[4] + 12, 0.42), g(0.78, 'bell', notes[2] + 24, 0.3)];
    }
    case 'celestial.blackout':
      // 2 秒の暗闇: 深い器の音と、光を吸い込む低い風
      return [sweep(0, 2.0, 3000, 120, 0.16, 0.8), g(0, 'bowl', 33, 0.6)];
    case 'celestial.stars':
      // 星が一つずつ灯る: 高い音が上へ向かって一つずつ
      return Array.from({ length: 7 }, (_, i) => g(i * 0.3, i % 2 ? 'chime' : 'bell', pick(h, 84 + i * 2.4, 80, 102), 0.2 + i * 0.025));
    case 'celestial.constellation': {
      // 楽曲の頂点: 星がつながる瞬間の、全体を持ち上げる大きな和音
      const notes = run(h.chord, 52, 5);
      return [
        sweep(-0.4, 1.8, 400, 9000, 0.14, 0.8),
        g(0, 'bowl', 28, 0.7),
        pad(0, 'strings', run(h.chord, 40, 3), 0.55, 4.5),
        ...notes.map((m, i) => g(0.05 + i * 0.05, 'harp', m + 12, 0.4, 3.4)),
        ...Array.from({ length: 8 }, (_, i) => g(0.2 + i * 0.12, 'bell', pick(h, 80 + i * 3, 76, 104), 0.34)),
      ];
    }
    case 'dawn.sunrise': {
      const notes = run(h.chord, 60, 6);
      return [
        sweep(-0.5, 2.8, 300, 2600, 0.08, 0.8),
        pad(0, 'choir', run(h.chord, 52, 3), 0.5, 5),
        ...notes.map((m, i) => g(i * 0.2, 'harp', m, 0.34, 3)),
        g(0.9, 'bell', notes[4] + 12, 0.4),
        g(1.0, 'bell', notes[2] + 24, 0.3),
      ];
    }
    default:
      return null;
  }
}

/** 見どころの3秒前の誘導音: 上へ向かう三つの柔らかい音。方向から鳴らす（呼び出し側で空間に置く） */
export function lureEffect(h: Harmony): readonly Ev[] {
  const base = pick(h, 76, 70, 84);
  const notes = [base, nearestPitch(touchCandidates(h.key, h.chord), base + 4, base + 1, 98), nearestPitch(touchCandidates(h.key, h.chord), base + 9, base + 5, 100)];
  return notes.map((m, i) => g(i * 0.22, i === 2 ? 'bell' : 'chime', m, 0.34 + i * 0.06));
}

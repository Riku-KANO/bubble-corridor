// S-11 楽曲の構成データ、演奏の予定、触れた音、時計（親が作成。実装担当は変更しない）
// 音そのもの（音色の美しさ、盛り上がり）は dev/audio.html で人が聴いて確かめる。ここは決定的な部分だけ。
import { describe, expect, it } from 'vitest';
import type { DoorChoice, SectionId } from '../contracts/ids';
import { SECTION_IDS } from '../contracts/ids';
import { MOMENT_BARS, RIDE_BARS, SEC_PER_BAR, SECTIONS, TOUCH_GRID_BEATS } from '../config';
import { touchCandidates } from '../core/sound/scale';
import { createAudioClock } from './clock';
import { planNotes } from './conductor';
import { harmonyAt, membranePitch, SCORE, sectionScore } from './score';
import { createTouchGate, planHiddenChord, planTouch } from './touch';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const diatonic = (tonic: number, mode: 'major' | 'minor') => (mode === 'major' ? MAJOR : MINOR).map((x) => (x + tonic) % 12);
const pc = (midi: number) => ((midi % 12) + 12) % 12;
const T = (bar: number) => bar * SEC_PER_BAR;

describe('AUD-1 構成データ', () => {
  it('72BPM・4/4、7区間＋万華鏡の金と青、計 234 小節', () => {
    expect(SCORE.bpm).toBe(72);
    expect(SCORE.beatsPerBar).toBe(4);
    for (const id of SECTION_IDS) {
      const spec = SECTIONS.find((s) => s.id === id)!;
      const doors: DoorChoice[] = id === 'kaleidoscope' ? ['amber', 'lapis'] : ['lapis'];
      for (const door of doors) {
        const s = sectionScore(id, door);
        expect(s.section).toBe(id);
        expect(s.startBar, id).toBe(spec.startBar);
        expect(s.bars, id).toBe(spec.bars);
      }
    }
    const total = SECTION_IDS.reduce((n, id) => n + sectionScore(id, 'lapis').bars, 0);
    expect(total).toBe(RIDE_BARS);
  });

  it('万華鏡の金と青は、和音の進行か調が違う', () => {
    const a = sectionScore('kaleidoscope', 'amber');
    const b = sectionScore('kaleidoscope', 'lapis');
    expect(a.variant).toBe('amber');
    expect(b.variant).toBe('lapis');
    expect(JSON.stringify([a.key, a.chords])).not.toBe(JSON.stringify([b.key, b.chords]));
  });

  it('各区間は調と、小節0から始まる和音の進行（区間の小節数の中）を持つ', () => {
    for (const id of SECTION_IDS) {
      const s = sectionScore(id, 'lapis');
      expect(s.chords.length, id).toBeGreaterThanOrEqual(id === 'departure' ? 1 : 2);
      expect(s.chords[0].bar, id).toBe(0);
      for (let i = 1; i < s.chords.length; i++) expect(s.chords[i].bar).toBeGreaterThan(s.chords[i - 1].bar);
      for (const c of s.chords) expect(c.bar).toBeLessThan(s.bars);
    }
  });

  it('主題は温室で初めて現れ（4小節以内の旋律、調の音だけ）、天球で戻る', () => {
    const g = sectionScore('greenhouse', 'lapis');
    expect(g.theme.length).toBeGreaterThanOrEqual(4);
    const span = Math.max(...g.theme.map((n) => n.bar + n.beat / 4 + n.beats / 4)) - Math.min(...g.theme.map((n) => n.bar));
    expect(span).toBeLessThanOrEqual(4);
    for (const n of g.theme) expect(diatonic(g.key.tonic, g.key.mode)).toContain(pc(n.midi));
    expect(sectionScore('platform', 'lapis').theme).toEqual([]);
    expect(sectionScore('celestial', 'lapis').theme.length).toBeGreaterThan(0);
  });

  it('リズムの層は万華鏡で初めて入る', () => {
    for (const id of ['platform', 'greenhouse', 'rain'] as SectionId[]) {
      expect(sectionScore(id, 'lapis').layers.map((l) => l.kind), id).not.toContain('rhythm');
    }
    for (const door of ['amber', 'lapis'] as const) expect(sectionScore('kaleidoscope', door).layers.map((l) => l.kind)).toContain('rhythm');
  });

  it('残響: 雨の回廊は短く乾いた響き、天球は長く深い響き', () => {
    expect(['dry', 'small']).toContain(sectionScore('rain', 'lapis').reverb);
    expect(sectionScore('celestial', 'lapis').reverb).toBe('huge');
  });

  it('harmonyAt は時刻の区間の調と和音を返し、扉で万華鏡が変わる', () => {
    const h = harmonyAt(T(50), 'lapis');
    expect(h.section).toBe('greenhouse');
    expect(h.key).toEqual(sectionScore('greenhouse', 'lapis').key);
    expect(harmonyAt(T(120), 'amber').key).toEqual(sectionScore('kaleidoscope', 'amber').key);
    expect(harmonyAt(T(120), 'lapis').key).toEqual(sectionScore('kaleidoscope', 'lapis').key);
  });

  it('膜の通過音は6つとも音程が違う', () => {
    const p = [0, 1, 2, 3, 4, 5].map((i) => membranePitch(i));
    expect(new Set(p).size).toBe(6);
  });
});

describe('AUD-5 演奏の予定（先の音まで予約する）', () => {
  it('決定的で、窓の中の音だけを時刻順に返す', () => {
    const a = planNotes(100, 130, 'lapis');
    expect(a).toEqual(planNotes(100, 130, 'lapis'));
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].t).toBeGreaterThanOrEqual(100);
      expect(a[i].t).toBeLessThan(130);
      if (i > 0) expect(a[i].t).toBeGreaterThanOrEqual(a[i - 1].t);
    }
  });

  it('窓を分けて予約しても、まとめて予約したのと同じ（取りこぼし・二重がない）', () => {
    const whole = planNotes(200, 260, 'amber');
    const parts = [...planNotes(200, 213.37, 'amber'), ...planNotes(213.37, 241.1, 'amber'), ...planNotes(241.1, 260, 'amber')];
    expect(parts).toEqual(whole);
  });

  it('旋律と分散和音の音は、その区間の調の音', () => {
    for (const [t0, t1] of [
      [70, 110],
      [230, 260],
      [380, 420],
      [560, 600],
      [690, 720],
    ]) {
      for (const n of planNotes(t0, t1, 'amber')) {
        if (n.layer !== 'melody' && n.layer !== 'arpeggio') continue;
        const h = harmonyAt(n.t, 'amber');
        expect(diatonic(h.key.tonic, h.key.mode), `${n.layer} t=${n.t.toFixed(2)}`).toContain(pc(n.midi));
      }
    }
  });

  it('リズムは 6:00 より前に鳴らない', () => {
    expect(planNotes(0, T(108), 'lapis').filter((n) => n.layer === 'rhythm')).toEqual([]);
    expect(planNotes(T(108), T(144), 'lapis').some((n) => n.layer === 'rhythm')).toBe(true);
  });

  const loudness = (t0: number, t1: number, door: DoorChoice = 'lapis') => planNotes(t0, t1, door).reduce((s, n) => s + n.velocity, 0);

  it('雨が止まった瞬間（5:10）はほぼ無音（直前の15%未満）', () => {
    const freeze = T(MOMENT_BARS.rainFreeze);
    expect(loudness(freeze, freeze + 3)).toBeLessThan(loudness(freeze - 15, freeze - 12) * 0.15);
  });

  it('楽曲の頂点は天球の見どころ（9:50 を含む15秒が全体で最も大きい、10% の幅）', () => {
    const peakT = T(MOMENT_BARS.celestialConstellation);
    const peak = loudness(peakT - 5, peakT + 10);
    for (let t = 0; t + 15 <= 780; t += 15) expect(loudness(t, t + 15), `${t}s`).toBeLessThanOrEqual(peak * 1.1);
  });

  it('見どころ（花、模様、星座、朝日）の時刻ちょうどに音が始まる（小節の頭）', () => {
    for (const bar of [MOMENT_BARS.greenhouseBloom, MOMENT_BARS.kaleidoscopeFlower, MOMENT_BARS.celestialConstellation, MOMENT_BARS.dawnSunrise]) {
      const notes = planNotes(T(bar) - 0.001, T(bar) + 0.001, 'lapis');
      expect(notes.length, `小節 ${bar}`).toBeGreaterThan(0);
    }
  });

  it('扉の前は金と青で同じ、万華鏡では違う', () => {
    expect(planNotes(100, 130, 'amber')).toEqual(planNotes(100, 130, 'lapis'));
    expect(planNotes(T(110), T(118), 'amber')).not.toEqual(planNotes(T(110), T(118), 'lapis'));
  });
});

describe('AUD-2/3 触れた音', () => {
  it('次の8分音符に、その瞬間の和音と調の5音の共通部分から鳴らす', () => {
    for (const now of [65.1, 150.37, 300.2, 400.9, 600.05, 700.7]) {
      const h = harmonyAt(now, 'amber');
      const p = planTouch({ kind: 'leaf', section: h.section }, now, 'amber');
      const grid = (60 / SCORE.bpm) * TOUCH_GRID_BEATS;
      expect(p.at).toBeGreaterThanOrEqual(now);
      expect(p.at - now).toBeLessThanOrEqual(grid + 0.05);
      expect(Math.abs(p.at / grid - Math.round(p.at / grid))).toBeLessThan(1e-6);
      const at = harmonyAt(p.at, 'amber');
      expect(touchCandidates(at.key, at.chord)).toContain(pc(p.midi));
      expect(p.midi).toBeGreaterThanOrEqual(48);
      expect(p.midi).toBeLessThanOrEqual(100);
      expect(p.velocity).toBeGreaterThan(0);
      expect(p.velocity).toBeLessThanOrEqual(1);
    }
  });

  it('隠れた泡は特別な和音（同時に3音以上、すべて候補の音）', () => {
    const c = planHiddenChord('rain', 250.2, 'lapis');
    expect(c.length).toBeGreaterThanOrEqual(3);
    const h = harmonyAt(c[0].at, 'lapis');
    for (const n of c) {
      expect(n.at).toBe(c[0].at);
      expect(touchCandidates(h.key, h.chord)).toContain(pc(n.midi));
    }
    expect(new Set(c.map((n) => n.midi)).size).toBe(c.length);
  });
});

describe('AUD-4 うるさくならない', () => {
  it('同時に鳴る触れた音は8まで。鳴り終われば次を受ける', () => {
    const gate = createTouchGate();
    for (let i = 0; i < 8; i++) expect(gate.tryAcquire(`a${i}`, 10, 1)).toBe(true);
    expect(gate.tryAcquire('a8', 10.1, 1)).toBe(false);
    expect(gate.tryAcquire('a9', 11.05, 1)).toBe(true);
  });

  it('同じ物は0.3秒以内に再び鳴らない', () => {
    const gate = createTouchGate();
    expect(gate.tryAcquire('leaf-1', 5, 0.2)).toBe(true);
    expect(gate.tryAcquire('leaf-1', 5.29, 0.2)).toBe(false);
    expect(gate.tryAcquire('leaf-1', 5.31, 0.2)).toBe(true);
  });
});

describe('AUD-5 時計（楽曲の再生位置）', () => {
  it('AudioContext の時刻で進み、ポーズで止まり、同じ位置から続く', () => {
    const ctx = { currentTime: 5 };
    const clock = createAudioClock(ctx);
    expect(clock.running).toBe(false);
    clock.start(0);
    ctx.currentTime = 8;
    expect(clock.time).toBeCloseTo(3, 9);
    clock.pause();
    ctx.currentTime = 20;
    expect(clock.time).toBeCloseTo(3, 9);
    clock.resume();
    ctx.currentTime = 21;
    expect(clock.time).toBeCloseTo(4, 9);
    clock.seek(100);
    expect(clock.time).toBeCloseTo(100, 9);
    expect(clock.toContextTime(102)).toBeCloseTo(ctx.currentTime + 2, 9);
    ctx.currentTime = 10_000;
    expect(clock.time).toBeCloseTo(780, 6);
  });
});

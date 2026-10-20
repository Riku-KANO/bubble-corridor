// S-10 キューシートと出来事の配信（親が作成。実装担当は変更しない）
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Cue, CueName, EventBus, RideEvents } from '../contracts/events';
import { SEC_PER_BAR } from '../config';
import { buildCueSheet, createCueDispatcher, createRide, generateRideData } from './index';

const cues = buildCueSheet();
const ride = createRide(generateRideData());
const byName = (name: CueName) => cues.filter((c) => c.name === name);
const one = (name: CueName) => {
  const list = byName(name);
  expect(list, name).toHaveLength(1);
  return list[0];
};

function recorder(): { bus: EventBus; seen: Cue[] } {
  const seen: Cue[] = [];
  const bus: EventBus = {
    on: () => () => {},
    emit<K extends keyof RideEvents>(type: K, payload: RideEvents[K]) {
      if (type === 'cue') seen.push(payload as Cue);
    },
  };
  return { bus, seen };
}

describe('RIDE-5 キューシート', () => {
  it('時刻の昇順で、id は一意、t は小節から計算されている', () => {
    for (let i = 1; i < cues.length; i++) expect(cues[i].t).toBeGreaterThanOrEqual(cues[i - 1].t);
    expect(new Set(cues.map((c) => c.id)).size).toBe(cues.length);
    for (const c of cues) expect(c.t, c.id).toBeCloseTo(c.bar * SEC_PER_BAR, 6);
  });

  it('見どころと出来事の時刻が設計書どおり', () => {
    const expected: [CueName, number][] = [
      ['ride.start', 0],
      ['hint.touch', 20],
      ['greenhouse.bloom', 160],
      ['greenhouse.dewfall', 160 + SEC_PER_BAR],
      ['rain.freeze', 310],
      ['rain.doors', 350],
      ['kaleidoscope.flower', 440],
      ['celestial.blackout', 480],
      ['celestial.stars', 482],
      ['celestial.constellation', 590],
      ['dawn.sunrise', 710],
      ['departure.open', 750],
      ['ride.end', 780],
    ];
    for (const [name, t] of expected) expect(one(name).t, name).toBeCloseTo(t, 6);
  });

  it('見どころはすべて小節の頭にある', () => {
    for (const name of ['greenhouse.bloom', 'rain.freeze', 'rain.doors', 'kaleidoscope.flower', 'celestial.constellation', 'dawn.sunrise'] as const) {
      expect(Number.isInteger(Math.round(one(name).bar * 1e6) / 1e6), name).toBe(true);
    }
  });

  it('部屋の境目の膜は6つ（1:00 温室、3:30 回廊、6:00 万華鏡、8:00 天球、11:00 岸、12:30 乗り場）', () => {
    const m = byName('membrane');
    expect(m.map((c) => Math.round(c.t))).toEqual([60, 210, 360, 480, 660, 750]);
    expect(m.map((c) => c.data?.to)).toEqual(['greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn', 'departure']);
  });

  it('扉の確定は万華鏡の膜の手前（扉が現れた後、6:00 より前）', () => {
    const d = one('branch.decide');
    expect(d.t).toBeGreaterThan(350);
    expect(d.t).toBeLessThan(360);
  });

  it('見どころの3秒前に誘導がある（target に見どころの名前）', () => {
    const lures = byName('lure');
    for (const name of ['greenhouse.bloom', 'rain.freeze', 'kaleidoscope.flower', 'celestial.constellation', 'dawn.sunrise'] as const) {
      const target = one(name);
      const lure = lures.find((l) => l.data?.target === name);
      expect(lure, name).toBeDefined();
      expect(lure!.t).toBeCloseTo(target.t - 3, 6);
    }
  });

  it('自動撮影は 2:40 花、5:10 雨粒、9:50 星座の3か所', () => {
    const shots = byName('photo.capture').map((c) => [Math.round(c.t), c.data?.shot]);
    expect(shots).toEqual([
      [160, 'bloom'],
      [310, 'freeze'],
      [590, 'constellation'],
    ]);
  });

  it('各出来事の区間は、その時刻の区間', () => {
    for (const c of cues) expect(c.section, c.id).toBe(ride.sectionAt(c.t));
  });

  it('public/assets/cues.json は buildCueSheet と同じ（書き出し済み）', () => {
    const file = JSON.parse(readFileSync(new URL('../../public/assets/cues.json', import.meta.url), 'utf8')) as Cue[];
    expect(file).toEqual(cues);
  });
});

describe('RIDE-6 出来事の配信', () => {
  it('時刻が来た出来事を時刻順に一度だけ流す', () => {
    const { bus, seen } = recorder();
    const d = createCueDispatcher(cues, bus);
    d.update(0);
    expect(seen.map((c) => c.name)).toEqual(['ride.start']);
    d.update(19.99);
    expect(seen).toHaveLength(1);
    d.update(20);
    expect(seen.map((c) => c.name)).toEqual(['ride.start', 'hint.touch']);
    d.update(20);
    expect(seen).toHaveLength(2);
  });

  it('フレームが飛んでも取りこぼさない', () => {
    const { bus, seen } = recorder();
    const d = createCueDispatcher(cues, bus);
    d.update(400);
    expect(seen).toEqual(cues.filter((c) => c.t <= 400));
    d.update(780);
    expect(seen).toEqual(cues);
  });

  it('reset(t) の後は t より前の出来事を流さない', () => {
    const { bus, seen } = recorder();
    const d = createCueDispatcher(cues, bus);
    d.reset(300);
    d.update(300.5);
    expect(seen.every((c) => c.t >= 300)).toBe(true);
    d.update(315);
    expect(seen.map((c) => c.name)).toContain('rain.freeze');
    expect(seen.map((c) => c.name)).not.toContain('greenhouse.bloom');
  });

  it('時刻が戻っても（reset なしの巻き戻し）流し直さず、例外も出さない', () => {
    const { bus, seen } = recorder();
    const d = createCueDispatcher(cues, bus);
    d.update(200);
    const n = seen.length;
    d.update(100);
    d.update(200);
    expect(seen).toHaveLength(n);
  });

  it('reset で巻き戻せば、その時刻から先を流し直す', () => {
    const { bus, seen } = recorder();
    const d = createCueDispatcher(cues, bus);
    d.update(200);
    d.reset(150);
    seen.length = 0;
    d.update(170);
    expect(seen.map((c) => c.name)).toContain('greenhouse.bloom');
  });
});

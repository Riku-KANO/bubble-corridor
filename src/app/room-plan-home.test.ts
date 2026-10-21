// S-25 入口で止まる確認用（?screen=home&t=）の部屋の計画と、ライドフォトの計画、空気の部屋の選び方（実装担当が追加）
// 乗る時刻の部屋を入口にいる間も持っておく（毎フレーム入口の計画を渡すので、HOME_PLAN だけだと先に読んだ部屋が解放されてしまう）
import { describe, expect, it } from 'vitest';
import type { ScreenId } from '../contracts/ui';
import { SECTION_IDS } from '../contracts/ids';
import { createRide, generateRideData, streamingPlan } from '../ride';
import { RIDE_DURATION } from '../config';
import { HOME_PLAN, atmosphereRoomFor, homePlanFor, planFor } from './room-plan';

const ride = createRide(generateRideData());

describe('入口にいる間の部屋の計画', () => {
  it('時刻の指定がなければ HOME_PLAN', () => {
    expect(homePlanFor(null, ride)).toBe(HOME_PLAN);
  });

  it('時刻つきで止まるときは、見える部屋は入口のまま、乗る時刻の部屋も持つ。同じ時刻なら同じ参照', () => {
    const p = homePlanFor(588, ride);
    expect([...p.visible]).toEqual([...HOME_PLAN.visible]);
    expect(p.keep).toEqual(expect.arrayContaining([...HOME_PLAN.keep, ...streamingPlan(588, ride).keep]));
    expect(homePlanFor(588, ride)).toBe(p);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.keep)).toBe(true);
  });
});

describe('ライドフォトの計画（P3-5）', () => {
  it('見せるのは降車の景色（降車の計画と同じ）。入口の部屋と最初の部屋も読み込んだままにする（「入口へ」で空にならない）', () => {
    const p = planFor('photo', 0, ride);
    expect(p.visible).toBe(streamingPlan(RIDE_DURATION, ride).visible);
    expect(p.keep).toEqual(expect.arrayContaining([...p.visible, ...HOME_PLAN.keep]));
    expect(new Set(p.keep).size).toBe(p.keep.length);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.keep)).toBe(true);
    expect(planFor('photo', 500, ride)).toBe(p);
  });
});

describe('背景と擬似照明の元にする部屋の空気', () => {
  it('乗車中・ポーズ・ライドフォトは今の区間の部屋（降車は乗り場）、ほかは入口の部屋', () => {
    expect(atmosphereRoomFor('riding', 'rain')).toBe('rain');
    expect(atmosphereRoomFor('pause', 'celestial')).toBe('celestial');
    expect(atmosphereRoomFor('photo', 'departure')).toBe('platform');
    const others: ScreenId[] = ['queue', 'home', 'guide', 'shelf', 'settings', 'howto', 'credits'];
    for (const s of others) for (const section of SECTION_IDS) expect(atmosphereRoomFor(s, section), `${s} ${section}`).toBe('lobby');
  });
});

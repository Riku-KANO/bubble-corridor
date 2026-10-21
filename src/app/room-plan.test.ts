// S-25 乗車の外の部屋の計画（親が作成。実装担当は変更しない）
// 降車して入口へ戻ったとき、最後の乗車の計画が残ると、入口の背景が前の部屋の空気のままになり、乗り場と待ち列の部屋が解放されて
// もう一度乗ると頭で部屋が空になる（S-24 レビュー1巡目の申し送り）。画面ごとに、凍結した定数の計画を渡す。
import { describe, expect, it } from 'vitest';
import type { ScreenId } from '../contracts/ui';
import { RIDE_DURATION } from '../config';
import { createRide, generateRideData, streamingPlan } from '../ride';
import { HOME_PLAN, planFor } from './room-plan';

const ride = createRide(generateRideData());

describe('乗車の外では入口の部屋の計画', () => {
  it('HOME_PLAN は待ち列・入口（lobby）と乗り場（platform）を見せ、最初の部屋（greenhouse）も読み込んでおく。凍結した定数', () => {
    expect([...HOME_PLAN.visible]).toEqual(['lobby', 'platform']);
    expect(HOME_PLAN.keep).toEqual(expect.arrayContaining(['lobby', 'platform', 'greenhouse']));
    expect(Object.isFrozen(HOME_PLAN)).toBe(true);
    expect(Object.isFrozen(HOME_PLAN.visible)).toBe(true);
    expect(Object.isFrozen(HOME_PLAN.keep)).toBe(true);
  });

  it('待ち列・入口・案内・棚・設定・乗り方・クレジットでは HOME_PLAN（時刻に依らず同じ参照。部屋の管理は参照で同じ計画かを比べる）', () => {
    const screens: ScreenId[] = ['queue', 'home', 'guide', 'shelf', 'settings', 'howto', 'credits'];
    for (const s of screens) for (const t of [0, 300, RIDE_DURATION]) expect(planFor(s, t, ride), `${s} t=${t}`).toBe(HOME_PLAN);
  });

  it('乗車中とポーズは、その時刻の streamingPlan', () => {
    for (const t of [0, 61, 300, 480, 700]) {
      expect(planFor('riding', t, ride)).toBe(streamingPlan(t, ride));
      expect(planFor('pause', t, ride)).toBe(streamingPlan(t, ride));
    }
  });

  it('ライドフォト（降車の後）は降車の景色のまま（乗り場が見える）', () => {
    const p = planFor('photo', RIDE_DURATION, ride);
    expect(p.visible).toContain('platform');
    expect(planFor('photo', 100, ride)).toBe(p);
  });
});

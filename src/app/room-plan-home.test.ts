// S-25 入口で止まる確認用（?screen=home&t=）の部屋の計画（実装担当が追加）
// 乗る時刻の部屋を入口にいる間も持っておく（毎フレーム入口の計画を渡すので、HOME_PLAN だけだと先に読んだ部屋が解放されてしまう）
import { describe, expect, it } from 'vitest';
import { createRide, generateRideData, streamingPlan } from '../ride';
import { HOME_PLAN, homePlanFor } from './room-plan';

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

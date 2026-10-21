// S-25 乗車の外の部屋の計画（親が作成。実装担当は変更しない）
// 降車して入口へ戻ったとき、最後の乗車の計画が残ると、入口の背景が前の部屋の空気のままになり、乗り場と待ち列の部屋が解放されて
// もう一度乗ると頭で部屋が空になる（S-24 レビュー1巡目の申し送り）。画面ごとに、凍結した定数の計画を渡す。
import { describe, expect, it } from 'vitest';
import type { RidePose } from '../contracts/ride';
import type { ScreenId } from '../contracts/ui';
import { RIDE_DURATION } from '../config';
import { createRide, generateRideData, streamingPlan } from '../ride';
import { HOME_PLAN, planFor, sceneScreenFor, sceneTimeFor } from './room-plan';

const ride = createRide(generateRideData());

describe('乗車の外では入口の部屋の計画', () => {
  it('HOME_PLAN は待ち列・入口（lobby）と乗り場（platform）を見せて読み込む。温室は待ち列の間に読まない（初回の読み込み 10MB 以下。関門4。S-29）。凍結した定数', () => {
    expect([...HOME_PLAN.visible]).toEqual(['lobby', 'platform']);
    expect([...HOME_PLAN.keep].sort()).toEqual(['lobby', 'platform']);
    expect(Object.isFrozen(HOME_PLAN)).toBe(true);
    expect(Object.isFrozen(HOME_PLAN.visible)).toBe(true);
    expect(Object.isFrozen(HOME_PLAN.keep)).toBe(true);
  });

  it('温室は乗車の頭から読み込み始める（膜の15秒前に描くまで45秒ある）', () => {
    expect(planFor('riding', 0, ride).keep).toContain('greenhouse');
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

describe('ゴンドラの位置を決める時刻（降車の瞬間に回らない。レビュー1巡目 P2-2）', () => {
  it('乗車中とポーズは乗車の時刻', () => {
    for (const t of [0, 300, 779]) {
      expect(sceneTimeFor('riding', t)).toBe(t);
      expect(sceneTimeFor('pause', t)).toBe(t);
    }
  });

  it('ライドフォトは降車の時刻のまま（乗車の時計が止まっても、VR で世界が回らない）', () => {
    for (const t of [0, 300, RIDE_DURATION]) expect(sceneTimeFor('photo', t)).toBe(RIDE_DURATION);
    const pose = (): RidePose => ({ x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 });
    const end = ride.poseAt(RIDE_DURATION, 'standard', pose());
    const photo = ride.poseAt(sceneTimeFor('photo', 0), 'standard', pose());
    expect(photo.yaw).toBeCloseTo(end.yaw, 9);
  });

  it('ほかの画面（待ち列・入口・案内・棚・設定・乗り方・クレジット）は乗車の頭', () => {
    const screens: ScreenId[] = ['queue', 'home', 'guide', 'shelf', 'settings', 'howto', 'credits'];
    for (const s of screens) expect(sceneTimeFor(s, 300), s).toBe(0);
  });
});

describe('小画面（棚・設定・乗り方・クレジット）は、開いた元の画面の景色のまま（S-25 レビュー2巡目 P3-1。S-29）', () => {
  it('ライドフォトから開いた小画面は、ライドフォトの景色（降車の時刻と計画）', () => {
    for (const sub of ['shelf', 'settings', 'howto', 'credits'] as const) {
      expect(sceneScreenFor(sub, 'photo')).toBe('photo');
      expect(sceneTimeFor(sceneScreenFor(sub, 'photo'), 0)).toBe(RIDE_DURATION);
      expect(planFor(sceneScreenFor(sub, 'photo'), 0, ride)).toBe(planFor('photo', 0, ride));
    }
  });

  it('入口から開いた小画面と、小画面でない画面は、その画面のまま', () => {
    expect(sceneScreenFor('settings', 'home')).toBe('home');
    expect(sceneScreenFor('settings', null)).toBe('settings');
    for (const s of ['queue', 'home', 'guide', 'riding', 'pause', 'photo'] as const) expect(sceneScreenFor(s, 'photo')).toBe(s);
  });
});

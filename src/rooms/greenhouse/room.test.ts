// S-20 第1室「朝露の温室」（親が作成。実装担当は変更しない）
import { describe, expect, it } from 'vitest';
import { INTERACTION, MOMENT_BARS, SEC_PER_BAR } from '../../config';
import {
  backgroundHsl,
  clearanceViolations,
  cues,
  drawStats,
  expectBlenderRoom,
  expectExitMembrane,
  expectFocusAhead,
  expectHiddenBubble,
  expectRoomContract,
  loadRoom,
  reachableFraction,
  sectionTimes,
  shapeClearanceViolations,
  timeDeterminismDiffs,
} from '../testing';
import { createGreenhouseRoom } from './index';

const BLOOM = MOMENT_BARS.greenhouseBloom * SEC_PER_BAR;

describe('第1室 朝露の温室', () => {
  it('部屋の契約', async () => {
    await expectRoomContract(createGreenhouseRoom, ['greenhouse']);
  });

  it('BLD-4〜7 Blender で造形して焼いた glb とライトマップを読む（blender/scripts/rooms/greenhouse.py）', async () => {
    await expectBlenderRoom(createGreenhouseRoom, 'greenhouse');
  });

  it('RIDE-8 clearanceExempt の物も本当の形で 0.5m 以上（区間の前後 3m まで。ADR-0013）', async () => {
    const { room } = await loadRoom(createGreenhouseRoom);
    expect(shapeClearanceViolations(room, ['greenhouse'])).toEqual([]);
  });

  it('RIDE-8 ゴンドラの表面から物まで 0.5m 以上', async () => {
    const { room } = await loadRoom(createGreenhouseRoom);
    expect(clearanceViolations(room, ['greenhouse']).slice(0, 5)).toEqual([]);
  });

  it('INT-5 見どころ（2:40 ガラスの花）は誘導の時刻にも見どころの時刻にも正面にある', async () => {
    const { room } = await loadRoom(createGreenhouseRoom);
    expectFocusAhead(room, 'greenhouse.bloom', BLOOM - 3);
    expectFocusAhead(room, 'greenhouse.bloom', BLOOM);
    expect(room.focusPoint('rain.freeze')).toBeNull();
  });

  it('INT-1 葉（12枚以上）と蕾（1つ以上）。葉の7割以上はレールから縁が光る距離に来る', async () => {
    const { room } = await loadRoom(createGreenhouseRoom);
    expect(room.touchables.filter((t) => t.kind === 'leaf').length).toBeGreaterThanOrEqual(12);
    expect(room.touchables.filter((t) => t.kind === 'bud').length).toBeGreaterThanOrEqual(1);
    expect(reachableFraction(room, 'leaf', ['greenhouse'], INTERACTION.highlightDistance)).toBeGreaterThanOrEqual(0.7);
  });

  it('INT-6 隠れた小さな泡', async () => {
    await expectHiddenBubble(createGreenhouseRoom, 'greenhouse');
  });

  it('TRN-1 雨の回廊への膜', async () => {
    const { room } = await loadRoom(createGreenhouseRoom);
    expectExitMembrane(room, 'greenhouse');
  });

  it('朝の明るい空気（若葉の緑と白）', async () => {
    const { room } = await loadRoom(createGreenhouseRoom);
    expect(backgroundHsl(room).l).toBeGreaterThan(0.6);
  });

  it('柱「時刻から決める」: 通しで乗った絵と、その時刻から始めた絵が同じ（露の光の輪が凍って残らない。レビュー1巡目 P1-3）', async () => {
    const dew = cues.find((c) => c.name === 'greenhouse.dewfall')!.t;
    const { t0 } = sectionTimes('greenhouse');
    for (const at of [t0 + 20, BLOOM - 3, BLOOM + 1, dew + 1, dew + 3, dew + 30]) {
      expect(await timeDeterminismDiffs(createGreenhouseRoom, t0 - 5, at), `t=${at.toFixed(1)}`).toEqual([]);
    }
  });

  it('光の強い場面（2:40 の花）の直前は少し暗くし、明るさの差で驚きを作る（レビュー1巡目 P1-4）', async () => {
    const h = await loadRoom(createGreenhouseRoom);
    const { t0 } = sectionTimes('greenhouse');
    h.frame(t0 + 30);
    const room = h.room.atmosphere.exposure;
    h.frame(BLOOM - 2);
    const before = h.room.atmosphere.exposure;
    h.frame(BLOOM + 1);
    const after = h.room.atmosphere.exposure;
    expect(before, '直前は部屋より暗い').toBeLessThanOrEqual(room - 0.15);
    expect(after, '花が開いたら戻る').toBeGreaterThanOrEqual(before + 0.15);
  });

  it('ガラスの擬似照明は空気で渡す（斜めに差し込む朝日。レビュー1巡目 P2-2）', async () => {
    const h = await loadRoom(createGreenhouseRoom);
    h.frame(120);
    const l = h.room.atmosphere.glassLighting;
    expect(l).toBeDefined();
    expect(l!.keyDir, '朝日の向き').toBeDefined();
  });

  it('REN-3 描画の予算（描く物 120 以下、三角形 120万以下、low は high の6割以下）', async () => {
    const high = drawStats((await loadRoom(createGreenhouseRoom, { tier: 'high' })).room.root);
    const low = drawStats((await loadRoom(createGreenhouseRoom, { tier: 'low' })).room.root);
    expect(high.drawables).toBeLessThanOrEqual(120);
    expect(high.triangles).toBeLessThanOrEqual(1_200_000);
    expect(low.triangles).toBeLessThanOrEqual(high.triangles * 0.6);
  });
});

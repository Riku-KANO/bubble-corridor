// S-22 第5室「夜明けの岸」（親が作成。実装担当は変更しない）
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { MOMENT_BARS, SEC_PER_BAR } from '../../config';
import {
  backgroundHsl,
  clearanceViolations,
  drawStats,
  expectBlenderRoom,
  expectExitMembrane,
  expectFocusAhead,
  expectHiddenBubble,
  expectRoomContract,
  loadRoom,
  sectionTimes,
  shapeClearanceViolations,
} from '../testing';
import { createDawnRoom } from './index';

const SUNRISE = MOMENT_BARS.dawnSunrise * SEC_PER_BAR;

describe('第5室 夜明けの岸', () => {
  it('部屋の契約', async () => {
    await expectRoomContract(createDawnRoom, ['dawn']);
  });

  it('BLD-4〜7 Blender で造形して焼いた glb とライトマップを読む（blender/scripts/rooms/dawn.py）', async () => {
    await expectBlenderRoom(createDawnRoom, 'dawn');
  });

  it('RIDE-8 clearanceExempt の物も本当の形で 0.5m 以上（区間の前後 3m まで。殻・膜・水面は除く。ADR-0013）', async () => {
    const { room } = await loadRoom(createDawnRoom);
    expect(shapeClearanceViolations(room, ['dawn'])).toEqual([]);
  });

  it('RIDE-8 ゴンドラの表面から物まで 0.5m 以上（水面は除く）', async () => {
    const { room } = await loadRoom(createDawnRoom);
    expect(clearanceViolations(room, ['dawn']).slice(0, 5)).toEqual([]);
  });

  it('INT-5 見どころ（11:50 朝日）は正面にある', async () => {
    const { room } = await loadRoom(createDawnRoom);
    expectFocusAhead(room, 'dawn.sunrise', SUNRISE - 3);
    expectFocusAhead(room, 'dawn.sunrise', SUNRISE);
  });

  it('INT-1 水面に触れられる（波紋）', async () => {
    const { room } = await loadRoom(createDawnRoom);
    const water = room.touchables.filter((t) => t.kind === 'water');
    expect(water.length).toBeGreaterThanOrEqual(1);
    expect(() => water[0].onTouch({ t: 690, source: 'pointer', point: [0, 0, 0] })).not.toThrow();
  });

  it('朝日が昇ると空気が明るく暖かくなる（金・桃色）', async () => {
    const h = await loadRoom(createDawnRoom);
    h.play(sectionTimes('dawn').t0, sectionTimes('dawn').t0 + 5, 0.5);
    const before = backgroundHsl(h.room);
    h.play(sectionTimes('dawn').t0 + 5, SUNRISE + 5, 0.5);
    const after = backgroundHsl(h.room);
    expect(after.l).toBeGreaterThan(before.l + 0.1);
    expect(after.h <= 60 || after.h >= 320).toBe(true);
  });

  it('朝日の光の向きと色は空気（atmosphere.glassLighting）で渡す: 日が昇るにつれて光が上から、暖かく（レビュー1巡目 P1）', async () => {
    const h = await loadRoom(createDawnRoom);
    h.play(sectionTimes('dawn').t0, SUNRISE - 10, 0.5);
    const before = h.room.atmosphere.glassLighting;
    h.play(SUNRISE - 10, SUNRISE + 5, 0.5);
    const after = h.room.atmosphere.glassLighting;
    expect(before?.keyDir, '日の出の前の光の向き').toBeDefined();
    expect(after?.keyDir, '日の出の後の光の向き').toBeDefined();
    expect(after!.keyDir!.y).toBeGreaterThan(before!.keyDir!.y);
    const c = new THREE.Color(after!.keyColor ?? '#ffffff');
    expect(c.r).toBeGreaterThan(c.b);
  });

  it('INT-6 隠れた小さな泡', async () => {
    await expectHiddenBubble(createDawnRoom, 'dawn');
  });

  it('TRN-1 乗り場（降車）への膜', async () => {
    const { room } = await loadRoom(createDawnRoom);
    expectExitMembrane(room, 'dawn');
  });

  it('REN-3 描画の予算（描く物 100 以下、三角形 100万以下）', async () => {
    const s = drawStats((await loadRoom(createDawnRoom)).room.root);
    expect(s.drawables).toBeLessThanOrEqual(100);
    expect(s.triangles).toBeLessThanOrEqual(1_000_000);
  });
});

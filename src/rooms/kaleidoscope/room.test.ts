// S-21 第3室「万華鏡の間」（金と青）（親が作成。実装担当は変更しない）
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
  findByRole,
  loadRoom,
  sectionTimes,
  shapeClearanceViolations,
} from '../testing';
import { createKaleidoscopeRoom } from './index';

const FLOWER = MOMENT_BARS.kaleidoscopeFlower * SEC_PER_BAR;

describe('第3室 万華鏡の間', () => {
  it('部屋の契約', async () => {
    await expectRoomContract(createKaleidoscopeRoom, ['kaleidoscope']);
  });

  it('BLD-4〜7 Blender で造形して焼いた glb とライトマップを読む（blender/scripts/rooms/kaleidoscope.py）', async () => {
    await expectBlenderRoom(createKaleidoscopeRoom, 'kaleidoscope');
  });

  it('RIDE-8 clearanceExempt の物（壁・穹窿・鏡の板など）も本当の形で 0.5m 以上（区間の前後 3m まで。ADR-0013）', async () => {
    const h = await loadRoom(createKaleidoscopeRoom);
    h.play(sectionTimes('kaleidoscope').t0, sectionTimes('kaleidoscope').t1, 1);
    expect(shapeClearanceViolations(h.room, ['kaleidoscope'])).toEqual([]);
  });

  it('RIDE-8 ゴンドラの表面から物まで 0.5m 以上', async () => {
    const { room } = await loadRoom(createKaleidoscopeRoom);
    expect(clearanceViolations(room, ['kaleidoscope']).slice(0, 5)).toEqual([]);
  });

  it('INT-8 扉で金と青に変わる（琥珀と金の暖かい光 / 瑠璃と水色の冷たい光）', async () => {
    const { room } = await loadRoom(createKaleidoscopeRoom);
    room.setDoor?.('amber');
    const gold = backgroundHsl(room);
    room.setDoor?.('lapis');
    const blue = backgroundHsl(room);
    expect(gold.h).toBeGreaterThanOrEqual(20);
    expect(gold.h).toBeLessThanOrEqual(60);
    expect(blue.h).toBeGreaterThanOrEqual(190);
    expect(blue.h).toBeLessThanOrEqual(250);
  });

  it('INT-5 見どころ（7:20 花の模様）は正面にある', async () => {
    const { room } = await loadRoom(createKaleidoscopeRoom);
    expectFocusAhead(room, 'kaleidoscope.flower', FLOWER - 3);
    expectFocusAhead(room, 'kaleidoscope.flower', FLOWER);
  });

  it('INT-1 ガラス片（12以上）に触れられる', async () => {
    const { room } = await loadRoom(createKaleidoscopeRoom);
    expect(room.touchables.filter((t) => t.kind === 'shard').length).toBeGreaterThanOrEqual(12);
  });

  it('触れたガラス片の動きは時刻から決まる（フレームの刻み方に依らず、同じ時刻なら同じ向き。レビュー1巡目 P1-1）', async () => {
    const run = async (dt: number) => {
      const h = await loadRoom(createKaleidoscopeRoom);
      const shard = h.room.touchables.filter((t) => t.kind === 'shard')[0]!;
      h.frame(380, 1 / 60);
      shard.onTouch({ t: 380, source: 'pointer', point: [0, 0, 0] });
      // 回っている途中（触れて 0.4 秒後）の向きを、刻み方を変えて比べる
      const steps = Math.round(0.4 / dt);
      for (let i = 1; i <= steps; i++) h.frame(380 + i * dt, dt);
      shard.object.updateMatrixWorld(true);
      return shard.object.getWorldQuaternion(new THREE.Quaternion());
    };
    const fine = await run(0.4 / 48);
    const coarse = await run(0.1);
    expect(fine.angleTo(coarse)).toBeLessThan(1e-3);
  });

  it('RIDE-4 穏やかモードでは模様の回転を止める（標準では回る）', async () => {
    const rot = async (comfort: 'standard' | 'gentle') => {
      const h = await loadRoom(createKaleidoscopeRoom, { comfort });
      const patterns = findByRole(h.room.root, 'pattern');
      expect(patterns.length).toBeGreaterThan(0);
      h.frame(370, 1 / 60, comfort);
      const a = patterns.map((p) => p.quaternion.clone());
      for (let t = 370; t <= 380; t += 0.25) h.frame(t, 0.25, comfort);
      return patterns.every((p, i) => p.quaternion.angleTo(a[i]) < 1e-4);
    };
    expect(await rot('gentle')).toBe(true);
    expect(await rot('standard')).toBe(false);
  });

  it('INT-6 隠れた小さな泡', async () => {
    await expectHiddenBubble(createKaleidoscopeRoom, 'kaleidoscope');
  });

  it('TRN-1 天球への膜', async () => {
    const { room } = await loadRoom(createKaleidoscopeRoom);
    expectExitMembrane(room, 'kaleidoscope');
  });

  it('REN-3 描画の予算（描く物 120 以下、三角形 120万以下）', async () => {
    const s = drawStats((await loadRoom(createKaleidoscopeRoom)).room.root);
    expect(s.drawables).toBeLessThanOrEqual(120);
    expect(s.triangles).toBeLessThanOrEqual(1_200_000);
  });
});

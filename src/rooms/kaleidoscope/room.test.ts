// S-21 第3室「万華鏡の間」（金と青）（親が作成。実装担当は変更しない）
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

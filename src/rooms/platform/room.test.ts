// S-20 乗り場「泡の発着場」と降車（親が作成。実装担当は変更しない）
import { describe, expect, it } from 'vitest';
import {
  backgroundHsl,
  clearanceViolations,
  drawStats,
  expectBlenderRoom,
  expectExitMembrane,
  expectRoomContract,
  loadRoom,
  sectionTimes,
} from '../testing';
import { createPlatformRoom } from './index';

describe('乗り場と降車', () => {
  it('部屋の契約', async () => {
    await expectRoomContract(createPlatformRoom, ['platform', 'departure']);
  });

  it('BLD-4〜7 Blender で造形して焼いた glb とライトマップを読む（blender/scripts/rooms/platform.py）', async () => {
    await expectBlenderRoom(createPlatformRoom, 'platform');
  });

  it('RIDE-8 ゴンドラ（半径1.2m）の表面から物まで 0.5m 以上（水面は除く）', async () => {
    const { room } = await loadRoom(createPlatformRoom);
    expect(clearanceViolations(room, ['platform', 'departure']).slice(0, 5)).toEqual([]);
  });

  it('INT-4 吊られた泡（6つ以上）は触れると鳴り、近づくと自分でも鳴る', async () => {
    const { room } = await loadRoom(createPlatformRoom);
    const bubbles = room.touchables.filter((t) => t.kind === 'hanging-bubble');
    expect(bubbles.length).toBeGreaterThanOrEqual(6);
    expect(bubbles.every((b) => b.idleChime)).toBe(true);
  });

  it('TRN-1 膜の門（温室への出口）', async () => {
    const { room } = await loadRoom(createPlatformRoom);
    expectExitMembrane(room, 'platform');
  });

  it('夜明け前の青灰 → 降車では朝の光に変わる', async () => {
    const h = await loadRoom(createPlatformRoom);
    h.frame(30);
    const before = backgroundHsl(h.room);
    expect(before.h).toBeGreaterThanOrEqual(180);
    expect(before.h).toBeLessThanOrEqual(250);
    expect(before.l).toBeLessThan(0.45);
    h.play(sectionTimes('departure').t0, sectionTimes('departure').t0 + 15, 0.5);
    expect(backgroundHsl(h.room).l).toBeGreaterThan(before.l + 0.15);
  });

  it('REN-3 描画の予算（描く物 80 以下、三角形 60万以下）', async () => {
    const { room } = await loadRoom(createPlatformRoom);
    const s = drawStats(room.root);
    expect(s.drawables).toBeLessThanOrEqual(80);
    expect(s.triangles).toBeLessThanOrEqual(600_000);
  });
});

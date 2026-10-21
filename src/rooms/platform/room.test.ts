// S-20 乗り場「泡の発着場」と降車（親が作成。実装担当は変更しない）
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { RidePose } from '../../contracts/ride';
import { GONDOLA_DIAMETER, MOTION } from '../../config';
import {
  backgroundHsl,
  clearanceViolations,
  drawStats,
  expectBlenderRoom,
  expectExitMembrane,
  expectRoomContract,
  loadRoom,
  ride,
  sectionTimes,
  shapeClearanceViolations,
  timeDeterminismDiffs,
} from '../testing';
import { createPlatformRoom } from './index';

describe('乗り場と降車', () => {
  it('部屋の契約', async () => {
    await expectRoomContract(createPlatformRoom, ['platform', 'departure']);
  });

  it('BLD-4〜7 Blender で造形して焼いた glb とライトマップを読む（blender/scripts/rooms/platform.py）', async () => {
    await expectBlenderRoom(createPlatformRoom, 'platform');
  });

  it('RIDE-8 clearanceExempt の物も本当の形で 0.5m 以上（区間の前後 3m まで。ADR-0013）', async () => {
    const { room } = await loadRoom(createPlatformRoom);
    expect(shapeClearanceViolations(room, ['platform', 'departure'])).toEqual([]);
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

  it('RIDE-8 触れた吊られた泡は、揺れてもゴンドラの表面から 0.5m 以上（押された向きへ振れる。レビュー1巡目 P1-1）', async () => {
    const need = GONDOLA_DIAMETER / 2 + MOTION.clearanceMin;
    const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
    const h = await loadRoom(createPlatformRoom);
    const { t0, t1 } = sectionTimes('platform');
    const bubbles = h.room.touchables.filter((t) => t.kind === 'hanging-bubble');
    const center = new THREE.Vector3();
    for (const b of bubbles) {
      // ゴンドラがいちばん近づく時刻に触れる（最も危ない場合）
      let best = t0;
      let bestD = Infinity;
      for (let t = t0; t <= t1; t += 0.5) {
        ride.poseAt(t, 'standard', pose);
        h.frame(t, 0.5);
        h.room.root.updateMatrixWorld(true);
        const d = b.object.getWorldPosition(center).distanceTo(new THREE.Vector3(pose.x, pose.y, pose.z));
        if (d < bestD) [bestD, best] = [d, t];
      }
      h.frame(best - 0.1, 1 / 30);
      ride.poseAt(best - 0.1, 'standard', pose);
      b.onTouch({ t: best - 0.1, source: 'pointer', point: [pose.x, pose.y, pose.z] });
      for (let t = best - 0.1; t <= best + 3; t += 1 / 30) {
        h.frame(t, 1 / 30);
        ride.poseAt(t, 'standard', pose);
        // 泡は吊る点（親）ごと回るので、部屋全体の世界の行列を更新してから測る
        h.room.root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(b.object);
        const d = box.distanceToPoint(new THREE.Vector3(pose.x, pose.y, pose.z));
        expect(d, `${b.id} の t=${t.toFixed(2)} の距離`).toBeGreaterThanOrEqual(need);
      }
    }
  });

  it('柱「時刻から決める」: 通しで乗った絵と、その時刻から始めた絵が同じ', async () => {
    for (const at of [20, 45, 58, 665, 700, 740, 762, 775]) {
      const from = at < 100 ? 0 : at < 750 ? 655 : sectionTimes('departure').t0 - 5;
      expect(await timeDeterminismDiffs(createPlatformRoom, from, at), `t=${at}`).toEqual([]);
    }
  });

  it('ガラスの擬似照明は空気で渡す（夜明け前と降車の朝。レビュー1巡目 P2-2）', async () => {
    const h = await loadRoom(createPlatformRoom);
    h.frame(30);
    expect(h.room.atmosphere.glassLighting, '夜明け前').toBeDefined();
    const before = h.room.atmosphere.glassLighting;
    h.play(sectionTimes('departure').t0, sectionTimes('departure').t0 + 15, 0.5);
    expect(h.room.atmosphere.glassLighting, '降車の朝').toBeDefined();
    expect(h.room.atmosphere.glassLighting).not.toBe(before);
  });

  it('REN-3 描画の予算（描く物 80 以下、三角形 60万以下）', async () => {
    const { room } = await loadRoom(createPlatformRoom);
    const s = drawStats(room.root);
    expect(s.drawables).toBeLessThanOrEqual(80);
    expect(s.triangles).toBeLessThanOrEqual(600_000);
  });
});

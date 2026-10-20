// S-22 第4室「星の天球」（親が作成。実装担当は変更しない）
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { RidePose } from '../../contracts/ride';
import { CELESTIAL_BLACKOUT_SEC, MOMENT_BARS, SEC_PER_BAR } from '../../config';
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
  ride,
  sectionTimes,
  worldCenter,
} from '../testing';
import { createCelestialRoom } from './index';

const CONSTELLATION = MOMENT_BARS.celestialConstellation * SEC_PER_BAR;

describe('第4室 星の天球', () => {
  it('部屋の契約', async () => {
    await expectRoomContract(createCelestialRoom, ['celestial']);
  });

  it('BLD-4〜7 Blender で造形して焼いた glb とライトマップを読む（blender/scripts/rooms/celestial.py）', async () => {
    await expectBlenderRoom(createCelestialRoom, 'celestial');
  });

  it('RIDE-8 ゴンドラの表面から物まで 0.5m 以上（通り抜ける殻は除く）', async () => {
    const { room } = await loadRoom(createCelestialRoom);
    expect(clearanceViolations(room, ['celestial']).slice(0, 5)).toEqual([]);
  });

  it('何層もの透明な球の殻（4層以上、同心、半径が違う）を通り抜けて、9:50 に中心に着く', async () => {
    const { room } = await loadRoom(createCelestialRoom);
    const shells = findByRole(room.root, 'shell');
    expect(shells.length).toBeGreaterThanOrEqual(4);
    const centers = shells.map((s) => worldCenter(s));
    const radii = shells.map((s) => new THREE.Box3().setFromObject(s).getSize(new THREE.Vector3()).x / 2).sort((a, b) => a - b);
    for (const c of centers) expect(c.distanceTo(centers[0])).toBeLessThan(1);
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeGreaterThan(radii[i - 1] + 0.5);
    const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
    ride.poseAt(CONSTELLATION, 'standard', pose);
    expect(new THREE.Vector3(pose.x, pose.y, pose.z).distanceTo(centers[0])).toBeLessThan(radii[0]);
    for (const s of shells) {
      let exempt = false;
      for (let o: THREE.Object3D | null = s; o; o = o.parent) if (o.userData.clearanceExempt) exempt = true;
      expect(exempt).toBe(true);
    }
  });

  it('ADR-0009 外殻は中心から約60m 以内。暗転が明けると、殻の外から球が見えて近づいていく', async () => {
    const { room } = await loadRoom(createCelestialRoom);
    const shells = findByRole(room.root, 'shell');
    const center = worldCenter(shells[0]);
    const outer = Math.max(...shells.map((s) => new THREE.Box3().setFromObject(s).getSize(new THREE.Vector3()).x / 2));
    expect(outer).toBeLessThanOrEqual(62);
    const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
    const look = (t: number) => {
      ride.poseAt(t, 'standard', pose);
      const dx = center.x - pose.x;
      const dz = center.z - pose.z;
      const dist = Math.hypot(dx, center.y - pose.y, dz);
      const cos = (dx * -Math.sin(pose.yaw) + dz * -Math.cos(pose.yaw)) / Math.max(1e-6, Math.hypot(dx, dz));
      const toCenter = Math.acos(Math.min(1, Math.max(-1, cos))) * (180 / Math.PI);
      // 球の見かけの半径を引いた、正面から球の縁までの角度
      return { dist, edge: toCenter - Math.asin(Math.min(1, outer / dist)) * (180 / Math.PI) };
    };
    const after = look(sectionTimes('celestial').t0 + CELESTIAL_BLACKOUT_SEC + 1);
    expect(after.dist, '暗転が明けたときは殻の外').toBeGreaterThan(outer);
    expect(after.edge, '球の一部が正面から 30° 以内に見える').toBeLessThanOrEqual(30);
  });

  it('星は光を宿したガラス玉（数千。low では減らす）', async () => {
    const count = async (tier: 'high' | 'low') => {
      const { room } = await loadRoom(createCelestialRoom, { tier });
      return findByRole(room.root, 'stars').reduce((n, o) => n + ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 0), 0);
    };
    const high = await count('high');
    const low = await count('low');
    expect(high).toBeGreaterThanOrEqual(1500);
    expect(low).toBeGreaterThanOrEqual(300);
    expect(low).toBeLessThan(high);
  });

  it('INT-1 星に触れると近くの星と光の線でつながる（自分だけの星座）', async () => {
    const h = await loadRoom(createCelestialRoom);
    const stars = h.room.touchables.filter((t) => t.kind === 'star');
    expect(stars.length).toBeGreaterThanOrEqual(20);
    stars[0].onTouch({ t: 560, source: 'pointer', point: [0, 0, 0] });
    const links = h.emitted.filter((e) => e.type === 'constellationLinked').map((e) => e.payload as { fromId: string; toId: string });
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].fromId).toBe(stars[0].id);
    expect(links[0].toId).not.toBe(stars[0].id);
    expect(stars.map((s) => s.id)).toContain(links[0].toId);
  });

  it('INT-5 見どころ（9:50 星座）は正面にある', async () => {
    const { room } = await loadRoom(createCelestialRoom);
    expectFocusAhead(room, 'celestial.constellation', CONSTELLATION - 3);
    expectFocusAhead(room, 'celestial.constellation', CONSTELLATION);
  });

  it('INT-6 隠れた小さな泡', async () => {
    await expectHiddenBubble(createCelestialRoom, 'celestial');
  });

  it('TRN-1 夜明けの岸への膜（天球の殻を抜ける）', async () => {
    const { room } = await loadRoom(createCelestialRoom);
    expectExitMembrane(room, 'celestial');
  });

  it('夜の藍の空気', async () => {
    const { room } = await loadRoom(createCelestialRoom);
    const c = backgroundHsl(room);
    expect(c.l).toBeLessThan(0.15);
    expect(c.h).toBeGreaterThanOrEqual(200);
    expect(c.h).toBeLessThanOrEqual(260);
  });

  it('REN-3 描画の予算（描く物 120 以下、三角形 high 150万以下・low 50万以下）', async () => {
    const high = drawStats((await loadRoom(createCelestialRoom, { tier: 'high' })).room.root);
    const low = drawStats((await loadRoom(createCelestialRoom, { tier: 'low' })).room.root);
    expect(high.drawables).toBeLessThanOrEqual(120);
    expect(high.triangles).toBeLessThanOrEqual(1_500_000);
    expect(low.triangles).toBeLessThanOrEqual(500_000);
  });
});

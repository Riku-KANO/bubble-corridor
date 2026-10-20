// S-20 待ち列と入口（親が作成。実装担当は変更しない）
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  backgroundHsl,
  expectBlenderRoom,
  expectRoomContract,
  findByRole,
  loadRoom,
  ride,
  worldCenter,
} from '../testing';
import { createLobbyRoom, isLobbyRoom, lobbyViews } from './index';

describe('UI-1 待ち列と入口（3D）', () => {
  it('部屋の契約', async () => {
    await expectRoomContract(createLobbyRoom, []);
  });

  it('BLD-4〜7 Blender で造形して焼いた glb とライトマップを読む（blender/scripts/rooms/lobby.py）', async () => {
    await expectBlenderRoom(createLobbyRoom, 'lobby');
  });

  it('乗り場の手前にある（乗り場の始点から見て後ろ側）', async () => {
    const { room } = await loadRoom(createLobbyRoom);
    const start = ride.pointAt(0);
    const c = worldCenter(room.root);
    const fwdX = -Math.sin(start.yaw);
    const fwdZ = -Math.cos(start.yaw);
    expect((c.x - start.x) * fwdX + (c.z - start.z) * fwdZ).toBeLessThan(0);
  });

  it('待ち列の灯りは読み込みにつれて手前から灯る（8つ以上）', async () => {
    const { room } = await loadRoom(createLobbyRoom);
    expect(isLobbyRoom(room)).toBe(true);
    if (!isLobbyRoom(room)) return;
    const lamps = findByRole(room.root, 'lamp');
    expect(lamps.length).toBeGreaterThanOrEqual(8);
    room.setLoadProgress(0);
    expect(lamps.filter((l) => l.userData.lit).length).toBe(0);
    room.setLoadProgress(0.5);
    expect(lamps.filter((l) => l.userData.lit).length).toBe(Math.round(lamps.length * 0.5));
    // 手前（入口から遠い方）から灯る: 灯った灯りは灯っていない灯りより待ち列の視点に近い
    const queue = new THREE.Vector3(...lobbyViews(ride).queue.position);
    const lit = lamps.filter((l) => l.userData.lit).map((l) => worldCenter(l).distanceTo(queue));
    const unlit = lamps.filter((l) => !l.userData.lit).map((l) => worldCenter(l).distanceTo(queue));
    expect(Math.max(...lit)).toBeLessThanOrEqual(Math.min(...unlit) + 0.01);
    room.setLoadProgress(1);
    expect(lamps.every((l) => l.userData.lit)).toBe(true);
  });

  it('入口のアーチと浮かぶガラスの切符。改札で切符が光の粒になって消える', async () => {
    const h = await loadRoom(createLobbyRoom);
    const room = h.room;
    if (!isLobbyRoom(room)) throw new Error('lobby ではない');
    expect(findByRole(room.root, 'arch').length).toBeGreaterThan(0);
    const ticket = findByRole(room.root, 'ticket')[0];
    expect(ticket).toBeDefined();
    room.setTicketNumber(3);
    room.punchTicket();
    for (let i = 0; i < 120; i++) h.frame(0, 1 / 60);
    let shown = false;
    ticket.traverseVisible(() => {
      shown = true;
    });
    expect(shown && ticket.scale.length() > 0.05).toBe(false);
  });

  it('視点: 待ち列は通路の中、入口はアーチを見る、乗り場はレールの始点の近く', async () => {
    const { room } = await loadRoom(createLobbyRoom);
    const v = lobbyViews(ride);
    const box = new THREE.Box3().setFromObject(room.root).expandByScalar(1);
    expect(box.containsPoint(new THREE.Vector3(...v.queue.position))).toBe(true);
    const arch = worldCenter(findByRole(room.root, 'arch')[0]);
    expect(new THREE.Vector3(...v.home.target).distanceTo(arch)).toBeLessThan(3);
    const start = ride.pointAt(0);
    expect(new THREE.Vector3(...v.boarding.position).distanceTo(new THREE.Vector3(start.x, start.y, start.z))).toBeLessThan(6);
  });

  it('夜明け前の暗い空気', async () => {
    const { room } = await loadRoom(createLobbyRoom);
    expect(backgroundHsl(room).l).toBeLessThan(0.3);
  });
});

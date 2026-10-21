// S-21 第2室「雨の回廊」と扉の分岐（親が作成。実装担当は変更しない）
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
import { createRainRoom } from './index';

const FREEZE = MOMENT_BARS.rainFreeze * SEC_PER_BAR;
const DOORS = MOMENT_BARS.rainDoors * SEC_PER_BAR;

describe('第2室 雨の回廊', () => {
  it('部屋の契約', async () => {
    await expectRoomContract(createRainRoom, ['rain']);
  });

  it('BLD-4〜7 Blender で造形して焼いた glb とライトマップを読む（blender/scripts/rooms/rain.py）', async () => {
    await expectBlenderRoom(createRainRoom, 'rain');
  });

  it('RIDE-8 clearanceExempt の物（壁・穹窿・鏡の板など）も本当の形で 0.5m 以上（区間の前後 3m まで。ADR-0013）', async () => {
    const h = await loadRoom(createRainRoom);
    h.play(sectionTimes('rain').t0, sectionTimes('rain').t1, 1);
    expect(shapeClearanceViolations(h.room, ['rain'])).toEqual([]);
  });

  it('RIDE-8 ゴンドラの表面から物まで 0.5m 以上（止まった雨粒も）', async () => {
    const h = await loadRoom(createRainRoom);
    h.play(sectionTimes('rain').t0, FREEZE + 2, 0.5);
    expect(clearanceViolations(h.room, ['rain']).slice(0, 5)).toEqual([]);
  });

  it('INT-5 見どころ（5:10 雨粒が止まる）は正面にある', async () => {
    const { room } = await loadRoom(createRainRoom);
    expectFocusAhead(room, 'rain.freeze', FREEZE - 3);
    expectFocusAhead(room, 'rain.freeze', FREEZE);
  });

  it('INT-1 止まった雨粒（20以上）は、止まった後に触れられる', async () => {
    const h = await loadRoom(createRainRoom);
    h.play(sectionTimes('rain').t0, FREEZE + 1, 0.5);
    const drops = h.room.touchables.filter((t) => t.kind === 'raindrop' && t.enabled);
    expect(drops.length).toBeGreaterThanOrEqual(20);
    expect(() => drops[0].onTouch({ t: FREEZE + 2, source: 'pointer', point: [0, 0, 0] })).not.toThrow();
  });

  it('INT-8 琥珀と瑠璃の扉: 5:50 に現れ、触れた・見つめた扉を選ぶ', async () => {
    const h = await loadRoom(createRainRoom);
    const doors = h.room.touchables.filter((t) => t.kind === 'door');
    expect(doors).toHaveLength(2);
    const amber = doors.find((d) => d.id.includes('amber'))!;
    const lapis = doors.find((d) => d.id.includes('lapis'))!;
    expect(amber && lapis).toBeTruthy();
    h.play(sectionTimes('rain').t0, DOORS - 1, 0.5);
    expect(amber.enabled || lapis.enabled).toBe(false);
    h.play(DOORS - 0.5, DOORS + 1, 0.25);
    expect(amber.enabled && lapis.enabled).toBe(true);
    amber.onTouch({ t: DOORS + 2, source: 'pointer', point: [0, 0, 0] });
    lapis.onTouch({ t: DOORS + 3, source: 'gaze', point: [0, 0, 0] });
    const chosen = h.emitted.filter((e) => e.type === 'doorChosen').map((e) => e.payload);
    expect(chosen).toEqual([
      { door: 'amber', by: 'touch' },
      { door: 'lapis', by: 'gaze' },
    ]);
  });

  it('扉を交互に選び直しても、選んだ扉（と膜の向こうの万華鏡の色）の入れ替わりは1秒に3回未満（光の明滅の上限。レビュー2巡目 P1）', async () => {
    const h = await loadRoom(createRainRoom);
    h.play(sectionTimes('rain').t0, DOORS + 1, 0.25);
    const doors = h.room.touchables.filter((t) => t.kind === 'door');
    const changes: number[] = [];
    let last: string | null = null;
    let seen = h.emitted.length;
    for (let i = 0, t = DOORS + 1; t < DOORS + 5; i++, t += 0.15) {
      h.frame(t, 0.15);
      doors[i % 2]!.onTouch({ t, source: 'pointer', point: [0, 0, 0] });
      for (; seen < h.emitted.length; seen++) {
        const e = h.emitted[seen]!;
        if (e.type !== 'doorChosen') continue;
        const door = (e.payload as { door: string }).door;
        if (door !== last) changes.push(t);
        last = door;
      }
    }
    expect(changes.length, '選び直しは受け付ける').toBeGreaterThanOrEqual(2);
    for (const t of changes) expect(changes.filter((x) => x >= t && x < t + 1).length, `t=${t.toFixed(2)} からの1秒`).toBeLessThan(3);
  });

  it('INT-6 隠れた小さな泡', async () => {
    await expectHiddenBubble(createRainRoom, 'rain');
  });

  it('TRN-1 万華鏡への膜', async () => {
    const { room } = await loadRoom(createRainRoom);
    expectExitMembrane(room, 'rain');
  });

  it('雨の昼の灰青の空気', async () => {
    const { room } = await loadRoom(createRainRoom);
    const c = backgroundHsl(room);
    expect(c.h).toBeGreaterThanOrEqual(180);
    expect(c.h).toBeLessThanOrEqual(250);
    expect(c.s).toBeLessThan(0.4);
    expect(c.l).toBeGreaterThan(0.2);
    expect(c.l).toBeLessThan(0.6);
  });

  it('REN-3 描画の予算（描く物 120 以下、三角形 120万以下）', async () => {
    const s = drawStats((await loadRoom(createRainRoom)).room.root);
    expect(s.drawables).toBeLessThanOrEqual(120);
    expect(s.triangles).toBeLessThanOrEqual(1_200_000);
  });
});

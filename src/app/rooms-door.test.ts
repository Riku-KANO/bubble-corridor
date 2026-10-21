// S-25 INT-8 扉の選択は、後から読み込まれる部屋にも届く（親が作成。実装担当は変更しない）
// 乗車の頭や doorChosen で読み込み済みの部屋にだけ setDoor を呼ぶと、345 秒ごろに読み込まれる万華鏡は既定の色のままになる（S-21 の申し送り）。
// 部屋の管理が今の扉を覚え、読み込みが終わった部屋にも渡す。
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { DoorChoice, RoomId } from '../contracts/ids';
import type { RoomContext, RoomFactory, RoomModule } from '../contracts/room';
import { RoomManager } from './rooms';

function fakeRoom(id: RoomId, doors: DoorChoice[]) {
  let finish: () => void = () => {};
  const module: RoomModule = {
    id,
    root: new THREE.Group(),
    touchables: [],
    atmosphere: { background: 0, exposure: 1 },
    load: () => new Promise<void>((resolve) => (finish = resolve)),
    update() {},
    onCue() {},
    focusPoint: () => null,
    setDoor: (d) => doors.push(d),
    dispose() {},
  };
  return { module, finishLoad: () => finish() };
}

function setup() {
  const doors = new Map<RoomId, DoorChoice[]>();
  const loads = new Map<RoomId, () => void>();
  const ids: RoomId[] = ['lobby', 'platform', 'greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn'];
  const factories = Object.fromEntries(
    ids.map((id) => [
      id,
      (() => {
        const list: DoorChoice[] = [];
        doors.set(id, list);
        const f = fakeRoom(id, list);
        loads.set(id, f.finishLoad);
        return f.module;
      }) as RoomFactory,
    ]),
  ) as Record<RoomId, RoomFactory>;
  const rooms = new RoomManager(factories, {} as RoomContext, new THREE.Scene());
  return { rooms, doors, loads };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('INT-8 扉の選択は後から読み込まれる部屋にも届く', () => {
  it('setDoor は読み込み済みの部屋にすぐ渡す', async () => {
    const { rooms, doors, loads } = setup();
    void rooms.ensure('rain');
    loads.get('rain')!();
    await flush();
    rooms.setDoor('amber');
    expect(doors.get('rain')).toEqual(['amber']);
  });

  it('扉を決めた後に読み込みが終わった部屋にも、今の扉を渡す', async () => {
    const { rooms, doors, loads } = setup();
    rooms.setDoor('amber');
    void rooms.ensure('kaleidoscope');
    expect(doors.get('kaleidoscope')).toEqual([]);
    loads.get('kaleidoscope')!();
    await flush();
    expect(doors.get('kaleidoscope')).toEqual(['amber']);
  });

  it('扉が変わったら最新の扉（読み込み中に変わっても、読み込みの後は最新）', async () => {
    const { rooms, doors, loads } = setup();
    rooms.setDoor('amber');
    void rooms.ensure('kaleidoscope');
    rooms.setDoor('lapis');
    loads.get('kaleidoscope')!();
    await flush();
    expect(doors.get('kaleidoscope')!.at(-1)).toBe('lapis');
  });

  it('扉が決まっていなければ渡さない', async () => {
    const { rooms, doors, loads } = setup();
    void rooms.ensure('kaleidoscope');
    loads.get('kaleidoscope')!();
    await flush();
    expect(doors.get('kaleidoscope')).toEqual([]);
  });
});

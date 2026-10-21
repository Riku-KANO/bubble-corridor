// S-29 部屋の読み込みが終わったら先読みの口を呼ぶ（実装担当が追加）。シェーダーを描き始める前に組むための口
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { RoomId } from '../contracts/ids';
import type { RoomContext, RoomFactory, RoomModule } from '../contracts/room';
import { RoomManager } from './rooms';

function fakeRoom(id: RoomId, finishers: Map<RoomId, () => void>, fail = false): RoomModule {
  return {
    id,
    root: new THREE.Group(),
    touchables: [],
    atmosphere: { background: 0, exposure: 1 },
    load: () =>
      new Promise<void>((resolve, reject) => {
        finishers.set(id, () => (fail ? reject(new Error('load failed')) : resolve()));
      }),
    update() {},
    onCue() {},
    focusPoint: () => null,
    dispose() {},
  };
}

const plan = (visible: RoomId[], keep: RoomId[]) => Object.freeze({ visible: Object.freeze(visible), keep: Object.freeze(keep) });

function setup(fail = false, mayStart: { current: boolean } = { current: true }) {
  const finishers = new Map<RoomId, () => void>();
  const finish = (id: RoomId) => finishers.get(id)?.();
  const calls: { module: RoomModule; alive: () => boolean }[] = [];
  const made: RoomId[] = [];
  const ids: RoomId[] = ['lobby', 'platform', 'greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn'];
  const factories = Object.fromEntries(
    ids.map((id): [RoomId, RoomFactory] => [
      id,
      () => {
        made.push(id);
        return fakeRoom(id, finishers, fail);
      },
    ]),
  ) as Record<RoomId, RoomFactory>;
  const scene = new THREE.Scene();
  const rooms = new RoomManager(factories, {} as RoomContext, scene, {
    onPreload: (module, alive) => calls.push({ module, alive }),
    mayStartPreload: () => mayStart.current,
  });
  return { rooms, scene, finish, calls, made };
}

describe('部屋の先読みの口', () => {
  it('読み込みが終わった部屋に、一度だけ呼ぶ。まだ描かれない部屋にも、描く部屋にも', async () => {
    const { rooms, finish, calls } = setup();
    rooms.sync(plan(['lobby'], ['lobby', 'platform']));
    expect(calls).toHaveLength(0); // 読み込み中は呼ばない
    finish('lobby');
    await rooms.ensure('lobby');
    expect(calls.map((c) => c.module.id)).toEqual(['lobby']);
    finish('platform');
    await rooms.ensure('platform');
    expect(calls.map((c) => c.module.id)).toEqual(['lobby', 'platform']);
    rooms.sync(plan(['lobby'], ['lobby', 'platform'])); // 同じ中身の別の計画でも、読み込み済みの部屋には呼ばない
    expect(calls).toHaveLength(2);
  });

  it('部屋が計画から外れて解放されたら、alive が偽になる（先読みを打ち切れる）', async () => {
    const { rooms, finish, calls } = setup();
    rooms.sync(plan(['lobby'], ['lobby']));
    finish('lobby');
    await rooms.ensure('lobby');
    expect(calls[0].alive()).toBe(true);
    rooms.sync(plan([], []));
    expect(calls[0].alive()).toBe(false);
  });

  it('読み込みに失敗した部屋には呼ばない', async () => {
    const { rooms, finish, calls } = setup(true);
    const error = console.error;
    console.error = () => {};
    try {
      rooms.sync(plan(['lobby'], ['lobby']));
      finish('lobby');
      await rooms.ensure('lobby');
    } finally {
      console.error = error;
    }
    expect(calls).toHaveLength(0);
  });
});

describe('次の部屋の読み込みを始める時（膜の前後を避ける）', () => {
  it('いま描く部屋は待たずに読み、まだ描かない部屋は、始めてよくなるまで待って、同じ計画のまま始める', () => {
    const mayStart = { current: false };
    const { rooms, made } = setup(false, mayStart);
    const p = plan(['lobby'], ['lobby', 'platform']);
    rooms.sync(p);
    expect(made).toEqual(['lobby']); // 描く部屋はすぐ
    rooms.sync(p);
    expect(made).toEqual(['lobby']); // 次の部屋は待つ
    mayStart.current = true;
    rooms.sync(p); // 毎フレームの同じ計画の呼び出しで、待っていた読み込みが始まる
    expect(made).toEqual(['lobby', 'platform']);
    rooms.sync(p);
    expect(made).toEqual(['lobby', 'platform']); // 二重に読まない
  });

  it('待っている間に計画から外れた部屋は読まない', () => {
    const mayStart = { current: false };
    const { rooms, made } = setup(false, mayStart);
    rooms.sync(plan(['lobby'], ['lobby', 'platform']));
    rooms.sync(plan(['lobby'], ['lobby']));
    mayStart.current = true;
    rooms.sync(plan(['lobby'], ['lobby']));
    expect(made).toEqual(['lobby']);
  });

  it('読み込み済みの部屋は、待たされない（計画が変わっても、解放して読み直さない）', async () => {
    const mayStart = { current: true };
    const { rooms, finish, made } = setup(false, mayStart);
    rooms.sync(plan(['lobby'], ['lobby', 'platform']));
    finish('platform');
    await rooms.ensure('platform');
    mayStart.current = false;
    rooms.sync(plan(['platform'], ['lobby', 'platform']));
    expect(made).toEqual(['lobby', 'platform']);
  });
});

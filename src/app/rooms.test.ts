// S-25 部屋の管理（実装担当が追加）。読み込み中に計画から外れた部屋は、読み込みが終わったときに解放する（P3-4）
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { RoomId } from '../contracts/ids';
import type { RoomContext, RoomFactory, RoomModule } from '../contracts/room';
import { RoomManager } from './rooms';

interface Fake {
  module: RoomModule;
  finishLoad(): void;
  disposed: number;
}

function fakeRoom(id: RoomId): Fake {
  let finish: () => void = () => {};
  const fake: Fake = {
    disposed: 0,
    finishLoad: () => finish(),
    module: {
      id,
      root: new THREE.Group(),
      touchables: [],
      atmosphere: { background: 0, exposure: 1 },
      load: () => new Promise<void>((resolve) => (finish = resolve)),
      update() {},
      onCue() {},
      focusPoint: () => null,
      dispose: () => {
        fake.disposed++;
      },
    },
  };
  return fake;
}

function setup() {
  const made = new Map<RoomId, Fake[]>();
  const factory = (id: RoomId): RoomFactory => () => {
    const f = fakeRoom(id);
    made.set(id, [...(made.get(id) ?? []), f]);
    return f.module;
  };
  const ids: RoomId[] = ['lobby', 'platform', 'greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn'];
  const factories = Object.fromEntries(ids.map((id) => [id, factory(id)])) as Record<RoomId, RoomFactory>;
  const scene = new THREE.Scene();
  const rooms = new RoomManager(factories, {} as RoomContext, scene);
  return { rooms, scene, made };
}

const plan = (visible: RoomId[], keep: RoomId[]) => Object.freeze({ visible: Object.freeze(visible), keep: Object.freeze(keep) });

describe('部屋の管理', () => {
  it('読み込みが終わった部屋は、見せる計画ならシーンに入り、外れたら解放される', async () => {
    const { rooms, scene, made } = setup();
    rooms.sync(plan(['lobby'], ['lobby']));
    made.get('lobby')![0].finishLoad();
    await rooms.ensure('lobby');
    expect(scene.children).toContain(made.get('lobby')![0].module.root);
    rooms.sync(plan([], []));
    expect(made.get('lobby')![0].disposed).toBe(1);
    expect(scene.children).not.toContain(made.get('lobby')![0].module.root);
  });

  it('読み込み中に計画から外れた部屋は、読み込みが終わったときに解放し、シーンに入れない（P3-4）', async () => {
    const { rooms, scene, made } = setup();
    rooms.sync(plan(['rain'], ['rain']));
    const loading = rooms.ensure('rain');
    // 読み込みの途中で計画から外れる（まだ ready でないので、解放はまだできない）
    rooms.sync(plan(['lobby'], ['lobby']));
    expect(made.get('rain')![0].disposed).toBe(0);
    made.get('rain')![0].finishLoad();
    await loading;
    expect(made.get('rain')![0].disposed).toBe(1);
    expect(rooms.isReady('rain')).toBe(false);
    expect(rooms.get('rain')).toBeNull();
    expect(scene.children).not.toContain(made.get('rain')![0].module.root);
  });

  it('外れた後にもう一度計画に入れば、新しく作って読み込む（古い読み込みの解放が新しい物を巻き込まない）', async () => {
    const { rooms, made } = setup();
    rooms.sync(plan(['rain'], ['rain']));
    rooms.sync(plan(['lobby'], ['lobby']));
    rooms.sync(plan(['rain'], ['rain']));
    expect(made.get('rain')!.length).toBe(2);
    made.get('rain')![0].finishLoad();
    made.get('rain')![1].finishLoad();
    await rooms.ensure('rain');
    await Promise.resolve();
    expect(made.get('rain')![0].disposed).toBe(1);
    expect(made.get('rain')![1].disposed).toBe(0);
    expect(rooms.isReady('rain')).toBe(true);
  });
});

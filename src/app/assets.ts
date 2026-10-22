// ブラウザのアセットの読み込み口（契約 AssetLoader）。同じパスは一度だけ読む。
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { AssetLoader } from '../contracts/room';

/**
 * 読み込みの結果を部屋に返す前に、次のタスクまで待つ。部屋は結果を受け取った続きで材質を組むので、glb の解析と部屋の組み立てが
 * 同じタスクに並ばないようにする（次の部屋の読み込みで主スレッドが 50〜120ms 続けて止まる。S-29 レビュー1巡目 P2-1）
 */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** アプリの読み込み口。契約の口に、読み込み済みの画像を引く口を足す（GPU への転送を先に済ませるのに使う） */
export interface AppAssetLoader extends AssetLoader {
  /** 読み込み済みの画像のうち、パスが prefix で始まるもの（例: 'rooms/platform.'。部屋の画像はこの形で置いてある） */
  loadedTextures(prefix: string): THREE.Texture[];
}

export function createAssetLoader(base = `${import.meta.env.BASE_URL}assets/`): AppAssetLoader {
  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const gltfCache = new Map<string, ReturnType<AssetLoader['gltf']>>();
  const texCache = new Map<string, Promise<THREE.Texture>>();
  const loaded = new Map<string, THREE.Texture>();
  return {
    loadedTextures(prefix) {
      const out: THREE.Texture[] = [];
      for (const [path, texture] of loaded) if (path.startsWith(prefix)) out.push(texture);
      return out;
    },
    gltf(path) {
      let p = gltfCache.get(path);
      if (!p) {
        p = gltfLoader.loadAsync(base + path).then(async (g) => {
          await nextTask();
          return { scene: g.scene, animations: g.animations };
        });
        gltfCache.set(path, p);
      }
      return p;
    },
    texture(path) {
      let p = texCache.get(path);
      if (!p) {
        p = texLoader.loadAsync(base + path).then(async (t) => {
          t.flipY = false; // glTF の UV の向きに合わせる
          // 画像の展開（WebP・PNG の復号）を主スレッドの外で先に済ませる。済ませないと、GPU への最初の転送で復号も走り、数十 ms 止まる
          await (t.image as { decode?: () => Promise<void> } | undefined)?.decode?.().catch(() => undefined);
          await nextTask();
          loaded.set(path, t);
          return t;
        });
        texCache.set(path, p);
      }
      return p;
    },
  };
}

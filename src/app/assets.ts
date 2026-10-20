// ブラウザのアセットの読み込み口（契約 AssetLoader）。同じパスは一度だけ読む。
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { AssetLoader } from '../contracts/room';

export function createAssetLoader(base = `${import.meta.env.BASE_URL}assets/`): AssetLoader {
  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const gltfCache = new Map<string, ReturnType<AssetLoader['gltf']>>();
  const texCache = new Map<string, Promise<THREE.Texture>>();
  return {
    gltf(path) {
      let p = gltfCache.get(path);
      if (!p) {
        p = gltfLoader.loadAsync(base + path).then((g) => ({ scene: g.scene, animations: g.animations }));
        gltfCache.set(path, p);
      }
      return p;
    },
    texture(path) {
      let p = texCache.get(path);
      if (!p) {
        p = texLoader.loadAsync(base + path).then((t) => {
          t.flipY = false; // glTF の UV の向きに合わせる
          return t;
        });
        texCache.set(path, p);
      }
      return p;
    },
  };
}

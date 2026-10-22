// 部屋の環境画像（反射）を場面に反映する。環境画像のノードは 1 つだけ作って使い回し、部屋が変わるときは中の画像だけを差し替える。
//
// なぜ scene.environment を差し替えないのか: three r186 は、環境画像の有無とどの画像かを「描く物の鍵」に含める。
// 部屋の境目で scene.environment を別の画像や null に替えると、見えている材質すべての組み立てが作り直される
// （60 秒の乗り場 → 温室で WebGL2 約 2 秒、750 秒の岸 → 降車の乗り場で 2 秒以上。ADR-0014）。
// 環境画像を持つ PMREM のノード（pmremTexture）を scene.environmentNode に常に置き、value だけ替える。
// ノードの鍵は変わらず、組み立て済みのシェーダーはそのまま、画像（のサンプラーと大きさの uniform）だけが替わる。
// 環境画像のない部屋は、同じノードに直前の画像を置いたまま scene.environmentIntensity を 0 にする（反射への寄与は 0。ガラスの擬似反射は
// glass-lighting.ts が atmosphere.environment の有無で決めるので、見た目は変わらない）。
//
// PMREM（反射用に粗さごとにぼかした画像）は、three が描画の最中に作るのではなく、ここで描画の外で先に作って渡す。
// 描画の中で作ると、呼び出しの深さ（水面の映り込みの中なら +1）ごとに PMREM 自身のシェーダーを組み直す（750 秒で 54ms の引っかかり）。
import * as THREE from 'three/webgpu';
import { pmremTexture } from 'three/tsl';

export interface EnvironmentSlot {
  /** 部屋の環境画像を反映する（null は環境画像なし）。同じ画像なら何もしない。PMREM が未作成ならここで作る（描画の外で呼ぶ） */
  apply(texture: THREE.Texture | null): void;
  /** 部屋の環境画像の PMREM を先に作る（部屋の読み込みの後、描画の外で呼ぶ。膜を通る瞬間に作らない） */
  prepare(texture: THREE.Texture | null | undefined): void;
}

/** 画像が来るまでの入れ物。黒（PMREM にできる最小の大きさ 64×32 の正距円筒。three の PMREM の仕様） */
function placeholder(): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array(64 * 32 * 4).fill(0), 64, 32, THREE.RGBAFormat);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export function createEnvironmentSlot(scene: THREE.Scene, renderer: THREE.WebGPURenderer): EnvironmentSlot {
  const generator = new THREE.PMREMGenerator(renderer);
  /** 元の画像 → 反射用に作った画像。元の画像が解放されたら、こちらも解放する */
  const made = new Map<THREE.Texture, THREE.RenderTarget>();

  /** 反射用の画像。作れなかったら null（その部屋は環境画像なしとして扱う） */
  function pmremOf(source: THREE.Texture): THREE.Texture | null {
    const cached = made.get(source);
    if (cached) return cached.texture;
    try {
      const target = generator.fromEquirectangular(source);
      made.set(source, target);
      const onDispose = (): void => {
        source.removeEventListener('dispose', onDispose);
        const rt = made.get(source);
        made.delete(source);
        if (!rt) return;
        // 部屋の解放で元の画像が捨てられた。ノードが捨てる反射用の画像を指したままにならないよう、入れ物の画像へ戻してから捨てる
        if (node.value === rt.texture) {
          node.value = placeholderPmrem;
          scene.environmentIntensity = 0;
          if (current === source) current = null;
        }
        rt.dispose();
      };
      source.addEventListener('dispose', onDispose);
      return target.texture;
    } catch (err) {
      console.warn('[environment] 環境画像の PMREM を作れませんでした', err);
      return null;
    }
  }

  const initial = placeholder();
  const placeholderPmrem: THREE.Texture = pmremOf(initial) ?? initial;
  const node = pmremTexture(placeholderPmrem);
  // scene.environment は使わない（null のまま）。three は scene.environmentNode があればそれを環境として使う
  (scene as THREE.Scene & { environmentNode: unknown }).environmentNode = node;
  scene.environment = null;
  scene.environmentIntensity = 0;
  let current: THREE.Texture | null = null;

  return {
    apply(texture) {
      if (texture === current) return;
      current = texture;
      const pmrem = texture ? pmremOf(texture) : null; // 作れなかったときは環境画像なしとして扱う（前の部屋の反射を残さない）
      if (pmrem) node.value = pmrem;
      scene.environmentIntensity = pmrem ? 1 : 0;
    },
    prepare(texture) {
      if (texture) pmremOf(texture);
    },
  };
}

// INT-4「何もしない人にも」: 触れられないまま近づいた物が、一度だけ自分で小さく鳴る。
// 画面（光線）でも VR（指先）でも同じ物差し（ゴンドラから物の表面まで）で決めたいので、入力の側ではなく統合の側で持つ。
import { INTERACTION } from '../config';
import type { Vec3Tuple } from '../contracts/events';
import type { Touchable } from '../contracts/room';

export interface IdleChimer {
  /**
   * 毎フレーム。ゴンドラの位置と、いま触れられる物の一覧。
   * 表面までの距離（中心までの距離 − radius）が INTERACTION.idleChimeDistance 未満の物を一度だけ鳴らす。
   * 無効・見えない（自分か祖先が隠れている）・idleChime でない・すでに触れた物は鳴らさない。
   */
  update(gondola: Vec3Tuple, touchables: readonly Touchable[]): void;
  /** 触れた（touch の出来事）。触れた物は自分で鳴らない */
  touched(id: string): void;
  /** 新しい乗車。数え直す */
  reset(): void;
}

/** 自分か祖先が隠れていれば false（部屋ごと隠れている場合も含む） */
function isVisible(object: Touchable['object']): boolean {
  for (let o: Touchable['object'] | null = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

export function createIdleChimer(onChime: (t: Touchable) => void): IdleChimer {
  /** 触れた物と、すでに鳴った物（どちらも二度と鳴らさない）。id で覚えるので、部屋の再読み込みで物が作り直されても重ならない */
  const done = new Set<string>();
  const limit = INTERACTION.idleChimeDistance;

  return {
    update(gondola, touchables) {
      const gx = gondola[0];
      const gy = gondola[1];
      const gz = gondola[2];
      for (let i = 0; i < touchables.length; i++) {
        const t = touchables[i];
        if (!t.enabled || !t.idleChime || done.has(t.id)) continue;
        // 物の原点（ワールド）から表面までの距離。matrixWorld は直近の描画で更新済み。毎フレームの確保を避けて要素を直接読む
        const m = t.object.matrixWorld.elements;
        const dx = m[12] - gx;
        const dy = m[13] - gy;
        const dz = m[14] - gz;
        const surface = Math.sqrt(dx * dx + dy * dy + dz * dz) - t.radius;
        // 見えるかどうかは、近い物にだけ調べる（祖先をたどるので）
        if (surface >= limit || !isVisible(t.object)) continue;
        done.add(t.id);
        onChime(t);
      }
    },
    touched(id) {
      done.add(id);
    },
    reset() {
      done.clear();
    },
  };
}

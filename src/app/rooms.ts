// 部屋の読み込みと解放。今の部屋にいる間に次の部屋を読み込み、2つ前の部屋は解放する（設計書「読み込み」）。
import type * as THREE from 'three/webgpu';
import type { Cue } from '../contracts/events';
import type { RoomId } from '../contracts/ids';
import type { RoomContext, RoomFactory, RoomFrame, RoomModule, Touchable } from '../contracts/room';

interface Slot {
  readonly module: RoomModule;
  /** load() が終わったか */
  ready: boolean;
  readonly loading: Promise<void>;
  attached: boolean;
}

export class RoomManager {
  private readonly slots = new Map<RoomId, Slot>();
  private visible: readonly RoomId[] = [];
  private touchCache: Touchable[] = [];
  private touchDirty = true;

  constructor(
    private readonly factories: Readonly<Record<RoomId, RoomFactory>>,
    private readonly ctx: RoomContext,
    private readonly scene: THREE.Scene,
  ) {}

  /** 読み込みを始める（済んでいれば何もしない）。読み込み終わりで resolve */
  ensure(id: RoomId): Promise<void> {
    const existing = this.slots.get(id);
    if (existing) return existing.loading;
    const module = this.factories[id]();
    const slot: Slot = {
      module,
      ready: false,
      attached: false,
      loading: module.load(this.ctx).then(
        () => {
          slot.ready = true;
          this.touchDirty = true;
          this.applyVisibility();
        },
        (err) => {
          console.error(`[rooms] ${id} の読み込みに失敗`, err);
        },
      ),
    };
    this.slots.set(id, slot);
    return slot.loading;
  }

  /** 計画に合わせて読み込み・解放・表示を揃える */
  sync(plan: { readonly visible: readonly RoomId[]; readonly keep: readonly RoomId[] }): void {
    for (const id of plan.keep) void this.ensure(id);
    for (const [id, slot] of this.slots) {
      if (plan.keep.includes(id)) continue;
      if (slot.attached) this.scene.remove(slot.module.root);
      if (slot.ready) slot.module.dispose();
      this.slots.delete(id);
      this.touchDirty = true;
    }
    if (plan.visible.join() !== this.visible.join()) {
      this.visible = [...plan.visible];
      this.touchDirty = true;
    }
    this.applyVisibility();
  }

  private applyVisibility(): void {
    for (const [id, slot] of this.slots) {
      const show = slot.ready && this.visible.includes(id);
      if (show && !slot.attached) {
        this.scene.add(slot.module.root);
        slot.attached = true;
      } else if (!show && slot.attached) {
        this.scene.remove(slot.module.root);
        slot.attached = false;
      }
    }
  }

  get(id: RoomId): RoomModule | null {
    const slot = this.slots.get(id);
    return slot?.ready ? slot.module : null;
  }

  isReady(id: RoomId): boolean {
    return this.slots.get(id)?.ready ?? false;
  }

  /** いま見えている部屋の触れられる物 */
  touchables(): readonly Touchable[] {
    if (this.touchDirty) {
      this.touchCache = [];
      for (const id of this.visible) {
        const m = this.get(id);
        if (m) this.touchCache.push(...m.touchables);
      }
      this.touchDirty = false;
    }
    return this.touchCache;
  }

  /** 触れられる物の一覧が変わったか（読み込み・表示の変化）。読むと false に戻る */
  consumeTouchChange(): boolean {
    const was = this.touchDirty;
    if (was) this.touchables();
    return was;
  }

  update(frame: RoomFrame): void {
    for (const id of this.visible) this.get(id)?.update(frame);
  }

  /** 出来事は読み込み済みのすべての部屋に流す（膜の前後で次の部屋が準備できるように） */
  onCue(cue: Cue): void {
    for (const slot of this.slots.values()) if (slot.ready) slot.module.onCue(cue);
  }

  forEachReady(fn: (m: RoomModule) => void): void {
    for (const slot of this.slots.values()) if (slot.ready) fn(slot.module);
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      if (slot.attached) this.scene.remove(slot.module.root);
      if (slot.ready) slot.module.dispose();
    }
    this.slots.clear();
  }
}

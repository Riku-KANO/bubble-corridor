// 部屋の読み込みと解放。今の部屋にいる間に次の部屋を読み込み、2つ前の部屋は解放する（設計書「読み込み」）。
import type * as THREE from 'three/webgpu';
import type { Cue } from '../contracts/events';
import type { DoorChoice, RoomId } from '../contracts/ids';
import type { RoomContext, RoomFactory, RoomFrame, RoomModule, Touchable } from '../contracts/room';

interface Slot {
  readonly module: RoomModule;
  /** load() が終わったか */
  ready: boolean;
  readonly loading: Promise<void>;
  attached: boolean;
}

/** 部屋の並びが同じか（確保なしで比べる） */
function sameRooms(a: readonly RoomId[], b: readonly RoomId[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class RoomManager {
  private readonly slots = new Map<RoomId, Slot>();
  private visible: readonly RoomId[] = [];
  /** 前回の sync の計画。同じ計画（参照が同じ）なら、読み込みも表示も変える必要がない */
  private lastPlan: { readonly visible: readonly RoomId[]; readonly keep: readonly RoomId[] } | null = null;
  /** 今の扉の選択（決まっていなければ null）。後から読み込まれる部屋（万華鏡など）にも渡す */
  private door: DoorChoice | null = null;
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
          // 読み込み中に計画から外れて、スロットはもう無い（解放のときは読み込みが終わっていなかったので dispose できなかった）。ここで解放する
          if (this.slots.get(id) !== slot) {
            module.dispose();
            return;
          }
          slot.ready = true;
          if (this.door !== null) module.setDoor?.(this.door);
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

  /**
   * 計画に合わせて読み込み・解放・表示を揃える。毎フレーム呼ばれる。
   * streamingPlan は凍結した計画を使い回すので、同じ計画なら（参照で比べて）何もしない。
   * 読み込みが終わったときの表示の反映は、ensure の完了が自分で行う。計画の配列は書き換えない前提。
   */
  sync(plan: { readonly visible: readonly RoomId[]; readonly keep: readonly RoomId[] }): void {
    if (plan === this.lastPlan) return;
    this.lastPlan = plan;
    for (const id of plan.keep) void this.ensure(id);
    for (const [id, slot] of this.slots) {
      if (plan.keep.includes(id)) continue;
      if (slot.attached) this.scene.remove(slot.module.root);
      if (slot.ready) slot.module.dispose();
      this.slots.delete(id);
      this.touchDirty = true;
    }
    if (!sameRooms(plan.visible, this.visible)) {
      this.visible = plan.visible;
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

  /**
   * 扉の選択を覚え、読み込み済みの部屋にすぐ渡す。読み込みが終わる部屋にも、そのとき最新の扉を渡す
   * （乗車の頭や doorChosen の時点で読み込まれていない万華鏡が、既定の色のままにならない）
   */
  setDoor(door: DoorChoice): void {
    this.door = door;
    for (const slot of this.slots.values()) if (slot.ready) slot.module.setDoor?.(door);
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

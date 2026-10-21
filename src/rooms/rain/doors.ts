// 琥珀と瑠璃の扉の状態（INT-8）。見た目は時刻と「選んだ記録」から決める（フレームの積み上げで作らない）。
//   ・5:50（DOORS）に床から立ち上がる。立ち上がってから触れられる
//   ・触れた／見つめた扉を選ぶ（扉が開き、奥の光が強まる）。決まる（branch.decide）までは選び直せる
//   ・何もしなければ、決まる時刻にアプリの扉（setDoor。既定は瑠璃）が開く
//   ・2周目は前回と違う扉（suggestedDoor）が少し強く光る
import type { DoorChoice } from '../../contracts/ids';

export const DOOR_RISE_SEC = 2.8;
export const DOOR_OPEN_SEC = 1.6;
export const DOOR_CLOSE_SEC = 1.2;

const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export interface DoorLook {
  /** 立ち上がり（0〜1） */
  readonly rise: number;
  /** 開き具合（0〜1） */
  readonly open: Record<DoorChoice, number>;
  /** 奥の光の強さ（0〜1 くらい） */
  readonly glow: Record<DoorChoice, number>;
}

export class DoorChoices {
  private picks: { door: DoorChoice; t: number }[] = [];
  private appDoor: DoorChoice;

  constructor(
    /** 扉が現れる時刻 */
    readonly appearT: number,
    /** 扉が決まる時刻（branch.decide） */
    readonly decideT: number,
    defaultDoor: DoorChoice,
    private readonly suggested: DoorChoice | null,
  ) {
    this.appDoor = defaultDoor;
  }

  /** 触れられるか（現れてから、決まるまで。決まった後も触れれば光るが、選び直しはしない） */
  enabledAt(t: number): boolean {
    return t >= this.appearT;
  }

  /** 選ぶ。受け付けたら true（doorChosen を出す） */
  pick(door: DoorChoice, t: number): boolean {
    if (!(t >= this.appearT - 0.5) || t > this.decideT) return false;
    // 時刻が戻った（巻き戻し・新しい乗車）なら、それより後の記録は捨てる
    this.picks = this.picks.filter((p) => p.t <= t);
    this.picks.push({ door, t });
    return true;
  }

  /** アプリの扉（setDoor）。乗車の頭の既定値と、決まったときの値が来る */
  setAppDoor(door: DoorChoice): void {
    this.appDoor = door;
  }

  /** 時刻が戻ったら、その時刻より後の記録を捨てる */
  rewind(t: number): void {
    if (this.picks.length > 0 && t < this.picks[this.picks.length - 1].t - 0.25) this.picks = this.picks.filter((p) => p.t <= t);
  }

  /** 時刻 t に選ばれている扉と、選ばれた時刻（なければ null） */
  selectedAt(t: number): { door: DoorChoice; since: number } | null {
    let last: { door: DoorChoice; t: number } | null = null;
    for (const p of this.picks) if (p.t <= t) last = p;
    if (t >= this.decideT) {
      // 決まった後: 決まる前に選んだ扉、なければアプリの扉（何もしなければ瑠璃）
      if (last) return { door: last.door, since: last.t };
      return { door: this.appDoor, since: this.decideT };
    }
    return last ? { door: last.door, since: last.t } : null;
  }

  look(t: number): DoorLook {
    const rise = ease((t - this.appearT + 0.3) / DOOR_RISE_SEC);
    const open: Record<DoorChoice, number> = { amber: 0, lapis: 0 };
    // 選んだ記録を「同じ扉が続く間」にまとめ、区間ごとに 開く（選んだ時刻から）× 閉じる（別の扉に替わった時刻から）。
    // 同じ扉の区間が複数あれば大きい方（閉じかけで選び直しても、開き具合が飛ばない）
    const runs: { door: DoorChoice; start: number }[] = [];
    for (const p of this.picks) {
      if (p.t > t || p.t > this.decideT) break;
      if (runs.length === 0 || runs[runs.length - 1].door !== p.door) runs.push({ door: p.door, start: p.t });
    }
    if (runs.length === 0 && t >= this.decideT) runs.push({ door: this.appDoor, start: this.decideT });
    for (let i = 0; i < runs.length; i++) {
      const end = i + 1 < runs.length ? runs[i + 1].start : Infinity;
      const v = ease((t - runs[i].start) / DOOR_OPEN_SEC) * (end === Infinity ? 1 : 1 - ease((t - end) / DOOR_CLOSE_SEC));
      open[runs[i].door] = Math.max(open[runs[i].door], v);
    }
    const sel = this.selectedAt(t);
    const decided = t >= this.decideT;
    const glow: Record<DoorChoice, number> = { amber: 0, lapis: 0 };
    for (const d of ['amber', 'lapis'] as const) {
      const base = 0.28 + (this.suggested === d ? 0.22 : 0);
      const other = decided && sel && sel.door !== d ? 1 - 0.75 * ease((t - this.decideT) / 2) : 1;
      glow[d] = rise * (base * other + open[d] * 0.9);
    }
    return { rise, open, glow };
  }
}

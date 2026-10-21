// 琥珀と瑠璃の扉の状態（INT-8）。見た目は時刻と「選んだ記録」から決める（フレームの積み上げで作らない）。
//   ・5:50（DOORS）に床から立ち上がる。立ち上がってから触れられる
//   ・触れた／見つめた扉を選ぶ（扉が開き、奥の光が強まる）。決まる（branch.decide）までは選び直せる
//   ・何もしなければ、決まる時刻にアプリの扉（setDoor。既定は瑠璃）が開く
//   ・決まった後、選ばなかった扉は閉じて暗くなる（ADR-0013: 選んだ扉の光と色で膜が満たされ、その中を進む）
//   ・2周目は前回と違う扉（suggestedDoor）が少し強く光る
//   ・別の扉への選び直しは 1 拍（SEC_PER_BEAT）に 1 回まで。交互に触れ続けても、選んだ扉と膜の向こうの万華鏡の色の
//     入れ替わりは 1 秒に 1.2 回まで（光の明滅は 1 秒に 3 回未満の決まり）。受け付けなかった触れ方にも光の応答は返す（部屋）
// 毎フレーム呼ぶ look・selectedAt は、渡した入れ物に書く（確保しない）。選んだ記録の配列は出来事のときだけ変える。
import { SEC_PER_BEAT } from '../../config';
import type { DoorChoice } from '../../contracts/ids';

export const DOOR_RISE_SEC = 2.8;
export const DOOR_OPEN_SEC = 1.6;
export const DOOR_CLOSE_SEC = 1.2;
/** 決まった後に、選ばなかった扉の光が落ちきるまでの秒と、残る明るさの割合 */
export const DOOR_DIM_SEC = 2;
export const DOOR_DIM_TO = 0.12;
/** 別の扉へ選び直せる最短の間隔（秒） */
export const DOOR_REPICK_SEC = SEC_PER_BEAT;

const DOORS: readonly DoorChoice[] = ['amber', 'lapis'];

const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export interface DoorLook {
  /** 立ち上がり（0〜1） */
  rise: number;
  /** 開き具合（0〜1） */
  readonly open: Record<DoorChoice, number>;
  /** 奥の光の強さ（0〜1 くらい） */
  readonly glow: Record<DoorChoice, number>;
}

export function createDoorLook(): DoorLook {
  return { rise: 0, open: { amber: 0, lapis: 0 }, glow: { amber: 0, lapis: 0 } };
}

export interface DoorSelection {
  door: DoorChoice | null;
  since: number;
}

export class DoorChoices {
  private picks: { door: DoorChoice; t: number }[] = [];
  private appDoor: DoorChoice;
  // look の作業用（同じ扉が続く間にまとめた区間）
  private readonly runDoor: DoorChoice[] = [];
  private readonly runStart: number[] = [];
  private readonly sel: DoorSelection = { door: null, since: 0 };

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

  /** 触れられるか（現れてから。決まった後も触れれば光るが、選び直しはしない） */
  enabledAt(t: number): boolean {
    return t >= this.appearT;
  }

  /**
   * 選ぶ。受け付けたら true（doorChosen を出す）。いま選ばれている扉にもう一度触れても、選び直しではないので false。
   * 別の扉への選び直しは、前に選んだ時刻から DOOR_REPICK_SEC 経つまで受け付けない。
   */
  pick(door: DoorChoice, t: number): boolean {
    if (!(t >= this.appearT - 0.5) || t > this.decideT) return false;
    // 時刻が戻った（巻き戻し・新しい乗車）なら、それより後の記録は捨てる
    if (this.picks.length > 0 && this.picks[this.picks.length - 1].t > t) this.picks = this.picks.filter((p) => p.t <= t);
    const last = this.picks[this.picks.length - 1];
    if (last && last.door === door) return false;
    if (last && t - last.t < DOOR_REPICK_SEC) return false;
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

  /** 時刻 t に選ばれている扉と、選ばれた時刻（なければ door = null）を out に書く */
  selectedAt(t: number, out: DoorSelection): DoorSelection {
    let door: DoorChoice | null = null;
    let since = 0;
    for (const p of this.picks) {
      if (p.t > t) break;
      door = p.door;
      since = p.t;
    }
    if (t >= this.decideT && door === null) {
      // 決まった後で選んでいなければ、アプリの扉（何もしなければ瑠璃）
      door = this.appDoor;
      since = this.decideT;
    }
    out.door = door;
    out.since = since;
    return out;
  }

  look(t: number, out: DoorLook): DoorLook {
    out.rise = ease((t - this.appearT + 0.3) / DOOR_RISE_SEC);
    out.open.amber = 0;
    out.open.lapis = 0;
    // 選んだ記録を「同じ扉が続く間」にまとめ、区間ごとに 開く（選んだ時刻から）× 閉じる（別の扉に替わった時刻から）。
    // 同じ扉の区間が複数あれば大きい方（閉じかけで選び直しても、開き具合が飛ばない）
    let n = 0;
    for (const p of this.picks) {
      if (p.t > t || p.t > this.decideT) break;
      if (n === 0 || this.runDoor[n - 1] !== p.door) {
        this.runDoor[n] = p.door;
        this.runStart[n] = p.t;
        n++;
      }
    }
    if (n === 0 && t >= this.decideT) {
      this.runDoor[0] = this.appDoor;
      this.runStart[0] = this.decideT;
      n = 1;
    }
    for (let i = 0; i < n; i++) {
      const end = i + 1 < n ? this.runStart[i + 1] : Infinity;
      const v = ease((t - this.runStart[i]) / DOOR_OPEN_SEC) * (end === Infinity ? 1 : 1 - ease((t - end) / DOOR_CLOSE_SEC));
      const d = this.runDoor[i];
      out.open[d] = Math.max(out.open[d], v);
    }
    const sel = this.selectedAt(t, this.sel);
    const decided = t >= this.decideT;
    for (const d of DOORS) {
      const base = 0.28 + (this.suggested === d ? 0.22 : 0);
      // 決まった後、選ばなかった扉は暗くなる
      const dim = decided && sel.door !== null && sel.door !== d ? 1 - (1 - DOOR_DIM_TO) * ease((t - this.decideT) / DOOR_DIM_SEC) : 1;
      out.glow[d] = out.rise * (base + out.open[d] * 0.9) * dim;
    }
    return out;
  }
}

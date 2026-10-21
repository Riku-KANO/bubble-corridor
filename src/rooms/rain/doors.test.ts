// 扉の状態（rooms-b の実装担当のテスト。INT-8 の見た目の細部）
import { describe, expect, it } from 'vitest';
import { DOOR_OPEN_SEC, DoorChoices } from './doors';

const APPEAR = 350;
const DECIDE = 356.67;

describe('扉の状態', () => {
  it('現れる前は選べず、現れてから決まるまで選べる', () => {
    const d = new DoorChoices(APPEAR, DECIDE, 'lapis', null);
    expect(d.pick('amber', 300)).toBe(false);
    expect(d.enabledAt(349)).toBe(false);
    expect(d.enabledAt(350.1)).toBe(true);
    expect(d.pick('amber', 352)).toBe(true);
    expect(d.pick('lapis', 360)).toBe(false);
    expect(d.selectedAt(361)?.door).toBe('amber');
  });

  it('何もしなければ、決まる時刻にアプリの扉（既定は瑠璃）が開く', () => {
    const d = new DoorChoices(APPEAR, DECIDE, 'lapis', null);
    expect(d.look(DECIDE - 0.1).open).toEqual({ amber: 0, lapis: 0 });
    expect(d.look(DECIDE + DOOR_OPEN_SEC + 0.1).open.lapis).toBe(1);
    d.setAppDoor('amber');
    expect(d.look(DECIDE + DOOR_OPEN_SEC + 0.1).open.amber).toBe(1);
  });

  it('選び直すと前の扉は閉じ、開き具合は時刻だけで決まる（同じ時刻なら同じ見た目）', () => {
    const d = new DoorChoices(APPEAR, DECIDE, 'lapis', null);
    d.pick('amber', 351);
    d.pick('lapis', 353);
    const a = d.look(355);
    const b = d.look(355);
    expect(a).toEqual(b);
    expect(a.open.lapis).toBeGreaterThan(0.9);
    expect(a.open.amber).toBeLessThan(0.1);
    // 戻して見ても同じ
    expect(d.look(352).open.amber).toBeGreaterThan(0.4);
  });

  it('2周目は前回と違う扉が少し強く光る', () => {
    const d = new DoorChoices(APPEAR, DECIDE, 'lapis', 'amber');
    const l = d.look(APPEAR + 3);
    expect(l.glow.amber).toBeGreaterThan(l.glow.lapis);
  });

  it('時刻が戻ったら、その後の選択は捨てる', () => {
    const d = new DoorChoices(APPEAR, DECIDE, 'lapis', null);
    d.pick('amber', 352);
    d.rewind(200);
    expect(d.selectedAt(355)).toBeNull();
  });
});

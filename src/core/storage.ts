// localStorage の安全な読み書き。案1と共有する。
// プライベートウィンドウや容量超過で例外が出ても体験を止めない。読んだ値は既知のキーだけを検証して使う
// （JSON.parse の結果をそのまま使わない。プロトタイプ汚染と壊れた保存の対策）。

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** JSON を読む。無い・壊れている・読めないときは null */
export function readJson(key: string, store: KeyValueStore | null = defaultStore()): unknown {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** JSON を書く。書けなかったら false（容量超過、プライベートウィンドウ） */
export function writeJson(key: string, value: unknown, store: KeyValueStore | null = defaultStore()): boolean {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: string, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.removeItem(key);
  } catch {
    // 消せなくても続ける
  }
}

// ── 検証の小道具（読んだ値から既知のキーだけを取り出す） ─────────────────

/** 自身のプロパティだけを読む（__proto__ などを辿らない） */
export function own(obj: unknown, key: string): unknown {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

/** 有限の数で、範囲内ならその値。そうでなければ既定値 */
export function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

export function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** 候補のどれかと一致すればその値。そうでなければ既定値 */
export function oneOf<T extends string | number>(v: unknown, choices: readonly T[], fallback: T): T {
  return (choices as readonly unknown[]).includes(v) ? (v as T) : fallback;
}

/** 候補に含まれる文字列だけを、重複なしで取り出す */
export function subsetOf<T extends string>(v: unknown, choices: readonly T[]): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) if ((choices as readonly unknown[]).includes(x) && !out.includes(x as T)) out.push(x as T);
  return out;
}

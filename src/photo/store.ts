// 写真の棚の保存（IndexedDB）。1回の乗車 = 1件（id がキー、並びは createdAt の新しい順）。
// IndexedDB が使えない環境（プライベートウィンドウ、古い端末）や書き込みの失敗（容量超過）では、
// 例外を出さずにメモリへ退避して、その場の体験を止めない。
import { HIDDEN_BUBBLE_SECTIONS, PHOTO } from '../config';
import type { DoorChoice, Lang, ShotId } from '../contracts/ids';
import type { PhotoMeta, PhotoRecord, PhotoStore } from '../contracts/photo';
import { num, oneOf, own } from '../core/storage';

const STORE = 'rides';
const DOORS: readonly DoorChoice[] = ['amber', 'lapis'];
const LANGS: readonly Lang[] = ['ja', 'en'];
const SHOTS: readonly ShotId[] = ['bloom', 'freeze', 'constellation'];

/** 整数に丸めて範囲に収める。数でなければ fallback */
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

/** 読んだ値から既知のキーだけを取り出す。壊れていたら null（棚には出さない） */
function sanitizeRecord(raw: unknown): PhotoRecord | null {
  const id = own(raw, 'id');
  const createdAt = num(own(raw, 'createdAt'), -1, 0);
  if (typeof id !== 'string' || id.length === 0 || id.length > 128 || createdAt < 0) return null;

  const m = own(raw, 'meta');
  const date = own(m, 'date');
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const meta: PhotoMeta = {
    rideNo: clampInt(own(m, 'rideNo'), 0, 1_000_000, 0),
    date,
    door: oneOf(own(m, 'door'), DOORS, 'lapis'),
    // 額縁を決める数。範囲の外は端に丸める（壊れた値で額縁が崩れないように）
    hiddenTotal: clampInt(own(m, 'hiddenTotal'), 0, HIDDEN_BUBBLE_SECTIONS.length, 0),
    constellations: clampInt(own(m, 'constellations'), 0, 10_000, 0),
    lang: oneOf(own(m, 'lang'), LANGS, 'ja'),
  };

  // 場面ごとに 1 枚、最大 3 枚。画像でない種類が付いた Blob は捨てる（種類が空のものは通す）
  const rawShots = own(raw, 'shots');
  const shots: { shot: ShotId; image: Blob }[] = [];
  if (Array.isArray(rawShots)) {
    for (const s of rawShots) {
      const shot = own(s, 'shot');
      const image = own(s, 'image');
      if (!(SHOTS as readonly unknown[]).includes(shot) || !(image instanceof Blob) || (image.type !== '' && !image.type.startsWith('image/'))) continue;
      if (shots.some((x) => x.shot === shot) || shots.length >= SHOTS.length) continue;
      shots.push({ shot: shot as ShotId, image });
    }
  }
  if (shots.length === 0) return null;
  // 選んだ場面が撮れていなくても値は保つ（画面側が shots の先頭に切り替える）
  const chosen = oneOf(own(raw, 'chosen'), SHOTS, shots[0].shot);

  return { id, createdAt, meta, shots, chosen };
}

/** 新しい順（同時刻なら id で安定させる）に並べて、残す枚数まで */
function newestFirst(records: Iterable<PhotoRecord>): PhotoRecord[] {
  return [...records].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)).slice(0, PHOTO.keep);
}

function openDb(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('createdAt', 'createdAt');
    };
    req.onsuccess = () => {
      const db = req.result;
      // 別のタブがバージョンを上げようとしたら、接続を閉じて道を空ける
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function readAll(db: IDBDatabase): Promise<PhotoRecord[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => {
      const out: PhotoRecord[] = [];
      for (const raw of req.result as unknown[]) {
        const r = sanitizeRecord(raw);
        if (r) out.push(r);
      }
      resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 1件を入れて、残す枚数を超えた古いものを同じ取引の中で消す。入れられなければ false */
function putRecord(db: IDBDatabase, record: PhotoRecord): Promise<boolean> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put(record);
      const counting = store.count();
      counting.onsuccess = () => {
        let excess = counting.result - PHOTO.keep;
        if (excess <= 0) return;
        const cursorReq = store.index('createdAt').openCursor(); // 古い順
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && excess > 0) {
            excess--;
            cursor.delete();
            cursor.continue();
          }
        };
      };
    } catch {
      // DataCloneError（複製できない値）など
      resolve(false);
      return;
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

function removeRecord(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** ブラウザ内のデータベース（IndexedDB）。最新10枚まで */
export function createPhotoStore(dbName = 'utakata-photos'): PhotoStore {
  /** IndexedDB が使えない・書けなかったときの退避先（このタブの間だけ） */
  const memory = new Map<string, PhotoRecord>();
  let opening: Promise<IDBDatabase | null> | null = null;
  const db = () => (opening ??= openDb(dbName));

  return {
    async list() {
      const handle = await db();
      let stored: PhotoRecord[] = [];
      if (handle) {
        try {
          stored = await readAll(handle);
        } catch {
          // 読めなければ、メモリにあるものだけを見せる
        }
      }
      // 同じ id はメモリ（新しく入れた方）を優先する
      const merged = new Map(stored.map((r) => [r.id, r]));
      for (const [id, r] of memory) merged.set(id, r);
      return newestFirst(merged.values());
    },

    async put(record) {
      const handle = await db();
      const saved = handle ? await putRecord(handle, record) : false;
      if (saved) {
        memory.delete(record.id);
        return;
      }
      memory.set(record.id, record);
      for (const old of oldestBeyondKeep(memory)) memory.delete(old);
    },

    async remove(id) {
      memory.delete(id);
      const handle = await db();
      if (handle) await removeRecord(handle, id);
    },
  };
}

/** メモリが残す枚数を超えているとき、消す対象（古い順）の id */
function oldestBeyondKeep(memory: ReadonlyMap<string, PhotoRecord>): string[] {
  const keep = new Set(newestFirst(memory.values()).map((r) => r.id));
  return [...memory.keys()].filter((id) => !keep.has(id));
}

// 型つきの小さなイベントの仕組み。案1と共有する（core の外を import しない）。

export type Unsubscribe = () => void;

export interface TypedBus<E> {
  on<K extends keyof E>(type: K, fn: (payload: E[K]) => void): Unsubscribe;
  emit<K extends keyof E>(type: K, payload: E[K]): void;
}

/**
 * 受け手の例外で他の受け手が止まらないよう、例外は console.error に流して続ける。
 * emit の途中で on / off されても、その emit で呼ぶ受け手は変わらない（一覧を写してから回す）。
 */
export function createBus<E>(): TypedBus<E> {
  const handlers = new Map<keyof E, Set<(payload: never) => void>>();
  return {
    on(type, fn) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(fn as (payload: never) => void);
      return () => {
        set.delete(fn as (payload: never) => void);
      };
    },
    emit(type, payload) {
      const set = handlers.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          (fn as (p: typeof payload) => void)(payload);
        } catch (err) {
          console.error(`[bus] ${String(type)} の受け手で例外`, err);
        }
      }
    },
  };
}

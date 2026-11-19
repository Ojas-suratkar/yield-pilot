import { useCallback, useEffect, useSyncExternalStore } from "react";

/*
 * A small stale-while-revalidate cache for API reads. Keys name an immutable thing (a data version and mapping, a
 * forecast), so a cached answer is shown instantly on every revisit, and steps ahead are prefetched in the background.
 */

type Entry = { data?: unknown; error?: string; at: number; promise?: Promise<unknown> };
const cache = new Map<string, Entry>();
const subs = new Map<string, Set<() => void>>();
const EMPTY: Entry = { at: 0 };

// Answers are also kept in this browser (newest 80, small ones only), so a reload paints from disk in a few ms.
const ROOT = "yp:q:";
const DISK = `${ROOT}${process.env.BUILD_ID ?? "dev"}:`;
/** Forget answers saved by older releases: their shape may not match this code. */
export function clearSavedQueries(all = false) {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(ROOT) && (all || !k.startsWith(DISK)))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* storage blocked */
  }
}
if (typeof window !== "undefined") clearSavedQueries();
const disk = {
  read(key: string): Entry | undefined {
    try {
      const raw = localStorage.getItem(DISK + key);
      return raw ? (JSON.parse(raw) as Entry) : undefined;
    } catch {
      return undefined;
    }
  },
  write(key: string, e: Entry) {
    try {
      const raw = JSON.stringify({ data: e.data, at: e.at });
      if (raw.length > 400_000) return;
      localStorage.setItem(DISK + key, raw);
      const keys = Object.keys(localStorage).filter((k) => k.startsWith(DISK));
      if (keys.length > 80)
        keys
          .map((k) => [k, (JSON.parse(localStorage.getItem(k) ?? "{}") as Entry).at ?? 0] as const)
          .sort((a, b) => a[1] - b[1])
          .slice(0, keys.length - 80)
          .forEach(([k]) => localStorage.removeItem(k));
    } catch {
      /* storage full or blocked: memory cache still works */
    }
  },
};

function get(key: string): Entry | undefined {
  let e = cache.get(key);
  if (!e && typeof window !== "undefined") {
    e = disk.read(key);
    if (e) cache.set(key, e);
  }
  return e;
}

function put(key: string, e: Entry) {
  cache.set(key, e);
  if (e.data !== undefined && !e.promise) disk.write(key, e);
  subs.get(key)?.forEach((f) => f());
}

export function fetchQuery<T>(key: string, fn: () => Promise<T>, force = false): Promise<T> {
  const e = get(key);
  if (e?.promise) return e.promise as Promise<T>;
  if (e?.data !== undefined && !force) return Promise.resolve(e.data as T);
  const promise = fn().then(
    (data) => (put(key, { data, at: Date.now() }), data),
    (err: Error) => {
      cache.set(key, { data: cache.get(key)?.data, error: err.message, at: Date.now() });
      subs.get(key)?.forEach((f) => f());
      throw err;
    },
  );
  put(key, { data: e?.data, at: e?.at ?? 0, promise });
  return promise;
}

export const peekQuery = <T>(key: string) => get(key)?.data as T | undefined;
export const prefetch = (key: string, fn: () => Promise<unknown>) => void fetchQuery(key, fn).catch(() => undefined);
export const setQuery = (key: string, data: unknown) => put(key, { data, at: Date.now() });
export function dropQueries(prefix: string) {
  [...cache.keys()].filter((k) => k.startsWith(prefix)).forEach((k) => cache.delete(k));
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(DISK + prefix))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* storage blocked */
  }
}

/** Cached data at once (when there is any), refreshed in the background when older than maxAge ms. */
export function useQuery<T>(key: string | null, fn: () => Promise<T>, maxAge = Infinity) {
  const entry = useSyncExternalStore(
    useCallback(
      (l: () => void) => {
        if (!key) return () => undefined;
        const set = subs.get(key) ?? new Set();
        set.add(l);
        subs.set(key, set);
        return () => set.delete(l);
      },
      [key],
    ),
    () => (key ? (get(key) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
  useEffect(() => {
    if (!key) return;
    const e = get(key);
    if (e?.data === undefined || Date.now() - e.at > maxAge) void fetchQuery(key, fn, e?.data !== undefined).catch(() => undefined);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => (key ? fetchQuery(key, fn, true).catch(() => undefined) : undefined), [key, fn]);
  return {
    data: entry.data as T | undefined,
    error: entry.data === undefined ? entry.error : undefined,
    loading: !!key && entry.data === undefined && !entry.error,
    refreshing: !!entry.promise && entry.data !== undefined,
    reload,
  };
}

/* -------------------------------------------------------------- progress */

/** How far a long task is, as the server reports it (bytes sent, rows read, trees trained, steps finished). */
export interface Step {
  pct: number;
  label: string;
  detail?: string;
}

// Keyed by task (e.g. `plan:<project>`), so any page can show a task that started elsewhere.
const steps = new Map<string, Step>();
const stepListeners = new Set<() => void>();
export function setStep(key: string, s: Step | null) {
  if (s) steps.set(key, s);
  else steps.delete(key);
  stepListeners.forEach((f) => f());
}
export const useStep = (key: string | null) =>
  useSyncExternalStore(
    (l) => (stepListeners.add(l), () => stepListeners.delete(l)),
    () => (key ? steps.get(key) : undefined),
    () => undefined,
  );

const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_MAX_KEYS = 256;

export interface KeyedLogLimiter {
  /** Null while `key` is inside its window; otherwise how many calls were held back since it last went out. */
  take(key: string): number | null;
  clear(): void;
}

export function createKeyedLogLimiter(
  options: { windowMs?: number; maxKeys?: number; now?: () => number } = {}
): KeyedLogLimiter {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? (() => performance.now());
  const entries = new Map<string, { at: number; suppressed: number }>();

  return {
    take(key) {
      const t = now();
      const entry = entries.get(key);
      if (entry && t - entry.at < windowMs) {
        entry.suppressed++;
        return null;
      }
      const suppressed = entry?.suppressed ?? 0;
      entries.delete(key);
      entries.set(key, { at: t, suppressed: 0 });
      if (entries.size > maxKeys) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return suppressed;
    },
    clear() {
      entries.clear();
    },
  };
}

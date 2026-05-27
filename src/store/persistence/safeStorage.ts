import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";
import { isRendererPerfCaptureEnabled, markRendererPerformance } from "@/utils/performance";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { notify } from "@/lib/notify";

const fallbackStorageData = new Map<string, string>();

const BACKUP_KEY_SUFFIX = ".__bak";

/**
 * A `QuotaExceededError` (or its Firefox alias) is transient: the write was
 * too large, but storage is still healthy, so smaller subsequent writes can
 * succeed. We must NOT permanently route a store to in-memory storage on quota
 * — that would silently drop every later write for the session (issue #9170).
 */
function isQuotaExceededError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

function shouldCollectPersistencePerf(): boolean {
  if (typeof window === "undefined") return false;
  return isRendererPerfCaptureEnabled() || Array.isArray(window.__DAINTREE_PERF_MARKS__);
}

const PERF_TEXT_ENCODER = new TextEncoder();

function estimateStringBytes(value: string | null): number | null {
  if (value === null) return null;
  try {
    return PERF_TEXT_ENCODER.encode(value).length;
  } catch {
    return null;
  }
}

function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const memoryStorage: StateStorage = {
  getItem: (name) => fallbackStorageData.get(name) ?? null,
  setItem: (name, value) => {
    fallbackStorageData.set(name, value);
  },
  removeItem: (name) => {
    fallbackStorageData.delete(name);
  },
};

function resolveLocalStorage(): StateStorage | undefined {
  let storage: unknown;

  try {
    storage = globalThis.localStorage;
  } catch {
    return undefined;
  }

  if (!storage) {
    return undefined;
  }

  const candidate = storage as Partial<StateStorage>;
  const hasStorageApi =
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function";

  return hasStorageApi ? (candidate as StateStorage) : undefined;
}

/**
 * Outcome of a resilient write, so the caller can keep the backup copy
 * consistent with what actually reached durable storage:
 * - `durable`  — written to real localStorage; the backup may advance.
 * - `quota`    — transient quota error; primary unchanged, backup must NOT advance.
 * - `memory`   — written only to the in-memory fallback; nothing durable to back up.
 */
type ResilientWriteResult = "durable" | "quota" | "memory";

/**
 * Resilient storage augmented with best-effort backup operations. The backup
 * methods write/read a sibling `${key}.__bak` entry directly on the real
 * localStorage — bypassing the perf-marked primary path and skipping entirely
 * once a permanent in-memory fallback is active (a backup in memory buys
 * nothing and would needlessly re-hit broken localStorage).
 */
interface ResilientStorage {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => ResilientWriteResult;
  removeItem: (name: string) => void;
  writeBackup: (name: string, value: string) => void;
  readBackup: (name: string) => string | null;
  removeBackup: (name: string) => void;
}

function createResilientStorage(baseStorage: StateStorage | undefined): ResilientStorage {
  let activeStorage = baseStorage ?? memoryStorage;
  let hasNotifiedPermanentFallback = false;

  const switchToMemoryStorage = (): StateStorage => {
    activeStorage = memoryStorage;
    return activeStorage;
  };

  const backupKeyFor = (name: string): string => `${name}${BACKUP_KEY_SUFFIX}`;

  // Fire exactly once per storage instance when a structural failure forces a
  // permanent in-memory fallback. Until then writes never reach localStorage,
  // so changes this session are lost on restart — a degradation the user can't
  // otherwise observe. Quota errors are transient and never reach here.
  const notifyPermanentFallbackOnce = (): void => {
    if (hasNotifiedPermanentFallback) return;
    hasNotifiedPermanentFallback = true;
    try {
      notify({
        type: "warning",
        title: "Settings won't be saved",
        message:
          "Couldn't write to local storage, so changes made this session won't persist after restart.",
        context: { eventKind: "settings" },
      });
    } catch {
      // The notification surface is best-effort — never let it break persistence.
    }
  };

  return {
    getItem: (name) => {
      const collectPerf = shouldCollectPersistencePerf();
      const startedAt = collectPerf ? perfNow() : 0;
      const storage: "localStorage" | "memory" =
        activeStorage === memoryStorage ? "memory" : "localStorage";
      try {
        const value = activeStorage.getItem(name);
        if (collectPerf && !(value instanceof Promise)) {
          markRendererPerformance("persistence_localstorage_get", {
            key: name,
            payloadBytes: estimateStringBytes(value),
            durationMs: Number((perfNow() - startedAt).toFixed(3)),
            ok: true,
            storage,
          });
        }
        return value;
      } catch {
        if (collectPerf) {
          markRendererPerformance("persistence_localstorage_get", {
            key: name,
            payloadBytes: null,
            durationMs: Number((perfNow() - startedAt).toFixed(3)),
            ok: false,
            storage,
          });
        }
        return switchToMemoryStorage().getItem(name);
      }
    },
    setItem: (name, value) => {
      const collectPerf = shouldCollectPersistencePerf();
      const startedAt = collectPerf ? perfNow() : 0;
      const payloadBytes = collectPerf ? estimateStringBytes(value) : null;
      const storage: "localStorage" | "memory" =
        activeStorage === memoryStorage ? "memory" : "localStorage";
      const wroteToMemory = activeStorage === memoryStorage;
      try {
        activeStorage.setItem(name, value);
        if (collectPerf) {
          markRendererPerformance("persistence_localstorage_set", {
            key: name,
            payloadBytes,
            durationMs: Number((perfNow() - startedAt).toFixed(3)),
            ok: true,
            storage,
          });
        }
        return wroteToMemory ? "memory" : "durable";
      } catch (error) {
        if (collectPerf) {
          markRendererPerformance("persistence_localstorage_set", {
            key: name,
            payloadBytes,
            durationMs: Number((perfNow() - startedAt).toFixed(3)),
            ok: false,
            storage,
          });
        }
        if (isQuotaExceededError(error)) {
          // Transient: storage is healthy but this write was too large. Keep
          // localStorage active so later (smaller) writes retry it. The value
          // still lives in the in-memory React store this session; it simply
          // isn't persisted, so we don't switch storages or notify.
          console.warn("[safeStorage] storage quota exceeded, skipping persistent write", {
            key: name,
            error: formatErrorMessage(error, "Storage quota exceeded"),
          });
          return "quota";
        }
        switchToMemoryStorage().setItem(name, value);
        notifyPermanentFallbackOnce();
        return "memory";
      }
    },
    removeItem: (name) => {
      try {
        activeStorage.removeItem(name);
      } catch (error) {
        if (isQuotaExceededError(error)) {
          memoryStorage.removeItem(name);
          return;
        }
        switchToMemoryStorage().removeItem(name);
        notifyPermanentFallbackOnce();
      }
    },
    writeBackup: (name, value) => {
      // Skip while in memory fallback: localStorage is known broken, so a write
      // here would just re-hit it (and a memory backup duplicates live state).
      if (activeStorage === memoryStorage || !baseStorage) return;
      try {
        baseStorage.setItem(backupKeyFor(name), value);
      } catch {
        // Backup is opportunistic — losing it is acceptable.
      }
    },
    readBackup: (name) => {
      // localStorage is known broken once we've fallen back — don't re-hit it.
      if (activeStorage === memoryStorage || !baseStorage) return null;
      try {
        const value = baseStorage.getItem(backupKeyFor(name));
        return value instanceof Promise ? null : value;
      } catch {
        return null;
      }
    },
    removeBackup: (name) => {
      if (!baseStorage) return;
      try {
        baseStorage.removeItem(backupKeyFor(name));
      } catch {
        // Best-effort cleanup.
      }
    },
  };
}

/**
 * Parse a JSON string safely, returning a typed fallback and logging a warning
 * with caller-supplied context (store/key) when the parse fails. Null input is
 * treated as an absent value and returns the fallback without warning —
 * corruption is distinct from a cache miss.
 */
export function safeJSONParse<T>(
  raw: string | null,
  context: { store: string; key: string },
  fallback: T
): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn("[safeStorage] JSON parse failed", {
      ...context,
      error: formatErrorMessage(error, "JSON parse failed"),
    });
    return fallback;
  }
}

/**
 * Parse a recovered backup blob, returning null when it is absent or itself
 * corrupt so the caller falls through to a clean reset.
 */
function parseBackup<T>(raw: string | null): StorageValue<T> | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as StorageValue<T>;
  } catch {
    return null;
  }
}

export function createSafeJSONStorage<T>(): PersistStorage<T> {
  const raw = createResilientStorage(resolveLocalStorage());

  return {
    getItem: (name) => {
      const value = raw.getItem(name);
      if (value instanceof Promise) return null;
      if (value === null) return null;
      try {
        return JSON.parse(value) as StorageValue<T>;
      } catch (error) {
        // The live blob is corrupt but present — try the last known-good backup
        // before discarding the user's config to defaults (issue #9170).
        const recovered = parseBackup<T>(raw.readBackup(name));
        if (recovered !== null) {
          console.warn("[safeStorage] corrupt persisted state, recovered from backup", {
            key: name,
            error: formatErrorMessage(error, "Corrupt persisted state"),
          });
          return recovered;
        }
        console.warn("[safeStorage] corrupt persisted state, resetting to defaults", {
          key: name,
          error: formatErrorMessage(error, "Corrupt persisted state"),
        });
        return null;
      }
    },
    setItem: (name, value) => {
      const serialized = JSON.stringify(value);
      // Only advance the backup when the primary write actually reached durable
      // storage. On a quota failure the primary keeps its old value, so writing
      // a newer backup would leave the two inconsistent and recover stale state.
      if (raw.setItem(name, serialized) === "durable") {
        raw.writeBackup(name, serialized);
      }
    },
    removeItem: (name) => {
      raw.removeItem(name);
      raw.removeBackup(name);
    },
  };
}

export function readLocalStorageItemSafely(name: string): string | null {
  const storage = resolveLocalStorage();
  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(name);
    return value instanceof Promise ? null : value;
  } catch {
    return null;
  }
}

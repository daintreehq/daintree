import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";
import { isRendererPerfCaptureEnabled, markRendererPerformance } from "@/utils/performance";
import { formatErrorMessage } from "@shared/utils/errorMessage";

const fallbackStorageData = new Map<string, string>();

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

function createResilientStorage(baseStorage: StateStorage | undefined): StateStorage {
  let activeStorage = baseStorage ?? memoryStorage;

  const switchToMemoryStorage = (): StateStorage => {
    activeStorage = memoryStorage;
    return activeStorage;
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
      } catch {
        if (collectPerf) {
          markRendererPerformance("persistence_localstorage_set", {
            key: name,
            payloadBytes,
            durationMs: Number((perfNow() - startedAt).toFixed(3)),
            ok: false,
            storage,
          });
        }
        switchToMemoryStorage().setItem(name, value);
      }
    },
    removeItem: (name) => {
      try {
        activeStorage.removeItem(name);
      } catch {
        switchToMemoryStorage().removeItem(name);
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
        console.warn("[safeStorage] corrupt persisted state, resetting to defaults", {
          key: name,
          error: formatErrorMessage(error, "Corrupt persisted state"),
        });
        return null;
      }
    },
    setItem: (name, value) => {
      raw.setItem(name, JSON.stringify(value));
    },
    removeItem: (name) => {
      raw.removeItem(name);
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

import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

const fallbackStorageData = new Map<string, string>();

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
      try {
        return activeStorage.getItem(name);
      } catch {
        return switchToMemoryStorage().getItem(name);
      }
    },
    setItem: (name, value) => {
      try {
        activeStorage.setItem(name, value);
      } catch {
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
      error: error instanceof Error ? error.message : String(error),
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
          error: error instanceof Error ? error.message : String(error),
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

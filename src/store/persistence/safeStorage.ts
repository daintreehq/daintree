import { createJSONStorage, type PersistStorage, type StateStorage } from "zustand/middleware";

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

export function createSafeJSONStorage<T>(): PersistStorage<T> {
  return createJSONStorage<T>(() => createResilientStorage(resolveLocalStorage()))!;
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

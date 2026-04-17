/**
 * Read-only registry for diagnosing renderer-side Zustand stores that persist
 * to localStorage. Stores opt in at module-load time by passing a reference to
 * the live store; the registry derives `name`/`version`/`partialize`/`migrate`/
 * `merge` lazily from `store.persist.getOptions()` so there is no duplicated
 * metadata to keep in sync.
 *
 * Registration has no effect on persistence behavior — the registry is a pure
 * lookup surface for the `actions.persistedStores` diagnostic action.
 */

interface PersistOptionsShape {
  name?: string;
  version?: number;
  partialize?: unknown;
  migrate?: unknown;
  merge?: unknown;
}

export interface StoreWithPersist {
  persist: {
    getOptions: () => Partial<PersistOptionsShape>;
  };
}

export interface PersistedStoreRegistration {
  /** Stable identifier for the store module (e.g. "preferencesStore"). */
  storeId: string;
  /** Live reference to the Zustand store; used for `persist.getOptions()`. */
  store: StoreWithPersist;
  /** TypeScript type name of the persisted shape (documentation-only). */
  persistedStateType: string;
}

const registry = new Map<string, PersistedStoreRegistration>();

function isDev(): boolean {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}

export function registerPersistedStore(registration: PersistedStoreRegistration): void {
  const existing = registry.get(registration.storeId);
  if (existing) {
    const message = `[persistedStoreRegistry] duplicate storeId: "${registration.storeId}"`;
    if (isDev()) throw new Error(message);
    console.warn(message);
    return;
  }

  const incomingKey = registration.store.persist.getOptions().name;
  if (typeof incomingKey === "string") {
    for (const entry of registry.values()) {
      if (entry.store.persist.getOptions().name === incomingKey) {
        const message =
          `[persistedStoreRegistry] storage key collision: "${incomingKey}" ` +
          `already registered by "${entry.storeId}" (new: "${registration.storeId}")`;
        if (isDev()) throw new Error(message);
        console.warn(message);
        return;
      }
    }
  }

  registry.set(registration.storeId, registration);
}

export function listPersistedStores(): readonly PersistedStoreRegistration[] {
  return Array.from(registry.values());
}

export function _resetPersistedStoreRegistryForTests(): void {
  registry.clear();
}

import { store, type StoreSchema } from "../store.js";

export type SecureKey = "userConfig.githubToken";

type UserConfigKey = keyof StoreSchema["userConfig"];
type DotNotatedUserConfigKey = `userConfig.${UserConfigKey}`;

/**
 * Simple key-value storage backed by electron-store.
 * Values are stored as plain text — the same security model as ~/.gitconfig or .env files.
 */
class SecureStorage {
  public set(key: SecureKey, value: string | undefined): void {
    if (!value) {
      store.delete(key as DotNotatedUserConfigKey);
      return;
    }
    store.set(key as DotNotatedUserConfigKey, value);
  }

  public get(key: SecureKey): string | undefined {
    const rawValue = store.get(key as DotNotatedUserConfigKey) as unknown;
    if (rawValue === undefined || rawValue === null || rawValue === "") return undefined;
    if (typeof rawValue !== "string") {
      console.warn(`[SecureStorage] Found invalid non-string ${key}, clearing corrupted entry.`);
      store.delete(key as DotNotatedUserConfigKey);
      return undefined;
    }
    return rawValue;
  }

  public delete(key: SecureKey): void {
    store.delete(key as DotNotatedUserConfigKey);
  }
}

export const secureStorage = new SecureStorage();

import * as electron from "electron";
import { store, type StoreSchema } from "../store.js";

export type SecureKey = "userConfig.githubToken";

type UserConfigKey = keyof StoreSchema["userConfig"];
type DotNotatedUserConfigKey = `userConfig.${UserConfigKey}`;

class SecureStorage {
  private _isAvailable: boolean | undefined;

  private get isAvailable(): boolean {
    if (!electron.safeStorage) {
      return false;
    }
    if (this._isAvailable === undefined) {
      this._isAvailable = electron.safeStorage.isEncryptionAvailable();
      if (!this._isAvailable) {
        console.warn("[SecureStorage] OS encryption not available. Falling back to plain text.");
      }
    }
    return this._isAvailable;
  }

  private isHexEncoded(value: string): boolean {
    return /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0;
  }

  public set(key: SecureKey, value: string | undefined): void {
    if (!value) {
      store.delete(key as DotNotatedUserConfigKey);
      return;
    }

    if (this.isAvailable) {
      try {
        const encrypted = electron.safeStorage.encryptString(value);
        store.set(key as DotNotatedUserConfigKey, encrypted.toString("hex"));
      } catch (error) {
        console.error(
          `[SecureStorage] Failed to encrypt ${key}, falling back to plain text:`,
          error
        );
        store.set(key as DotNotatedUserConfigKey, value);
      }
    } else {
      store.set(key as DotNotatedUserConfigKey, value);
    }
  }

  public get(key: SecureKey): string | undefined {
    const rawValue = store.get(key as DotNotatedUserConfigKey) as unknown;
    if (rawValue === undefined || rawValue === null || rawValue === "") return undefined;
    if (typeof rawValue !== "string") {
      console.warn(`[SecureStorage] Found invalid non-string ${key}, clearing corrupted entry.`);
      store.delete(key as DotNotatedUserConfigKey);
      return undefined;
    }

    const storedValue = rawValue;

    // If it's not hex encoded, it's definitely plain text.
    if (!this.isHexEncoded(storedValue)) {
      if (this.isAvailable) {
        console.info(`[SecureStorage] Found plain-text ${key}, migrating to encrypted storage.`);
        this.set(key, storedValue);
      } else {
        console.warn(
          `[SecureStorage] Found plain-text ${key}, but encryption is unavailable. Keeping as plain-text.`
        );
      }
      return storedValue;
    }

    // Only check for encryption availability if we have an encrypted value to decrypt
    if (this.isAvailable) {
      try {
        const buffer = Buffer.from(storedValue, "hex");
        return electron.safeStorage.decryptString(buffer);
      } catch (_error) {
        console.warn(
          `[SecureStorage] Failed to decrypt ${key}, clearing corrupted entry. User will need to re-enter.`
        );
        store.delete(key as DotNotatedUserConfigKey);
        return undefined;
      }
    }

    // Value is hex encoded (looks encrypted) but encryption is not available
    if (this.isHexEncoded(storedValue)) {
      console.warn(
        `[SecureStorage] Found encrypted ${key} but encryption unavailable. Clearing entry, user will need to re-enter.`
      );
      store.delete(key as DotNotatedUserConfigKey);
      return undefined;
    }

    return storedValue;
  }
  public delete(key: SecureKey): void {
    store.delete(key as DotNotatedUserConfigKey);
  }
}

export const secureStorage = new SecureStorage();

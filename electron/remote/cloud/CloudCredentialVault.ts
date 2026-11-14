import { PluginSettingsStore } from "../../services/PluginSettingsStore.js";
import {
  safeStorageCipher,
  secretWriteRefusal,
  type SecretCipher,
} from "../../services/plugin/secretCipher.js";
import { AppError } from "../../utils/errorTypes.js";

/**
 * Cloud account keys, one per account id, held only as OS-keychain
 * ciphertext in their own file (never in the settings file, which other
 * features copy and export). A key is written once when the account is
 * connected or its key replaced, read in main when a provider call needs it,
 * and never returned over IPC. With no keychain, the write is refused rather
 * than stored in plaintext.
 */
export interface CloudCredentialVault {
  available(): boolean;
  put(accountId: string, apiKey: string): Promise<void>;
  get(accountId: string): Promise<string | null>;
  delete(accountId: string): Promise<void>;
}

export class KeychainCloudCredentialVault implements CloudCredentialVault {
  private readonly store: PluginSettingsStore;

  constructor(
    filePath: string,
    private readonly cipher: SecretCipher = safeStorageCipher
  ) {
    this.store = new PluginSettingsStore(filePath, cipher);
  }

  available(): boolean {
    return this.cipher.tier() === "keychain";
  }

  async put(accountId: string, apiKey: string): Promise<void> {
    const tier = this.cipher.tier();
    if (tier !== "keychain") {
      throw new AppError({
        code: "UNSUPPORTED",
        message: "No OS keychain to protect the cloud API key",
        userMessage: `${secretWriteRefusal("API key", tier)}. Daintree never stores a cloud key in plain text.`,
      });
    }
    try {
      await this.store.set(accountId, apiKey, { secret: true });
    } catch (error) {
      // The store's own message names the entry; the person needs only what happened.
      throw new AppError({
        code: "PERSIST_FAILED",
        message: "Couldn't seal the cloud API key",
        userMessage:
          "Daintree couldn't save the API key in this device's keychain. Unlock the keychain if it asked, then try again.",
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async get(accountId: string): Promise<string | null> {
    const value = await this.store.get<string>(accountId, { secret: true });
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  async delete(accountId: string): Promise<void> {
    await this.store.delete(accountId);
  }
}

/** For tests: keys in memory. */
export class MemoryCloudCredentialVault implements CloudCredentialVault {
  readonly keys = new Map<string, string>();
  available(): boolean {
    return true;
  }
  async put(accountId: string, apiKey: string): Promise<void> {
    this.keys.set(accountId, apiKey);
  }
  async get(accountId: string): Promise<string | null> {
    return this.keys.get(accountId) ?? null;
  }
  async delete(accountId: string): Promise<void> {
    this.keys.delete(accountId);
  }
}

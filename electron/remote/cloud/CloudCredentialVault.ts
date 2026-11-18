import { PluginSettingsStore } from "../../services/PluginSettingsStore.js";
import {
  safeStorageCipher,
  secretWriteRefusal,
  type SecretCipher,
} from "../../services/plugin/secretCipher.js";
import type { CloudCredentialValues } from "../../../shared/types/cloudHosts.js";
import { AppError } from "../../utils/errorTypes.js";

/**
 * Cloud account credentials, one sealed set per account id, held only as
 * OS-keychain ciphertext in their own file (never in the settings file, which
 * other features copy and export). A set is written whole when the account is
 * connected or its credentials replaced, read in main when a provider call
 * needs it, and never returned over IPC. With no keychain, the write is
 * refused rather than stored in plaintext.
 */
export interface CloudCredentialVault {
  available(): boolean;
  /** Seals the account's whole set, replacing whatever it held. */
  put(accountId: string, values: CloudCredentialValues): Promise<void>;
  get(accountId: string): Promise<CloudCredentialValues | null>;
  delete(accountId: string): Promise<void>;
}

/**
 * Before sets, an account sealed one bare API key; every one of them was a
 * provider whose only credential field is this id.
 */
const LEGACY_KEY_FIELD = "apiKey";
/**
 * The first line of a sealed set. A bare key was one trimmed line, so anything
 * with a line break in it is a set, however the key itself was spelled.
 */
const SEALED_SET_HEADER = "daintree-cloud-credentials/1";

export function sealCloudCredentials(values: CloudCredentialValues): string {
  return `${SEALED_SET_HEADER}\n${JSON.stringify(values)}`;
}

/**
 * A sealed set, or a bare key sealed before sets existed. Null when there is
 * nothing usable: a set this build can't read is never taken for a bare key.
 */
export function openCloudCredentials(sealed: unknown): CloudCredentialValues | null {
  if (typeof sealed !== "string" || sealed.length === 0) return null;
  const breakAt = sealed.indexOf("\n");
  if (breakAt === -1) return { [LEGACY_KEY_FIELD]: sealed };
  if (sealed.slice(0, breakAt) !== SEALED_SET_HEADER) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sealed.slice(breakAt + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const values: CloudCredentialValues = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== "string") return null;
    if (value.length > 0) values[id] = value;
  }
  return Object.keys(values).length > 0 ? values : null;
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

  async put(accountId: string, values: CloudCredentialValues): Promise<void> {
    const tier = this.cipher.tier();
    if (tier !== "keychain") {
      throw new AppError({
        code: "UNSUPPORTED",
        message: "No OS keychain to protect the cloud credentials",
        userMessage: `${secretWriteRefusal("credentials", tier)}. Daintree never stores cloud credentials in plain text.`,
      });
    }
    try {
      await this.store.set(accountId, sealCloudCredentials(values), { secret: true });
    } catch (error) {
      // The store's own message names the entry; the person needs only what happened.
      throw new AppError({
        code: "PERSIST_FAILED",
        message: "Couldn't seal the cloud credentials",
        userMessage:
          "Daintree couldn't save the credentials in this device's keychain. Unlock the keychain if it asked, then try again.",
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async get(accountId: string): Promise<CloudCredentialValues | null> {
    return openCloudCredentials(await this.store.get<string>(accountId, { secret: true }));
  }

  async delete(accountId: string): Promise<void> {
    await this.store.delete(accountId);
  }
}

/** For tests: sets in memory. */
export class MemoryCloudCredentialVault implements CloudCredentialVault {
  readonly sets = new Map<string, CloudCredentialValues>();
  available(): boolean {
    return true;
  }
  async put(accountId: string, values: CloudCredentialValues): Promise<void> {
    this.sets.set(accountId, { ...values });
  }
  async get(accountId: string): Promise<CloudCredentialValues | null> {
    const values = this.sets.get(accountId);
    return values ? { ...values } : null;
  }
  async delete(accountId: string): Promise<void> {
    this.sets.delete(accountId);
  }
}

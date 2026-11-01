import { safeStorage } from "electron";
import {
  ciphertextPrefix,
  encryptWithKeychain,
  keychainAvailable,
  keychainKeyed,
  keychainLockedReason,
  keychainSessionFailure,
  selectedLinuxBackend,
  SecretStorageTimeoutError,
  withSecretStorageTimeout,
} from "../osKeychain.js";
import { isLinuxKeyringBackend } from "./linuxKeyringBackend.js";

export {
  _resetSecretStorageSessionForTests,
  SECRET_STORAGE_TIMEOUT_MS,
  SecretStorageTimeoutError,
} from "../osKeychain.js";

/**
 * The at-rest tier a secret write would use right now, disclosed honestly in the
 * plugin settings UI. `"unavailable"` means there is no OS keychain to encrypt
 * with, and a secret write is refused rather than stored in plaintext (#12613).
 * `"locked"` means there is one, but it gave Daintree no key this session (its
 * unlock prompt was dismissed or failed) and only a restart asks again.
 */
export type SecretStorageTier = "keychain" | "locked" | "unavailable";

/** A decrypted secret, and whether its ciphertext is due to be written again. */
export interface DecryptedSecret {
  plaintext: string;
  /**
   * The ciphertext should be replaced: Chromium reports its key superseded (a
   * fixed-key value now that a keyring answers), or only the synchronous API
   * could read it.
   */
  reencrypt: boolean;
}

/**
 * Encrypts/decrypts secret setting values for at-rest storage. The store holds
 * an instance so the OS-keychain dependency is injectable — vitest's node
 * environment has no Electron `safeStorage`, and tests substitute a fake.
 */
export interface SecretCipher {
  /** Which at-rest tier {@link encrypt} will use right now. */
  tier(): SecretStorageTier;
  /**
   * Encrypt a plaintext secret to a base64 ciphertext string. Resolves `null`
   * when no OS keychain holds the key (the caller then refuses the write), and
   * rejects when the keychain didn't answer in time.
   */
  encrypt(plaintext: string): Promise<string | null>;
  /**
   * Decrypt a base64 ciphertext. `legacy` marks one the synchronous API wrote
   * before secrets moved to the async one, which may need that API to read.
   */
  decrypt(ciphertextBase64: string, options?: { legacy?: boolean }): Promise<DecryptedSecret>;
}

const RESTART = "restart Daintree to try again";

/** Why a secret write was refused at `tier`, in words for the person who tried it. */
export function secretWriteRefusal(key: string, tier: SecretStorageTier): string {
  if (tier !== "locked") {
    return `Secure storage is unavailable on this device, so the secret "${key}" wasn't saved`;
  }
  return `${keychainLockedReason()}, so the secret "${key}" wasn't saved — ${RESTART}`;
}

function readRefusal(cause?: unknown): unknown {
  if (keychainSessionFailure() === "locked") {
    return new Error(`${keychainLockedReason()}, so the secret couldn't be read — ${RESTART}`);
  }
  return cause ?? new Error("Secure storage is unavailable, so the secret couldn't be read");
}

/**
 * The synchronous API, kept only to read ciphertext it wrote before secrets
 * moved to the async one. It fetches the key on the main thread and would hold
 * the app on a keychain prompt until the watchdog kills it, so callers run it
 * only once {@link keychainKeyed} shows the async encryptor holds a real key:
 * the keychain has answered by then. On KWallet that means the async provider
 * has just opened the wallet, which kwalletd leaves open by default; a wallet
 * set to close as soon as no app uses it can still prompt here, once per legacy
 * secret, since the read that needed this rewrites it through the async API.
 * Gone in Electron 46.
 */
function decryptLegacy(ciphertext: Buffer, cause?: unknown): string {
  if (typeof safeStorage?.decryptString !== "function") throw readRefusal(cause);
  return safeStorage.decryptString(ciphertext);
}

/**
 * The sync API keeps its KWallet key in the "Chromium Keys" folder every
 * Chromium-based app shares; Electron's async provider keeps its own under the
 * app's name. A sync "v11" value is therefore under a key the async API doesn't
 * hold, and decrypting it there fails, or with an unlucky padding byte returns
 * garbage. libsecret, Keychain and DPAPI share one key across both APIs.
 */
function needsSyncKey(ciphertext: Buffer): boolean {
  return (
    process.platform === "linux" &&
    (selectedLinuxBackend() ?? "").startsWith("kwallet") &&
    ciphertextPrefix(ciphertext) === "v11"
  );
}

/**
 * Default cipher backed by Electron `safeStorage` (macOS Keychain, Windows DPAPI,
 * Linux libsecret/kwallet) through its async API, which fetches the key off the
 * main thread: on Linux the sync API holds the whole app on a keyring prompt.
 */
export const safeStorageCipher: SecretCipher = {
  tier() {
    // What this session already learned stands until restart, and answering
    // from it keeps the sync check below from going back to a Keychain that
    // just refused, on the main thread.
    const sessionFailure = keychainSessionFailure();
    if (sessionFailure !== null) return sessionFailure;
    // On Linux isEncryptionAvailable() fetches the key synchronously and holds
    // the main thread on a keyring prompt (autologin, a locked or missing
    // keyring) until the watchdog kills the app. The settings view only needs
    // the tier, which the backend already tells; a write still checks fully.
    const present =
      process.platform === "linux"
        ? isLinuxKeyringBackend(selectedLinuxBackend() ?? "")
        : keychainAvailable();
    return present ? "keychain" : "unavailable";
  },
  async encrypt(plaintext) {
    return (await encryptWithKeychain(plaintext))?.toString("base64") ?? null;
  },
  async decrypt(ciphertextBase64, options) {
    const ciphertext = Buffer.from(ciphertextBase64, "base64");
    const legacy = options?.legacy === true;
    if (legacy && needsSyncKey(ciphertext)) {
      if (!(await keychainKeyed())) throw readRefusal();
      return { plaintext: decryptLegacy(ciphertext), reencrypt: true };
    }
    try {
      const { result, shouldReEncrypt } = await withSecretStorageTimeout(
        safeStorage.decryptStringAsync(ciphertext)
      );
      return { plaintext: result, reencrypt: shouldReEncrypt };
    } catch (error) {
      if (error instanceof SecretStorageTimeoutError) throw error;
      // Electron's own message names neither the cause nor a way round it; a
      // keychain that gave no key this session is both.
      if (!(await keychainKeyed())) throw readRefusal(error);
      // Outside KWallet, Linux's sync API holds the same keys as the async one,
      // so a sync retry could only add a keyring prompt on the main thread.
      if (!legacy || process.platform === "linux") throw error;
      return { plaintext: decryptLegacy(ciphertext, error), reencrypt: true };
    }
  },
};

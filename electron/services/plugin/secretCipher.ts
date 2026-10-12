import { safeStorage } from "electron";
import { isLinuxKeyringBackend } from "./linuxKeyringBackend.js";

/**
 * The at-rest tier a secret write would use right now, disclosed honestly in the
 * plugin settings UI. `"unavailable"` means there is no OS keychain to encrypt
 * with, and a secret write is refused rather than stored in plaintext (#12613).
 */
export type SecretStorageTier = "keychain" | "unavailable";

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

/**
 * A keychain prompt waits on a person, so a call can take as long as it takes
 * them to type a password. It must not wait forever, though: no one may be at
 * the machine (a remote host), and a pending write holds up the plugin's whole
 * settings store behind it.
 */
export const SECRET_STORAGE_TIMEOUT_MS = 60_000;

export class SecretStorageTimeoutError extends Error {
  constructor(ms: number) {
    super(
      `Secure storage didn't answer within ${Math.round(ms / 1000)} s. It may be waiting on a password prompt.`
    );
    this.name = "SecretStorageTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new SecretStorageTimeoutError(SECRET_STORAGE_TIMEOUT_MS)),
      SECRET_STORAGE_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function linuxBackend(): string | null {
  try {
    return safeStorage.getSelectedStorageBackend();
  } catch {
    return null;
  }
}

/**
 * `safeStorage.isEncryptionAvailable()` can throw on Linux when called before
 * the app `ready` event, and `safeStorage` is absent entirely outside an Electron
 * runtime. Treat any such failure as "no keychain" so a settings read never
 * crashes on it.
 */
function keychainAvailable(): boolean {
  try {
    return safeStorage?.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}

function prefixOf(ciphertext: Buffer): string {
  return ciphertext.subarray(0, 3).toString("latin1");
}

/**
 * Encrypt with the async API, or `null` when the result wouldn't be keychain
 * protected. Linux needs a real keyring backend, and Chromium's async encryptor
 * falls back there to its fixed-key provider ("v10") when the keyring doesn't
 * answer, which anyone can decrypt.
 */
async function encryptWithKeychain(plaintext: string): Promise<Buffer | null> {
  const linux = process.platform === "linux";
  if (linux && !isLinuxKeyringBackend(linuxBackend() ?? "")) return null;
  let encrypted: Buffer;
  try {
    encrypted = await withTimeout(safeStorage.encryptStringAsync(plaintext));
  } catch (error) {
    if (error instanceof SecretStorageTimeoutError) throw error;
    return null;
  }
  return linux && prefixOf(encrypted) === "v10" ? null : encrypted;
}

const PROBE_TEXT = "daintree-secret-probe";

/**
 * The synchronous API, kept only to read ciphertext it wrote before secrets
 * moved to the async one. It fetches the key on the main thread and would hold
 * the app on a keychain prompt until the watchdog kills it, so it runs only once
 * the async encryptor holds a real keychain key: the keychain has answered by
 * then. On KWallet that means the async provider has just opened the wallet,
 * which kwalletd leaves open by default; a wallet set to close as soon as no
 * app uses it can still prompt here, once per legacy secret, since the read
 * that needed this rewrites it through the async API. Gone in Electron 46.
 */
async function decryptLegacy(ciphertext: Buffer, cause?: unknown): Promise<string> {
  const unreadable =
    cause ?? new Error("Secure storage is unavailable, so the secret couldn't be read");
  if (typeof safeStorage?.decryptString !== "function") throw unreadable;
  if ((await encryptWithKeychain(PROBE_TEXT)) === null) throw unreadable;
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
    (linuxBackend() ?? "").startsWith("kwallet") &&
    prefixOf(ciphertext) === "v11"
  );
}

/**
 * Default cipher backed by Electron `safeStorage` (macOS Keychain, Windows DPAPI,
 * Linux libsecret/kwallet) through its async API, which fetches the key off the
 * main thread: on Linux the sync API holds the whole app on a keyring prompt.
 */
export const safeStorageCipher: SecretCipher = {
  tier() {
    // On Linux isEncryptionAvailable() fetches the key synchronously and holds
    // the main thread on a keyring prompt (autologin, a locked or missing
    // keyring) until the watchdog kills the app. The settings view only needs
    // the tier, which the backend already tells; a write still checks fully.
    if (process.platform === "linux") {
      return isLinuxKeyringBackend(linuxBackend() ?? "") ? "keychain" : "unavailable";
    }
    return keychainAvailable() ? "keychain" : "unavailable";
  },
  async encrypt(plaintext) {
    return (await encryptWithKeychain(plaintext))?.toString("base64") ?? null;
  },
  async decrypt(ciphertextBase64, options) {
    const ciphertext = Buffer.from(ciphertextBase64, "base64");
    const legacy = options?.legacy === true;
    if (legacy && needsSyncKey(ciphertext)) {
      return { plaintext: await decryptLegacy(ciphertext), reencrypt: true };
    }
    try {
      const { result, shouldReEncrypt } = await withTimeout(
        safeStorage.decryptStringAsync(ciphertext)
      );
      return { plaintext: result, reencrypt: shouldReEncrypt };
    } catch (error) {
      // Outside KWallet, Linux's sync API holds the same keys as the async one,
      // so a sync retry could only add a keyring prompt on the main thread.
      const retrySync =
        legacy && !(error instanceof SecretStorageTimeoutError) && process.platform !== "linux";
      if (!retrySync) throw error;
      return { plaintext: await decryptLegacy(ciphertext, error), reencrypt: true };
    }
  },
};

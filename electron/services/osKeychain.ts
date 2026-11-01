import { safeStorage } from "electron";
import { isLinuxKeyringBackend } from "./plugin/linuxKeyringBackend.js";

/**
 * Electron `safeStorage` through its async API, shared by everything that seals
 * a secret with the OS keychain (plugin secrets, Decisions keys). The session
 * memo below is process-wide on purpose: Electron's async encryptor is too.
 */

export type KeychainSessionFailure = "locked" | "unavailable";

/**
 * A keychain prompt waits on a person, so a call can take as long as it takes
 * them to type a password. It must not wait forever, though: no one may be at
 * the machine (a remote host), and a pending write holds up whatever store is
 * waiting behind it.
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

export function withSecretStorageTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new SecretStorageTimeoutError(SECRET_STORAGE_TIMEOUT_MS)),
      SECRET_STORAGE_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function selectedLinuxBackend(): string | null {
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
export function keychainAvailable(): boolean {
  try {
    return safeStorage?.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}

export function ciphertextPrefix(ciphertext: Buffer): string {
  return ciphertext.subarray(0, 3).toString("latin1");
}

/**
 * How the keychain failed this session, once it has. Electron builds its async
 * encryptor once per process, so a keychain that gave it no key (an unlock
 * prompt dismissed or failed) gives none for the rest of the run, and nothing
 * asks again until Daintree restarts. That no-key result can't say why: on
 * Linux the same fixed-key fallback follows a dismissed unlock prompt and a
 * keyring service that isn't running at all, and Chromium's Keychain provider
 * reports a denial and any other Keychain error alike, so the words say only
 * that the store wasn't available. DPAPI has no prompt to dismiss, so on
 * Windows a failure just means there is no keychain to use.
 */
let sessionFailure: KeychainSessionFailure | null = null;

/** What this session already learned about the keychain, or null while it has given a key or not been asked. */
export function keychainSessionFailure(): KeychainSessionFailure | null {
  return sessionFailure;
}

/** @internal Tests only. */
export function _resetSecretStorageSessionForTests(): void {
  sessionFailure = null;
}

function noteKeychainKey(keyed: boolean): void {
  if (keyed) sessionFailure = null;
  else sessionFailure = process.platform === "win32" ? "unavailable" : "locked";
}

/** What stopped this session getting a key: all that is known is that it didn't. */
export function keychainLockedReason(): string {
  const store = process.platform === "darwin" ? "The Keychain" : "The keyring";
  return `${store} wasn't available this session`;
}

/**
 * Encrypt with the async API, or `null` when the result wouldn't be keychain
 * protected. Linux needs a real keyring backend, and Chromium's async encryptor
 * falls back there to its fixed-key provider ("v10") when the keyring doesn't
 * answer, which anyone can decrypt.
 */
export async function encryptWithKeychain(plaintext: string): Promise<Buffer | null> {
  const linux = process.platform === "linux";
  if (linux && !isLinuxKeyringBackend(selectedLinuxBackend() ?? "")) return null;
  let encrypted: Buffer;
  try {
    encrypted = await withSecretStorageTimeout(safeStorage.encryptStringAsync(plaintext));
  } catch (error) {
    // Still waiting on a prompt says nothing yet about how it will be answered.
    if (error instanceof SecretStorageTimeoutError) throw error;
    noteKeychainKey(false);
    return null;
  }
  const keyed = !(linux && ciphertextPrefix(encrypted) === "v10");
  noteKeychainKey(keyed);
  return keyed ? encrypted : null;
}

const PROBE_TEXT = "daintree-secret-probe";

/** Whether the async encryptor holds a real keychain key, noting the answer. */
export async function keychainKeyed(): Promise<boolean> {
  return (await encryptWithKeychain(PROBE_TEXT)) !== null;
}


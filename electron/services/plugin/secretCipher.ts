import { safeStorage } from "electron";
import { isLinuxKeyringBackend } from "./linuxKeyringBackend.js";

/**
 * The at-rest tier a secret write would use right now, disclosed honestly in the
 * plugin settings UI. `"unavailable"` means there is no OS keychain to encrypt
 * with, and a secret write is refused rather than stored in plaintext (#12613).
 */
export type SecretStorageTier = "keychain" | "unavailable";

/**
 * Encrypts/decrypts secret setting values for at-rest storage. The store holds
 * an instance so the OS-keychain dependency is injectable — vitest's node
 * environment has no Electron `safeStorage`, and tests substitute a fake.
 */
export interface SecretCipher {
  /** Which at-rest tier {@link encrypt} will use right now. */
  tier(): SecretStorageTier;
  /**
   * Encrypt a plaintext secret to a base64 ciphertext string, or `null` when no
   * OS keychain is available (the caller then refuses the write).
   */
  encrypt(plaintext: string): string | null;
  /** Decrypt a base64 ciphertext produced by {@link encrypt}. */
  decrypt(ciphertextBase64: string): string;
}

/**
 * `safeStorage.isEncryptionAvailable()` can throw on Linux when called before
 * the app `ready` event, and `safeStorage` is absent entirely outside an Electron
 * runtime. Treat any such failure as "no keychain" so a secret write is refused
 * rather than crashing a settings read. A Linux backend that isn't a real
 * keychain is treated the same way, so the UI never labels it as one.
 */
function keychainAvailable(): boolean {
  try {
    if (safeStorage?.isEncryptionAvailable() !== true) return false;
    if (process.platform !== "linux") return true;
    return isLinuxKeyringBackend(safeStorage.getSelectedStorageBackend());
  } catch {
    return false;
  }
}

function linuxKeyringSelected(): boolean {
  try {
    return isLinuxKeyringBackend(safeStorage.getSelectedStorageBackend());
  } catch {
    return false;
  }
}

/**
 * Default cipher backed by Electron `safeStorage` (macOS Keychain, Windows DPAPI,
 * Linux libsecret/kwallet). When `isEncryptionAvailable()` is false — typically a
 * headless Linux box with no backing store — {@link encrypt} returns `null`.
 */
export const safeStorageCipher: SecretCipher = {
  tier() {
    // On Linux isEncryptionAvailable() fetches the key synchronously and holds
    // the main thread on a keyring prompt (autologin, a locked or missing
    // keyring) until the watchdog kills the app. The settings view only needs
    // the tier, which the backend already tells; a write still checks fully.
    if (process.platform === "linux") return linuxKeyringSelected() ? "keychain" : "unavailable";
    return keychainAvailable() ? "keychain" : "unavailable";
  },
  encrypt(plaintext) {
    if (!keychainAvailable()) return null;
    return safeStorage.encryptString(plaintext).toString("base64");
  },
  decrypt(ciphertextBase64) {
    return safeStorage.decryptString(Buffer.from(ciphertextBase64, "base64"));
  },
};

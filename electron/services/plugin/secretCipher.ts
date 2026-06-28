import { safeStorage } from "electron";

/**
 * At-rest tier a secret value is stored under. Surfaced honestly to the user so
 * the plugin settings UI can disclose whether a token is in the OS keychain or
 * only `chmod 0o600` plaintext (#9167).
 */
export type SecretStorageTier = "keychain" | "plaintext";

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
   * OS keychain is available (caller then falls back to plaintext at-rest).
   */
  encrypt(plaintext: string): string | null;
  /** Decrypt a base64 ciphertext produced by {@link encrypt}. */
  decrypt(ciphertextBase64: string): string;
}

/**
 * Default cipher backed by Electron `safeStorage` (macOS Keychain, Windows DPAPI,
 * Linux libsecret/kwallet). When `isEncryptionAvailable()` is false — typically a
 * headless Linux box with no backing store — {@link encrypt} returns `null` and
 * the store persists plaintext under `chmod 0o600` as before.
 */
/**
 * `safeStorage.isEncryptionAvailable()` can throw on Linux when called before
 * the app `ready` event, and `safeStorage` is absent entirely outside an Electron
 * runtime. Treat any such failure as "no keychain" so secret writes degrade to
 * the plaintext-0600 fallback rather than crashing a settings read.
 */
function keychainAvailable(): boolean {
  try {
    return safeStorage?.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}

export const safeStorageCipher: SecretCipher = {
  tier() {
    return keychainAvailable() ? "keychain" : "plaintext";
  },
  encrypt(plaintext) {
    if (!keychainAvailable()) return null;
    return safeStorage.encryptString(plaintext).toString("base64");
  },
  decrypt(ciphertextBase64) {
    return safeStorage.decryptString(Buffer.from(ciphertextBase64, "base64"));
  },
};

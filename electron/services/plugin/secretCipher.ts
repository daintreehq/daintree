import { safeStorage } from "electron";

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
type LinuxStorageBackend = ReturnType<typeof safeStorage.getSelectedStorageBackend>;

/**
 * On Linux `isEncryptionAvailable()` doesn't say what backs the encryption:
 * `basic_text` uses Chromium's hardcoded key and `unknown` is what Electron
 * reports before `ready` (#12614). Exhaustive over Electron's backend union so a
 * new backend fails typecheck until it is classified; a string outside the union
 * at runtime is treated as not a keychain.
 */
const LINUX_BACKEND_IS_KEYCHAIN: Record<LinuxStorageBackend, boolean> = {
  gnome_libsecret: true,
  kwallet: true,
  kwallet5: true,
  kwallet6: true,
  basic_text: false,
  unknown: false,
};

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
    return LINUX_BACKEND_IS_KEYCHAIN[safeStorage.getSelectedStorageBackend()] === true;
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

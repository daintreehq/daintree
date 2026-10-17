import type { safeStorage } from "electron";

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
 * Whether a Linux `safeStorage.getSelectedStorageBackend()` value names a real
 * keyring. The backend reads without touching the keyring, unlike the sync
 * `isEncryptionAvailable()`, which fetches the key on the main thread and
 * blocks there for as long as a keyring prompt is open.
 */
export function isLinuxKeyringBackend(backend: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(LINUX_BACKEND_IS_KEYCHAIN, backend) &&
    LINUX_BACKEND_IS_KEYCHAIN[backend as LinuxStorageBackend]
  );
}

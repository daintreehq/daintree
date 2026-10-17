import type { HostModeCheckState } from "../../../shared/types/ipc/hostMode.js";
import { isLinuxKeyringBackend } from "../../services/plugin/linuxKeyringBackend.js";

/**
 * Whether plugin secrets can be stored on this host. Plugin secrets use the
 * async `safeStorage` API this trial runs, and the keychain can still prompt
 * depending on how the app was launched, so the check is run from the GUI
 * session at the machine under a timeout: a keychain that doesn't answer reads
 * as "unknown", never as a hang.
 */

export interface KeychainCheck {
  state: HostModeCheckState;
  detail: string;
}

/**
 * The slice of Electron's `safeStorage` the check uses. Deliberately no sync
 * `isEncryptionAvailable()` (or the secret store's `tier()`, built on it): on
 * Linux it fetches the key on the main thread, and a keyring that needs creating
 * or unlocking holds the whole app on a prompt until the watchdog kills it. The
 * status rows read this on every launch.
 */
export interface KeychainProbe {
  getSelectedStorageBackend(): string;
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string }>;
}

export const KEYCHAIN_PREFLIGHT_TIMEOUT_MS = 10_000;
export const NO_KEYRING_DETAIL = "Plugin secrets unavailable on this host: no keyring (headless)";
const TRIAL_TEXT = "daintree-host-keychain-preflight";

class PreflightTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PreflightTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * What can be said without touching the keychain. On Linux the selected
 * backend already tells whether a keyring is there (the secret store counts
 * only a real keyring); on macOS nothing is known until the trial has run.
 */
export function classifyKeychainWithoutTrial(
  platform: NodeJS.Platform,
  probe: Pick<KeychainProbe, "getSelectedStorageBackend">
): KeychainCheck {
  if (platform !== "linux") {
    return { state: "unknown", detail: "Not checked yet" };
  }
  const backend = readLinuxBackend(probe);
  if (backend === null) {
    return { state: "unknown", detail: "The keyring backend couldn't be read" };
  }
  if (backend === "basic_text") return { state: "unavailable", detail: NO_KEYRING_DETAIL };
  if (isLinuxKeyringBackend(backend)) {
    return { state: "unknown", detail: `Keyring ${backend} selected, not checked yet` };
  }
  return {
    state: "unavailable",
    detail: `Plugin secrets unavailable on this host: keyring backend ${backend} isn't usable`,
  };
}

function readLinuxBackend(probe: Pick<KeychainProbe, "getSelectedStorageBackend">): string | null {
  try {
    return probe.getSelectedStorageBackend();
  } catch {
    return null;
  }
}

export async function runKeychainPreflight(
  platform: NodeJS.Platform,
  probe: KeychainProbe,
  timeoutMs = KEYCHAIN_PREFLIGHT_TIMEOUT_MS
): Promise<KeychainCheck> {
  const label = platform === "linux" ? "Keyring" : "Keychain";
  // Only a keyring the secret store would actually use is worth a trial; a
  // backend that couldn't be read stays "unknown" rather than trialled blind.
  if (platform === "linux") {
    const backend = readLinuxBackend(probe);
    if (backend === null || !isLinuxKeyringBackend(backend)) {
      return classifyKeychainWithoutTrial(platform, probe);
    }
  }
  // Only async calls from here, so the timeout bounds the whole check: the
  // synchronous availability probe can itself block on the keychain.
  const unavailable = new Error("unavailable");
  const fixedKey = new Error("fixed key");
  try {
    await withTimeout(
      (async () => {
        if (!(await probe.isAsyncEncryptionAvailable())) throw unavailable;
        const encrypted = await probe.encryptStringAsync(TRIAL_TEXT);
        // The async API falls back to Chromium's fixed-key provider ("v10")
        // when the keyring fails, so a round trip alone would read as a keyring.
        if (platform === "linux" && encrypted.subarray(0, 3).toString("latin1") === "v10") {
          throw fixedKey;
        }
        const { result } = await probe.decryptStringAsync(encrypted);
        if (result !== TRIAL_TEXT) throw new Error("a test value didn't decrypt to itself");
      })(),
      timeoutMs
    );
  } catch (error) {
    if (error instanceof PreflightTimeout) {
      return {
        state: "unknown",
        detail: `${label} didn't answer within ${Math.round(timeoutMs / 1000)} s — it may be waiting on a prompt at this machine`,
      };
    }
    if (error === fixedKey) {
      return {
        state: "unavailable",
        detail: `${label} didn't answer, so the test value used Chromium's fixed key: plugin secrets can't be stored on this host`,
      };
    }
    if (error === unavailable) {
      return {
        state: "unavailable",
        detail: `${label} unavailable: plugin secrets can't be stored on this host`,
      };
    }
    return {
      state: "unavailable",
      detail: `${label} test failed: ${(error as Error).message || "unknown error"}`,
    };
  }
  return { state: "ok", detail: `${label} answered a test encrypt and decrypt` };
}

import type { HostModeCheckState } from "../../../shared/types/ipc/hostMode.js";

/**
 * Whether plugin secrets can be stored on this host. Plugin secrets use
 * `safeStorage` synchronously, and on macOS that can prompt or block depending
 * on how the app was launched, so the check is run from the GUI session at the
 * machine and uses the async API under a timeout: a keychain that doesn't
 * answer reads as "unknown", never as a hang.
 */

export interface KeychainCheck {
  state: HostModeCheckState;
  detail: string;
}

/** The slice of Electron's `safeStorage` the check uses. */
export interface KeychainProbe {
  /**
   * The plugin secret store's own verdict (`safeStorageCipher.tier()`), which
   * already classifies Linux backends: only a real keyring counts.
   */
  secretTier(): "keychain" | "unavailable";
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
 * backend already tells whether a keyring is there; on macOS nothing is known
 * until the trial has run.
 */
export function classifyKeychainWithoutTrial(
  platform: NodeJS.Platform,
  probe: Pick<KeychainProbe, "getSelectedStorageBackend" | "secretTier">
): KeychainCheck {
  if (platform !== "linux") {
    return { state: "unknown", detail: "Not checked yet" };
  }
  let backend: string;
  try {
    backend = probe.getSelectedStorageBackend();
  } catch {
    return { state: "unknown", detail: "The keyring backend couldn't be read" };
  }
  if (backend === "basic_text") return { state: "unavailable", detail: NO_KEYRING_DETAIL };
  if (probe.secretTier() === "keychain") {
    return { state: "unknown", detail: `Keyring ${backend} selected, not checked yet` };
  }
  return {
    state: "unavailable",
    detail: `Plugin secrets unavailable on this host: keyring backend ${backend} isn't usable`,
  };
}

export async function runKeychainPreflight(
  platform: NodeJS.Platform,
  probe: KeychainProbe,
  timeoutMs = KEYCHAIN_PREFLIGHT_TIMEOUT_MS
): Promise<KeychainCheck> {
  const label = platform === "linux" ? "Keyring" : "Keychain";
  if (platform === "linux") {
    const classified = classifyKeychainWithoutTrial(platform, probe);
    // Only a keyring the secret store would actually use is worth a trial.
    if (classified.state === "unavailable" || probe.secretTier() !== "keychain") {
      return classified;
    }
  }
  // Only async calls from here, so the timeout bounds the whole check: the
  // synchronous availability probe can itself block on the keychain.
  const unavailable = new Error("unavailable");
  try {
    await withTimeout(
      (async () => {
        if (!(await probe.isAsyncEncryptionAvailable())) throw unavailable;
        const encrypted = await probe.encryptStringAsync(TRIAL_TEXT);
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

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_KEYRING_DETAIL,
  classifyKeychainWithoutTrial,
  runKeychainPreflight,
  type KeychainProbe,
} from "../keychainPreflight.js";

function probe(overrides: Partial<KeychainProbe> = {}): KeychainProbe {
  return {
    secretTier: () => "keychain",
    getSelectedStorageBackend: () => "gnome_libsecret",
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text) => Buffer.from(text),
    decryptStringAsync: async (buf) => ({ result: buf.toString() }),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("keychain preflight", () => {
  it("passes when a test value round-trips", async () => {
    expect(await runKeychainPreflight("darwin", probe())).toEqual({
      state: "ok",
      detail: "Keychain answered a test encrypt and decrypt",
    });
  });

  it("reads unknown, not a hang, when the keychain doesn't answer", async () => {
    vi.useFakeTimers();
    const pending = runKeychainPreflight(
      "darwin",
      probe({ encryptStringAsync: () => new Promise<Buffer>(() => {}) }),
      10_000
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({
      state: "unknown",
      detail: "Keychain didn't answer within 10 s — it may be waiting on a prompt at this machine",
    });
  });

  it("reports an unavailable keychain", async () => {
    expect(
      await runKeychainPreflight("darwin", probe({ isAsyncEncryptionAvailable: async () => false }))
    ).toEqual({
      state: "unavailable",
      detail: "Keychain unavailable: plugin secrets can't be stored on this host",
    });
    expect(
      await runKeychainPreflight(
        "darwin",
        probe({
          decryptStringAsync: async () => {
            throw new Error("errSecAuthFailed");
          },
        })
      )
    ).toEqual({ state: "unavailable", detail: "Keychain test failed: errSecAuthFailed" });
  });

  it("says a headless Linux host has no keyring, without a trial", async () => {
    const encrypt = vi.fn(async (text: string) => Buffer.from(text));
    const headless = probe({
      secretTier: () => "unavailable",
      getSelectedStorageBackend: () => "basic_text",
      encryptStringAsync: encrypt,
    });
    expect(classifyKeychainWithoutTrial("linux", headless)).toEqual({
      state: "unavailable",
      detail: NO_KEYRING_DETAIL,
    });
    expect(await runKeychainPreflight("linux", headless)).toEqual({
      state: "unavailable",
      detail: NO_KEYRING_DETAIL,
    });
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("tries a Linux keyring the secret store would use", async () => {
    expect(await runKeychainPreflight("linux", probe())).toEqual({
      state: "ok",
      detail: "Keyring answered a test encrypt and decrypt",
    });
    expect(classifyKeychainWithoutTrial("linux", probe())).toEqual({
      state: "unknown",
      detail: "Keyring gnome_libsecret selected, not checked yet",
    });
  });

  it("knows nothing on macOS until the check runs", () => {
    const backend = vi.fn(() => "unknown");
    expect(
      classifyKeychainWithoutTrial("darwin", probe({ getSelectedStorageBackend: backend }))
    ).toEqual({ state: "unknown", detail: "Not checked yet" });
    expect(backend).not.toHaveBeenCalled();
  });
});

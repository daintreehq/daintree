import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_KEYRING_DETAIL,
  classifyKeychainWithoutTrial,
  runKeychainPreflight,
  type KeychainProbe,
} from "../keychainPreflight.js";

function probe(overrides: Partial<KeychainProbe> = {}): KeychainProbe {
  return {
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

  // The status rows classify on every launch. Anything beyond the backend name
  // can reach the keyring, and a sync reach blocks the main thread on a prompt.
  it("classifies a Linux keyring from its backend name alone", () => {
    const backendOnly = new Proxy(
      { getSelectedStorageBackend: () => "gnome_libsecret" },
      {
        get(target, key) {
          if (key !== "getSelectedStorageBackend") throw new Error(`touched ${String(key)}`);
          return target[key];
        },
      }
    ) as unknown as KeychainProbe;
    expect(classifyKeychainWithoutTrial("linux", backendOnly)).toEqual({
      state: "unknown",
      detail: "Keyring gnome_libsecret selected, not checked yet",
    });
  });

  it("says a Linux backend the secret store can't use is unavailable, without a trial", async () => {
    const encrypt = vi.fn(async (text: string) => Buffer.from(text));
    const unusable = probe({
      getSelectedStorageBackend: () => "unknown",
      encryptStringAsync: encrypt,
    });
    const expected = {
      state: "unavailable",
      detail: "Plugin secrets unavailable on this host: keyring backend unknown isn't usable",
    };
    expect(classifyKeychainWithoutTrial("linux", unusable)).toEqual(expected);
    expect(await runKeychainPreflight("linux", unusable)).toEqual(expected);
    expect(encrypt).not.toHaveBeenCalled();
  });

  // Measured on Electron 42: with the keyring answering, async ciphertext is
  // tagged "v11"; Chromium's fixed-key fallback tags it "v10".
  it("doesn't call a keyring that fell back to Chromium's fixed key one that answered", async () => {
    const fellBack = probe({ encryptStringAsync: async () => Buffer.from("v10 whatever") });
    const check = await runKeychainPreflight("linux", fellBack);
    expect(check.state).toBe("unavailable");
    expect(check.detail).toContain("fixed key");
    const answered = probe({
      encryptStringAsync: async (t) => Buffer.from(`v11${t}`),
      decryptStringAsync: async (b) => ({ result: b.toString().slice(3) }),
    });
    expect((await runKeychainPreflight("linux", answered)).state).toBe("ok");
  });

  it("leaves a backend it couldn't read unknown instead of trialling it", async () => {
    const encrypt = vi.fn(async (text: string) => Buffer.from(text));
    const unreadable = probe({
      getSelectedStorageBackend: () => {
        throw new Error("not ready");
      },
      encryptStringAsync: encrypt,
    });
    expect(await runKeychainPreflight("linux", unreadable)).toEqual({
      state: "unknown",
      detail: "The keyring backend couldn't be read",
    });
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("knows nothing on macOS until the check runs", () => {
    const backend = vi.fn(() => "unknown");
    expect(
      classifyKeychainWithoutTrial("darwin", probe({ getSelectedStorageBackend: backend }))
    ).toEqual({ state: "unknown", detail: "Not checked yet" });
    expect(backend).not.toHaveBeenCalled();
  });
});

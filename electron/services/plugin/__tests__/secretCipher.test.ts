import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A keyring-backed async encrypt tags its output "v11" on Linux; the fixed-key
// fallback tags it "v10". Keychain (macOS) and DPAPI (Windows) both use "v10".
const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn<() => boolean>(),
  getSelectedStorageBackend: vi.fn<() => string>(),
  encryptString: vi.fn<(plaintext: string) => Buffer>(),
  decryptString: vi.fn<(encrypted: Buffer) => string>(),
  encryptStringAsync: vi.fn<(plaintext: string) => Promise<Buffer>>(),
  decryptStringAsync:
    vi.fn<(encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
}));

vi.mock("electron", () => ({ safeStorage: safeStorageMock }));

import {
  _resetSecretStorageSessionForTests,
  SECRET_STORAGE_TIMEOUT_MS,
  SecretStorageTimeoutError,
  safeStorageCipher,
  secretWriteRefusal,
} from "../secretCipher.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function sealed(prefix: string, plaintext: string): Buffer {
  return Buffer.from(`${prefix}:${plaintext}`, "latin1");
}

function opened(encrypted: Buffer): string {
  return encrypted.toString("latin1").replace(/^v1\d:/, "");
}

/** The async encryptor holding a key that tags its output `prefix`. */
function asyncKey(prefix: string) {
  safeStorageMock.encryptStringAsync.mockImplementation(async (plaintext) =>
    sealed(prefix, plaintext)
  );
  safeStorageMock.decryptStringAsync.mockImplementation(async (encrypted) => ({
    result: opened(encrypted),
    shouldReEncrypt: false,
  }));
}

const b64 = (buffer: Buffer) => buffer.toString("base64");

beforeEach(() => {
  vi.resetAllMocks();
  _resetSecretStorageSessionForTests();
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  safeStorageMock.decryptString.mockImplementation(opened);
});

// Electron builds its async encryptor once per process: a keychain that gave it
// no key gives none until Daintree restarts, which is what asks again.
describe("a keychain that gave no key this session", () => {
  describe("on Linux", () => {
    beforeEach(() => {
      setPlatform("linux");
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
    });

    it("reads as locked once the keyring prompt was dismissed", async () => {
      asyncKey("v10");

      expect(safeStorageCipher.tier()).toBe("keychain");
      expect(await safeStorageCipher.encrypt("hunter2")).toBeNull();
      expect(safeStorageCipher.tier()).toBe("locked");
      expect(secretWriteRefusal("apiKey", safeStorageCipher.tier())).toBe(
        `The keyring wasn't available this session, so the secret "apiKey" wasn't saved — restart Daintree to try again`
      );
    });

    it("stays unavailable, not locked, with no keyring backend to ask", async () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("basic_text");

      expect(await safeStorageCipher.encrypt("hunter2")).toBeNull();
      expect(safeStorageCipher.tier()).toBe("unavailable");
      expect(secretWriteRefusal("apiKey", safeStorageCipher.tier())).toBe(
        `Secure storage is unavailable on this device, so the secret "apiKey" wasn't saved`
      );
    });

    it("isn't locked while a prompt is only waiting on an answer", async () => {
      vi.useFakeTimers();
      safeStorageMock.encryptStringAsync.mockReturnValue(new Promise<Buffer>(() => {}));

      const settled = expect(safeStorageCipher.encrypt("hunter2")).rejects.toBeInstanceOf(
        SecretStorageTimeoutError
      );
      await vi.advanceTimersByTimeAsync(SECRET_STORAGE_TIMEOUT_MS);
      await settled;
      expect(safeStorageCipher.tier()).toBe("keychain");
    });

    it("explains a failed read by the locked keyring rather than Electron's error", async () => {
      asyncKey("v10");
      safeStorageMock.decryptStringAsync.mockRejectedValue(
        new Error(
          "Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync."
        )
      );

      await expect(safeStorageCipher.decrypt(b64(sealed("v11", "hunter2")))).rejects.toThrow(
        "The keyring wasn't available this session, so the secret couldn't be read — restart Daintree to try again"
      );
      expect(safeStorageCipher.tier()).toBe("locked");
    });
  });

  // Chromium's Keychain provider reports a denial and any other Keychain error
  // alike, so the words claim only that the Keychain wasn't available.
  it("reads as locked on macOS once the Keychain gave no key", async () => {
    setPlatform("darwin");
    safeStorageMock.encryptStringAsync.mockRejectedValue(new Error("Error while encrypting"));

    expect(await safeStorageCipher.encrypt("hunter2")).toBeNull();
    expect(safeStorageCipher.tier()).toBe("locked");
    expect(secretWriteRefusal("apiKey", "locked")).toBe(
      `The Keychain wasn't available this session, so the secret "apiKey" wasn't saved — restart Daintree to try again`
    );
  });

  // The sync check would ask the Keychain again on the main thread, and a
  // Keychain still refusing would read as no keychain at all, hiding the restart.
  it("answers the tier from the session on macOS without the sync Keychain check", async () => {
    setPlatform("darwin");
    safeStorageMock.encryptStringAsync.mockRejectedValue(new Error("Error while encrypting"));
    await safeStorageCipher.encrypt("hunter2");
    safeStorageMock.isEncryptionAvailable.mockReset();
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    expect(safeStorageCipher.tier()).toBe("locked");
    expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled();
  });

  // DPAPI has no prompt to dismiss, so a restart wouldn't change anything.
  it("reads as unavailable on Windows when DPAPI gives no key", async () => {
    setPlatform("win32");
    safeStorageMock.encryptStringAsync.mockRejectedValue(new Error("Error while encrypting"));

    expect(await safeStorageCipher.encrypt("hunter2")).toBeNull();
    expect(safeStorageCipher.tier()).toBe("unavailable");
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

describe("safeStorageCipher tier", () => {
  describe("on Linux", () => {
    beforeEach(() => setPlatform("linux"));

    it.each(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"])(
      "reports keychain under the %s backend",
      (backend) => {
        safeStorageMock.getSelectedStorageBackend.mockReturnValue(backend);
        expect(safeStorageCipher.tier()).toBe("keychain");
      }
    );

    it.each(["basic_text", "unknown", "some_future_backend", "constructor"])(
      "reports unavailable under the %s backend",
      (backend) => {
        safeStorageMock.getSelectedStorageBackend.mockReturnValue(backend);
        expect(safeStorageCipher.tier()).toBe("unavailable");
      }
    );

    it("reports unavailable when the backend lookup throws", () => {
      safeStorageMock.getSelectedStorageBackend.mockImplementation(() => {
        throw new Error("not ready");
      });
      expect(safeStorageCipher.tier()).toBe("unavailable");
    });

    // isEncryptionAvailable() can hold the main thread on a keyring prompt,
    // so the tier the settings view shows comes from the backend alone.
    it("reads the tier without the synchronous availability check", () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");

      expect(safeStorageCipher.tier()).toBe("keychain");
      expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled();
    });
  });

  it.each(["darwin", "win32"] as const)("trusts isEncryptionAvailable on %s", (platform) => {
    setPlatform(platform);
    expect(safeStorageCipher.tier()).toBe("keychain");
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(safeStorageCipher.tier()).toBe("unavailable");
    expect(safeStorageMock.getSelectedStorageBackend).not.toHaveBeenCalled();
  });

  it("reports unavailable when isEncryptionAvailable throws", () => {
    setPlatform("darwin");
    safeStorageMock.isEncryptionAvailable.mockImplementation(() => {
      throw new Error("not ready");
    });
    expect(safeStorageCipher.tier()).toBe("unavailable");
  });
});

describe("safeStorageCipher encrypt", () => {
  describe("on Linux", () => {
    beforeEach(() => setPlatform("linux"));

    it.each(["gnome_libsecret", "kwallet6"])(
      "encrypts through the async API under the %s backend and never the sync one",
      async (backend) => {
        safeStorageMock.getSelectedStorageBackend.mockReturnValue(backend);
        asyncKey("v11");

        const ciphertext = await safeStorageCipher.encrypt("hunter2");

        expect(ciphertext).toBe(b64(sealed("v11", "hunter2")));
        expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled();
        expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
      }
    );

    it.each(["basic_text", "unknown", "some_future_backend"])(
      "refuses without touching the keyring under the %s backend",
      async (backend) => {
        safeStorageMock.getSelectedStorageBackend.mockReturnValue(backend);
        asyncKey("v11");

        expect(await safeStorageCipher.encrypt("hunter2")).toBeNull();
        expect(safeStorageMock.encryptStringAsync).not.toHaveBeenCalled();
      }
    );

    it("refuses when the async encrypt rejects", async () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
      safeStorageMock.encryptStringAsync.mockRejectedValue(new Error("Error while encrypting"));

      expect(await safeStorageCipher.encrypt("hunter2")).toBeNull();
    });

    it("gives up on a keyring prompt no one answers instead of waiting forever", async () => {
      vi.useFakeTimers();
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
      safeStorageMock.encryptStringAsync.mockReturnValue(new Promise<Buffer>(() => {}));

      const pending = safeStorageCipher.encrypt("hunter2");
      const settled = expect(pending).rejects.toBeInstanceOf(SecretStorageTimeoutError);
      await vi.advanceTimersByTimeAsync(SECRET_STORAGE_TIMEOUT_MS);
      await settled;
    });
  });

  it.each(["darwin", "win32"] as const)(
    "counts the platform keychain's v10 ciphertext on %s",
    async (platform) => {
      setPlatform(platform);
      asyncKey("v10");

      expect(await safeStorageCipher.encrypt("hunter2")).toBe(b64(sealed("v10", "hunter2")));
      expect(safeStorageMock.getSelectedStorageBackend).not.toHaveBeenCalled();
      expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
    }
  );
});

describe("safeStorageCipher decrypt", () => {
  describe("on Linux with a keyring", () => {
    beforeEach(() => {
      setPlatform("linux");
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
      asyncKey("v11");
    });

    it("decrypts through the async API", async () => {
      const ciphertext = b64(sealed("v11", "hunter2"));

      expect(await safeStorageCipher.decrypt(ciphertext)).toEqual({
        plaintext: "hunter2",
        reencrypt: false,
      });
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    });

    // libsecret keeps one key for both APIs, so the async API reads what the
    // sync API wrote.
    it("reads a value the sync API wrote through the async API", async () => {
      const ciphertext = b64(sealed("v11", "hunter2"));

      expect(await safeStorageCipher.decrypt(ciphertext, { legacy: true })).toEqual({
        plaintext: "hunter2",
        reencrypt: false,
      });
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    });

    it("passes on Chromium's advice to re-encrypt", async () => {
      safeStorageMock.decryptStringAsync.mockResolvedValue({
        result: "hunter2",
        shouldReEncrypt: true,
      });

      expect(await safeStorageCipher.decrypt(b64(sealed("v10", "hunter2")))).toEqual({
        plaintext: "hunter2",
        reencrypt: true,
      });
    });

    it("never falls back to the sync API for a value the async API wrote", async () => {
      const failure = new Error("Error while decrypting");
      safeStorageMock.decryptStringAsync.mockRejectedValue(failure);

      await expect(safeStorageCipher.decrypt(b64(sealed("v11", "hunter2")))).rejects.toBe(failure);
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    });

    // libsecret and the fixed key are the same for both APIs, so the sync API
    // could only add a keyring prompt on the main thread (a keyring locked since
    // the async key was fetched, say), never read what the async one couldn't.
    it("never retries a legacy value with the sync API", async () => {
      const failure = new Error("Error while decrypting");
      safeStorageMock.decryptStringAsync.mockRejectedValue(failure);

      await expect(
        safeStorageCipher.decrypt(b64(sealed("v11", "hunter2")), { legacy: true })
      ).rejects.toBe(failure);
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    });

    it("leaves the sync API alone on a keyring prompt no one answers", async () => {
      vi.useFakeTimers();
      safeStorageMock.decryptStringAsync.mockReturnValue(new Promise(() => {}));

      const pending = safeStorageCipher.decrypt(b64(sealed("v11", "hunter2")), { legacy: true });
      const settled = expect(pending).rejects.toBeInstanceOf(SecretStorageTimeoutError);
      await vi.advanceTimersByTimeAsync(SECRET_STORAGE_TIMEOUT_MS);
      await settled;
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    });
  });

  describe("on Linux with KWallet", () => {
    beforeEach(() => {
      setPlatform("linux");
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("kwallet6");
      asyncKey("v11");
    });

    // The sync API's KWallet key sits in "Chromium Keys", the async API's under
    // the app's own name; the async API would decrypt with the wrong key.
    it("reads a legacy keyring value with the sync API, never the async one", async () => {
      expect(
        await safeStorageCipher.decrypt(b64(sealed("v11", "hunter2")), { legacy: true })
      ).toEqual({ plaintext: "hunter2", reencrypt: true });
      expect(safeStorageMock.decryptStringAsync).not.toHaveBeenCalled();
      expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1);
    });

    it("refuses a legacy keyring value while the wallet gave no key this session", async () => {
      safeStorageMock.encryptStringAsync.mockImplementation(async (plaintext) =>
        sealed("v10", plaintext)
      );

      await expect(
        safeStorageCipher.decrypt(b64(sealed("v11", "hunter2")), { legacy: true })
      ).rejects.toThrow(
        "The keyring wasn't available this session, so the secret couldn't be read — restart Daintree to try again"
      );
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    });

    it("reads a legacy fixed-key value through the async API, which shares that key", async () => {
      expect(
        await safeStorageCipher.decrypt(b64(sealed("v10", "hunter2")), { legacy: true })
      ).toEqual({ plaintext: "hunter2", reencrypt: false });
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    });

    it("reads its own values through the async API", async () => {
      expect(await safeStorageCipher.decrypt(b64(sealed("v11", "hunter2")))).toEqual({
        plaintext: "hunter2",
        reencrypt: false,
      });
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    });

    // Electron 46 removes the sync methods.
    it("refuses a legacy keyring value once the sync API is gone", async () => {
      const { decryptString } = safeStorageMock;
      Reflect.deleteProperty(safeStorageMock, "decryptString");
      try {
        await expect(
          safeStorageCipher.decrypt(b64(sealed("v11", "hunter2")), { legacy: true })
        ).rejects.toThrow(/Secure storage is unavailable/);
      } finally {
        safeStorageMock.decryptString = decryptString;
      }
    });
  });

  describe("on macOS", () => {
    beforeEach(() => setPlatform("darwin"));

    it("retries a legacy value with the sync API once the Keychain gave the async API a key", async () => {
      asyncKey("v10");
      safeStorageMock.decryptStringAsync.mockRejectedValue(new Error("Error while decrypting"));

      expect(
        await safeStorageCipher.decrypt(b64(sealed("v10", "hunter2")), { legacy: true })
      ).toEqual({ plaintext: "hunter2", reencrypt: true });
      expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1);
    });

    it("never retries a value the async API wrote", async () => {
      asyncKey("v10");
      const failure = new Error("Error while decrypting");
      safeStorageMock.decryptStringAsync.mockRejectedValue(failure);

      await expect(safeStorageCipher.decrypt(b64(sealed("v10", "hunter2")))).rejects.toBe(failure);
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    });

    // The sync API would block the main thread on the Keychain prompt the
    // async one couldn't get past.
    it("keeps an unavailable Keychain from reaching the sync API, and says so", async () => {
      safeStorageMock.decryptStringAsync.mockRejectedValue(
        new Error("safeStorage.decryptStringAsync is temporarily unavailable")
      );
      safeStorageMock.encryptStringAsync.mockRejectedValue(new Error("Error while encrypting"));

      await expect(
        safeStorageCipher.decrypt(b64(sealed("v10", "hunter2")), { legacy: true })
      ).rejects.toThrow(
        "The Keychain wasn't available this session, so the secret couldn't be read — restart Daintree to try again"
      );
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    });

    // Electron 46 removes the sync methods.
    it("reports the async failure once the sync API is gone", async () => {
      asyncKey("v10");
      const failure = new Error("Error while decrypting");
      safeStorageMock.decryptStringAsync.mockRejectedValue(failure);
      const { decryptString } = safeStorageMock;
      Reflect.deleteProperty(safeStorageMock, "decryptString");
      try {
        await expect(
          safeStorageCipher.decrypt(b64(sealed("v10", "hunter2")), { legacy: true })
        ).rejects.toBe(failure);
      } finally {
        safeStorageMock.decryptString = decryptString;
      }
    });
  });

  it.each(["darwin", "win32"] as const)(
    "reads a legacy value through the async API on %s, which shares the sync key",
    async (platform) => {
      setPlatform(platform);
      asyncKey("v10");

      expect(
        await safeStorageCipher.decrypt(b64(sealed("v10", "hunter2")), { legacy: true })
      ).toEqual({ plaintext: "hunter2", reencrypt: false });
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    }
  );
});

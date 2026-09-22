import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn<() => boolean>(),
  getSelectedStorageBackend: vi.fn<() => string>(),
  encryptString: vi.fn((plaintext: string) => Buffer.from(`enc:${plaintext}`)),
  decryptString: vi.fn((encrypted: Buffer) => encrypted.toString().replace(/^enc:/, "")),
}));

vi.mock("electron", () => ({ safeStorage: safeStorageMock }));

import { safeStorageCipher } from "../secretCipher.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

describe("safeStorageCipher tier", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  describe("on Linux", () => {
    beforeEach(() => setPlatform("linux"));

    it.each(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"])(
      "reports keychain and encrypts under the %s backend",
      (backend) => {
        safeStorageMock.getSelectedStorageBackend.mockReturnValue(backend);

        expect(safeStorageCipher.tier()).toBe("keychain");
        const ciphertext = safeStorageCipher.encrypt("hunter2");
        expect(ciphertext).toBe(Buffer.from("enc:hunter2").toString("base64"));
        expect(safeStorageCipher.decrypt(ciphertext!)).toBe("hunter2");
      }
    );

    it.each(["basic_text", "unknown", "some_future_backend", "constructor"])(
      "reports plaintext and refuses to encrypt under the %s backend",
      (backend) => {
        safeStorageMock.getSelectedStorageBackend.mockReturnValue(backend);

        expect(safeStorageCipher.tier()).toBe("plaintext");
        expect(safeStorageCipher.encrypt("hunter2")).toBeNull();
        expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
      }
    );

    it("still decrypts existing ciphertext while refusing new encryption", () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("basic_text");
      const ciphertext = Buffer.from("enc:hunter2").toString("base64");

      expect(safeStorageCipher.encrypt("hunter2")).toBeNull();
      expect(safeStorageCipher.decrypt(ciphertext)).toBe("hunter2");
    });

    it("reports plaintext when the backend lookup throws", () => {
      safeStorageMock.getSelectedStorageBackend.mockImplementation(() => {
        throw new Error("not ready");
      });

      expect(safeStorageCipher.tier()).toBe("plaintext");
      expect(safeStorageCipher.encrypt("hunter2")).toBeNull();
    });

    it("skips the backend lookup when encryption is unavailable", () => {
      safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");

      expect(safeStorageCipher.tier()).toBe("plaintext");
      expect(safeStorageCipher.encrypt("hunter2")).toBeNull();
      expect(safeStorageMock.getSelectedStorageBackend).not.toHaveBeenCalled();
      expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
    });
  });

  it.each(["darwin", "win32"] as const)(
    "trusts isEncryptionAvailable on %s without a backend lookup",
    (platform) => {
      setPlatform(platform);

      expect(safeStorageCipher.tier()).toBe("keychain");
      expect(safeStorageCipher.encrypt("hunter2")).not.toBeNull();
      expect(safeStorageMock.getSelectedStorageBackend).not.toHaveBeenCalled();
    }
  );

  it("reports plaintext when isEncryptionAvailable throws", () => {
    setPlatform("darwin");
    safeStorageMock.isEncryptionAvailable.mockImplementation(() => {
      throw new Error("not ready");
    });

    expect(safeStorageCipher.tier()).toBe("plaintext");
    expect(safeStorageCipher.encrypt("hunter2")).toBeNull();
  });
});

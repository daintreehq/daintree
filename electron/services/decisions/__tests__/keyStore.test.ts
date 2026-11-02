import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredIdentity } from "@daintreehq/decisions-client";

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn<() => boolean>(),
  getSelectedStorageBackend: vi.fn<() => string>(),
  encryptStringAsync: vi.fn<(plaintext: string) => Promise<Buffer>>(),
  decryptStringAsync:
    vi.fn<(encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
}));

vi.mock("electron", () => ({
  safeStorage: safeStorageMock,
  app: { getPath: () => "/unused" },
}));

import {
  _resetSecretStorageSessionForTests,
  keychainSessionFailure,
  SECRET_STORAGE_TIMEOUT_MS,
} from "../../osKeychain.js";
import { DecisionsKeyStoreError, KeyFileChangedError, SealedKeyStore } from "../keyStore.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

// An opaque fake: the "ciphertext" is the plaintext with every byte flipped, so
// a file holding key material in the clear would show it, and this doesn't.
function sealed(prefix: string, plaintext: string): Buffer {
  const body = Buffer.from(plaintext, "utf8").map((byte) => byte ^ 0x5a);
  return Buffer.concat([Buffer.from(prefix, "latin1"), Buffer.from(body)]);
}

function opened(prefix: string, encrypted: Buffer): string {
  if (encrypted.subarray(0, 3).toString("latin1") !== prefix) {
    throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
  }
  return Buffer.from(encrypted.subarray(3).map((byte) => byte ^ 0x5a)).toString("utf8");
}

/** The async encryptor holding a key that tags its output `prefix`, and opening only what it sealed. */
function keyed(prefix: string) {
  safeStorageMock.encryptStringAsync.mockImplementation(async (plaintext) =>
    sealed(prefix, plaintext)
  );
  safeStorageMock.decryptStringAsync.mockImplementation(async (encrypted) => ({
    result: opened(prefix, encrypted),
    shouldReEncrypt: false,
  }));
}

/** A keychain that gives this session no key: every call fails. */
function noKey() {
  safeStorageMock.encryptStringAsync.mockRejectedValue(new Error("Encryption is not available."));
  safeStorageMock.decryptStringAsync.mockRejectedValue(new Error("Decryption is not available."));
}

function identity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  return {
    v: 1,
    config: {
      relayOrigin: "https://relay.example",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Daintree",
    },
    keys: {
      signing_private_pkcs8: "SIGNING-PRIVATE-SENTINEL",
      signing_public: "signing-public",
      exchange_private_pkcs8: "EXCHANGE-PRIVATE-SENTINEL",
      exchange_public: "exchange-public",
    },
    epochs: [
      { epoch: 1, raw: "EPOCH-ONE-SENTINEL" },
      { epoch: 2, raw: "EPOCH-TWO-SENTINEL" },
    ],
    currentEpoch: 2,
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<DecisionsKeyStoreError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(DecisionsKeyStoreError);
  return error as DecisionsKeyStoreError;
}

let dir: string;
let file: string;

beforeEach(async () => {
  vi.resetAllMocks();
  _resetSecretStorageSessionForTests();
  setPlatform("darwin");
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  dir = await mkdtemp(join(tmpdir(), "decisions-keys-"));
  file = join(dir, "decisions", "keys.bin");
});

afterEach(async () => {
  vi.useRealTimers();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  await rm(dir, { recursive: true, force: true });
});

describe("SealedKeyStore", () => {
  it("seals keys into one owner-only file and opens them again in a later store", async () => {
    keyed("v10");
    await new SealedKeyStore(file).save(identity());

    const text = await readFile(file, "utf8");
    for (const secret of ["SIGNING-PRIVATE", "EXCHANGE-PRIVATE", "EPOCH-ONE", "EPOCH-TWO"]) {
      expect(text).not.toContain(secret);
    }
    expect(JSON.parse(text)).toMatchObject({ v: 1, protection: "keychain" });
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, "decisions"))).mode & 0o777).toBe(0o700);
    }

    await expect(new SealedKeyStore(file).load()).resolves.toEqual(identity());
  });

  it("saves conditionally on what the file holds when the write's turn comes, writing nothing on a refusal", async () => {
    keyed("v10");
    const owner = identity();
    await new SealedKeyStore(file).save(owner);
    const before = await readFile(file, "utf8");
    const seen: Array<StoredIdentity | null> = [];

    const refused = new SealedKeyStore(file).saveIf(
      (current) => {
        seen.push(current);
        return current === null ? null : "Something else holds it";
      },
      identity({ config: { ...owner.config, deviceId: "dev_other_0001" } })
    );
    await expect(refused).rejects.toBeInstanceOf(KeyFileChangedError);
    await expect(refused).rejects.toThrow("Something else holds it");
    expect(seen).toEqual([owner]);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("runs every store's steps on one file in turn, so one's read never lands inside another's write", async () => {
    keyed("v10");
    await new SealedKeyStore(file).save(identity());
    // The first store's write waits on the keychain.
    let unseal!: () => void;
    const sealing = new Promise<void>((resolve) => (unseal = resolve));
    safeStorageMock.encryptStringAsync.mockImplementationOnce(async (plaintext) => {
      await sealing;
      return sealed("v10", plaintext);
    });
    const next = identity({ currentEpoch: 3 });
    const writing = new SealedKeyStore(file).save(next);
    const reading = new SealedKeyStore(file).load();
    let read: StoredIdentity | null | undefined;
    void reading.then((value) => (read = value));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).toBeUndefined();

    unseal();
    await writing;
    await expect(reading).resolves.toEqual(next);
  });

  it("saves what it was handed at the call, not what the caller changes afterwards", async () => {
    keyed("v10");
    const store = new SealedKeyStore(file);
    const handed = identity();

    const saving = store.save(handed);
    handed.epochs.push({ epoch: 3, raw: "LATER" });
    handed.currentEpoch = 3;
    await saving;

    const loaded = await store.load();
    expect(loaded?.currentEpoch).toBe(2);
    expect(loaded?.epochs.map((epoch) => epoch.epoch)).toEqual([1, 2]);
  });

  it("reads a missing file as no keys without asking the keychain, even a locked one", async () => {
    noKey();
    const store = new SealedKeyStore(file);

    await expect(store.load()).resolves.toBeNull();

    expect(safeStorageMock.encryptStringAsync).not.toHaveBeenCalled();
    expect(safeStorageMock.decryptStringAsync).not.toHaveBeenCalled();
    await expect(stat(join(dir, "decisions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["the format version", (id: Record<string, unknown>) => (id.v = 2)],
    [
      "the relay origin",
      (id: Record<string, unknown>) => delete (id.config as Record<string, unknown>).relayOrigin,
    ],
    [
      "the installation id",
      (id: Record<string, unknown>) => delete (id.config as Record<string, unknown>).installationId,
    ],
    [
      "the device id",
      (id: Record<string, unknown>) => delete (id.config as Record<string, unknown>).deviceId,
    ],
    [
      "the signing private key",
      (id: Record<string, unknown>) =>
        delete (id.keys as Record<string, unknown>).signing_private_pkcs8,
    ],
    [
      "the signing public key",
      (id: Record<string, unknown>) => delete (id.keys as Record<string, unknown>).signing_public,
    ],
    [
      "the exchange private key",
      (id: Record<string, unknown>) =>
        delete (id.keys as Record<string, unknown>).exchange_private_pkcs8,
    ],
    [
      "the exchange public key",
      (id: Record<string, unknown>) => delete (id.keys as Record<string, unknown>).exchange_public,
    ],
    [
      "an epoch number",
      (id: Record<string, unknown>) =>
        ((id.epochs as Array<Record<string, unknown>>)[1]!.epoch = "2"),
    ],
    [
      "an epoch key",
      (id: Record<string, unknown>) => delete (id.epochs as Array<Record<string, unknown>>)[0]!.raw,
    ],
    ["the current epoch", (id: Record<string, unknown>) => (id.currentEpoch = 1.5)],
  ])("refuses an identity missing %s and writes nothing", async (_label, breakIt) => {
    keyed("v10");
    const broken = identity() as unknown as Record<string, unknown>;
    breakIt(broken);

    const error = await refusal(new SealedKeyStore(file).save(broken as unknown as StoredIdentity));

    expect(error.kind).toBe("invalid-identity");
    expect(safeStorageMock.encryptStringAsync).not.toHaveBeenCalled();
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("on Linux", () => {
    beforeEach(() => setPlatform("linux"));

    it("seals with a real keyring", async () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
      keyed("v11");
      const store = new SealedKeyStore(file);

      await expect(store.check()).resolves.toEqual({ kind: "keychain" });
      await store.save(identity());

      expect(JSON.parse(await readFile(file, "utf8")).protection).toBe("keychain");
      await expect(store.load()).resolves.toEqual(identity());
    });

    it("refuses basic_text with a reason until the weaker storage is confirmed", async () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("basic_text");
      keyed("v10");
      const store = new SealedKeyStore(file);

      const check = await store.check();
      expect(check.kind).toBe("weak");
      const error = await refusal(store.save(identity()));

      expect(error.kind).toBe("weak-storage-unconfirmed");
      expect(error.message).toMatch(/keyring/);
      expect(safeStorageMock.encryptStringAsync).not.toHaveBeenCalled();
      await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("stores under the fixed key once confirmed, and the file carries that consent forward", async () => {
      // The session already learned the keyring gave no key; a weak seal mustn't forget it.
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
      keyed("v10");
      expect((await new SealedKeyStore(file).check()).kind).toBe("locked");
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("basic_text");
      const confirmed = new SealedKeyStore(file);
      confirmed.confirmWeakStorage();

      await confirmed.save(identity());
      expect(JSON.parse(await readFile(file, "utf8")).protection).toBe("basic");

      const later = new SealedKeyStore(file);
      await expect(later.load()).resolves.toEqual(identity());
      await later.save(identity({ currentEpoch: 1 }));
      await expect(later.load()).resolves.toMatchObject({ currentEpoch: 1 });
      // A weak seal asks no keychain, so it doesn't clear what the session learned about one.
      expect(keychainSessionFailure()).toBe("locked");
    });

    it("moves fixed-key storage up to the keyring on the next save once one answers", async () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("basic_text");
      keyed("v10");
      const store = new SealedKeyStore(file);
      store.confirmWeakStorage();
      await store.save(identity());

      safeStorageMock.getSelectedStorageBackend.mockReturnValue("kwallet6");
      safeStorageMock.encryptStringAsync.mockImplementation(async (plaintext) =>
        sealed("v11", plaintext)
      );
      safeStorageMock.decryptStringAsync.mockImplementation(async (encrypted) => ({
        result: opened(encrypted.subarray(0, 3).toString("latin1"), encrypted),
        shouldReEncrypt: false,
      }));
      await new SealedKeyStore(file).save(identity());

      expect(JSON.parse(await readFile(file, "utf8")).protection).toBe("keychain");
    });

    it.each([false, true])(
      "treats a keyring answering with the fixed-key fallback as locked (weak storage confirmed: %s)",
      async (confirmed) => {
        safeStorageMock.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
        keyed("v10");
        const store = new SealedKeyStore(file);
        if (confirmed) store.confirmWeakStorage();

        const error = await refusal(store.save(identity()));

        expect(error.kind).toBe("locked");
        expect(error.message).toMatch(/keyring wasn't available this session/);
        await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      }
    );

    it("reports an unknown backend as unavailable", async () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("unknown");
      keyed("v11");
      const store = new SealedKeyStore(file);
      store.confirmWeakStorage();

      expect((await store.check()).kind).toBe("unavailable");
      expect((await refusal(store.save(identity()))).kind).toBe("unavailable");
    });

    it("never reads keyring-sealed keys as missing once only basic_text is left", async () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
      keyed("v11");
      await new SealedKeyStore(file).save(identity());
      const before = await readFile(file);

      safeStorageMock.getSelectedStorageBackend.mockReturnValue("basic_text");
      keyed("v10");
      const store = new SealedKeyStore(file);
      store.confirmWeakStorage();

      expect((await refusal(store.load())).kind).toBe("unavailable");
      expect((await refusal(store.save(identity({ currentEpoch: 1 })))).kind).toBe("unavailable");
      expect(await readFile(file)).toEqual(before);
    });
  });

  describe("with a locked keychain", () => {
    it("reports existing keys as locked, never as missing", async () => {
      keyed("v10");
      await new SealedKeyStore(file).save(identity());
      noKey();

      const error = await refusal(new SealedKeyStore(file).load());

      expect(error.kind).toBe("locked");
      expect(error.message).toMatch(/Keychain wasn't available this session/);
      expect(error.message).not.toContain("SENTINEL");
    });

    it("never overwrites existing keys, a recovery import's direct save included", async () => {
      keyed("v10");
      await new SealedKeyStore(file).save(identity());
      const before = await readFile(file);
      noKey();

      const error = await refusal(new SealedKeyStore(file).save(identity({ currentEpoch: 1 })));

      expect(error.kind).toBe("locked");
      expect(await readFile(file)).toEqual(before);
    });

    it("says so before setup saves anything", async () => {
      noKey();
      const check = await new SealedKeyStore(file).check();

      expect(check.kind).toBe("locked");
    });

    it("on Windows, says there is no keychain to use", async () => {
      setPlatform("win32");
      noKey();

      expect((await refusal(new SealedKeyStore(file).save(identity()))).kind).toBe("unavailable");
    });
  });

  describe("with a file that won't open", () => {
    it("reports keys this computer's key can't open as unreadable and leaves them", async () => {
      keyed("v10");
      await new SealedKeyStore(file).save(identity());
      const before = await readFile(file);
      // The keychain answers, but with a different key than the one that sealed the file.
      safeStorageMock.decryptStringAsync.mockRejectedValue(new Error("bad decrypt"));
      const store = new SealedKeyStore(file);

      expect((await refusal(store.load())).kind).toBe("unreadable");
      expect((await refusal(store.save(identity()))).kind).toBe("unreadable");
      expect(await readFile(file)).toEqual(before);
    });

    it.each([
      ["text that isn't JSON", () => "not json"],
      ["an envelope without ciphertext", () => JSON.stringify({ v: 1, protection: "keychain" })],
      [
        "ciphertext that isn't base64",
        () => JSON.stringify({ v: 1, protection: "keychain", ciphertext: "%%%" }),
      ],
      [
        "a sealed payload that isn't an identity",
        () =>
          JSON.stringify({
            v: 1,
            protection: "keychain",
            ciphertext: sealed("v10", JSON.stringify({ v: 1, protection: "keychain" })).toString(
              "base64"
            ),
          }),
      ],
      [
        "an envelope claiming weaker storage than its payload",
        () =>
          JSON.stringify({
            v: 1,
            protection: "basic",
            ciphertext: sealed(
              "v10",
              JSON.stringify({ v: 1, protection: "keychain", identity: identity() })
            ).toString("base64"),
          }),
      ],
    ])("reads %s as unreadable, never as missing", async (_label, contents) => {
      keyed("v10");
      await mkdir(join(dir, "decisions"), { recursive: true });
      await writeFile(file, contents());

      expect((await refusal(new SealedKeyStore(file).load())).kind).toBe("unreadable");
    });

    it.each([
      ["text that isn't JSON", "not json"],
      ["an envelope without ciphertext", JSON.stringify({ v: 1, protection: "keychain" })],
      ["an unknown protection", JSON.stringify({ v: 1, protection: "plain", ciphertext: "AAAA" })],
      [
        "sealed base64 with a stray character, which a lenient decoder would accept",
        JSON.stringify({
          v: 1,
          protection: "keychain",
          ciphertext: `${sealed("v10", JSON.stringify({ v: 1, protection: "keychain", identity: identity() })).toString("base64")}!`,
        }),
      ],
    ])("refuses %s before asking the keychain anything", async (_label, contents) => {
      keyed("v10");
      await mkdir(join(dir, "decisions"), { recursive: true });
      await writeFile(file, contents);

      expect((await refusal(new SealedKeyStore(file).load())).kind).toBe("unreadable");
      expect(safeStorageMock.decryptStringAsync).not.toHaveBeenCalled();
      expect(safeStorageMock.encryptStringAsync).not.toHaveBeenCalled();
    });

    it("leaves a file from another format version alone", async () => {
      keyed("v10");
      await mkdir(join(dir, "decisions"), { recursive: true });
      const future = JSON.stringify({ v: 2, sealed: "elsewhere" });
      await writeFile(file, future);
      const store = new SealedKeyStore(file);

      expect((await refusal(store.load())).kind).toBe("unsupported-format");
      expect((await refusal(store.save(identity()))).kind).toBe("unsupported-format");
      expect(await readFile(file, "utf8")).toBe(future);
    });
  });

  it("gives up on a keychain that doesn't answer at its deadline, without calling it locked or writing", async () => {
    keyed("v10");
    await new SealedKeyStore(file).save(identity());
    const before = await readFile(file);
    let entered!: () => void;
    const asked = new Promise<void>((resolve) => (entered = resolve));
    safeStorageMock.decryptStringAsync.mockImplementation(() => {
      entered();
      return new Promise(() => {});
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = new SealedKeyStore(file);

    let settled = false;
    const saving = store.save(identity({ currentEpoch: 1 }));
    saving.then(
      () => (settled = true),
      () => (settled = true)
    );
    await asked;
    await vi.advanceTimersByTimeAsync(SECRET_STORAGE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await refusal(saving);

    expect(error.kind).toBe("timeout");
    expect(keychainSessionFailure()).toBeNull();
    expect(await readFile(file)).toEqual(before);

    // The store keeps working once the keychain answers again.
    vi.useRealTimers();
    keyed("v10");
    await expect(store.load()).resolves.toEqual(identity());
  });

  it("clears the file without asking the keychain, and the weak-storage consent with it", async () => {
    setPlatform("linux");
    safeStorageMock.getSelectedStorageBackend.mockReturnValue("basic_text");
    keyed("v10");
    const store = new SealedKeyStore(file);
    store.confirmWeakStorage();
    await store.save(identity());
    vi.clearAllMocks();

    await store.clear();
    await store.clear();

    expect(safeStorageMock.encryptStringAsync).not.toHaveBeenCalled();
    expect(safeStorageMock.decryptStringAsync).not.toHaveBeenCalled();
    await expect(store.load()).resolves.toBeNull();
    expect((await refusal(store.save(identity()))).kind).toBe("weak-storage-unconfirmed");
  });

  it("waits on close for what was asked before, and refuses anything after", async () => {
    keyed("v10");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const asked = new Promise<void>((resolve) => (entered = resolve));
    safeStorageMock.encryptStringAsync.mockImplementation(async (plaintext) => {
      entered();
      await held;
      return sealed("v10", plaintext);
    });
    const store = new SealedKeyStore(file);

    const saving = store.save(identity());
    const clearing = store.clear();
    let closed = false;
    const closing = store.close().then(() => (closed = true));
    await asked;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    release();
    await Promise.all([saving, clearing, closing]);

    // The clear asked after the save ran after it, so nothing is left behind.
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await refusal(store.load())).kind).toBe("closed");
    expect((await refusal(store.check())).kind).toBe("closed");
  });
});

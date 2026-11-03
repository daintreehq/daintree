// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn<() => boolean>(() => true),
  getSelectedStorageBackend: vi.fn<() => string>(() => "keychain"),
  encryptStringAsync: vi.fn<(plaintext: string) => Promise<Buffer>>(),
  decryptStringAsync:
    vi.fn<(encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
}));

vi.mock("electron", () => ({
  safeStorage: safeStorageMock,
  app: { getPath: () => "/unused" },
  net: {},
}));

const made = vi.hoisted(() => ({ requests: 0 }));
vi.mock("@daintreehq/decisions-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daintreehq/decisions-client")>();
  return {
    ...actual,
    createHostRequest: (...args: Parameters<typeof actual.createHostRequest>) => {
      made.requests += 1;
      return actual.createHostRequest(...args);
    },
  };
});

import { enrollHost, importIdentity } from "@daintreehq/decisions-client";
import { _resetSecretStorageSessionForTests } from "../../osKeychain.js";
import { HostEnrollments } from "../hostEnrollmentHost.js";
import { SealedKeyStore } from "../keyStore.js";
import { makeOwner, memoryKeys } from "../../../remote/decisions/__tests__/ownerFixture.js";

// An opaque fake keychain: bytes flipped, so key material in the clear would show.
function keyed() {
  safeStorageMock.encryptStringAsync.mockImplementation(async (plaintext) =>
    Buffer.from(Buffer.from(plaintext, "utf8").map((byte) => byte ^ 0x5a))
  );
  safeStorageMock.decryptStringAsync.mockImplementation(async (encrypted) => ({
    result: Buffer.from(encrypted.map((byte) => byte ^ 0x5a)).toString("utf8"),
    shouldReEncrypt: false,
  }));
}

let dir: string;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(async () => {
  // The fake keychain is a macOS one, on every machine the tests run on.
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  dir = await mkdtemp(join(tmpdir(), "decisions-host-"));
  made.requests = 0;
  _resetSecretStorageSessionForTests();
  keyed();
});

afterEach(async () => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  await rm(dir, { recursive: true, force: true });
});

describe("HostEnrollments", () => {
  it("seals the accepted identity with this machine's keychain, readable only through it", async () => {
    const file = join(dir, "decisions", "keys.bin");
    const enrollment = new HostEnrollments({ openKeys: () => new SealedKeyStore(file) });
    const owner = await makeOwner();
    const link = {};

    const requested = await enrollment.request(link, {
      attempt: "attempt_0000000001",
      label: "studio",
    });
    if (requested.step !== "requested") throw new Error(JSON.stringify(requested));
    const { response } = await enrollHost(owner.client, requested.request);
    const accepted = await enrollment.accept(link, { attempt: "attempt_0000000001", response });
    expect(accepted).toMatchObject({ step: "accepted" });

    const stored = await new SealedKeyStore(file).load();
    expect(stored?.role).toBe("desktop-host");
    expect((await importIdentity(stored!)).owner.deviceId).toBe(owner.deviceId);
    // On disk nothing is in the clear: not its private keys, not the content key it was granted.
    const onDisk = await readFile(file, "utf8");
    for (const secret of [
      stored!.keys.signing_private_pkcs8,
      stored!.keys.exchange_private_pkcs8,
      stored!.epochs[0].raw,
    ]) {
      expect(onDisk).not.toContain(secret);
    }
    expect(await enrollment.status()).toMatchObject({
      kind: "host",
      deviceId: stored!.config.deviceId,
    });
  });

  it.each([
    ["locked", { kind: "locked", reason: "The keychain is locked" }],
    ["unavailable", { kind: "unavailable", reason: "Secure storage is unavailable" }],
    ["timeout", { kind: "timeout", reason: "The keychain didn't answer" }],
  ] as const)(
    "asks the keychain before making any key, and makes none when it is %s",
    async (_kind, check) => {
      const keys = memoryKeys();
      keys.state.keychain = check;
      const enrollment = new HostEnrollments({ openKeys: keys.open });
      expect(
        await enrollment.request({}, { attempt: "attempt_0000000001", label: "studio" })
      ).toEqual({ step: "refused", reason: "no-keychain", detail: check.reason });
      expect(made.requests).toBe(0);

      keys.state.keychain = { kind: "keychain" };
      expect(
        await enrollment.request({}, { attempt: "attempt_0000000002", label: "studio" })
      ).toMatchObject({ step: "requested" });
      expect(made.requests).toBe(1);
    }
  );

  it("with no keychain, says the fixed-key storage is all there is, and makes no key unless the owner accepted it", async () => {
    const keys = memoryKeys();
    keys.state.keychain = { kind: "weak", reason: "No keyring is available" };
    const enrollment = new HostEnrollments({ openKeys: keys.open });
    expect(await enrollment.request({}, { attempt: "attempt_0000000001", label: "wsl" })).toEqual({
      step: "refused",
      reason: "weak-storage-only",
      detail: "No keyring is available",
    });
    expect(made.requests).toBe(0);
  });

  it("seals under the fixed key only for an attempt the owner accepted it for", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    safeStorageMock.getSelectedStorageBackend.mockReturnValue("basic_text");
    try {
      const file = join(dir, "decisions", "keys.bin");
      const enrollment = new HostEnrollments({ openKeys: () => new SealedKeyStore(file) });
      const owner = await makeOwner();
      const link = {};
      const requested = await enrollment.request(link, {
        attempt: "attempt_0000000001",
        label: "wsl",
        allowWeakStorage: true,
      });
      if (requested.step !== "requested") throw new Error(JSON.stringify(requested));
      const { response } = await enrollHost(owner.client, requested.request);
      expect(
        await enrollment.accept(link, { attempt: "attempt_0000000001", response })
      ).toMatchObject({ step: "accepted" });
      expect(JSON.parse(await readFile(file, "utf8")).protection).toBe("basic");
      expect((await new SealedKeyStore(file).load())?.role).toBe("desktop-host");
    } finally {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("keychain");
    }
  });

  it("never seals under the fixed key for an attempt that started with a keychain", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    safeStorageMock.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
    try {
      const file = join(dir, "decisions", "keys.bin");
      const enrollment = new HostEnrollments({ openKeys: () => new SealedKeyStore(file) });
      const owner = await makeOwner();
      const link = {};
      const requested = await enrollment.request(link, {
        attempt: "attempt_0000000001",
        label: "wsl",
      });
      if (requested.step !== "requested") throw new Error(JSON.stringify(requested));
      const { response } = await enrollHost(owner.client, requested.request);
      // The keyring went away between the request and the owner's answer: nobody accepted the downgrade.
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("basic_text");
      expect(
        await enrollment.accept(link, { attempt: "attempt_0000000001", response })
      ).not.toMatchObject({ step: "accepted" });
      await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue("keychain");
    }
  });

  it("refuses when the keychain itself fails, making no key", async () => {
    const keys = memoryKeys();
    const enrollment = new HostEnrollments({
      openKeys: () => ({
        ...keys.open(),
        check: async () => {
          throw new Error("The keychain refused");
        },
      }),
    });
    expect(
      await enrollment.request({}, { attempt: "attempt_0000000001", label: "studio" })
    ).toEqual({ step: "refused", reason: "no-keychain", detail: "The keychain refused" });
    expect(made.requests).toBe(0);
  });

  it("closes the key store it opened for every step, a failed one included", async () => {
    const keys = memoryKeys();
    const enrollment = new HostEnrollments({ openKeys: keys.open });
    await enrollment.status();
    await enrollment.request({}, { attempt: "attempt_0000000001", label: "studio" });
    await enrollment.accept({}, { attempt: "attempt_0000000001", response: "not an enrollment" });
    expect(keys.state.opened).toBe(3);
    expect(keys.state.closed).toBe(3);
  });

  it("says which Host identity it holds once accepted and on every read, for its own Decisions to run as", async () => {
    const keys = memoryKeys();
    const onHeld = vi.fn();
    const enrollment = new HostEnrollments({ openKeys: keys.open, onHeld });
    const owner = await makeOwner();
    const link = {};

    await enrollment.status();
    expect(onHeld).not.toHaveBeenCalled();

    const requested = await enrollment.request(link, {
      attempt: "attempt_0000000001",
      label: "studio",
    });
    if (requested.step !== "requested") throw new Error("not requested");
    const { response } = await enrollHost(owner.client, requested.request);
    const accepted = await enrollment.accept(link, { attempt: "attempt_0000000001", response });
    if (accepted.step !== "accepted") throw new Error("not accepted");

    const held = {
      relayOrigin: owner.stored.config.relayOrigin,
      installationId: owner.installationId,
      deviceId: accepted.deviceId,
      ownerDeviceId: owner.deviceId,
    };
    expect(onHeld.mock.calls).toEqual([[held]]);
    await enrollment.status();
    expect(onHeld.mock.calls).toEqual([[held], [held]]);
  });

  it("says nothing is held for an owner's own identity, or a refused enrollment", async () => {
    const owner = await makeOwner();
    const keys = memoryKeys(owner.stored);
    const onHeld = vi.fn();
    const enrollment = new HostEnrollments({ openKeys: keys.open, onHeld });

    await enrollment.status();
    await enrollment.accept({}, { attempt: "attempt_0000000001", response: "not an enrollment" });
    expect(onHeld).not.toHaveBeenCalled();
  });
});

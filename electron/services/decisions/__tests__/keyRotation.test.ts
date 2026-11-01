import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  MemoryKeyStore,
  RelayError,
  importIdentity,
  type KeyStore,
  type RelayClient,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  issueDeviceCert,
  openEpochGrant,
  serializeDeviceKeys,
  type DeviceKeys,
} from "@daintreehq/decisions-crypto";
import {
  bytesToBase64Url,
  type DeviceInfo,
  type DevicesResponse,
  type EpochGrant,
} from "@daintreehq/decisions-protocol";
import { KeyRotations, KeyRotationsClosedError, pendingRotationOf } from "../keyRotation.js";

const INSTALLATION = "inst_12345678";
const OWNER = "dev_owner_1234";

interface Phone {
  id: string;
  keys: DeviceKeys;
  info: DeviceInfo;
}

let ownerKeys: DeviceKeys;
let ownerStored: StoredIdentity;
let phoneA: Phone;
let phoneB: Phone;
let stranger: Phone;
/** This computer, as the relay lists it: never a recipient. */
let ownerDevice: Phone;
/** Revoked before: never a recipient either. */
let gone: Phone;
/** Owner-signed, but each certificate disagrees with the listing in one field. */
let mismatched: Phone[];

async function phone(
  id: string,
  issuer: DeviceKeys,
  cert: {
    issuerId?: string;
    installationId?: string;
    deviceId?: string;
    role?: "phone" | "tablet" | "owner-desktop";
    keys?: DeviceKeys;
  } = {},
  role: "phone" | "owner-desktop" = "phone"
): Promise<Phone> {
  const keys = cert.keys ?? (await generateDeviceKeys(true));
  const serialized = await serializeDeviceKeys(keys);
  const issued = await issueDeviceCert({
    issuerDeviceId: cert.issuerId ?? OWNER,
    issuerSigningKey: issuer.signing.privateKey,
    installationId: cert.installationId ?? INSTALLATION,
    deviceId: cert.deviceId ?? id,
    role: cert.role ?? role,
    label: `Phone ${id}`,
    signingPub: serialized.signing_public,
    exchangePub: serialized.exchange_public,
  });
  return {
    id,
    keys,
    info: {
      device_id: id,
      role,
      label: `Phone ${id}`,
      created_at: "2026-11-01T00:00:00.000Z",
      revoked_at: null,
      last_seen_at: null,
      last_ack_seq: 0,
      cert: issued,
      push_enabled: false,
    } as DeviceInfo,
  };
}

beforeAll(async () => {
  ownerKeys = await generateDeviceKeys(true);
  const serialized = await serializeDeviceKeys(ownerKeys);
  ownerStored = {
    v: 1,
    config: {
      relayOrigin: "https://relay.example.com",
      installationId: INSTALLATION,
      deviceId: OWNER,
      label: "Desktop",
    },
    keys: serialized,
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  };
  phoneA = await phone("dev_phone_a", ownerKeys);
  phoneB = await phone("dev_phone_b", ownerKeys);
  // Signed by someone else's key: the relay can list it, but nothing may be sealed to it.
  stranger = await phone("dev_stranger", await generateDeviceKeys(true));
  ownerDevice = await phone(OWNER, ownerKeys, { keys: ownerKeys }, "owner-desktop");
  gone = await phone("dev_gone", ownerKeys);
  gone.info = { ...gone.info, revoked_at: "2026-10-31T00:00:00.000Z" };
  mismatched = await Promise.all([
    phone("dev_other_install", ownerKeys, { installationId: "inst_other" }),
    phone("dev_other_issuer", ownerKeys, { issuerId: "dev_someone_else" }),
    phone("dev_other_subject", ownerKeys, { deviceId: "dev_someone_else" }),
    phone("dev_other_role", ownerKeys, { role: "tablet" }),
  ]);
});

/** The relay's state, as the fake client answers it. */
interface RelayState {
  epoch: number;
  devices: DeviceInfo[];
  /** Grants the relay took, by epoch. */
  grants: Map<number, EpochGrant[]>;
}

function relayWith(devices: Phone[], epoch = 1): RelayState {
  return { epoch, devices: devices.map((p) => ({ ...p.info })), grants: new Map() };
}

function list(state: RelayState): DevicesResponse {
  return {
    key_epoch: state.epoch,
    devices: state.devices.map((d) => ({ ...d })),
  } as DevicesResponse;
}

/** Takes a rotation as the relay does: exactly current + 1, grants for every remaining device. */
function commit(
  state: RelayState,
  revoke: string | null,
  epoch: number,
  grants: EpochGrant[]
): void {
  if (epoch !== state.epoch + 1) throw new RelayError("validation_error", "stale epoch", 400);
  if (revoke !== null) {
    const target = state.devices.find((d) => d.device_id === revoke);
    if (!target) throw new RelayError("not_found", "no such device", 404);
    if (target.revoked_at !== null) throw new RelayError("invalid_state", "already revoked", 409);
  }
  const expected = state.devices
    .filter((d) => d.revoked_at === null && d.role !== "owner-desktop" && d.device_id !== revoke)
    .map((d) => d.device_id)
    .sort();
  const got = grants.map((g) => g.device_id).sort();
  if (expected.join() !== got.join()) {
    throw new RelayError("validation_error", "grants must cover every remaining device", 400);
  }
  if (revoke !== null) {
    state.devices = state.devices.map((d) =>
      d.device_id === revoke ? { ...d, revoked_at: "2026-11-02T00:00:00.000Z" } : d
    );
  }
  state.epoch = epoch;
  state.grants.set(epoch, grants);
}

interface FakeClient {
  client: RelayClient;
  devices: ReturnType<typeof vi.fn>;
  revokeDevice: ReturnType<typeof vi.fn>;
  rotateEpoch: ReturnType<typeof vi.fn>;
}

function fakeClient(state: RelayState): FakeClient {
  const devices = vi.fn(async () => list(state));
  const revokeDevice = vi.fn(async (id: string, epoch: number, grants: EpochGrant[]) =>
    commit(state, id, epoch, grants)
  );
  const rotateEpoch = vi.fn(async (epoch: number, grants: EpochGrant[]) =>
    commit(state, null, epoch, grants)
  );
  const client = { identity: null, devices, revokeDevice, rotateEpoch } as unknown as RelayClient;
  return { client, devices, revokeDevice, rotateEpoch };
}

async function keysWith(stored: StoredIdentity = ownerStored): Promise<MemoryKeyStore> {
  const keys = new MemoryKeyStore();
  await keys.save(structuredClone(stored));
  return keys;
}

async function stored(keys: KeyStore): Promise<StoredIdentity> {
  const value = await keys.load();
  if (!value) throw new Error("no keys");
  return value;
}

async function rawKey(keys: KeyStore, epoch: number): Promise<string | undefined> {
  return (await stored(keys)).epochs.find((entry) => entry.epoch === epoch)?.raw;
}

/** What `holder` gets when it opens its grant for `epoch`. */
async function opened(state: RelayState, holder: Phone, epoch: number): Promise<string> {
  const grant = state.grants.get(epoch)?.find((g) => g.device_id === holder.id);
  if (!grant) throw new Error(`no grant for ${holder.id} at ${epoch}`);
  const key = await openEpochGrant({
    grant,
    ownerSigningPublicKey: ownerKeys.signing.publicKey,
    exchangePrivateKey: holder.keys.exchange.privateKey,
    expectedInstallationId: INSTALLATION,
    expectedDeviceId: holder.id,
    keepRaw: true,
  });
  if (!key.raw) throw new Error("grant opened without its raw key");
  return bytesToBase64Url(key.raw);
}

describe("KeyRotations", () => {
  it("revokes a device and seals the new key to each one that remains, then makes it current", async () => {
    const keys = await keysWith();
    const state = relayWith([ownerDevice, phoneA, phoneB, gone]);
    const { client, revokeDevice } = fakeClient(state);

    const outcome = await new KeyRotations(keys).rotate(client, phoneA.id);

    expect(outcome).toEqual({ outcome: "done", epoch: 2, revoked: phoneA.id });
    expect(revokeDevice).toHaveBeenCalledOnce();
    // Neither this computer nor a device revoked before gets a grant.
    expect(state.grants.get(2)?.map((g) => g.device_id)).toEqual([phoneB.id]);
    const after = await stored(keys);
    expect(after.currentEpoch).toBe(2);
    expect(pendingRotationOf(after)).toBeNull();
    // The remaining phone opens exactly the key this computer now seals with.
    expect(await opened(state, phoneB, 2)).toBe(await rawKey(keys, 2));
    // The old key stays, so what it sealed can still be read.
    expect(await rawKey(keys, 1)).toBe(ownerStored.epochs[0]!.raw);
    expect((client.identity as { currentEpoch: number }).currentEpoch).toBe(2);
  });

  it("rotates without revoking anyone, sealing to every paired device", async () => {
    const keys = await keysWith();
    const state = relayWith([phoneA, phoneB]);
    const { client, rotateEpoch, revokeDevice } = fakeClient(state);

    await expect(new KeyRotations(keys).rotate(client, null)).resolves.toMatchObject({
      outcome: "done",
      epoch: 2,
      revoked: null,
    });

    expect(revokeDevice).not.toHaveBeenCalled();
    expect(rotateEpoch).toHaveBeenCalledOnce();
    expect(await opened(state, phoneA, 2)).toBe(await rawKey(keys, 2));
    expect(await opened(state, phoneB, 2)).toBe(await rawKey(keys, 2));
  });

  it("keeps the staged key when the relay took it but the answer was lost, and makes it current on settle", async () => {
    const keys = await keysWith();
    const state = relayWith([phoneA, phoneB]);
    const relay = fakeClient(state);
    relay.revokeDevice.mockImplementationOnce(async (id: string, epoch: number, grants) => {
      commit(state, id, epoch, grants);
      throw new RelayError("network_error", "socket hang up", 0);
    });
    const rotations = new KeyRotations(keys);

    const lost = await rotations.rotate(relay.client, phoneA.id);

    expect(lost.outcome).toBe("unconfirmed");
    const between = await stored(keys);
    // Still sealing with the old key, but the new one and its purpose are kept.
    expect(between.currentEpoch).toBe(1);
    expect(pendingRotationOf(between)).toEqual({ epoch: 2, revoke: phoneA.id });

    // Next start: a fresh lifetime over the same keys.
    const next = fakeClient(state);
    await expect(new KeyRotations(keys).settle(next.client)).resolves.toMatchObject({
      outcome: "done",
      epoch: 2,
      revoked: phoneA.id,
    });

    expect(next.revokeDevice).not.toHaveBeenCalled();
    const after = await stored(keys);
    expect(after.currentEpoch).toBe(2);
    expect(pendingRotationOf(after)).toBeNull();
    expect(await opened(state, phoneB, 2)).toBe(await rawKey(keys, 2));
  });

  it("sends the same staged key again when a crash came before the relay took it", async () => {
    const keys = await keysWith();
    const state = relayWith([phoneA, phoneB]);
    const relay = fakeClient(state);
    // The request never reaches the relay, and the process dies with the key staged.
    relay.revokeDevice.mockRejectedValueOnce(new RelayError("network_error", "offline", 0));
    await new KeyRotations(keys).rotate(relay.client, phoneA.id);
    const staged = await rawKey(keys, 2);
    expect(state.epoch).toBe(1);

    const next = fakeClient(state);
    await expect(new KeyRotations(keys).settle(next.client)).resolves.toMatchObject({
      outcome: "done",
      revoked: phoneA.id,
    });

    expect(next.revokeDevice).toHaveBeenCalledOnce();
    // Never a second key for the epoch: what the relay holds is the one staged before the crash.
    expect(await rawKey(keys, 2)).toBe(staged);
    expect(await opened(state, phoneB, 2)).toBe(staged);
    expect((await stored(keys)).currentEpoch).toBe(2);
  });

  it("makes the staged key current when a resend finds the earlier request landed late", async () => {
    const keys = await keysWith();
    const state = relayWith([phoneA]);
    const relay = fakeClient(state);
    let late: (() => void) | null = null;
    relay.rotateEpoch.mockImplementationOnce(async (epoch: number, grants: EpochGrant[]) => {
      late = () => commit(state, null, epoch, grants);
      throw new RelayError("network_error", "timeout", 0);
    });
    const rotations = new KeyRotations(keys);
    await rotations.rotate(relay.client, null);

    // The relay reads as unchanged, then the first request lands before the resend does.
    relay.rotateEpoch.mockImplementationOnce(async () => {
      late?.();
      throw new RelayError("validation_error", "new_key_epoch must be 3", 400);
    });
    await expect(rotations.settle(relay.client)).resolves.toMatchObject({ outcome: "done" });

    expect((await stored(keys)).currentEpoch).toBe(2);
    expect(await opened(state, phoneA, 2)).toBe(await rawKey(keys, 2));
  });

  it("seals to a device paired while it ran, retrying with the same key", async () => {
    const keys = await keysWith();
    const state = relayWith([phoneA]);
    const relay = fakeClient(state);
    let firstStaged: string | undefined;
    relay.rotateEpoch.mockImplementationOnce(async (epoch: number, grants: EpochGrant[]) => {
      firstStaged = await rawKey(keys, 2);
      state.devices.push({ ...phoneB.info });
      commit(state, null, epoch, grants);
    });

    await expect(new KeyRotations(keys).rotate(relay.client, null)).resolves.toMatchObject({
      outcome: "done",
    });

    expect(relay.rotateEpoch).toHaveBeenCalledTimes(2);
    expect(firstStaged).toBeDefined();
    expect(await rawKey(keys, 2)).toBe(firstStaged);
    expect(await opened(state, phoneA, 2)).toBe(firstStaged);
    expect(await opened(state, phoneB, 2)).toBe(firstStaged);
  });

  it("stages and sends nothing when a remaining device's certificate doesn't verify", async () => {
    const keys = await keysWith();
    const state = relayWith([phoneA, stranger]);
    const relay = fakeClient(state);

    await expect(new KeyRotations(keys).rotate(relay.client, phoneA.id)).resolves.toEqual({
      outcome: "unverified",
    });

    expect(relay.revokeDevice).not.toHaveBeenCalled();
    expect(await stored(keys)).toEqual(ownerStored);
  });

  it("refuses an owner-signed certificate that names another installation, issuer, device or role", async () => {
    for (const odd of mismatched) {
      const keys = await keysWith();
      const relay = fakeClient(relayWith([phoneA, odd]));

      await expect(new KeyRotations(keys).rotate(relay.client, null), odd.id).resolves.toEqual({
        outcome: "unverified",
      });

      expect(relay.rotateEpoch, odd.id).not.toHaveBeenCalled();
      expect(await stored(keys), odd.id).toEqual(ownerStored);
    }
  });

  it("sends nothing when the key couldn't be staged", async () => {
    const memory = await keysWith();
    const keys: KeyStore = {
      load: () => memory.load(),
      clear: () => memory.clear(),
      save: async () => {
        throw new Error("disk full");
      },
    };
    const relay = fakeClient(relayWith([phoneA]));

    await expect(new KeyRotations(keys).rotate(relay.client, phoneA.id)).rejects.toThrow(
      "disk full"
    );

    expect(relay.revokeDevice).not.toHaveBeenCalled();
    expect(await stored(memory)).toEqual(ownerStored);
  });

  it("says a device the relay doesn't list as active can't be revoked, staging nothing", async () => {
    const keys = await keysWith();
    const state = relayWith([ownerDevice, phoneA]);
    state.devices[1] = { ...state.devices[1]!, revoked_at: "2026-11-01T00:00:00.000Z" };
    const relay = fakeClient(state);

    await expect(new KeyRotations(keys).rotate(relay.client, phoneA.id)).resolves.toEqual({
      outcome: "not-found",
    });
    await expect(new KeyRotations(keys).rotate(relay.client, OWNER)).resolves.toEqual({
      outcome: "not-found",
    });

    expect(await stored(keys)).toEqual(ownerStored);
  });

  it("never stages over a key that was in force here when the relay reads as behind", async () => {
    const keys = await keysWith({ ...ownerStored, currentEpoch: 1 });
    const state = relayWith([phoneA], 0);
    const relay = fakeClient(state);

    await expect(new KeyRotations(keys).rotate(relay.client, null)).resolves.toEqual({
      outcome: "conflict",
    });

    expect(await stored(keys)).toEqual(ownerStored);
    expect(relay.rotateEpoch).not.toHaveBeenCalled();
  });

  it("keeps a key the relay moved past as a past key, and forgets what it was for", async () => {
    const keys = await keysWith();
    const state = relayWith([phoneA]);
    const relay = fakeClient(state);
    relay.rotateEpoch.mockRejectedValueOnce(new RelayError("network_error", "offline", 0));
    await new KeyRotations(keys).rotate(relay.client, null);
    const staged = await rawKey(keys, 2);
    state.epoch = 3;

    await expect(new KeyRotations(keys).settle(relay.client)).resolves.toEqual({
      outcome: "superseded",
    });

    const after = await stored(keys);
    expect(pendingRotationOf(after)).toBeNull();
    expect(after.currentEpoch).toBe(1);
    expect(await rawKey(keys, 2)).toBe(staged);
  });

  it("stays pending when the relay took it but the key couldn't be saved, and saves it on the next settle", async () => {
    const memory = await keysWith();
    let saves = 0;
    const keys: KeyStore = {
      load: () => memory.load(),
      clear: () => memory.clear(),
      save: async (identity) => {
        saves += 1;
        // The staging save works; the save that makes the key current doesn't.
        if (saves === 2) throw new Error("keychain locked");
        await memory.save(identity);
      },
    };
    const state = relayWith([phoneA]);
    const relay = fakeClient(state);

    const outcome = await new KeyRotations(keys).rotate(relay.client, null);

    expect(outcome.outcome).toBe("unsaved");
    expect(state.epoch).toBe(2);
    expect(pendingRotationOf(await stored(memory))).toEqual({ epoch: 2, revoke: null });

    await expect(new KeyRotations(keys).settle(relay.client)).resolves.toMatchObject({
      outcome: "done",
    });
    expect(relay.rotateEpoch).toHaveBeenCalledOnce();
    expect((await stored(memory)).currentEpoch).toBe(2);
  });

  it("makes a pending key current when the relay's ledger confirms its epoch, and no other", async () => {
    const keys = await keysWith();
    const state = relayWith([phoneA]);
    const relay = fakeClient(state);
    relay.rotateEpoch.mockRejectedValueOnce(new RelayError("network_error", "offline", 0));
    const rotations = new KeyRotations(keys);
    await rotations.rotate(relay.client, null);

    await expect(rotations.confirm(3)).resolves.toBe(false);
    expect((await stored(keys)).currentEpoch).toBe(1);

    await expect(rotations.confirm(2)).resolves.toBe(true);
    const after = await stored(keys);
    expect(after.currentEpoch).toBe(2);
    expect(pendingRotationOf(after)).toBeNull();
  });

  it("settles a pending rotation before an approval reads which key is current", async () => {
    const keys = await keysWith();
    const state = relayWith([phoneA]);
    const relay = fakeClient(state);
    relay.rotateEpoch.mockImplementationOnce(async (epoch: number, grants: EpochGrant[]) => {
      commit(state, null, epoch, grants);
      throw new RelayError("network_error", "lost", 0);
    });
    const rotations = new KeyRotations(keys);
    await rotations.rotate(relay.client, null);

    const seen = await rotations.withCurrentKeys(
      relay.client,
      async () => (relay.client.identity as { currentEpoch: number }).currentEpoch
    );

    expect(seen).toBe(2);
  });

  it("runs one change at a time, in the order asked", async () => {
    const keys = await keysWith();
    const state = relayWith([phoneA, phoneB]);
    const relay = fakeClient(state);
    const rotations = new KeyRotations(keys);

    const [first, second] = await Promise.all([
      rotations.rotate(relay.client, null),
      rotations.rotate(relay.client, phoneA.id),
    ]);

    expect(first).toMatchObject({ outcome: "done", epoch: 2 });
    expect(second).toMatchObject({ outcome: "done", epoch: 3, revoked: phoneA.id });
    const after = await stored(keys);
    expect(after.currentEpoch).toBe(3);
    expect(after.epochs.map((entry) => entry.epoch).sort()).toEqual([1, 2, 3]);
  });

  it("refuses work queued after close, and lets what is running finish", async () => {
    const keys = await keysWith();
    const state = relayWith([phoneA]);
    const relay = fakeClient(state);
    const rotations = new KeyRotations(keys);
    let release!: () => void;
    let reading!: () => void;
    const read = new Promise<void>((resolve) => (reading = resolve));
    relay.devices.mockImplementationOnce(async () => {
      reading();
      await new Promise<void>((resolve) => (release = resolve));
      return list(state);
    });

    const running = rotations.rotate(relay.client, null);
    const queued = rotations.rotate(relay.client, null);
    await read;
    const closed = rotations.close();
    release();

    await expect(running).resolves.toMatchObject({ outcome: "done" });
    await expect(queued).rejects.toBeInstanceOf(KeyRotationsClosedError);
    await closed;
    expect(state.epoch).toBe(2);
  });

  it("ignores a pending record that names no staged key", async () => {
    const identity = await importIdentity(ownerStored);
    const damaged = {
      ...identity.stored,
      daintreePendingRotation: { epoch: 2, revoke: null },
    } as StoredIdentity;

    expect(pendingRotationOf(damaged)).toBeNull();
    expect(
      pendingRotationOf({ ...damaged, epochs: [...damaged.epochs, { epoch: 2, raw: "x" }] })
    ).toEqual({ epoch: 2, revoke: null });
  });
});

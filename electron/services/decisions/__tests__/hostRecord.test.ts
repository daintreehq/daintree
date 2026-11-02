import { describe, expect, it, vi } from "vitest";

vi.mock("../../../store.js", () => ({ store: { get: () => undefined, set: () => {} } }));
import {
  hostLifetimeSettings,
  hostRecordServes,
  hostRuntimeOf,
  readHostRecord,
  sanitizeHostRecord,
  writeHostRecord,
} from "../hostRecord.js";
import { ownerStateOf } from "../../../remote/decisions/clientInstall.js";

const RECORD = {
  relayOrigin: "https://relay.example.com",
  installationId: "inst_12345678",
  deviceId: "dev_host_0001",
  ownerDeviceId: "dev_owner_0001",
  hostId: "host_studio_01",
  ownerOffAt: null,
  revokedAt: null,
  credentialsRemovedAt: null,
};

function memoryStore(initial?: unknown) {
  let value = initial;
  return {
    get: () => value,
    set: (_key: "decisionsHost", next: unknown) => {
      value = next;
    },
    value: () => value,
  };
}

describe("an enrolled Host's record (#16022)", () => {
  it("reads only a whole record, and drops what nobody declared", () => {
    expect(sanitizeHostRecord({ ...RECORD, secret: "x" })).toEqual(RECORD);
    expect(sanitizeHostRecord({ ...RECORD, deviceId: "short" })).toBeNull();
    expect(sanitizeHostRecord({ ...RECORD, relayOrigin: "ftp://relay" })).toBeNull();
    expect(sanitizeHostRecord(null)).toBeNull();
    expect(sanitizeHostRecord([RECORD])).toBeNull();
  });

  it("keeps a removal only beside the revocation it followed", () => {
    expect(sanitizeHostRecord({ ...RECORD, credentialsRemovedAt: 9 })?.credentialsRemovedAt).toBe(
      null
    );
    expect(
      sanitizeHostRecord({ ...RECORD, revokedAt: 5, credentialsRemovedAt: 9 })
    ).toMatchObject({ revokedAt: 5, credentialsRemovedAt: 9 });
  });

  it("writes its sanitised form, and refuses one that isn't whole", () => {
    const store = memoryStore();
    writeHostRecord(store, { ...RECORD, relayOrigin: "https://relay.example.com/" });
    expect(readHostRecord(store)).toEqual(RECORD);
    expect(() => writeHostRecord(store, { ...RECORD, hostId: "" })).toThrow();
    expect(store.value()).toEqual(RECORD);
  });

  it("serves only while neither its owner turned it off nor the relay revoked it", () => {
    expect(hostRecordServes(RECORD)).toBe(true);
    expect(hostRecordServes({ ...RECORD, ownerOffAt: 1 })).toBe(false);
    expect(hostRecordServes({ ...RECORD, revokedAt: 1 })).toBe(false);
    expect(hostRecordServes(null)).toBe(false);
  });

  it("runs with its own relay identity and host id, and none of the owner's preferences", () => {
    expect(hostLifetimeSettings({ ...RECORD, ownerOffAt: 3 })).toMatchObject({
      enabled: true,
      relayOrigin: RECORD.relayOrigin,
      installationId: RECORD.installationId,
      deviceId: RECORD.deviceId,
      hostId: RECORD.hostId,
      proxyAllowlisted: false,
      revokedAt: null,
    });
    expect(hostLifetimeSettings({ ...RECORD, revokedAt: 4 }).revokedAt).toBe(4);
  });

  it("reports what it saw: stopped by its owner or the relay first, then its connection", () => {
    expect(hostRuntimeOf(null, null)).toEqual({ state: "not-enrolled" });
    expect(hostRuntimeOf({ ...RECORD, ownerOffAt: 7 }, { state: "connected" })).toEqual({
      state: "owner-off",
      deviceId: RECORD.deviceId,
      since: 7,
    });
    expect(
      hostRuntimeOf({ ...RECORD, revokedAt: 8, credentialsRemovedAt: 9 }, { state: "off" })
    ).toEqual({ state: "revoked", deviceId: RECORD.deviceId, since: 8, credentialsRemoved: true });
    expect(
      hostRuntimeOf(RECORD, { state: "reconnecting", nextAttemptAt: 40, relayOrigin: "x" })
    ).toEqual({
      state: "running",
      deviceId: RECORD.deviceId,
      connection: "reconnecting",
      nextAttemptAt: 40,
    });
    expect(hostRuntimeOf(RECORD, null)).toMatchObject({ connection: "not-connected" });
  });
});

describe("what a Shell tells its Hosts of its Decisions (#16022)", () => {
  it("speaks only as an owner identity, on or off as the switch is saved", () => {
    expect(ownerStateOf(undefined)).toBeNull();
    expect(ownerStateOf({ enabled: true })).toBeNull();
    expect(
      ownerStateOf({
        enabled: true,
        relayOrigin: "https://relay.example.com",
        installationId: "inst_12345678",
        deviceId: "dev_owner_0001",
      })
    ).toEqual({ installationId: "inst_12345678", ownerDeviceId: "dev_owner_0001", enabled: true });
    expect(
      ownerStateOf({
        enabled: false,
        relayOrigin: "https://relay.example.com",
        installationId: "inst_12345678",
        deviceId: "dev_owner_0001",
      })?.enabled
    ).toBe(false);
    // A damaged relay field turns the switch off, as every reader of the setting sees it.
    expect(
      ownerStateOf({
        enabled: true,
        relayOrigin: 42,
        installationId: "inst_12345678",
        deviceId: "dev_owner_0001",
      })?.enabled
    ).toBe(false);
  });
});

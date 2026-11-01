import type Store from "electron-store";
import { describe, expect, it } from "vitest";
import {
  defaultDecisionsSettings,
  normalizeRelayOrigin,
  readDecisionsSettings,
  sanitizeDecisionsSettings,
  writeDecisionsSettings,
  type DecisionsStore,
} from "../decisionsSettings.js";
import type { StoreSchema } from "../../../store.js";
import type { DecisionsSettings } from "../../../../shared/types/decisions.js";

// The app's settings store is what callers hand these helpers.
const appStoreFits: Store<StoreSchema> extends DecisionsStore ? true : never = true;
void appStoreFits;

const connected: DecisionsSettings = {
  enabled: true,
  relayOrigin: "https://decisions.example.workers.dev",
  installationId: "inst_01HZY3K9QW",
  deviceId: "dev-01HZY3K9QX",
  hostId: "host_01HZY3K9QY",
  proxyAllowlisted: true,
  consentedAt: 1_761_955_200_000,
  revokedAt: null,
};

function memoryStore(initial?: unknown) {
  let value = initial;
  const writes: unknown[] = [];
  const store: DecisionsStore = {
    get: () => value,
    set: (_key, next) => {
      writes.push(next);
      value = next;
    },
  };
  return { store, writes, current: () => value };
}

describe("sanitizeDecisionsSettings", () => {
  it("reads anything that isn't a settings object as off with no relay, without throwing", () => {
    for (const raw of [undefined, null, "on", 1, true, [], [{ enabled: true }], () => true]) {
      const settings = sanitizeDecisionsSettings(raw);
      expect(settings, String(raw)).toEqual(defaultDecisionsSettings());
      expect(settings.enabled).toBe(false);
    }
  });

  it("is on only for an exact true, and a proxy is allowed only for an exact true", () => {
    for (const flag of [false, "true", 1, {}, [true], null]) {
      const settings = sanitizeDecisionsSettings({
        ...connected,
        enabled: flag,
        proxyAllowlisted: flag,
      });
      expect(settings.enabled, String(flag)).toBe(false);
      expect(settings.proxyAllowlisted, String(flag)).toBe(false);
    }
    expect(sanitizeDecisionsSettings({ enabled: true }).enabled).toBe(true);
  });

  it("keeps a well-formed value whole, and a second pass changes nothing", () => {
    const once = sanitizeDecisionsSettings(connected);
    expect(once).toEqual(connected);
    expect(sanitizeDecisionsSettings(once)).toEqual(once);
  });

  it("reads a missing field as its default, so an older file needs no migration", () => {
    expect(sanitizeDecisionsSettings({ enabled: true })).toEqual({
      ...defaultDecisionsSettings(),
      enabled: true,
    });
    expect(sanitizeDecisionsSettings({})).toEqual(defaultDecisionsSettings());
  });

  it("drops a malformed id and turns Decisions off, keeping the other ids", () => {
    for (const bad of [
      "short",
      "x".repeat(65),
      "has space1",
      "dot.ted.id",
      "slash/id1",
      12345678,
    ]) {
      const settings = sanitizeDecisionsSettings({ ...connected, deviceId: bad });
      expect(settings, String(bad)).toEqual({ ...connected, enabled: false, deviceId: null });
    }
    for (const field of ["installationId", "deviceId", "hostId"] as const) {
      const settings = sanitizeDecisionsSettings({ ...connected, [field]: ["x".repeat(10)] });
      expect(settings, field).toEqual({ ...connected, enabled: false, [field]: null });
    }
    // Daintree's own host id is unique only per machine, so it never names a host here.
    expect(sanitizeDecisionsSettings({ ...connected, hostId: "local" })).toEqual({
      ...connected,
      enabled: false,
      hostId: null,
    });
  });

  it("takes ids at the protocol's length bounds", () => {
    for (const id of ["a".repeat(8), "Z".repeat(64), "a_b-C_d-9"]) {
      expect(sanitizeDecisionsSettings({ ...connected, deviceId: id }).deviceId, id).toBe(id);
    }
    expect(sanitizeDecisionsSettings({ ...connected, deviceId: "a".repeat(7) }).deviceId).toBe(
      null
    );
  });

  it("never carries a field it doesn't declare, a secret included", () => {
    const settings = sanitizeDecisionsSettings({
      ...connected,
      claimSecret: "claim-7f3a9c1e5b",
      keys: { signing: "priv-4d2e8a" },
      token: "tok-91bc2d",
      recoveryPassphrase: "correct horse battery",
    });
    expect(settings).toEqual(connected);
    const written = JSON.stringify(settings);
    for (const secret of ["claim-7f3a9c1e5b", "priv-4d2e8a", "tok-91bc2d", "correct horse"]) {
      expect(written).not.toContain(secret);
    }
  });

  it("turns Decisions off when the relay origin is there but unreadable", () => {
    for (const relayOrigin of ["not a url", "http://relay.example.com", 7, { href: "x" }]) {
      const settings = sanitizeDecisionsSettings({ ...connected, relayOrigin });
      expect(settings, String(relayOrigin)).toEqual({
        ...connected,
        enabled: false,
        relayOrigin: null,
      });
    }
  });

  it("keeps a revocation time with the relay's ids, and drops it without them or when malformed", () => {
    const revoked = sanitizeDecisionsSettings({ ...connected, revokedAt: 1_761_955_300_000 });
    expect(revoked).toEqual({ ...connected, revokedAt: 1_761_955_300_000 });

    for (const revokedAt of [0, -1, Number.NaN, "1761955300000", true, {}]) {
      const settings = sanitizeDecisionsSettings({ ...connected, revokedAt });
      expect(settings, String(revokedAt)).toEqual(connected);
    }
    for (const field of ["relayOrigin", "installationId", "deviceId"] as const) {
      const settings = sanitizeDecisionsSettings({
        ...connected,
        [field]: null,
        revokedAt: 1_761_955_300_000,
      });
      expect(settings.revokedAt, field).toBeNull();
    }
  });

  it("keeps a consent time only when it's a positive finite number, never turning off for one", () => {
    for (const consentedAt of [0, -1, Number.NaN, Infinity, "1761955200000", true, {}, null]) {
      const settings = sanitizeDecisionsSettings({ ...connected, consentedAt });
      expect(settings, String(consentedAt)).toEqual({ ...connected, consentedAt: null });
    }
  });

  it("keeps the switch on while no relay is set up yet", () => {
    const settings = sanitizeDecisionsSettings({
      enabled: true,
      relayOrigin: null,
      installationId: null,
      deviceId: null,
      hostId: null,
    });
    expect(settings).toEqual({ ...defaultDecisionsSettings(), enabled: true });
  });

  it("leaves what it was given untouched", () => {
    const raw = { ...connected, relayOrigin: "https://owner:pw@relay.example.com/x", extra: 1 };
    const before = structuredClone(raw);
    sanitizeDecisionsSettings(raw);
    expect(raw).toEqual(before);
  });
});

describe("readDecisionsSettings and writeDecisionsSettings", () => {
  it("reads an absent setting as off without writing anything", () => {
    const { store, writes } = memoryStore(undefined);
    expect(readDecisionsSettings(store)).toEqual(defaultDecisionsSettings());
    expect(readDecisionsSettings(memoryStore("garbage").store).enabled).toBe(false);
    expect(writes).toEqual([]);
  });

  it("reads a damaged setting sanitised, leaving the file as it was", () => {
    const onDisk = { ...connected, deviceId: "short", claimSecret: "claim-7f3a9c1e5b" };
    const { store, writes, current } = memoryStore(onDisk);
    expect(readDecisionsSettings(store)).toEqual({ ...connected, enabled: false, deviceId: null });
    expect(writes).toEqual([]);
    expect(current()).toBe(onDisk);
  });

  it("writes the whole setting in one set, sanitised, and returns what it stored", () => {
    const { store, writes, current } = memoryStore({
      ...connected,
      claimSecret: "claim-7f3a9c1e5b",
    });
    const next = {
      ...readDecisionsSettings(store),
      relayOrigin: "https://relay.example.com/setup?claim=claim-7f3a9c1e5b",
      token: "tok-91bc2d",
    } as DecisionsSettings;

    const stored = writeDecisionsSettings(store, next);

    expect(stored).toEqual({ ...connected, relayOrigin: "https://relay.example.com" });
    expect(writes).toEqual([stored]);
    expect(current()).toEqual(stored);
    expect(JSON.stringify(current())).not.toMatch(/claim-7f3a9c1e5b|tok-91bc2d/);
  });
});

describe("normalizeRelayOrigin", () => {
  it("reduces an https URL to its origin, dropping credentials, path and query", () => {
    expect(normalizeRelayOrigin("https://decisions.example.workers.dev")).toBe(
      "https://decisions.example.workers.dev"
    );
    expect(
      normalizeRelayOrigin("  https://owner:hunter2@relay.example.com:8443/api/v1?token=abc#x  ")
    ).toBe("https://relay.example.com:8443");
  });

  it("allows plain http only on loopback", () => {
    expect(normalizeRelayOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeRelayOrigin("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeRelayOrigin("http://relay.example.com")).toBeNull();
    expect(normalizeRelayOrigin("http://192.168.1.20:8787")).toBeNull();
    for (const other of ["ftp://localhost:8787", "wss://127.0.0.1:8787", "ws://localhost:8787"]) {
      expect(normalizeRelayOrigin(other), other).toBeNull();
      expect(sanitizeDecisionsSettings({ ...connected, relayOrigin: other }), other).toEqual({
        ...connected,
        enabled: false,
        relayOrigin: null,
      });
    }
  });

  it("refuses anything that isn't an http(s) URL", () => {
    for (const raw of [
      "",
      "relay.example.com",
      "ftp://relay.example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "wss://relay.example.com",
      42,
      null,
      { href: "https://relay.example.com" },
    ]) {
      expect(normalizeRelayOrigin(raw), String(raw)).toBeNull();
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  defaultDecisionsSettings,
  normalizeRelayOrigin,
  sanitizeDecisionsSettings,
} from "../decisionsSettings.js";
import type { DecisionsSettings } from "../../../../shared/types/decisions.js";

const connected: DecisionsSettings = {
  enabled: true,
  relayOrigin: "https://decisions.example.workers.dev",
  installationId: "inst_01HZY3K9QW",
  deviceId: "dev-01HZY3K9QX",
  hostId: "host_01HZY3K9QY",
};

describe("sanitizeDecisionsSettings", () => {
  it("reads anything that isn't a settings object as off with no relay, without throwing", () => {
    for (const raw of [undefined, null, "on", 1, true, [], [{ enabled: true }], () => true]) {
      const settings = sanitizeDecisionsSettings(raw);
      expect(settings, String(raw)).toEqual(defaultDecisionsSettings());
      expect(settings.enabled).toBe(false);
    }
  });

  it("is on only for an exact true", () => {
    for (const enabled of ["true", 1, {}, [true], null]) {
      expect(sanitizeDecisionsSettings({ ...connected, enabled }).enabled, String(enabled)).toBe(
        false
      );
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

  it("drops each malformed id on its own and leaves the rest", () => {
    for (const bad of ["short", "x".repeat(65), "has space1", "dot.ted.id", "slash/id1", 12345678]) {
      const settings = sanitizeDecisionsSettings({ ...connected, deviceId: bad });
      expect(settings, String(bad)).toEqual({ ...connected, deviceId: null });
    }
    expect(sanitizeDecisionsSettings({ ...connected, installationId: {} }).installationId).toBe(
      null
    );
    expect(sanitizeDecisionsSettings({ ...connected, hostId: ["host_01HZY3K9QY"] }).hostId).toBe(
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

  it("keeps the switch when the relay is unreadable, since it can be on before a relay is entered", () => {
    const settings = sanitizeDecisionsSettings({ ...connected, relayOrigin: "not a url" });
    expect(settings).toEqual({ ...connected, relayOrigin: null });
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

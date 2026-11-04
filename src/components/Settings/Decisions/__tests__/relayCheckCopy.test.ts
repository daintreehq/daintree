import { describe, expect, it } from "vitest";
import type { DecisionsRelayCompatibility, DecisionsRelayVersions } from "@shared/types/decisions";
import {
  describeCompatibility,
  describeRelayCheck,
  protocolRange,
  relayIsBehind,
  relayNeedsUpdate,
} from "../relayCheckCopy";

const DAINTREE: DecisionsRelayVersions = { protocolMin: 1, protocolMax: 2, workerVersion: "0.3.0" };

function compare(relay: Partial<DecisionsRelayVersions>): DecisionsRelayCompatibility {
  const merged = { ...DAINTREE, ...relay };
  return {
    relay: merged,
    daintree: DAINTREE,
    diverges:
      merged.workerVersion !== DAINTREE.workerVersion ||
      merged.protocolMin !== DAINTREE.protocolMin ||
      merged.protocolMax !== DAINTREE.protocolMax,
  };
}

describe("relay check copy", () => {
  it("prompts for whichever side is behind", () => {
    expect(describeCompatibility(compare({ workerVersion: "0.10.0" }))).toMatchObject({
      label: "The relay is newer than Daintree",
      detail: expect.stringContaining("Update Daintree"),
    });

    const older = describeCompatibility(compare({ workerVersion: "0.2.9" }));
    expect(older.label).toBe("The relay is an older release");
    expect(older.detail).not.toMatch(/never updates/);
  });

  // A 0.3.0 relay under Daintree's 0.4.0 libraries (#16229): both speak protocol 1.
  it("says an older relay on the same protocol still asks and answers, and doesn't press its update", () => {
    const daintree = { protocolMin: 1, protocolMax: 1, workerVersion: "0.4.0" };
    const compatibility = {
      relay: { ...daintree, workerVersion: "0.3.0" },
      daintree,
      diverges: true,
    };

    expect(describeCompatibility(compatibility, "offered")).toEqual({
      severity: "info",
      label: "The relay is an older release",
      detail:
        "The relay runs 0.3.0, protocol 1. Daintree expects 0.4.0, protocol 1. Both speak protocol 1, so questions and answers work. Update relay looks for a newer release that works with this Daintree and asks before changing anything.",
    });
    expect(relayIsBehind(compatibility)).toBe(true);
    expect(relayNeedsUpdate(compatibility)).toBe(false);
  });

  it("warns, and presses the update, only when the versions share no protocol", () => {
    const daintree = { protocolMin: 2, protocolMax: 3, workerVersion: "0.5.0" };
    const older = { relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.4.0" }, daintree };
    const newer = { relay: { protocolMin: 4, protocolMax: 4, workerVersion: "0.6.0" }, daintree };

    expect(describeCompatibility({ ...older, diverges: true })).toMatchObject({
      severity: "warning",
      label: "The relay needs an update",
    });
    expect(relayNeedsUpdate({ ...older, diverges: true })).toBe(true);
    expect(describeCompatibility({ ...newer, diverges: true }).severity).toBe("warning");
    expect(relayNeedsUpdate({ ...newer, diverges: true })).toBe(false);
    expect(describeCompatibility(compare({ workerVersion: "0.10.0" })).severity).toBe("info");
    expect(describeCompatibility(compare({ workerVersion: "dev" })).severity).toBe("info");
  });

  it.each([
    ["offered", /Update relay/],
    ["host", /on the Host/],
    ["cli", /decisions update/],
  ] as const)("points an older relay's update at where it comes from: %s", (route, where) => {
    const older = describeCompatibility(compare({ workerVersion: "0.2.9" }), route);
    const unordered = describeCompatibility(compare({ workerVersion: "dev" }), route);

    expect(older.detail).toMatch(where);
    expect(unordered.detail).toMatch(where);
    expect(unordered.detail).toContain("Update Daintree");
  });

  it("names the relay as behind only when updating it is what would close the gap", () => {
    expect(relayIsBehind(compare({ workerVersion: "0.2.9" }))).toBe(true);
    expect(relayIsBehind(compare({ workerVersion: "dev", protocolMax: 1 }))).toBe(true);
    expect(relayIsBehind(compare({ workerVersion: "0.10.0" }))).toBe(false);
    expect(relayIsBehind(compare({ workerVersion: "dev" }))).toBe(false);
    expect(relayIsBehind(compare({}))).toBe(false);
  });

  it.each([
    ["a major release ahead", "1.0.0", "The relay is newer than Daintree"],
    ["a patch ahead", "0.3.1", "The relay is newer than Daintree"],
    ["a patch behind, with a higher protocol", "0.2.9", "The relay is an older release"],
    ["a prerelease of the same release", "0.3.0-rc.1", "The relay is an older release"],
  ])("orders a relay %s by release", (_label, workerVersion, label) => {
    const protocolMax = workerVersion === "0.2.9" ? 3 : DAINTREE.protocolMax;

    expect(describeCompatibility(compare({ workerVersion, protocolMax })).label).toBe(label);
  });

  it("falls back to the protocol range, then to no side, when versions can't be ordered", () => {
    expect(describeCompatibility(compare({ workerVersion: "dev", protocolMax: 3 })).label).toBe(
      "The relay is newer than Daintree"
    );
    expect(describeCompatibility(compare({ workerVersion: "dev", protocolMax: 1 })).label).toBe(
      "The relay is an older release"
    );
    expect(describeCompatibility(compare({ workerVersion: "dev" })).label).toBe(
      "Relay and Daintree versions differ"
    );
  });

  it("names a matching pair without a prompt", () => {
    const same = describeCompatibility(compare({}));

    expect(same.label).toBe("Relay and Daintree versions match");
    expect(same.detail).toBe("Both on 0.3.0, protocols 1–2");
  });

  it("reads a one-version range as a single protocol", () => {
    expect(protocolRange({ protocolMin: 1, protocolMax: 1, workerVersion: "x" })).toBe(
      "protocol 1"
    );
    expect(protocolRange(DAINTREE)).toBe("protocols 1–2");
  });

  it("says which read failed when it was the second", () => {
    expect(
      describeRelayCheck({
        result: "http-error",
        origin: "https://relay.example.com:8443",
        endpoint: "info",
        status: 503,
      })
    ).toMatchObject({
      label: "relay.example.com:8443 answered with an error",
      detail: expect.stringMatching(/^\/api\/v1\/info answered HTTP 503\./),
    });
    expect(
      describeRelayCheck({
        result: "unreachable",
        origin: "https://relay.example.com",
        endpoint: "info",
        reason: "timeout",
      })?.detail
    ).toBe("/health answered, but /api/v1/info didn't answer in time");
  });

  it("names the first read when it was the one that failed", () => {
    expect(
      describeRelayCheck({
        result: "http-error",
        origin: "https://relay.example.com",
        endpoint: "health",
        status: 500,
      })?.detail
    ).toMatch(/^\/health answered HTTP 500\./);
    expect(
      describeRelayCheck({
        result: "unreachable",
        origin: "https://relay.example.com",
        endpoint: "info",
        reason: "refused",
      })?.detail
    ).toBe("/health answered, but the connection failed reading /api/v1/info");
  });

  it("leaves an address that was never sent to the field", () => {
    expect(describeRelayCheck({ result: "invalid-url", reason: "credentials" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { DecisionsRelayCompatibility, DecisionsRelayVersions } from "@shared/types/decisions";
import { describeCompatibility, describeRelayCheck, protocolRange } from "../relayCheckCopy";

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
  it("prompts for whichever side is behind, never claiming Daintree updates the relay", () => {
    expect(describeCompatibility(compare({ workerVersion: "0.10.0" }))).toMatchObject({
      label: "The relay is newer than Daintree",
      detail: expect.stringContaining("Update Daintree"),
    });

    const older = describeCompatibility(compare({ workerVersion: "0.2.9" }));
    expect(older.label).toBe("The relay needs an update");
    expect(older.detail).toContain("Daintree never updates it for you");
  });

  it.each([
    ["a major release ahead", "1.0.0", "The relay is newer than Daintree"],
    ["a patch ahead", "0.3.1", "The relay is newer than Daintree"],
    ["a patch behind, with a higher protocol", "0.2.9", "The relay needs an update"],
    ["a prerelease of the same release", "0.3.0-rc.1", "The relay needs an update"],
  ])("orders a relay %s by release", (_label, workerVersion, label) => {
    const protocolMax = workerVersion === "0.2.9" ? 3 : DAINTREE.protocolMax;

    expect(describeCompatibility(compare({ workerVersion, protocolMax })).label).toBe(label);
  });

  it("falls back to the protocol range, then to no side, when versions can't be ordered", () => {
    expect(describeCompatibility(compare({ workerVersion: "dev", protocolMax: 3 })).label).toBe(
      "The relay is newer than Daintree"
    );
    expect(describeCompatibility(compare({ workerVersion: "dev", protocolMax: 1 })).label).toBe(
      "The relay needs an update"
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

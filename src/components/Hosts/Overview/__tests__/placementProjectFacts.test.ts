import { describe, expect, it } from "vitest";
import { MAX_HOST_SUMMARY_DRIVERS, type HostDriverObservation } from "@shared/types/remoteHosts";
import type { ProjectHost } from "../../projectHosts";
import { describePlacementProjectFacts } from "../placementProjectFacts";
import { makeRow, makeSummary } from "./fixtures";

function driver(projectId: string, clientName: string): HostDriverObservation {
  return {
    projectId,
    projectName: projectId,
    state: "live",
    awayUntil: null,
    holder: {
      leaseId: 1,
      endpointId: "e",
      clientId: clientName,
      clientName,
      isHostLocal: false,
      acquiredAt: 0,
    },
  };
}

function hostFor(overrides: Partial<ProjectHost> = {}): ProjectHost {
  const row = makeRow();
  return {
    hostId: row.hostId,
    hostName: row.name,
    platform: "linux",
    isLocal: false,
    isCurrent: false,
    row,
    away: null,
    presence: "has",
    projectIds: ["p-remote"],
    entries: null,
    readFailed: false,
    ...overrides,
  };
}

describe("describePlacementProjectFacts", () => {
  it("reports a copy, the installed agents and who drives the project there", () => {
    const summary = makeSummary({
      agentClis: [{ agentId: "claude", version: "2.0.0" }],
      drivers: [driver("p-remote", "Greg's MacBook"), driver("other", "Elsewhere")],
    });
    const lines = describePlacementProjectFacts(hostFor(), makeRow({ summary }), summary);
    expect(lines).toEqual([
      "Has a copy of this project",
      "Agent CLIs: Claude 2.0.0",
      "Greg's MacBook has control",
    ]);
  });

  it("says a host without a copy would clone one, and skips drivers", () => {
    const summary = makeSummary({ agentClis: [], drivers: [] });
    const lines = describePlacementProjectFacts(
      hostFor({ presence: "none", projectIds: [] }),
      makeRow({ summary }),
      summary
    );
    expect(lines).toEqual(["No copy of this project, would clone it", "No agent CLIs reported"]);
  });

  it("reads a host that reports nothing as not reported, never as none", () => {
    const away = hostFor({ presence: "unknown", projectIds: [], away: "Not connected" });
    expect(describePlacementProjectFacts(away, makeRow({ summary: null }), null)).toEqual([
      "Copy of this project not reported",
      "Agent CLIs not reported",
    ]);
    const silentDrivers = makeSummary({ drivers: undefined });
    expect(
      describePlacementProjectFacts(hostFor(), makeRow({ summary: silentDrivers }), silentDrivers)
    ).toContain("Who has control not reported");
  });

  it("doesn't read a project missing from a capped drivers list as undriven", () => {
    const capped = makeSummary({
      drivers: Array.from({ length: MAX_HOST_SUMMARY_DRIVERS }, (_, i) => driver(`x${i}`, "A")),
    });
    expect(
      describePlacementProjectFacts(hostFor(), makeRow({ summary: capped }), capped)
    ).toContain("Who has control not reported");
    const full = makeSummary({ drivers: [] });
    expect(describePlacementProjectFacts(hostFor(), makeRow({ summary: full }), full)).toContain(
      "Nobody has control"
    );
  });
});

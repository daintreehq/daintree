import { describe, expect, it } from "vitest";
import { MAX_HOST_SUMMARY_DRIVERS, type HostDriverObservation } from "@shared/types/remoteHosts";
import type { ProjectHost } from "../../projectHosts";
import { CHECKING, describePlacementProjectFacts } from "../placementProjectFacts";
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
    expect(describePlacementProjectFacts(hostFor(), makeRow({ summary }), summary)).toEqual({
      project: "Has a copy",
      agentClis: ["Claude 2.0.0"],
      control: "Greg's MacBook has control",
    });
  });

  it("says a host without a copy clones one first, and has no control to report", () => {
    const summary = makeSummary({ agentClis: [], drivers: [] });
    expect(
      describePlacementProjectFacts(
        hostFor({ presence: "none", projectIds: [] }),
        makeRow({ summary }),
        summary
      )
    ).toEqual({ project: "No copy yet, so it's cloned there first", agentClis: [], control: null });
  });

  it("reads a host that reports nothing as not reported, never as none", () => {
    const away = hostFor({ presence: "unknown", projectIds: [], away: "Not connected" });
    expect(describePlacementProjectFacts(away, makeRow({ summary: null }), null)).toEqual({
      project: "Not reported",
      agentClis: null,
      control: null,
    });
    const silentDrivers = makeSummary({ drivers: undefined });
    expect(
      describePlacementProjectFacts(hostFor(), makeRow({ summary: silentDrivers }), silentDrivers)
        .control
    ).toBe("Not reported");
  });

  it("says it is still checking while the host's answer is out", () => {
    const summary = makeSummary();
    const facts = describePlacementProjectFacts(
      hostFor({ presence: "pending", projectIds: [] }),
      makeRow({ summary }),
      summary
    );
    expect([facts.project, facts.control]).toEqual([CHECKING, CHECKING]);
  });

  it("doesn't read a project missing from a capped drivers list as undriven", () => {
    const capped = makeSummary({
      drivers: Array.from({ length: MAX_HOST_SUMMARY_DRIVERS }, (_, i) => driver(`x${i}`, "A")),
    });
    expect(
      describePlacementProjectFacts(hostFor(), makeRow({ summary: capped }), capped).control
    ).toBe("Not reported");
    const full = makeSummary({ drivers: [] });
    expect(describePlacementProjectFacts(hostFor(), makeRow({ summary: full }), full).control).toBe(
      "Nobody has control"
    );
  });
});

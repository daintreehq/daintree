import { describe, expect, it } from "vitest";
import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import type { HostMenuRow } from "../hostModel";
import type { ProjectHost } from "../projectHosts";
import { summarizeHostProject } from "../projectHostSummary";
import { askTooltip, hostRowLabel, hostRowStatus, hostRowTooltip } from "../projectHostLines";
import { HANDSHAKE, makeRow } from "../Overview/__tests__/fixtures";

const NOW = 10 * 3_600_000;

function projectHost(row: Partial<HostMenuRow> = {}, rest: Partial<ProjectHost> = {}): ProjectHost {
  const menuRow = makeRow(row);
  return {
    hostId: menuRow.hostId,
    hostName: menuRow.name,
    platform: menuRow.platform,
    isLocal: menuRow.isLocal,
    isCurrent: menuRow.isCurrent,
    row: menuRow,
    away: null,
    presence: "has",
    projectIds: ["p"],
    entries: null,
    ...rest,
  };
}

function entry(branch: string, overrides: Partial<HostWorktreeEntry> = {}): HostWorktreeEntry {
  return {
    hostId: "studio-01",
    projectId: "p",
    projectName: "daintree",
    worktreeId: `/w/${branch}`,
    name: branch,
    branch,
    path: `/w/${branch}`,
    isMainWorktree: false,
    modifiedCount: null,
    lastActivityAt: null,
    observed: null,
    runs: [],
    ...overrides,
  };
}

const entries = [
  entry("feature/a", {
    lastActivityAt: NOW - 4 * 60_000,
    modifiedCount: 3,
    runs: [
      { terminalId: "t1", band: "needs-you", agentState: "waiting" },
      { terminalId: "t2", band: "running", agentState: "working" },
    ],
  }),
  entry("develop", {
    lastActivityAt: NOW - 60 * 60_000,
    runs: [{ terminalId: "t3", band: "done", agentState: "completed" }],
  }),
];

describe("hostRowTooltip", () => {
  it("leads with the project there, then the machine, then what a click does", () => {
    const summary = summarizeHostProject(entries);
    expect(hostRowTooltip(projectHost(), summary, "Cmd", NOW)).toEqual([
      "studio-01",
      "Connected · 12 ms",
      "2 worktrees",
      "1 waiting, 1 working, 1 finished (observed)",
      "Latest worktree activity 4 minutes ago",
      "Host-wide: CPU 20% · memory normal",
      "Click to switch · Cmd-click for a new window",
    ]);
  });

  it("marks the window's own host and says a click stays put", () => {
    const host = projectHost({ isCurrent: true, isLocal: true, name: "This Mac" });
    const lines = hostRowTooltip(host, summarizeHostProject(entries), "Cmd", NOW);
    expect(lines[0]).toBe("This Mac · this window");
    // This machine has no link to describe.
    expect(lines[1]).toBe("2 worktrees");
    expect(lines.at(-1)).toBe("Showing in this window");
  });

  it("says a host has no copy, and that a click opens the project there", () => {
    const host = projectHost({}, { presence: "none", projectIds: [] });
    expect(hostRowStatus(host, null)).toEqual({ kind: "note", text: "Not added" });
    expect(hostRowTooltip(host, null, "Ctrl", NOW)).toEqual([
      "studio-01",
      "Connected · 12 ms",
      "No project here shares this repository",
      "Host-wide: CPU 20% · memory normal",
      "Click to open this project there · Ctrl-click for a new window",
    ]);
  });

  it("gives a disconnected host's last sighting and nothing it said while connected", () => {
    const host = projectHost(
      { connection: { status: "disconnected" }, lastSeenAt: NOW - 3 * 3_600_000 },
      { away: "Not connected" }
    );
    expect(hostRowLabel(host, null)).toBe("studio-01, not connected");
    expect(hostRowTooltip(host, summarizeHostProject(entries), "Cmd", NOW)).toEqual([
      "studio-01",
      "Not connected · last seen 3 hours ago",
      "Agents not shown while not connected",
      "Click to switch · Cmd-click for a new window",
    ]);
  });

  it("says when a host was last heard from once its link goes silent", () => {
    const host = projectHost(
      {
        connection: {
          status: "connected",
          rttMs: 12,
          handshake: HANDSHAKE,
          quietSince: NOW - 2 * 60_000,
        },
      },
      { away: "No reply" }
    );
    expect(hostRowTooltip(host, null, "Cmd", NOW)[1]).toBe("No reply · last heard 2 minutes ago");
  });
});

describe("askTooltip", () => {
  it("names the branch, what the host observed, and what the worktree reported", () => {
    const [ask] = summarizeHostProject(entries).asks;
    expect(askTooltip(ask!, projectHost(), "Cmd", NOW)).toEqual([
      "feature/a",
      "Waiting on studio-01 (observed)",
      "3 files changed · active 4 minutes ago",
      "Click to go to this agent · Cmd-click for a new window",
    ]);
  });
});

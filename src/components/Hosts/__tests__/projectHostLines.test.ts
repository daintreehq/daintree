import { describe, expect, it } from "vitest";
import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import type { HostMenuRow } from "../hostModel";
import type { ProjectHost } from "../projectHosts";
import { summarizeHostProject } from "../projectHostSummary";
import { hostRowLabel, hostRowStatus, hostRowTooltip } from "../projectHostLines";
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
  it("reads who, what is going on there, then what a click does", () => {
    const summary = summarizeHostProject(entries);
    expect(hostRowTooltip(projectHost(), summary, "Cmd", NOW)).toEqual({
      title: "studio-01",
      note: null,
      // A healthy link says nothing about itself, and the machine's own load is not this project's.
      lines: [
        "1 waiting · 1 working · 1 finished (observed)",
        "2 worktrees · active 4 minutes ago",
      ],
      hint: "Click to switch · Cmd-click: new window",
    });
  });

  it("marks the window's own host, where a click does nothing", () => {
    const host = projectHost({ isCurrent: true, isLocal: true, name: "This Mac" });
    const tooltip = hostRowTooltip(host, summarizeHostProject(entries), "Cmd", NOW);
    expect(tooltip.title).toBe("This Mac");
    expect(tooltip.note).toBe("This window");
    expect(tooltip.hint).toBeNull();
  });

  it("says a host has no copy, and that a click opens the project there", () => {
    const host = projectHost({}, { presence: "none", projectIds: [] });
    expect(hostRowStatus(host, null)).toEqual({ kind: "note", text: "Not added" });
    expect(hostRowTooltip(host, null, "Ctrl", NOW)).toEqual({
      title: "studio-01",
      note: null,
      lines: ["No project here shares this repository"],
      hint: "Click to open it there · Ctrl-click: new window",
    });
  });

  it("gives a disconnected host's last sighting and nothing it said while connected", () => {
    const host = projectHost(
      { connection: { status: "disconnected" }, lastSeenAt: NOW - 3 * 3_600_000 },
      { away: "Not connected" }
    );
    expect(hostRowLabel(host, null)).toBe("studio-01, not connected");
    expect(hostRowTooltip(host, summarizeHostProject(entries), "Cmd", NOW).lines).toEqual([
      "Not connected · last seen 3 hours ago",
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
    expect(hostRowTooltip(host, null, "Cmd", NOW).lines).toEqual([
      "No reply · last heard 2 minutes ago",
    ]);
  });

  it("says a host is being checked while its answer is out", () => {
    const host = projectHost({}, { presence: "pending", projectIds: [] });
    expect(hostRowStatus(host, null)).toEqual({ kind: "checking" });
    expect(hostRowLabel(host, null)).toBe("studio-01, checking");
    expect(hostRowTooltip(host, null, "Cmd", NOW).lines).toEqual(["Checking for this project…"]);
  });
});

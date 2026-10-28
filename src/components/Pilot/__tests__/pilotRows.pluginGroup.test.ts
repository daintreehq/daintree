import { describe, expect, it } from "vitest";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { PluginAttentionRow } from "@/lib/pluginPanelAttention";
import {
  buildPilotGroups,
  buildPilotPluginGroup,
  countPilotBands,
  filterPilotBands,
  filterPilotGroups,
  isPilotAgentRow,
  pilotRowId,
  type PilotGroupCore,
} from "../pilotRows";

const NOW = 1_700_000_000_000;

function pluginRow(overrides: Partial<PluginAttentionRow> = {}): PluginAttentionRow {
  return {
    panelId: "p1",
    pluginId: "acme",
    pluginName: "Acme Board",
    title: "Sync board",
    kind: "acme.board",
    worktreeId: "wt-1",
    band: "needs-you",
    shown: "waiting",
    reason: "Pick a branch",
    description: "Reported by Acme Board: Waiting — Pick a branch",
    revision: 3,
    ...overrides,
  };
}

function run(overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return { runId: "t1", workspaceId: "p1", spawnedAt: NOW - 60_000, cwd: "/repo", ...overrides };
}

describe("buildPilotPluginGroup (#13821)", () => {
  it("is absent when no plugin panel is reporting", () => {
    expect(buildPilotPluginGroup([], "daintree")).toBeNull();
  });

  it("files plugin rows in their own group, attributed and with no clock", () => {
    const group = buildPilotPluginGroup([pluginRow()], "daintree");
    expect(group).toMatchObject({
      axis: "plugin",
      name: "Plugin panels",
      parentName: "daintree",
      demandCount: 1,
      topBand: "needs-you",
    });
    const [row] = group!.rows;
    expect(row?.plugin.pluginName).toBe("Acme Board");
    expect(row?.statusLabel).toContain("Acme Board");
    expect(row).toMatchObject({ age: null, agePhrase: null, parkNote: null, canopyEvidence: null });
    expect(isPilotAgentRow(row!)).toBe(false);
  });

  it("gives a plugin row an id no run can collide with, even on the same panel", () => {
    const [agentGroup] = buildPilotGroups([run({ runId: "p1" })], {
      workspaces: new Map(),
      currentWorkspaceId: null,
      nowMs: NOW,
    });
    const pluginGroup = buildPilotPluginGroup([pluginRow({ panelId: "p1" })], null)!;
    expect(pilotRowId(agentGroup!.rows[0]!)).not.toBe(pilotRowId(pluginGroup.rows[0]!));
  });

  it("matches a query on the plugin's name and its reason", () => {
    const groups: PilotGroupCore[] = [
      buildPilotPluginGroup(
        [pluginRow(), pluginRow({ panelId: "p2", title: "Other", reason: null })],
        null
      )!,
    ];
    expect(filterPilotGroups(groups, "acme")[0]?.rows).toHaveLength(2);
    expect(filterPilotGroups(groups, "pick a branch")[0]?.rows).toHaveLength(1);
    expect(filterPilotGroups(groups, "zzz")).toEqual([]);
  });

  it("counts plugin rows in the segments they would reveal", () => {
    const groups: PilotGroupCore[] = [
      buildPilotPluginGroup(
        [
          pluginRow(),
          pluginRow({ panelId: "p2", band: "parked" }),
          pluginRow({ panelId: "p3", band: "review", shown: "unread" }),
        ],
        null
      )!,
    ];
    const counts = countPilotBands(groups);
    expect(counts).toMatchObject({ all: 3, "needs-you": 1, parked: 1, finished: 1 });
    expect(filterPilotBands(groups, "needs-you")[0]?.rows.map((row) => pilotRowId(row))).toEqual([
      "plugin-panel-p1",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { PluginPanelActivityReport } from "@shared/types/plugin";
import {
  derivePluginAttentionRows,
  isPluginAttentionUnread,
  isPluginAttentionWaiting,
  pluginAttentionBand,
  pluginAttentionByWorktree,
  type PluginAttentionInputs,
  type PluginAttentionPanel,
  type PluginAttentionShelf,
} from "../pluginPanelAttention";

const NOW = 1_700_000_000_000;

function panel(id: string, overrides: Partial<PluginAttentionPanel> = {}): PluginAttentionPanel {
  return {
    id,
    title: `Panel ${id}`,
    kind: "acme.board",
    location: "grid",
    worktreeId: "wt-1",
    ...overrides,
  };
}

function inputs(overrides: Partial<PluginAttentionInputs> = {}): PluginAttentionInputs {
  const panels = new Map([["p1", panel("p1")]]);
  return {
    activityByPanelId: { p1: { acme: { state: "waiting", reason: "Pick a branch", revision: 3 } } },
    seenRevisionByPanelId: {},
    panels,
    reporterFor: (panelId) => (panels.has(panelId) ? "acme" : null),
    grantedPluginIds: new Set(["acme"]),
    pluginName: (id) => (id === "acme" ? "Acme Board" : id),
    shelfByPanelId: {},
    worktreeIds: new Set(),
    nowMs: NOW,
    ...overrides,
  };
}

const report = (
  state: PluginPanelActivityReport["state"],
  revision = 1
): PluginPanelActivityReport => ({ state, revision });

describe("derivePluginAttentionRows", () => {
  it("builds an attributed row for a granted plugin's report on its own panel", () => {
    const [row] = derivePluginAttentionRows(inputs());
    expect(row).toMatchObject({
      panelId: "p1",
      pluginId: "acme",
      pluginName: "Acme Board",
      title: "Panel p1",
      worktreeId: "wt-1",
      band: "needs-you",
      shown: "waiting",
      reason: "Pick a branch",
      revision: 3,
    });
    expect(row?.description).toContain("Acme Board");
    expect(row?.description).toContain("Pick a branch");
  });

  it("shows nothing until the user switches the plugin on", () => {
    expect(derivePluginAttentionRows(inputs({ grantedPluginIds: new Set() }))).toEqual([]);
    expect(derivePluginAttentionRows(inputs({ grantedPluginIds: new Set(["other"]) }))).toEqual([]);
  });

  it("ignores a report from a plugin that is not the panel's reporter", () => {
    const rows = derivePluginAttentionRows(
      inputs({
        activityByPanelId: { p1: { intruder: report("waiting") } },
        grantedPluginIds: new Set(["acme", "intruder"]),
      })
    );
    expect(rows).toEqual([]);
  });

  it("drops reports for panels this view does not hold, or whose kind does not report", () => {
    expect(
      derivePluginAttentionRows(
        inputs({ activityByPanelId: { elsewhere: { acme: report("waiting") } } })
      )
    ).toEqual([]);
    expect(derivePluginAttentionRows(inputs({ reporterFor: () => null }))).toEqual([]);
  });

  it("keeps only panels a row can open: grid and dock, not dialog, background or trash", () => {
    for (const location of ["dialog", "background", "trash", "overlay"] as const) {
      const panels = new Map([["p1", panel("p1", { location })]]);
      expect(derivePluginAttentionRows(inputs({ panels })), location).toEqual([]);
    }
    const docked = new Map([["p1", panel("p1", { location: "dock" })]]);
    expect(derivePluginAttentionRows(inputs({ panels: docked }))).toHaveLength(1);
  });

  it("drops a panel left in a worktree the surface no longer knows, but not with an unknown set", () => {
    expect(derivePluginAttentionRows(inputs({ worktreeIds: new Set(["wt-2"]) }))).toEqual([]);
    expect(derivePluginAttentionRows(inputs({ worktreeIds: new Set(["wt-1"]) }))).toHaveLength(1);
    expect(derivePluginAttentionRows(inputs({ worktreeIds: new Set() }))).toHaveLength(1);
  });

  it("ranks worst band first, then by title", () => {
    const panels = new Map([
      ["a", panel("a", { title: "Zed" })],
      ["b", panel("b", { title: "Alpha" })],
      ["c", panel("c", { title: "Beta" })],
    ]);
    const rows = derivePluginAttentionRows(
      inputs({
        panels,
        reporterFor: () => "acme",
        activityByPanelId: {
          a: { acme: report("failed") },
          b: { acme: report("working") },
          c: { acme: report("waiting") },
        },
      })
    );
    expect(rows.map((row) => row.panelId)).toEqual(["a", "c", "b"]);
  });

  it("ignores a shelf held for a different plugin", () => {
    const shelf: PluginAttentionShelf = { kind: "parked", pluginId: "other", revision: 3, at: NOW };
    const [row] = derivePluginAttentionRows(inputs({ shelfByPanelId: { p1: shelf } }));
    expect(row?.band).toBe("needs-you");
  });
});

describe("pluginAttentionBand", () => {
  it("maps reports onto the agents' bands", () => {
    expect(pluginAttentionBand(report("waiting"), false, undefined, NOW)).toBe("needs-you");
    expect(pluginAttentionBand(report("failed"), false, undefined, NOW)).toBe("blocked");
    expect(pluginAttentionBand(report("working"), false, undefined, NOW)).toBe("running");
    expect(pluginAttentionBand(report("finished"), false, undefined, NOW)).toBe("review");
    expect(pluginAttentionBand(report("finished"), true, undefined, NOW)).toBe("done");
  });

  it("parks only the report that was parked: a new one from the plugin releases it", () => {
    const shelf: PluginAttentionShelf = { kind: "parked", pluginId: "acme", revision: 4, at: NOW };
    expect(pluginAttentionBand(report("waiting", 4), false, shelf, NOW)).toBe("parked");
    expect(pluginAttentionBand(report("waiting", 5), false, shelf, NOW)).toBe("needs-you");
  });

  it("snoozes until the wake time, whatever the plugin reports meanwhile", () => {
    const shelf: PluginAttentionShelf = {
      kind: "snoozed",
      pluginId: "acme",
      until: NOW + 1000,
      at: NOW,
    };
    expect(pluginAttentionBand(report("failed", 9), false, shelf, NOW)).toBe("snoozed");
    expect(pluginAttentionBand(report("failed", 9), false, shelf, NOW + 1000)).toBe("blocked");
  });
});

describe("plugin row predicates and worktree facts", () => {
  const rowsFor = (states: Record<string, PluginPanelActivityReport>, seen = {}) => {
    const panels = new Map(
      Object.keys(states).map((id, i) => [id, panel(id, { worktreeId: i === 0 ? "wt-1" : null })])
    );
    return derivePluginAttentionRows(
      inputs({
        panels,
        reporterFor: () => "acme",
        seenRevisionByPanelId: seen,
        activityByPanelId: Object.fromEntries(
          Object.entries(states).map(([id, r]) => [id, { acme: r }])
        ),
      })
    );
  };

  it("sorts rows into the Waiting and Unread pills by band", () => {
    const [waiting] = rowsFor({ a: report("waiting") });
    const [failed] = rowsFor({ a: report("failed") });
    const [unread] = rowsFor({ a: report("finished", 2) });
    const [seen] = rowsFor({ a: report("finished", 2) }, { a: 2 });
    expect(isPluginAttentionWaiting(waiting!)).toBe(true);
    expect(isPluginAttentionWaiting(failed!)).toBe(true);
    expect(isPluginAttentionUnread(unread!)).toBe(true);
    expect(isPluginAttentionUnread(seen!)).toBe(false);
    expect(isPluginAttentionWaiting(seen!)).toBe(false);
  });

  it("files facts under the panel's worktree and skips project-level panels", () => {
    const byWorktree = pluginAttentionByWorktree(
      rowsFor({ a: report("finished", 2), b: report("waiting") })
    );
    expect([...byWorktree.keys()]).toEqual(["wt-1"]);
    expect(byWorktree.get("wt-1")).toEqual({
      working: false,
      attention: false,
      finished: true,
      unseen: true,
    });
  });

  it("contributes nothing for a parked or snoozed row", () => {
    const panels = new Map([["a", panel("a")]]);
    const rows = derivePluginAttentionRows(
      inputs({
        panels,
        reporterFor: () => "acme",
        activityByPanelId: { a: { acme: report("waiting", 7) } },
        shelfByPanelId: { a: { kind: "parked", pluginId: "acme", revision: 7, at: NOW } },
      })
    );
    expect(rows[0]?.band).toBe("parked");
    expect(pluginAttentionByWorktree(rows).size).toBe(0);
  });
});

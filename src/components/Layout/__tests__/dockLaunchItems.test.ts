import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerPanelKind,
  unregisterPanelKind,
  panelKindIsDockable,
  getPanelKindIds,
  getPanelKindConfig,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";

const addPanelMock = vi.fn();
const runRecipeWithResultsMock = vi.fn();
const recordActionMruMock = vi.fn();
const actionDispatchMock = vi.fn();
const notifySpawnFailuresMock = vi.fn();
const notifyMock = vi.fn();
const logErrorMock = vi.fn();

// The real `@/registry` eagerly pulls in TerminalPane and the whole panel
// component tree. Re-derive the spawnable list straight from the (pure) shared
// config instead, so the partition assertions below still run against real
// registry data without that import cost.
vi.mock("@/registry", () => ({
  // Terminal is deliberately included even though the real selector filters it
  // out (showInPalette:false), so the dedup below is actually exercised — with
  // the real predicate the model could never see a second Terminal and the
  // dedup assertion would pass even if the production guard were deleted.
  getSpawnablePanelKinds: (): PanelKindConfig[] =>
    getPanelKindIds()
      .filter((id) => id !== "agent")
      .map((id) => getPanelKindConfig(id))
      .filter(
        (c): c is PanelKindConfig =>
          c !== undefined && (c.id === "terminal" || c.showInPalette !== false)
      ),
  subscribeToPanelKindDefinitions: () => () => {},
  getPanelKindDefinitionsSnapshot: () => 0,
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({ addPanel: addPanelMock, panelsById: { "panel-1": { location: "grid" } } }),
  },
}));

vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: { getState: () => ({ runRecipeWithResults: runRecipeWithResultsMock }) },
}));

vi.mock("@/store/actionMruStore", () => ({
  useActionMruStore: { getState: () => ({ recordActionMru: recordActionMruMock }) },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => actionDispatchMock(...args) },
}));

vi.mock("@/utils/recipeNotify", () => ({
  notifyRecipeSpawnFailures: (...args: unknown[]) => notifySpawnFailuresMock(...args),
}));

vi.mock("@/utils/logger", () => ({
  logError: (...args: unknown[]) => logErrorMock(...args),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  buildDockLaunchModel,
  activateDockLaunchItem,
  RECENCY_BAND_CAP,
  type DockLaunchAgent,
  type DockLaunchItem,
  type DockLaunchPanelItem,
} from "../dockLaunchItems";
import type { TerminalRecipe } from "@shared/types";
import { PANEL_LIMIT_ERROR_SUFFIX } from "@/services/actions/definitions/panelLimitError";

const AGENTS: DockLaunchAgent[] = [
  { id: "claude", name: "Claude", availability: "ready" },
  { id: "gemini", name: "Gemini", availability: "blocked" },
];

function recipe(over: Partial<TerminalRecipe> & { id: string; name: string }): TerminalRecipe {
  return { terminals: [], createdAt: 0, ...over } as TerminalRecipe;
}

function build(over: Partial<Parameters<typeof buildDockLaunchModel>[0]> = {}) {
  return buildDockLaunchModel({
    agents: AGENTS,
    activeWorktreeId: null,
    recipes: [],
    mruEntries: [],
    surface: "dock",
    ...over,
  });
}

const PANEL_LIMIT_MESSAGE = `Can't open another panel: ${PANEL_LIMIT_ERROR_SUFFIX}`;

const PLUGIN_DOCKABLE = "test-plugin-dockable";
const PLUGIN_GRID_ONLY = "test-plugin-grid-only";
const PLUGIN_HIDDEN = "test-plugin-hidden";

beforeEach(() => {
  addPanelMock.mockReset().mockResolvedValue("panel-1");
  runRecipeWithResultsMock.mockReset().mockResolvedValue({ spawned: [], failed: [] });
  recordActionMruMock.mockReset();
  actionDispatchMock.mockReset().mockResolvedValue({ ok: true, result: null });
  notifySpawnFailuresMock.mockReset();
  notifyMock.mockReset();
  logErrorMock.mockReset();
});

afterEach(() => {
  for (const id of [PLUGIN_DOCKABLE, PLUGIN_GRID_ONLY, PLUGIN_HIDDEN]) {
    unregisterPanelKind(id);
  }
});

function registerPluginKind(id: string, over: Partial<PanelKindConfig> = {}) {
  registerPanelKind({
    id,
    name: id,
    iconId: "package",
    color: "#fff",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: "test-plugin",
    ...over,
  });
}

describe("buildDockLaunchModel — panel offering", () => {
  it("labels every panel with the location addPanel will actually use", () => {
    // The whole point of the two sections: a heading may never contradict
    // `normalizeDockLocation`, which redirects a non-dockable kind to the grid.
    const model = build();
    for (const item of [...model.dockPanels, ...model.gridPanels]) {
      expect(item.location).toBe(panelKindIsDockable(item.kindId) ? "dock" : "grid");
    }
  });

  it("offers the spawnable set rather than filtering it by dockability", () => {
    const model = build();
    const offered = [...model.dockPanels, ...model.gridPanels].map((p) => p.kindId);
    // Non-dockable kinds are present — previously they were dropped entirely.
    expect(offered).toEqual(expect.arrayContaining(["review", "file-browser", "dev-preview"]));
    // ...and each landed in the grid group, not the dock group.
    const dockIds = model.dockPanels.map((p) => p.kindId);
    expect(dockIds).not.toEqual(expect.arrayContaining(["review", "file-browser", "dev-preview"]));
  });

  it("includes File Viewer in the dock group (dockable but previously unlisted)", () => {
    const model = build();
    expect(model.dockPanels.map((p) => p.kindId)).toContain("file");
  });

  it("always offers Terminal even though it opts out of the palette", () => {
    // `terminal` sets showInPalette:false (it has dedicated spawn actions), so
    // the spawnable selector excludes it and the launcher adds it back.
    expect(getPanelKindConfig("terminal")?.showInPalette).toBe(false);
    expect(build().dockPanels.map((p) => p.kindId)).toContain("terminal");
  });

  it("excludes kinds that need a target (showInPalette false), e.g. diff", () => {
    const model = build();
    const offered = [...model.dockPanels, ...model.gridPanels].map((p) => p.kindId);
    expect(offered).not.toContain("diff");
    expect(offered).not.toContain("agent");
  });

  it("lists a plugin kind in the section matching its own dockability", () => {
    registerPluginKind(PLUGIN_DOCKABLE);
    registerPluginKind(PLUGIN_GRID_ONLY, { dockable: false });
    const model = build();

    expect(model.dockPanels.map((p) => p.kindId)).toContain(PLUGIN_DOCKABLE);
    expect(model.gridPanels.map((p) => p.kindId)).toContain(PLUGIN_GRID_ONLY);
  });

  it("honours a plugin kind's showInPalette opt-out", () => {
    registerPluginKind(PLUGIN_HIDDEN, { showInPalette: false });
    const model = build();
    const offered = [...model.dockPanels, ...model.gridPanels].map((p) => p.kindId);
    expect(offered).not.toContain(PLUGIN_HIDDEN);
  });

  it("does not duplicate Terminal when the spawnable list also yields it", () => {
    const model = build();
    const terminalEntries = [...model.dockPanels, ...model.gridPanels].filter(
      (p) => p.kindId === "terminal"
    );
    expect(terminalEntries).toHaveLength(1);
  });

  it("claims no dock destination on a grid surface, even for dockable kinds", () => {
    // The grid context menu's launch callback dispatches location:"grid" for
    // every kind, so offering Terminal/Browser under a dock heading there would
    // misstate the destination exactly the way #11054 did.
    const model = build({ surface: "grid" });

    expect(model.dockPanels).toHaveLength(0);
    const offered = model.gridPanels.map((p) => p.kindId);
    expect(offered).toEqual(expect.arrayContaining(["terminal", "browser", "file"]));
    for (const item of model.gridPanels) {
      expect(item.location).toBe("grid");
    }
  });

  it("keeps the dock destination for dockable kinds on a dock surface", () => {
    const dock = build({ surface: "dock" });
    // Same kinds, opposite surface — proves the split is surface-driven and not
    // an artifact of the registry alone.
    expect(dock.dockPanels.map((p) => p.kindId)).toEqual(
      expect.arrayContaining(["terminal", "browser", "file"])
    );
  });
});

describe("buildDockLaunchModel — search set", () => {
  it("covers all three categories in one list", () => {
    const model = build({ recipes: [recipe({ id: "r1", name: "Deploy" })] });
    const categories = new Set(model.searchItems.map((i) => i.category));
    expect(categories).toEqual(new Set(["agent", "panel", "recipe"]));
  });

  it("keeps keys unique so an agent and a panel sharing an id cannot collide", () => {
    registerPluginKind("claude");
    const model = build();
    const keys = model.searchItems.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    unregisterPanelKind("claude");
  });

  it("does not repeat a recency-band agent in the search set", () => {
    const model = build({
      mruEntries: [{ id: "agent.claude", lastAccessedAt: 5000 }],
    });
    expect(model.recentAgents.map((a) => a.id)).toEqual(["claude"]);
    expect(model.searchItems.filter((i) => i.key === "agent:claude")).toHaveLength(1);
  });

  it("makes a panel findable by its destination", () => {
    const model = build();
    const review = model.searchItems.find(
      (i): i is DockLaunchPanelItem => i.category === "panel" && i.kindId === "review"
    );
    expect(review?.searchAliases).toContain("grid");
  });
});

describe("buildDockLaunchModel — bands and recipes", () => {
  it("caps the recency band and drops never-launched and unknown entries", () => {
    // Sized from the exported cap so raising it doesn't need the same edit here.
    const overCap = RECENCY_BAND_CAP + 1;
    const many: DockLaunchAgent[] = Array.from({ length: overCap }, (_, i) => ({
      id: `a${i}`,
      name: `Agent ${i}`,
    }));
    const model = build({
      agents: many,
      mruEntries: [
        // Interleaved noise that must all be dropped: an unknown agent, a
        // non-agent key, and a never-launched cold-start seed.
        { id: "agent.ghost", lastAccessedAt: 5 },
        { id: "recipe.thing", lastAccessedAt: 9 },
        { id: "agent.a0", lastAccessedAt: 0 },
        ...many.map((a, i) => ({ id: `agent.${a.id}`, lastAccessedAt: overCap - i })),
      ],
    });

    expect(model.recentAgents).toHaveLength(RECENCY_BAND_CAP);
    expect(model.recentAgents.map((a) => a.id)).toEqual(
      many.slice(0, RECENCY_BAND_CAP).map((a) => a.id)
    );
  });

  it("splits Pinned/Other only for a strict subset", () => {
    expect(build({ pinnedCount: 1 }).showAgentGroups).toBe(true);
    expect(build({ pinnedCount: 0 }).showAgentGroups).toBe(false);
    expect(build({ pinnedCount: AGENTS.length }).showAgentGroups).toBe(false);
    expect(build().showAgentGroups).toBe(false);
  });

  it("scopes recipes to the active worktree, keeping unscoped ones", () => {
    const model = build({
      activeWorktreeId: "wt-1",
      recipes: [
        recipe({ id: "g", name: "Global" }),
        recipe({ id: "mine", name: "Mine", worktreeId: "wt-1" }),
        recipe({ id: "theirs", name: "Theirs", worktreeId: "wt-2" }),
      ],
    });
    expect(model.recipes.map((r) => r.name)).toEqual(["Global", "Mine"]);
  });

  it("keeps a shadowed recipe listed and marked", () => {
    const model = build({
      recipes: [recipe({ id: "s", name: "Work", projectId: "p", shadowedBy: "Work" })],
    });
    expect(model.recipes[0]?.isShadowed).toBe(true);
  });
});

describe("buildDockLaunchModel — browse rows", () => {
  const mru = [{ id: "agent.claude", score: 1, lastAccessedAt: 1000 }];

  it("orders rows exactly as the launcher renders its bands", () => {
    const model = build({ mruEntries: mru, recipes: [recipe({ id: "r-1", name: "Deploy" })] });

    // The launcher navigates this array with a single selectedIndex, so a band
    // ordering that drifts from the render order would move the highlight to a
    // row the user isn't looking at.
    const bands: string[] = [];
    for (const row of model.browseRows) {
      if (bands[bands.length - 1] !== row.band) bands.push(row.band);
    }
    expect(bands).toEqual(["recent", "agents", "dock-panels", "grid-panels", "recipes"]);
  });

  it("keys a recency row apart from its twin in the agent group", () => {
    const model = build({ mruEntries: mru });

    const claudeRows = model.browseRows.filter((row) => row.item?.key === "agent:claude");
    expect(claudeRows).toHaveLength(2);
    expect(new Set(claudeRows.map((row) => row.rowKey)).size).toBe(2);
  });

  it("gives every row a unique key so selection can never light two at once", () => {
    const model = build({
      mruEntries: mru,
      pinnedCount: 1,
      recipes: [recipe({ id: "r-1", name: "Deploy" })],
    });

    const keys = model.browseRows.map((row) => row.rowKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("splits the agent bands the same way the Pinned/Other groups do", () => {
    const model = build({ pinnedCount: 1 });
    const bands = model.browseRows.filter((row) => row.item?.category === "agent");

    expect(bands.map((row) => row.band)).toEqual(["pinned", "other"]);
  });

  it("collapses the panel bands when every panel shares one destination", () => {
    const model = build({ surface: "grid" });
    const panelBands = new Set(
      model.browseRows.filter((row) => row.item?.category === "panel").map((row) => row.band)
    );
    expect([...panelBands]).toEqual(["panels"]);
  });

  it("carries the create-recipe cue as an item-less row when there are none", () => {
    const withNone = build();
    const cue = withNone.browseRows.filter((row) => row.item === undefined);
    expect(cue).toHaveLength(1);
    expect(cue[0]!.band).toBe("recipes");

    // With recipes present the cue is gone, so it can't be navigated to.
    const withSome = build({ recipes: [recipe({ id: "r-1", name: "Deploy" })] });
    expect(withSome.browseRows.every((row) => row.item !== undefined)).toBe(true);
  });
});

describe("activateDockLaunchItem", () => {
  const ctx = {
    cwd: "/repo",
    activeWorktreeId: "wt-1",
    recipeContext: undefined,
    onLaunchAgent: vi.fn(),
    source: "menu" as const,
  };

  beforeEach(() => ctx.onLaunchAgent.mockReset());

  function panelItem(kindId: string): DockLaunchPanelItem {
    const model = build();
    const found = [...model.dockPanels, ...model.gridPanels].find((p) => p.kindId === kindId);
    if (!found) throw new Error(`no panel item for ${kindId}`);
    return found;
  }

  it("activates a panel kind through its registered launch action, not onLaunchAgent", () => {
    for (const kind of ["terminal", "browser", "dev-preview", "file-browser"]) {
      activateDockLaunchItem(panelItem(kind), ctx);
    }
    // Each kind reaches the action its registry entry names, so the dock can't
    // drift from the toolbar or the palette (#11668).
    expect(actionDispatchMock.mock.calls.map((c) => c[0])).toEqual([
      getPanelKindConfig("terminal")!.launchActionId,
      getPanelKindConfig("browser")!.launchActionId,
      getPanelKindConfig("dev-preview")!.launchActionId,
      getPanelKindConfig("file-browser")!.launchActionId,
    ]);
    expect(ctx.onLaunchAgent).not.toHaveBeenCalled();
    expect(addPanelMock).not.toHaveBeenCalled();
  });

  it("tells the launch action where the menu heading promised the panel would land", () => {
    activateDockLaunchItem(panelItem("browser"), ctx);
    expect(actionDispatchMock).toHaveBeenCalledWith(
      getPanelKindConfig("browser")!.launchActionId,
      expect.objectContaining({
        agentId: "browser",
        location: "dock",
        cwd: "/repo",
        activateDockOnCreate: true,
      }),
      { source: "menu" }
    );
    // The launcher's ambient worktree is not a named target — the action
    // resolves its own, so a ghost selection still lands beside its terminals.
    expect(actionDispatchMock.mock.calls[0]![1]).not.toHaveProperty("worktreeId");
  });

  it("reports a refused launch, since the menu closes on select", async () => {
    actionDispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "No folder to browse" },
    });

    activateDockLaunchItem(panelItem("file-browser"), ctx);
    await vi.waitFor(() => expect(notifyMock).toHaveBeenCalled());

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        // `uiFeedback` is passive, so without an explicit high priority this
        // refusal would be an inbox row the closed menu never surfaces.
        priority: "high",
        action: expect.objectContaining({ label: "Retry" }),
      })
    );
  });

  it("stays quiet when addPanel already reported a full grid", async () => {
    actionDispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: PANEL_LIMIT_MESSAGE },
    });

    activateDockLaunchItem(panelItem("file-browser"), ctx);
    // Drain past the continuation rather than counting microtasks: the control
    // below proves an ordinary refusal does reach notify through this same
    // flush, so silence here is suppression and not a race.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifyMock).not.toHaveBeenCalled();

    actionDispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "No folder to browse" },
    });
    activateDockLaunchItem(panelItem("file-browser"), ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("creates every other kind via addPanel at its advertised location", () => {
    activateDockLaunchItem(panelItem("review"), ctx);
    expect(ctx.onLaunchAgent).not.toHaveBeenCalled();
    expect(addPanelMock).toHaveBeenCalledWith({
      kind: "review",
      cwd: "/repo",
      worktreeId: "wt-1",
      location: "grid",
      activateDockOnCreate: false,
    });
  });

  it("activates the dock atomically for a dock-landing panel (#6590)", () => {
    activateDockLaunchItem(panelItem("file"), ctx);
    expect(addPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "file", location: "dock", activateDockOnCreate: true })
    );
  });

  it("passes an absent worktree as undefined, not null", () => {
    activateDockLaunchItem(panelItem("review"), { ...ctx, activeWorktreeId: null });
    expect(addPanelMock).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: undefined }));
  });

  it("spawns a plugin kind through addPanel", () => {
    registerPluginKind(PLUGIN_GRID_ONLY, { dockable: false });
    activateDockLaunchItem(panelItem(PLUGIN_GRID_ONLY), ctx);
    expect(addPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: PLUGIN_GRID_ONLY, location: "grid" })
    );
  });

  it("records MRU and launches a launchable agent", () => {
    const item: DockLaunchItem = {
      category: "agent",
      key: "agent:claude",
      name: "Claude",
      agent: AGENTS[0]!,
    };
    activateDockLaunchItem(item, ctx);
    expect(recordActionMruMock).toHaveBeenCalledWith("agent.claude");
    expect(ctx.onLaunchAgent).toHaveBeenCalledWith("claude");
  });

  it("routes a non-launchable agent to settings without recording MRU", () => {
    const item: DockLaunchItem = {
      category: "agent",
      key: "agent:gemini",
      name: "Gemini",
      agent: AGENTS[1]!,
    };
    activateDockLaunchItem(item, ctx);
    expect(ctx.onLaunchAgent).not.toHaveBeenCalled();
    expect(recordActionMruMock).not.toHaveBeenCalled();
    expect(actionDispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents", subtab: "gemini" },
      { source: "menu" }
    );
  });

  it("runs a recipe and surfaces spawn failures", async () => {
    const results = { spawned: [], failed: [{ index: 0, error: "Panel limit reached" }] };
    runRecipeWithResultsMock.mockResolvedValue(results);
    const model = build({ recipes: [recipe({ id: "r1", name: "Deploy" })] });

    activateDockLaunchItem(model.recipes[0]!, ctx);

    expect(runRecipeWithResultsMock).toHaveBeenCalledWith("r1", "/repo", "wt-1", undefined);
    await vi.waitFor(() =>
      expect(notifySpawnFailuresMock).toHaveBeenCalledWith(results, { recipeName: "Deploy" })
    );
  });

  it("logs a rejected recipe launch without notifying", async () => {
    runRecipeWithResultsMock.mockRejectedValue(new Error("recipe gone"));
    const model = build({ recipes: [recipe({ id: "r1", name: "Deploy" })] });

    activateDockLaunchItem(model.recipes[0]!, ctx);

    await vi.waitFor(() =>
      expect(logErrorMock).toHaveBeenCalledWith("Recipe launch from dock failed", expect.any(Error))
    );
    expect(notifySpawnFailuresMock).not.toHaveBeenCalled();
  });
});

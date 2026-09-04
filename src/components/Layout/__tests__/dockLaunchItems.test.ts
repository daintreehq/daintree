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
  activateDockLaunchCue,
  activateDockLaunchItem,
  DOCK_LAUNCH_CUE_LABELS,
  buildPresetChoices,
  buildPresetRows,
  getDockLaunchRowItem,
  insertExpandedPresetRows,
  rowHasPresets,
  RECENCY_BAND_CAP,
  type DockLaunchAgent,
  type DockLaunchItem,
  type DockLaunchPanelItem,
  type DockLaunchRow,
} from "../dockLaunchItems";
import type { TerminalRecipe } from "@shared/types";
import { TOOLBAR_CUSTOMIZE_LABEL } from "../toolbarMenuStrings";
import { PANEL_LIMIT_ERROR_SUFFIX } from "@/services/actions/definitions/panelLimitError";

const AGENTS: DockLaunchAgent[] = [
  { id: "claude", name: "Claude", availability: "ready" },
  { id: "gemini", name: "Gemini", availability: "blocked" },
];

/** Two agents that can both actually launch, for the Pinned/Other split. */
const LAUNCHABLE_AGENTS: DockLaunchAgent[] = [
  { id: "claude", name: "Claude", availability: "ready" },
  { id: "codex", name: "Codex", availability: "ready" },
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
    // ...and each non-dockable one landed in the grid group, not the dock group.
    const dockIds = model.dockPanels.map((p) => p.kindId);
    expect(dockIds).not.toEqual(expect.arrayContaining(["review", "dev-preview"]));
  });

  it("includes File Browser in the dock group now that it is dockable (#11917)", () => {
    // The heading is a promise about placement, so the kind that just gained
    // `dockable` has to move sections with it.
    const model = build();
    expect(model.dockPanels.map((p) => p.kindId)).toContain("file-browser");
    expect(model.gridPanels.map((p) => p.kindId)).not.toContain("file-browser");
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
      // Recency is drawn from launchable agents only — an agent that needs
      // setup has no business in a quick-reach band.
      availability: "ready",
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
    // Counted against the LAUNCHABLE agents, not every agent offered: a setup
    // row sits in its own band, so including it would split the group one row
    // early and leave "Other" describing nothing.
    const two = { agents: LAUNCHABLE_AGENTS };
    expect(build({ ...two, pinnedCount: 1 }).showAgentGroups).toBe(true);
    expect(build({ ...two, pinnedCount: 0 }).showAgentGroups).toBe(false);
    expect(build({ ...two, pinnedCount: LAUNCHABLE_AGENTS.length }).showAgentGroups).toBe(false);
    expect(build(two).showAgentGroups).toBe(false);

    // One launchable agent and one that needs setup: a pinnedCount of 1 covers
    // the whole launchable group, so there is nothing to split.
    expect(build({ pinnedCount: 1 }).showAgentGroups).toBe(false);
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
    expect(bands).toEqual([
      "recent",
      "agents",
      "dock-panels",
      "grid-panels",
      "recipes",
      "needs-setup",
      "actions",
    ]);
  });

  it("keys a recency row apart from its twin in the agent group", () => {
    const model = build({ mruEntries: mru });

    const claudeRows = model.browseRows.filter(
      (row) => getDockLaunchRowItem(row)?.key === "agent:claude"
    );
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
    const model = build({ agents: LAUNCHABLE_AGENTS, pinnedCount: 1 });
    const bands = model.browseRows.filter((row) => getDockLaunchRowItem(row)?.category === "agent");

    expect(bands.map((row) => row.band)).toEqual(["pinned", "other"]);
  });

  it("bands panels by destination even when every panel shares one", () => {
    // The generic "Launch panel" band used to be the single-destination
    // fallback, which left every row to say where it lands — six rows ending in
    // the word "Grid" under a heading that could have said it once. The heading
    // is now always the one that names the destination, so no row has to.
    const gridOnly = build({ surface: "grid" });
    const bandsOf = (model: ReturnType<typeof build>) => [
      ...new Set(
        model.browseRows
          .filter((row) => getDockLaunchRowItem(row)?.category === "panel")
          .map((row) => row.band)
      ),
    ];

    expect(bandsOf(gridOnly)).toEqual(["grid-panels"]);
    // And the split case is unchanged: two destinations, two bands.
    expect(bandsOf(build({ surface: "dock" }))).toEqual(["dock-panels", "grid-panels"]);
  });

  it("carries the create-recipe cue as an item-less row when there are none", () => {
    const createRecipeRows = (model: ReturnType<typeof build>) =>
      model.browseRows.filter((row) => row.kind === "cue" && row.cue === "create-recipe");

    const withNone = build();
    expect(createRecipeRows(withNone)).toHaveLength(1);
    expect(createRecipeRows(withNone)[0]!.band).toBe("recipes");

    // With recipes present the cue is gone, so it can't be navigated to.
    const withSome = build({ recipes: [recipe({ id: "r-1", name: "Deploy" })] });
    expect(createRecipeRows(withSome)).toEqual([]);
  });

  it("footers the More band with Manage agents and then Customize toolbar", () => {
    const actionCues = build().browseRows.filter((row) => row.band === "actions");

    // Both rows unconditionally: unlike the recipe and setup cues, neither
    // depends on inventory. Order is the assertion — Manage agents has held
    // this footer alone, and moving it would relocate a row under the cursor.
    expect(actionCues.map((row) => (row.kind === "cue" ? row.cue : row.kind))).toEqual([
      "manage-agents",
      "customize-toolbar",
    ]);
    expect(new Set(actionCues.map((row) => row.rowKey)).size).toBe(2);
  });

  it("labels the toolbar cue with the plugin tray's own wording", () => {
    // The issue asks for one string, not a second that agrees today: the launcher
    // and the tray point at the same settings page, so a copy edit to either has
    // to move both.
    expect(DOCK_LAUNCH_CUE_LABELS["customize-toolbar"]).toBe(TOOLBAR_CUSTOMIZE_LABEL);
  });
});

describe("activateDockLaunchCue", () => {
  it("sends each settings cue to its own tab", () => {
    activateDockLaunchCue("customize-toolbar", "wt-1", "menu");
    expect(actionDispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "toolbar" },
      { source: "menu" }
    );

    // Pinned alongside it because routing used to end in an unconditional
    // dispatch to `agents`: the two destinations are one edit away from being
    // swapped, and either swap is silent.
    actionDispatchMock.mockClear();
    activateDockLaunchCue("manage-agents", "wt-1", "menu");
    expect(actionDispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents" },
      { source: "menu" }
    );
  });
});

describe("buildDockLaunchModel — agent bands", () => {
  it("keeps a launchable agent out of the setup bands and vice versa", () => {
    const model = build();
    const bandOf = (id: string) =>
      model.browseRows.find((row) => getDockLaunchRowItem(row)?.key === `agent:${id}`)?.band;

    // `gemini` is blocked in the fixture, so it must not be offered as a launch.
    expect(bandOf("claude")).toBe("agents");
    expect(bandOf("gemini")).toBe("needs-setup");
  });

  it("offers every agent for setup and adds the wizard cue in fallback mode", () => {
    const model = build({ agentInventoryState: "fallback" });
    const bands = model.browseRows.filter((row) => getDockLaunchRowItem(row)?.category === "agent");

    expect(new Set(bands.map((row) => row.band))).toEqual(new Set(["available-agents"]));
    expect(model.browseRows.some((row) => row.kind === "cue" && row.cue === "setup-agents")).toBe(
      true
    );
  });

  it("omits the setup wizard cue when agents are actually installed", () => {
    const model = build();
    expect(model.browseRows.some((row) => row.kind === "cue" && row.cue === "setup-agents")).toBe(
      false
    );
  });

  it("counts the Pinned split against launchable agents, not the setup rows", () => {
    // With one pinned and only one launchable agent, splitting would leave
    // "Other" empty — the group must collapse instead of rendering a bare label.
    const model = build({ pinnedCount: 1 });
    const agentBands = model.browseRows
      .filter(
        (row) => getDockLaunchRowItem(row)?.category === "agent" && row.band !== "needs-setup"
      )
      .map((row) => row.band);
    expect(agentBands).toEqual(["agents"]);
  });

  it("drops a recently-launched agent from the recency band once it stops being launchable", () => {
    const model = build({
      agents: [{ id: "gemini", name: "Gemini", availability: "blocked" }],
      mruEntries: [{ id: "agent.gemini", lastAccessedAt: 10 }],
    });
    expect(model.recentAgents).toEqual([]);
    expect(model.browseRows.some((row) => row.band === "recent")).toBe(false);
  });
});

describe("buildDockLaunchModel — panel preconditions", () => {
  it("marks the workspace- and project-gated panels with a reason", () => {
    const model = build({ hasWorkspace: false, hasProject: false });
    const byKind = new Map(
      [...model.dockPanels, ...model.gridPanels].map((item) => [item.kindId, item])
    );
    expect(byKind.get("file-browser")?.disabled?.reason).toBe("Needs a workspace");
    expect(byKind.get("dev-preview")?.disabled?.reason).toBe("Needs a project");
  });

  it("leaves both rows enabled when the host doesn't state its preconditions", () => {
    // The dock's context menu supplies neither, and must keep offering both —
    // "not supplied" must never collapse into "false".
    const model = build();
    const gated = [...model.dockPanels, ...model.gridPanels].filter((item) => item.disabled);
    expect(gated).toEqual([]);
  });

  it("keeps a disabled panel in the row list so its pin stays reachable", () => {
    const model = build({ hasWorkspace: false });
    const row = model.browseRows.find((r) => getDockLaunchRowItem(r)?.key === "panel:file-browser");
    expect(row).toBeDefined();
  });
});

describe("preset rows", () => {
  const presets = [
    { id: "ccr-fast", name: "CCR: Fast" },
    { id: "team", name: "Team" },
    { id: "mine", name: "Mine" },
  ];

  it("puts Default first and orders the named groups CCR, project, custom", () => {
    const choices = buildPresetChoices(presets, new Set(["team"]), undefined);
    expect(choices.map((c) => c.presetId)).toEqual([null, "ccr-fast", "team", "mine"]);
    expect(choices.map((c) => c.group)).toEqual(["default", "ccr", "project", "custom"]);
  });

  it("lets project membership win over the ccr- prefix", () => {
    const choices = buildPresetChoices(
      [{ id: "ccr-shared", name: "CCR: Shared" }],
      new Set(["ccr-shared"]),
      undefined
    );
    expect(choices.find((c) => c.presetId === "ccr-shared")?.group).toBe("project");
  });

  it("selects Default exactly when no named preset is saved", () => {
    expect(buildPresetChoices(presets, new Set(), undefined)[0]!.isSelected).toBe(true);
    const withSaved = buildPresetChoices(presets, new Set(), "mine");
    expect(withSaved[0]!.isSelected).toBe(false);
    expect(withSaved.find((c) => c.presetId === "mine")?.isSelected).toBe(true);
  });

  it("strips the redundant CCR prefix only from CCR-group labels", () => {
    const choices = buildPresetChoices(
      [
        { id: "ccr-fast", name: "CCR: Fast" },
        { id: "ccr-team", name: "CCR: Team" },
      ],
      new Set(["ccr-team"]),
      undefined
    );
    expect(choices.find((c) => c.presetId === "ccr-fast")?.label).toBe("Fast");
    // Project-group: the heading no longer says CCR, so the name stays whole.
    expect(choices.find((c) => c.presetId === "ccr-team")?.label).toBe("CCR: Team");
  });

  it("keys preset rows to the parent ROW so a duplicated agent expands once", () => {
    const agent: DockLaunchAgent = {
      id: "claude",
      name: "Claude",
      availability: "ready",
      presetChoices: buildPresetChoices(presets, new Set(), undefined),
    };
    const model = build({
      agents: [agent],
      mruEntries: [{ id: "agent.claude", lastAccessedAt: 5 }],
    });
    const claudeRows = model.browseRows.filter(
      (row) => getDockLaunchRowItem(row)?.key === "agent:claude"
    );
    expect(claudeRows).toHaveLength(2);

    const expanded = insertExpandedPresetRows(model.browseRows, claudeRows[0]!.rowKey);
    const presetRows = expanded.filter((row) => row.kind === "preset");
    expect(presetRows).toHaveLength(4);
    // Every preset row points at the copy that was expanded, not the other one.
    for (const row of presetRows) {
      expect(row.kind === "preset" && row.parentRowKey).toBe(claudeRows[0]!.rowKey);
    }
    expect(new Set(expanded.map((row) => row.rowKey)).size).toBe(expanded.length);
  });

  it("keeps the synthetic Default distinct from a preset whose id is literally 'default'", () => {
    // Mistral ships exactly such a preset. One shared key spelling would make
    // two rows collide — they highlight together and `aria-activedescendant`
    // resolves to whichever rendered last.
    const agent: DockLaunchAgent = {
      id: "mistral",
      name: "Mistral",
      availability: "ready",
      presetChoices: buildPresetChoices([{ id: "default", name: "Default" }], new Set(), undefined),
    };
    const model = build({ agents: [agent] });
    const expanded = insertExpandedPresetRows(model.browseRows, "agent:mistral");
    const presetKeys = expanded.filter((row) => row.kind === "preset").map((row) => row.rowKey);

    expect(presetKeys).toHaveLength(2);
    expect(new Set(presetKeys).size).toBe(2);
  });

  it("splices the preset rows immediately after their parent", () => {
    const agent: DockLaunchAgent = {
      id: "claude",
      name: "Claude",
      availability: "ready",
      presetChoices: buildPresetChoices(presets, new Set(), undefined),
    };
    const model = build({ agents: [agent] });
    const parentKey = "agent:claude";
    const expanded = insertExpandedPresetRows(model.browseRows, parentKey);
    const parentIndex = expanded.findIndex((row) => row.rowKey === parentKey);
    expect(expanded.slice(parentIndex + 1, parentIndex + 5).every((r) => r.kind === "preset")).toBe(
      true
    );
  });

  it("leaves the list untouched for a row that has no presets", () => {
    const model = build();
    expect(insertExpandedPresetRows(model.browseRows, "agent:claude")).toEqual(model.browseRows);
    expect(insertExpandedPresetRows(model.browseRows, null)).toEqual(model.browseRows);
  });

  it("never expands an agent that can't be launched", () => {
    const blocked: DockLaunchRow = {
      kind: "item",
      rowKey: "agent:gemini",
      band: "needs-setup",
      item: {
        category: "agent",
        key: "agent:gemini",
        name: "Gemini",
        agentBand: "needs-setup",
        agent: {
          id: "gemini",
          name: "Gemini",
          availability: "blocked",
          presetChoices: buildPresetChoices(presets, new Set(), undefined),
        },
      },
    };
    expect(rowHasPresets(blocked)).toBe(false);
    // The rows themselves still build — only the keyboard affordance is gated.
    expect(buildPresetRows(blocked)).toHaveLength(4);
  });

  it("keeps presets out of the search set so one can never rank without its agent", () => {
    const agent: DockLaunchAgent = {
      id: "claude",
      name: "Claude",
      availability: "ready",
      presetChoices: buildPresetChoices(presets, new Set(), undefined),
    };
    const model = build({ agents: [agent] });
    expect(model.searchItems.filter((item) => item.category === "agent")).toHaveLength(1);
    // ...but the preset names are reachable through the parent's aliases.
    const claude = model.searchItems.find((item) => item.key === "agent:claude");
    expect(claude?.searchAliases).toEqual(expect.arrayContaining(["Fast", "Team", "Mine"]));
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
      agentBand: "launch",
    };
    activateDockLaunchItem(item, ctx);
    expect(recordActionMruMock).toHaveBeenCalledWith("agent.claude");
    expect(ctx.onLaunchAgent).toHaveBeenCalledWith("claude", undefined);
  });

  // The three-way preset sentinel, asserted against the real activation path.
  // `null` (explicit default) and `undefined` (inherit the saved preset) mean
  // different things all the way down to `agent.launch`, and a `!= null` guard
  // anywhere on that path collapses them — relaunching a saved preset when the
  // user asked for plain.
  it.each([
    ["explicit default", null],
    ["a named preset", "fast"],
    ["no selection", undefined],
  ])("forwards %s to the launch callback verbatim", (_label, presetId) => {
    const item: DockLaunchItem = {
      category: "agent",
      key: "agent:claude",
      name: "Claude",
      agent: AGENTS[0]!,
      agentBand: "launch",
    };
    activateDockLaunchItem(item, ctx, presetId as string | null | undefined);
    expect(ctx.onLaunchAgent).toHaveBeenCalledWith("claude", presetId);
  });

  it("refuses a panel whose precondition is unmet without dispatching anything", () => {
    const item: DockLaunchPanelItem = {
      ...panelItem("file-browser"),
      disabled: { reason: "Needs a workspace" },
    };
    activateDockLaunchItem(item, ctx);
    expect(addPanelMock).not.toHaveBeenCalled();
    expect(actionDispatchMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  // A non-launchable agent is a launch attempt like any other now: the launcher
  // re-probes and answers with either a session or the recovery gate. Settling
  // it here on a stale reading skipped that gate (#11760). MRU records the
  // attempt — the visible recency band filters to the launch band, so an
  // unavailable agent only surfaces there once it actually resolves.
  it("launches a non-launchable agent and records MRU instead of redirecting", () => {
    const item: DockLaunchItem = {
      category: "agent",
      key: "agent:gemini",
      name: "Gemini",
      agent: AGENTS[1]!,
      agentBand: "needs-setup",
    };
    activateDockLaunchItem(item, ctx);
    expect(ctx.onLaunchAgent).toHaveBeenCalledWith("gemini", undefined);
    expect(recordActionMruMock).toHaveBeenCalledWith("agent.gemini");
    expect(actionDispatchMock).not.toHaveBeenCalled();
  });

  it("forwards an explicit preset for a non-launchable agent so the gate can carry it", () => {
    const item: DockLaunchItem = {
      category: "agent",
      key: "agent:gemini",
      name: "Gemini",
      agent: AGENTS[1]!,
      agentBand: "needs-setup",
    };
    activateDockLaunchItem(item, ctx, "fast");
    expect(ctx.onLaunchAgent).toHaveBeenCalledWith("gemini", "fast");
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

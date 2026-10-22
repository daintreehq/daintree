import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerPanelKind,
  unregisterPanelKind,
  getPanelKindIds,
  getPanelKindConfig,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import { decodeLauncherItemToolbarButtonId } from "@shared/types/toolbar";
import type { PluginLaunchEntryConfig } from "@shared/types/plugin";

const actionDispatchMock = vi.fn();
const notifyMock = vi.fn();
const setGroupHiddenMock = vi.fn();
const knownAgents = new Set(["claude"]);

vi.mock("@/registry", () => ({
  getSpawnablePanelKinds: (): PanelKindConfig[] =>
    getPanelKindIds()
      .map((id) => getPanelKindConfig(id))
      .filter((c): c is PanelKindConfig => c !== undefined && c.showInPalette !== false),
  subscribeToPanelKindDefinitions: () => () => {},
  getPanelKindDefinitionsSnapshot: () => 0,
}));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => ({}) } }));
vi.mock("@/store/recipeStore", () => ({ useRecipeStore: { getState: () => ({}) } }));
vi.mock("@/store/actionMruStore", () => ({
  useActionMruStore: { getState: () => ({ recordActionMru: vi.fn() }) },
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => actionDispatchMock(...args) },
}));
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => notifyMock(...args) }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }));
vi.mock("@/hooks/useChromeWhenContext", () => ({ useChromeWhenContext: () => ({}) }));
vi.mock("@/store/pluginLaunchEntriesStore", () => ({
  usePluginLaunchEntriesStore: {
    getState: () => ({ setGroupHidden: (...args: unknown[]) => setGroupHiddenMock(...args) }),
  },
}));
vi.mock("@/config/agents", () => ({
  isRegisteredAgent: (id: string) => knownAgents.has(id),
}));

import type { LauncherArrangement } from "@shared/config/launcherArrangement";
import {
  activateDockLaunchCue,
  activateDockLaunchItem,
  buildDockLaunchModel,
  getDockLaunchRowPluginGroup,
  insertMoreRows,
  MORE_ROW_KEY,
  buildEmptyCanvasPluginGroups,
  dockLaunchBandLabel,
  type ActivateDockLaunchItemContext,
  type DockLaunchPluginEntryItem,
} from "../dockLaunchItems";
import {
  buildLauncherToolbarCatalog,
  resolveLauncherItemMetadata,
  resolveLauncherToolbarButtonId,
} from "../launcherToolbarCatalog";

const RECORDS = "acme.records";
const NOTES = "project__proj-1__acme.notes";
const RECORDS_KIND = "acme.records.records";
const NOTES_KIND = "project:proj-1/acme.notes/board";
const FOREIGN_KIND = "other.plugin.view";

function entry(over: Partial<PluginLaunchEntryConfig> & { id: string }): PluginLaunchEntryConfig {
  return {
    pluginId: RECORDS,
    pluginName: "Records",
    label: over.id,
    iconId: "plus",
    priority: 3,
    target: { type: "panel", panelKindId: RECORDS_KIND },
    ...over,
  };
}

function build(over: Partial<Parameters<typeof buildDockLaunchModel>[0]> = {}) {
  return buildDockLaunchModel({
    agents: [],
    activeWorktreeId: null,
    recipes: [],
    mruEntries: [],
    surface: "dock",
    ...over,
  });
}

function ctx(over: Partial<ActivateDockLaunchItemContext> = {}): ActivateDockLaunchItemContext {
  return {
    cwd: "/repo",
    activeWorktreeId: "wt-1",
    onLaunchAgent: vi.fn(),
    source: "menu",
    ...over,
  };
}

function itemFor(
  entries: PluginLaunchEntryConfig[],
  id: string,
  surface: "dock" | "grid" = "dock"
): DockLaunchPluginEntryItem {
  const found = build({ launchEntries: entries, surface })
    .pluginGroups.flatMap((g) => g.items)
    .find((item) => item.entryId === id);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
}

beforeEach(() => {
  actionDispatchMock.mockReset().mockResolvedValue({ ok: true, result: null });
  notifyMock.mockReset();
  setGroupHiddenMock.mockReset();
  registerPanelKind({
    id: RECORDS_KIND,
    name: "Records",
    iconId: "package",
    color: "#fff",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: RECORDS,
  });
  registerPanelKind({
    id: NOTES_KIND,
    name: "Board",
    iconId: "package",
    color: "#fff",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: NOTES,
    scope: "project",
  });
  registerPanelKind({
    id: FOREIGN_KIND,
    name: "Foreign",
    iconId: "package",
    color: "#fff",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: "other.plugin",
  });
});

afterEach(() => {
  for (const id of [RECORDS_KIND, NOTES_KIND, FOREIGN_KIND]) unregisterPanelKind(id);
});

describe("plugin launch entries — groups", () => {
  it("groups entries per plugin, in plugin-name order, each by priority then manifest order", () => {
    const model = build({
      launchEntries: [
        entry({ id: `${RECORDS}.b`, priority: 3 }),
        entry({ id: `${RECORDS}.a`, priority: 1 }),
        entry({ id: `${RECORDS}.c`, priority: 3 }),
        entry({
          id: `${NOTES}.n`,
          pluginId: NOTES,
          pluginName: "Notes",
          target: { type: "panel", panelKindId: NOTES_KIND },
        }),
      ],
    });
    expect(model.pluginGroups.map((g) => g.pluginName)).toEqual(["Notes", "Records"]);
    expect(model.pluginGroups[1]!.items.map((i) => i.entryId)).toEqual([
      `${RECORDS}.a`,
      `${RECORDS}.b`,
      `${RECORDS}.c`,
    ]);
  });

  it("leaves out a hidden group and an entry whose when is false", () => {
    const entries = [
      entry({ id: `${RECORDS}.always` }),
      entry({ id: `${RECORDS}.git`, when: "isGitBacked" }),
      entry({
        id: `${NOTES}.n`,
        pluginId: NOTES,
        pluginName: "Notes",
        target: { type: "panel", panelKindId: NOTES_KIND },
      }),
    ];
    const model = build({
      launchEntries: entries,
      hiddenPluginIds: [NOTES],
      whenContext: { isGitBacked: false },
    });
    expect(model.pluginGroups.flatMap((g) => g.items.map((i) => i.entryId))).toEqual([
      `${RECORDS}.always`,
    ]);
    expect(model.searchItems.some((i) => i.key === `plugin-entry:${NOTES}.n`)).toBe(false);
  });

  it("replaces the automatic row of a panel an entry opens, even while the entry is hidden", () => {
    const panelRows = (over: Partial<Parameters<typeof buildDockLaunchModel>[0]>) =>
      build(over)
        .searchItems.filter((i) => i.category === "panel")
        .map((i) => (i.category === "panel" ? i.kindId : ""));
    expect(panelRows({})).toContain(RECORDS_KIND);
    const claimed = [entry({ id: `${RECORDS}.new`, when: "never" })];
    expect(panelRows({ launchEntries: claimed })).not.toContain(RECORDS_KIND);
    expect(panelRows({ launchEntries: claimed, hiddenPluginIds: [RECORDS] })).not.toContain(
      RECORDS_KIND
    );
    expect(panelRows({ launchEntries: claimed })).toContain(FOREIGN_KIND);
  });

  it("drops an entry that names another plugin's panel or command", () => {
    const model = build({
      launchEntries: [
        entry({ id: `${RECORDS}.foreign`, target: { type: "panel", panelKindId: FOREIGN_KIND } }),
        entry({
          id: `${RECORDS}.builtin`,
          target: { type: "command", actionId: "terminal.new" },
        }),
        entry({
          id: `${RECORDS}.own`,
          target: { type: "command", actionId: `${RECORDS}.publish` },
        }),
      ],
    });
    expect(model.pluginGroups.flatMap((g) => g.items.map((i) => i.entryId))).toEqual([
      `${RECORDS}.own`,
    ]);
  });

  it("drops a built-in command even when its id starts with the plugin's name", () => {
    const model = build({
      launchEntries: [
        entry({
          id: "env.global.set-env",
          pluginId: "env.global",
          pluginName: "Env",
          target: { type: "command", actionId: "env.global.set" },
        }),
      ],
    });
    expect(model.pluginGroups).toEqual([]);
  });

  it("disables an agent entry whose agent isn't registered, keeping it listed", () => {
    const entries = [
      entry({ id: `${RECORDS}.ok`, target: { type: "agent", agentId: "claude", prompt: "hi" } }),
      entry({ id: `${RECORDS}.gone`, target: { type: "agent", agentId: "nope", prompt: "hi" } }),
    ];
    expect(itemFor(entries, `${RECORDS}.ok`).disabled).toBeUndefined();
    expect(itemFor(entries, `${RECORDS}.gone`).disabled?.reason).toBe("Agent not available");
    // The hook hands the builder the registries it subscribes to, so an agent
    // that registers later is what decides, not a stale global read.
    const model = build({ launchEntries: entries, isAgentRegistered: (id) => id === "nope" });
    const gone = model.pluginGroups[0]!.items.find((i) => i.entryId === `${RECORDS}.gone`);
    expect(gone?.disabled).toBeUndefined();
  });

  it("lists each group under its plugin's name, ended by the row that hides it, before recipes", () => {
    const model = build({ launchEntries: [entry({ id: `${RECORDS}.new` })] });
    const tail = model.browseRows.filter((row) => row.band === "plugin-entries");
    expect(tail.map((row) => row.rowKey)).toEqual([
      `plugin-entry:${RECORDS}.new`,
      `hide-plugin-group:${RECORDS}`,
    ]);
    expect(tail.map((row) => dockLaunchBandLabel("plugin-entries", row))).toEqual([
      "Records",
      "Records",
    ]);
    const bands = model.browseRows.map((row) => row.band);
    expect(bands.lastIndexOf("plugin-entries")).toBeLessThan(bands.indexOf("recipes"));
  });

  it("opens an unplaced panel where the surface opens panels, and an explicit placement as written", () => {
    const entries = [
      entry({ id: `${RECORDS}.plain` }),
      entry({
        id: `${RECORDS}.dialog`,
        target: { type: "panel", panelKindId: RECORDS_KIND, placement: "dialog" },
      }),
      entry({
        id: `${RECORDS}.grid`,
        target: { type: "panel", panelKindId: RECORDS_KIND, placement: "grid" },
      }),
      entry({
        id: `${NOTES}.board`,
        pluginId: NOTES,
        pluginName: "Notes",
        target: { type: "panel", panelKindId: NOTES_KIND },
      }),
    ];
    expect(itemFor(entries, `${RECORDS}.plain`, "dock").presentation).toBe("dock");
    expect(itemFor(entries, `${RECORDS}.plain`, "grid").presentation).toBe("panel");
    expect(itemFor(entries, `${RECORDS}.dialog`, "grid").presentation).toBe("dialog");
    expect(itemFor(entries, `${RECORDS}.grid`, "dock").presentation).toBe("panel");
    expect(itemFor(entries, `${NOTES}.board`, "grid").presentation).toBe("dock");
  });
});

describe("plugin launch entries — empty canvas", () => {
  const entries = [
    entry({ id: "listed", showInEmptyState: true }),
    entry({ id: "unlisted" }),
    entry({ id: "off", showInEmptyState: false }),
    entry({
      id: "other",
      pluginId: NOTES,
      pluginName: "Notes",
      showInEmptyState: true,
      target: { type: "panel", panelKindId: NOTES_KIND },
    }),
  ];

  it("lists only the entries that opted in, one group per plugin", () => {
    const groups = buildEmptyCanvasPluginGroups(entries, { surface: "grid" });
    expect(groups.map((g) => [g.pluginName, g.items.map((i) => i.entryId)])).toEqual([
      ["Notes", ["other"]],
      ["Records", ["listed"]],
    ]);
  });

  it("honours a hidden plugin and a false when clause", () => {
    const groups = buildEmptyCanvasPluginGroups(
      [...entries, entry({ id: "gated", showInEmptyState: true, when: "isGitBacked" })],
      { surface: "grid", hiddenPluginIds: [NOTES], whenContext: { isGitBacked: false } }
    );
    expect(groups.flatMap((g) => g.items.map((i) => i.entryId))).toEqual(["listed"]);
  });

  it("leaves the launcher's own model listing every entry", () => {
    const model = build({ launchEntries: entries, surface: "grid" });
    expect(model.pluginGroups.flatMap((g) => g.items).map((i) => i.entryId)).toHaveLength(4);
  });
});

describe("plugin launch entries — activation", () => {
  it("opens a panel entry through panel.openPluginPanel with its args", async () => {
    const entries = [
      entry({
        id: `${RECORDS}.new`,
        target: { type: "panel", panelKindId: RECORDS_KIND, args: { mode: "new" } },
      }),
    ];
    activateDockLaunchItem(itemFor(entries, `${RECORDS}.new`), ctx());
    expect(actionDispatchMock).toHaveBeenCalledWith(
      "panel.openPluginPanel",
      { kind: RECORDS_KIND, presentation: "dock", initialArgs: { mode: "new" } },
      { source: "menu" }
    );
  });

  it("runs a command entry's own action with its args", () => {
    const entries = [
      entry({
        id: `${RECORDS}.publish`,
        target: { type: "command", actionId: `${RECORDS}.publish`, args: { draft: true } },
      }),
    ];
    activateDockLaunchItem(itemFor(entries, `${RECORDS}.publish`), ctx({ source: "user" }));
    expect(actionDispatchMock).toHaveBeenCalledWith(
      `${RECORDS}.publish`,
      { draft: true },
      { source: "user" }
    );
  });

  it("starts an agent entry through the surface's own launch, with the prompt and nothing else", () => {
    const onLaunchAgent = vi.fn();
    const entries = [
      entry({ id: `${RECORDS}.chat`, target: { type: "agent", agentId: "claude", prompt: "hi" } }),
    ];
    activateDockLaunchItem(itemFor(entries, `${RECORDS}.chat`), ctx({ onLaunchAgent }));
    expect(onLaunchAgent).toHaveBeenCalledWith("claude", undefined, { prompt: "hi" });
    expect(actionDispatchMock).not.toHaveBeenCalled();
  });

  it("refuses at dispatch a panel the registry no longer gives to the entry's plugin", () => {
    const item = itemFor([entry({ id: `${RECORDS}.new` })], `${RECORDS}.new`);
    unregisterPanelKind(RECORDS_KIND);
    registerPanelKind({ ...getPanelKindConfig(FOREIGN_KIND)!, id: RECORDS_KIND });
    activateDockLaunchItem(item, ctx());
    expect(actionDispatchMock).not.toHaveBeenCalled();
  });

  it("reports a refused launch with one way to retry", async () => {
    actionDispatchMock.mockResolvedValue({ ok: false, error: { message: "boom" } });
    const entries = [
      entry({
        id: `${RECORDS}.publish`,
        label: "Publish site",
        target: { type: "command", actionId: `${RECORDS}.publish` },
      }),
    ];
    activateDockLaunchItem(itemFor(entries, `${RECORDS}.publish`), ctx());
    await vi.waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't launch Publish site",
        action: expect.objectContaining({ label: "Retry" }),
      })
    );
  });

  it("hides a group from its cue", () => {
    setGroupHiddenMock.mockResolvedValue(true);
    activateDockLaunchCue("hide-plugin-group", null, "menu", {
      pluginId: RECORDS,
      pluginName: "Records",
    });
    expect(setGroupHiddenMock).toHaveBeenCalledWith(RECORDS, true);
  });

  it("says so when a hide couldn't be saved, with one way to retry", async () => {
    setGroupHiddenMock.mockResolvedValue(false);
    activateDockLaunchCue("hide-plugin-group", null, "menu", {
      pluginId: RECORDS,
      pluginName: "Records",
    });
    await vi.waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't hide Records",
        action: expect.objectContaining({ label: "Retry" }),
      })
    );
  });
});

describe("plugin launch entries — pins", () => {
  it("pins an entry under its runtime id, project-qualified for a project plugin", () => {
    const entries = [
      entry({ id: `${RECORDS}.new` }),
      entry({
        id: `${NOTES}.board`,
        pluginId: NOTES,
        pluginName: "Notes",
        target: { type: "panel", panelKindId: NOTES_KIND },
      }),
    ];
    const ids = [`${RECORDS}.new`, `${NOTES}.board`].map((id) =>
      resolveLauncherToolbarButtonId(itemFor(entries, id), "proj-1")
    );
    expect(ids).toEqual([
      `launcher:plugin-entry:${RECORDS}.new`,
      `launcher:plugin-entry:${NOTES}.board`,
    ]);
    expect(decodeLauncherItemToolbarButtonId(ids[1]!)).toEqual({
      category: "plugin-entry",
      sourceId: `${NOTES}.board`,
    });
    const catalog = buildLauncherToolbarCatalog(
      build({ launchEntries: entries }).searchItems,
      "proj-1"
    );
    expect(
      [...catalog.keys()].filter((id) => id.startsWith("launcher:plugin-entry:")).sort()
    ).toEqual([...ids].sort());
  });

  it("names a pinned entry from the registered set, and nothing once it is gone", () => {
    const entries = [entry({ id: `${RECORDS}.new`, label: "New record…", when: "never" })];
    const pinned = `launcher:plugin-entry:${RECORDS}.new`;
    expect(resolveLauncherItemMetadata(pinned, [], null, entries)?.description).toBe(
      "New record… (Records)"
    );
    expect(resolveLauncherItemMetadata(pinned, [], null, [])).toBeUndefined();
  });
});

describe("project arrangement (#13791)", () => {
  // An installed plugin whose name sorts first, so stock order puts it first.
  const ALPHA = "acme.alpha";
  const entries = [
    entry({
      id: `${ALPHA}.open`,
      pluginId: ALPHA,
      pluginName: "Alpha",
      target: { type: "command", actionId: `${ALPHA}.open` },
    }),
    entry({
      id: `${NOTES}.board`,
      pluginId: NOTES,
      pluginName: "Notes",
      target: { type: "panel", panelKindId: NOTES_KIND },
    }),
  ];
  const arrangement = (over: Partial<LauncherArrangement> = {}): LauncherArrangement => ({
    projectId: "proj-1",
    demoted: { agents: false, panels: false },
    groupOrder: [],
    featuredEntry: null,
    ...over,
  });
  const firstGroupOf = (model: ReturnType<typeof build>) =>
    model.browseRows.map(getDockLaunchRowPluginGroup).find(Boolean)?.pluginName;

  it("keeps stock order, with no More, until the project arranges it", () => {
    const model = build({ launchEntries: entries, arrangement: arrangement() });
    expect(model.browseRows[0]!.band).toBe("dock-panels");
    expect(firstGroupOf(model)).toBe("Alpha");
    expect(model.moreRows).toEqual([]);
    expect(model.browseRows.some((row) => row.rowKey === MORE_ROW_KEY)).toBe(false);
    expect(model.fixedOrder).toBe(false);
  });

  it("leads with the project's own plugin and folds demoted panels into More, still searchable", () => {
    const model = build({
      launchEntries: entries,
      arrangement: arrangement({ demoted: { agents: false, panels: true } }),
    });
    expect(getDockLaunchRowPluginGroup(model.browseRows[0]!)?.pluginId).toBe(NOTES);
    expect(model.browseRows.some((row) => row.band === "dock-panels")).toBe(false);
    expect(model.moreRows.length).toBeGreaterThan(0);
    expect(
      model.moreRows.every((row) => row.band === "dock-panels" || row.band === "grid-panels")
    ).toBe(true);
    // More is the last body row, and the footer still follows it.
    const more = model.browseRows.findIndex((row) => row.rowKey === MORE_ROW_KEY);
    expect(model.browseRows.slice(more + 1).map((row) => row.rowKey)).toEqual([
      "manage-agents",
      "customize-toolbar",
    ]);
    expect(model.browseRows[more]).toMatchObject({ cue: "more", contents: "Panels" });
    expect(model.searchItems.some((item) => item.category === "panel")).toBe(true);
    expect(model.fixedOrder).toBe(true);
  });

  it("lets the user's group order win over the project's lead", () => {
    const model = build({
      launchEntries: entries,
      arrangement: arrangement({
        demoted: { agents: true, panels: false },
        groupOrder: [`plugin:${ALPHA}`, "recipes"],
      }),
    });
    expect(firstGroupOf(model)).toBe("Alpha");
    expect(model.groupOrder.slice(0, 3)).toEqual([`plugin:${ALPHA}`, "recipes", `plugin:${NOTES}`]);
  });

  it("resolves the featured entry to its row only while it is listed", () => {
    const featured = arrangement({ featuredEntry: "acme.notes.board" });
    expect(build({ launchEntries: entries, arrangement: featured }).featuredRowKey).toBe(
      `plugin-entry:${NOTES}.board`
    );
    // Hidden, or named for an installed plugin's entry: nothing is featured.
    expect(
      build({ launchEntries: entries, arrangement: featured, hiddenPluginIds: [NOTES] })
        .featuredRowKey
    ).toBeNull();
    expect(
      build({
        launchEntries: entries,
        arrangement: arrangement({ featuredEntry: "acme.alpha.open" }),
      }).featuredRowKey
    ).toBeNull();
  });

  it("features nothing while the featured entry cannot launch", () => {
    const unavailable = [
      ...entries,
      entry({
        id: `${NOTES}.ask`,
        pluginId: NOTES,
        pluginName: "Notes",
        target: { type: "agent", agentId: "not-installed" },
      }),
    ];
    const model = build({
      launchEntries: unavailable,
      arrangement: arrangement({ featuredEntry: "acme.notes.ask" }),
    });
    const notes = model.pluginGroups.find((group) => group.pluginId === NOTES);
    expect(notes?.items.some((item) => item.disabled !== undefined)).toBe(true);
    expect(model.featuredRowKey).toBeNull();
  });

  it("opens More in place, under its row", () => {
    const model = build({
      launchEntries: entries,
      arrangement: arrangement({ demoted: { agents: false, panels: true } }),
    });
    expect(insertMoreRows(model.browseRows, model.moreRows, false)).toEqual(model.browseRows);
    const open = insertMoreRows(model.browseRows, model.moreRows, true);
    const more = open.findIndex((row) => row.rowKey === MORE_ROW_KEY);
    expect(open.slice(more + 1, more + 1 + model.moreRows.length)).toEqual(model.moreRows);
    expect(open.slice(-2).map((row) => row.rowKey)).toEqual(["manage-agents", "customize-toolbar"]);
  });
});

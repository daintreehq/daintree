// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const registryMock = vi.hoisted(() => ({ getPanelKindConfig: vi.fn() }));
const focusPanelInput = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/diagnosticsStore", () => ({ useDiagnosticsStore: { getState: vi.fn() } }));
vi.mock("@/store/errorStore", () => ({ useErrorStore: { getState: vi.fn() } }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: { getState: vi.fn() } }));
vi.mock("@shared/config/panelKindRegistry", () => ({
  getPanelKindConfig: registryMock.getPanelKindConfig,
  // The real predicates, read off the mocked registry entry.
  panelKindIsDockable: (kind: string) => {
    const config = registryMock.getPanelKindConfig(kind) as { dockable?: boolean } | undefined;
    return config !== undefined && config.dockable !== false;
  },
  panelKindIsProjectScoped: (kind: string) =>
    (registryMock.getPanelKindConfig(kind) as { scope?: string } | undefined)?.scope === "project",
}));
vi.mock("@/components/Panel/panelFocusRegistry", () => ({ focusPanelInput }));

import { registerPanelCoreActions } from "../panelCoreActions";
import { usePanelDialogStore } from "@/store/panelDialogStore";
import { usePluginPanelOpenRequestStore } from "@/store/pluginPanelOpenRequestStore";

const addPanel = vi.fn();
const activateTerminal = vi.fn();
const removePanel = vi.fn();

/** Worktrees the current project owns, as `callbacks.getWorktrees()` sees them. */
let worktrees: Array<{ id: string }> = [];

function openRequestOf(panelId: string) {
  return usePluginPanelOpenRequestStore.getState().entriesByPanelId[panelId]?.request;
}

function setup(args?: unknown) {
  const actions: ActionRegistry = new Map();
  const callbacks = {
    getActiveWorktreeId: () => "wt-active",
    // A supplied worktreeId is checked for membership in the current project
    // (#11297), so the mock has to carry the ids these cases pass in.
    getWorktrees: () => worktrees,
  } as unknown as ActionCallbacks;
  registerPanelCoreActions(actions, callbacks);
  const factory = actions.get("panel.openPluginPanel");
  if (!factory) throw new Error("panel.openPluginPanel not registered");
  const def = factory() as AnyActionDefinition;
  return def.run(args, {} as never);
}

describe("panel.openPluginPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePluginPanelOpenRequestStore.setState({ entriesByPanelId: {} });
    worktrees = [{ id: "wt-active" }, { id: "wt-1" }];
    addPanel.mockResolvedValue("panel-new");
    panelStoreMock.getState.mockReturnValue({
      panelIds: [],
      panelsById: {},
      addPanel,
      activateTerminal,
    });
    // Default: a real plugin kind.
    registryMock.getPanelKindConfig.mockReturnValue({ id: "acme.dash", extensionId: "acme" });
  });

  afterEach(() => vi.clearAllMocks());

  it("rejects a kind that is not a registered plugin panel kind", async () => {
    registryMock.getPanelKindConfig.mockReturnValue(undefined);
    await expect(setup({ kind: "acme.dash" })).rejects.toThrow(
      /not a registered plugin panel kind/
    );
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("rejects a built-in kind (no extensionId) so only plugin kinds are reachable", async () => {
    registryMock.getPanelKindConfig.mockReturnValue({ id: "terminal" });
    await expect(setup({ kind: "terminal" })).rejects.toThrow(/not a registered plugin panel kind/);
  });

  it("spawns a new panel with initialArgs threaded through extensionState", async () => {
    const initialArgs = { path: "/repo/x.ts" };
    const result = await setup({ kind: "acme.dash", initialArgs, worktreeId: "wt-1" });

    expect(addPanel).toHaveBeenCalledTimes(1);
    const opts = addPanel.mock.calls[0]![0];
    expect(opts.kind).toBe("acme.dash");
    expect(opts.worktreeId).toBe("wt-1");
    expect(opts.extensionState).toEqual(initialArgs);
    expect(result).toEqual({ panelId: "panel-new" });
  });

  it("defaults the worktree to the active one when none is supplied", async () => {
    await setup({ kind: "acme.dash" });
    expect(addPanel.mock.calls[0]![0].worktreeId).toBe("wt-active");
  });

  it("focuses an existing panel of the kind in the worktree instead of spawning a second", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["p-existing"],
      panelsById: {
        "p-existing": { id: "p-existing", kind: "acme.dash", worktreeId: "wt-1", location: "grid" },
      },
      addPanel,
      activateTerminal,
    });

    const result = await setup({ kind: "acme.dash", worktreeId: "wt-1" });
    expect(activateTerminal).toHaveBeenCalledWith("p-existing");
    expect(addPanel).not.toHaveBeenCalled();
    expect(result).toEqual({ panelId: "p-existing" });
  });

  describe("handing a reused panel its new args (#13779)", () => {
    beforeEach(() => {
      panelStoreMock.getState.mockReturnValue({
        panelIds: ["p-other-wt", "p-existing"],
        panelsById: {
          "p-other-wt": {
            id: "p-other-wt",
            kind: "acme.dash",
            worktreeId: "wt-active",
            location: "grid",
          },
          "p-existing": {
            id: "p-existing",
            kind: "acme.dash",
            worktreeId: "wt-1",
            location: "dock",
          },
        },
        addPanel,
        activateTerminal,
      });
    });

    it("delivers them to the panel it focuses, and to no other", async () => {
      const result = await setup({
        kind: "acme.dash",
        worktreeId: "wt-1",
        initialArgs: { path: "/repo/b.ts" },
      });

      expect(result).toEqual({ panelId: "p-existing" });
      expect(activateTerminal).toHaveBeenCalledWith("p-existing");
      expect(openRequestOf("p-existing")?.args).toEqual({ path: "/repo/b.ts" });
      expect(openRequestOf("p-other-wt")).toBeUndefined();
      expect(addPanel).not.toHaveBeenCalled();
    });

    it("keeps only the latest call, with a new seq even for the same args", async () => {
      await setup({ kind: "acme.dash", worktreeId: "wt-1", initialArgs: { path: "/a" } });
      const first = openRequestOf("p-existing");
      await setup({ kind: "acme.dash", worktreeId: "wt-1", initialArgs: { path: "/a" } });
      const second = openRequestOf("p-existing");

      expect(second?.args).toEqual({ path: "/a" });
      expect(second!.seq).toBeGreaterThan(first!.seq);
    });

    it("stores a detached, JSON-canonical copy of the args", async () => {
      const nested = { n: 1 };
      await setup({
        kind: "acme.dash",
        worktreeId: "wt-1",
        initialArgs: { at: new Date(0), nested },
      });
      nested.n = 2;

      expect(openRequestOf("p-existing")?.args).toEqual({
        at: "1970-01-01T00:00:00.000Z",
        nested: { n: 1 },
      });
    });

    it("leaves a waiting request alone on an open without args", async () => {
      await setup({ kind: "acme.dash", worktreeId: "wt-1", initialArgs: { path: "/a" } });
      const waiting = openRequestOf("p-existing");

      await setup({ kind: "acme.dash", worktreeId: "wt-1" });

      expect(openRequestOf("p-existing")).toBe(waiting);
      expect(activateTerminal).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["not JSON-serializable", { id: 1n }],
      ["over the 64KB cap", { blob: "x".repeat(64 * 1024) }],
    ])(
      "rejects args that are %s without focusing or replacing the waiting request",
      async (_, bad) => {
        await setup({ kind: "acme.dash", worktreeId: "wt-1", initialArgs: { path: "/a" } });
        const waiting = openRequestOf("p-existing");
        activateTerminal.mockClear();

        await expect(
          setup({ kind: "acme.dash", worktreeId: "wt-1", initialArgs: bad })
        ).rejects.toThrow(/JSON-serializable and at most 64KB/);

        expect(activateTerminal).not.toHaveBeenCalled();
        expect(openRequestOf("p-existing")).toBe(waiting);
      }
    );

    it("leaves a fresh spawn's args to extensionState alone", async () => {
      await setup({
        kind: "acme.dash",
        worktreeId: "wt-1",
        initialArgs: { path: "/a" },
        reuseExisting: false,
      });

      expect(addPanel.mock.calls[0]![0].extensionState).toEqual({ path: "/a" });
      expect(usePluginPanelOpenRequestStore.getState().entriesByPanelId).toEqual({});
    });
  });

  it("does not reuse a trashed panel of the same kind", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["p-trashed"],
      panelsById: {
        "p-trashed": { id: "p-trashed", kind: "acme.dash", worktreeId: "wt-1", location: "trash" },
      },
      addPanel,
      activateTerminal,
    });

    await setup({ kind: "acme.dash", worktreeId: "wt-1" });
    expect(activateTerminal).not.toHaveBeenCalled();
    expect(addPanel).toHaveBeenCalledTimes(1);
  });

  it("spawns a fresh panel even when one exists when reuseExisting is false", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["p-existing"],
      panelsById: {
        "p-existing": { id: "p-existing", kind: "acme.dash", worktreeId: "wt-1", location: "grid" },
      },
      addPanel,
      activateTerminal,
    });

    await setup({ kind: "acme.dash", worktreeId: "wt-1", reuseExisting: false });
    expect(activateTerminal).not.toHaveBeenCalled();
    expect(addPanel).toHaveBeenCalledTimes(1);
  });

  // ── #11297: a foreign worktreeId must not be persisted onto the panel ──

  it("rejects a worktreeId that belongs to another project", async () => {
    await expect(setup({ kind: "acme.dash", worktreeId: "wt-other" })).rejects.toThrow(
      /does not belong to the current project/
    );
    // The whole point: nothing is persisted. Silently spawning under another
    // project is what made the command look like a no-op.
    expect(addPanel).not.toHaveBeenCalled();
    expect(activateTerminal).not.toHaveBeenCalled();
  });

  it("distinguishes an unloaded worktree list from a foreign id", async () => {
    // Membership can't be established, so it can't be granted — bypassing the
    // check on an empty list would re-admit arbitrary ids. But this failure is
    // transient and worth retrying, so it must not read as "wrong project".
    worktrees = [];
    await expect(setup({ kind: "acme.dash", worktreeId: "wt-1" })).rejects.toThrow(
      /haven't loaded yet/
    );
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("still spawns with the active worktree when none is supplied and none have loaded", async () => {
    // The default path must keep working while a project is still loading —
    // the check applies only to a caller-named target.
    worktrees = [];
    await setup({ kind: "acme.dash" });
    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel.mock.calls[0]![0].worktreeId).toBe("wt-active");
  });
});

describe("panel.openPluginPanel in the dock and across worktrees (#13778)", () => {
  const PROJECT_KIND = { id: "acme.records", extensionId: "acme", scope: "project" };

  beforeEach(() => {
    vi.clearAllMocks();
    usePluginPanelOpenRequestStore.setState({ entriesByPanelId: {} });
    worktrees = [{ id: "wt-active" }, { id: "wt-1" }];
    addPanel.mockResolvedValue("panel-new");
    panelStoreMock.getState.mockReturnValue({
      panelIds: [],
      panelsById: {},
      addPanel,
      activateTerminal,
    });
    registryMock.getPanelKindConfig.mockReturnValue({ id: "acme.dash", extensionId: "acme" });
  });

  it("opens a worktree kind as a dock chip in its worktree, shown", async () => {
    const result = await setup({ kind: "acme.dash", presentation: "dock", worktreeId: "wt-1" });

    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel.mock.calls[0]![0]).toMatchObject({
      kind: "acme.dash",
      worktreeId: "wt-1",
      location: "dock",
      activateDockOnCreate: true,
    });
    expect(result).toEqual({ panelId: "panel-new" });
  });

  it("does not ask the grid to show a panel it opens there", async () => {
    await setup({ kind: "acme.dash" });
    const opts = addPanel.mock.calls[0]![0];
    expect(opts.location).toBe("grid");
    expect(opts.activateDockOnCreate).toBeUndefined();
  });

  it("refuses the dock for a kind that opts out of it, rather than landing in the grid", async () => {
    registryMock.getPanelKindConfig.mockReturnValue({
      id: "acme.dash",
      extensionId: "acme",
      dockable: false,
    });
    await expect(setup({ kind: "acme.dash", presentation: "dock" })).rejects.toThrow(
      /opts out of the dock/
    );
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("opens a project-scoped kind in the dock with no worktree by default", async () => {
    registryMock.getPanelKindConfig.mockReturnValue(PROJECT_KIND);

    await setup({ kind: "acme.records", initialArgs: { id: 42 } });

    expect(addPanel.mock.calls[0]![0]).toMatchObject({
      kind: "acme.records",
      location: "dock",
      activateDockOnCreate: true,
      extensionState: { id: 42 },
    });
    expect(addPanel.mock.calls[0]![0].worktreeId).toBeUndefined();
  });

  function seedProjectPanels(panels: Array<{ id: string; worktreeId?: string; location: string }>) {
    panelStoreMock.getState.mockReturnValue({
      panelIds: panels.map((p) => p.id),
      panelsById: Object.fromEntries(panels.map((p) => [p.id, { ...p, kind: "acme.records" }])),
      addPanel,
      activateTerminal,
    });
  }

  it("reuses the project's dock panel before one the user moved into a worktree", async () => {
    registryMock.getPanelKindConfig.mockReturnValue(PROJECT_KIND);
    seedProjectPanels([
      { id: "p-moved", worktreeId: "wt-1", location: "grid" },
      { id: "p-project", location: "dock" },
    ]);

    const result = await setup({ kind: "acme.records", initialArgs: { id: 43 } });

    expect(result).toEqual({ panelId: "p-project" });
    expect(activateTerminal).toHaveBeenCalledWith("p-project");
    expect(openRequestOf("p-project")?.args).toEqual({ id: 43 });
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("reuses a project panel the user moved into another worktree's grid, where it is", async () => {
    registryMock.getPanelKindConfig.mockReturnValue(PROJECT_KIND);
    seedProjectPanels([
      { id: "p-trashed", location: "trash" },
      { id: "p-moved", worktreeId: "wt-1", location: "grid" },
    ]);

    const result = await setup({ kind: "acme.records" });

    expect(result).toEqual({ panelId: "p-moved" });
    expect(activateTerminal).toHaveBeenCalledWith("p-moved");
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("keeps a worktree kind's reuse to its own worktree", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["p-other"],
      panelsById: {
        "p-other": { id: "p-other", kind: "acme.dash", worktreeId: "wt-1", location: "dock" },
      },
      addPanel,
      activateTerminal,
    });

    await setup({ kind: "acme.dash", presentation: "dock" });

    expect(activateTerminal).not.toHaveBeenCalled();
    expect(addPanel.mock.calls[0]![0]).toMatchObject({ worktreeId: "wt-active", location: "dock" });
  });

  it("presents a project-scoped kind's dialog with no worktree", async () => {
    registryMock.getPanelKindConfig.mockReturnValue(PROJECT_KIND);
    usePanelDialogStore.setState({ dialogStack: [], dialogFrames: {}, requestSeq: 0 });
    addPanel.mockImplementation(async (options: { requestedId?: string }) => options.requestedId);

    const result = (await setup({ kind: "acme.records", presentation: "dialog" })) as {
      panelId: string;
    };

    expect(addPanel.mock.calls[0]![0].worktreeId).toBeUndefined();
    expect(usePanelDialogStore.getState().dialogFrames[result.panelId]).toEqual({
      kind: "acme.records",
    });
    usePanelDialogStore.setState({ dialogStack: [], dialogFrames: {}, requestSeq: 0 });
  });

  it("refuses a worktree named for a project-scoped kind rather than dropping it", async () => {
    registryMock.getPanelKindConfig.mockReturnValue(PROJECT_KIND);
    await expect(setup({ kind: "acme.records", worktreeId: "wt-1" })).rejects.toThrow(
      /belongs to the project/
    );
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("refuses the grid for a project-scoped kind, where it would never show", async () => {
    registryMock.getPanelKindConfig.mockReturnValue(PROJECT_KIND);
    await expect(setup({ kind: "acme.records", presentation: "panel" })).rejects.toThrow(
      /opens in the dock or a dialog/
    );
    expect(addPanel).not.toHaveBeenCalled();
  });
});

/** Dispatch a dialog open and return the `panelId` it resolves with. */
async function openDialog(args: Record<string, unknown>): Promise<string> {
  const result: unknown = await setup({ kind: "acme.dash", presentation: "dialog", ...args });
  if (
    typeof result !== "object" ||
    result === null ||
    !("panelId" in result) ||
    typeof result.panelId !== "string"
  ) {
    throw new Error("expected { panelId }");
  }
  return result.panelId;
}

describe("panel.openPluginPanel presentation: dialog (#13504)", () => {
  const dialogStack = () => usePanelDialogStore.getState().dialogStack;
  const frames = () => usePanelDialogStore.getState().dialogFrames;

  beforeEach(() => {
    vi.clearAllMocks();
    usePluginPanelOpenRequestStore.setState({ entriesByPanelId: {} });
    worktrees = [{ id: "wt-active" }, { id: "wt-1" }];
    usePanelDialogStore.setState({ dialogStack: [], dialogFrames: {}, requestSeq: 0 });
    // The dialog store hands its reserved id to addPanel; echo it back as the
    // real store does when it commits the record.
    addPanel.mockImplementation(async (options: { requestedId?: string }) => options.requestedId);
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["p-grid"],
      panelsById: {
        // A grid panel of the same kind must not satisfy a dialog request.
        "p-grid": { id: "p-grid", kind: "acme.dash", worktreeId: "wt-active", location: "grid" },
      },
      addPanel,
      activateTerminal,
      removePanel,
    });
    registryMock.getPanelKindConfig.mockReturnValue({ id: "acme.dash", extensionId: "acme" });
  });

  it("opens the kind as an ephemeral dialog with initialArgs and the requested size", async () => {
    const initialArgs = { filter: "needs-you" };
    const panelId = await openDialog({ size: "workspace", initialArgs });

    expect(activateTerminal).not.toHaveBeenCalled();
    expect(addPanel).toHaveBeenCalledTimes(1);
    const opts = addPanel.mock.calls[0]![0];
    expect(opts).toMatchObject({
      kind: "acme.dash",
      location: "dialog",
      worktreeId: "wt-active",
      extensionState: initialArgs,
      excludeFromPersistence: true,
    });
    expect(dialogStack()).toEqual([panelId]);
    expect(frames()[panelId]).toEqual({
      kind: "acme.dash",
      worktreeId: "wt-active",
      size: "workspace",
    });
  });

  it("leaves the size to the host default when none is given", async () => {
    const panelId = await openDialog({});
    expect(frames()[panelId]?.size).toBeUndefined();
  });

  it("returns the open dialog of the kind on a plain open instead of replacing it", async () => {
    const first = await openDialog({});
    const second = await openDialog({ size: "sm" });

    expect(second).toBe(first);
    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(removePanel).not.toHaveBeenCalled();
    expect(dialogStack()).toEqual([first]);
    // A reopen leaves the presented instance as it is.
    expect(frames()[first]?.size).toBeUndefined();
  });

  it("hands an already-open dialog the new args as an open request (#13779)", async () => {
    const first = await openDialog({ initialArgs: { filter: "needs-you" } });
    expect(openRequestOf(first)).toBeUndefined();

    expect(await openDialog({ initialArgs: { filter: "all" } })).toBe(first);

    expect(openRequestOf(first)?.args).toEqual({ filter: "all" });
    expect(addPanel).toHaveBeenCalledTimes(1);
  });

  it("delivers nothing when the open toggles the dialog closed", async () => {
    await openDialog({});
    await openDialog({ toggle: true, initialArgs: { filter: "all" } });

    expect(usePluginPanelOpenRequestStore.getState().entriesByPanelId).toEqual({});
  });

  it("drops a request made to a reservation whose panel never materialises", async () => {
    let settle: (id: string | null) => void = () => {};
    addPanel.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          settle = resolve;
        })
    );
    const failing = setup({ kind: "acme.dash", presentation: "dialog" });
    await Promise.resolve();
    const reserved = dialogStack()[0]!;

    expect(await openDialog({ initialArgs: { filter: "all" } })).toBe(reserved);
    expect(openRequestOf(reserved)).toBeDefined();

    settle(null);
    await expect(failing).rejects.toThrow(/Failed to open plugin panel/);
    expect(openRequestOf(reserved)).toBeUndefined();
  });

  it("treats a dialog still being created as already open", async () => {
    addPanel.mockImplementation(() => new Promise(() => {}));
    void setup({ kind: "acme.dash", presentation: "dialog" });
    await Promise.resolve();
    const reserved = dialogStack()[0];
    expect(reserved).toBeDefined();

    expect(await openDialog({})).toBe(reserved);
    expect(addPanel).toHaveBeenCalledTimes(1);
  });

  it("closes the kind's dialog on toggle when it is topmost", async () => {
    const first = await openDialog({});
    const toggled = await openDialog({ toggle: true });

    expect(toggled).toBe(first);
    expect(dialogStack()).toEqual([]);
    expect(frames()).toEqual({});
    expect(removePanel).toHaveBeenCalledWith(first);
  });

  it("opens the dialog on toggle when none of the kind is presented", async () => {
    const panelId = await openDialog({ toggle: true });
    expect(dialogStack()).toEqual([panelId]);
  });

  it("does not close a dialog of the kind that another dialog sits above", async () => {
    const bottom = await openDialog({});
    await usePanelDialogStore.getState().pushPanelDialog({ kind: "diff" }, bottom);
    const stackBefore = dialogStack();

    expect(await openDialog({ toggle: true })).toBe(bottom);
    expect(dialogStack()).toEqual(stackBefore);
    expect(removePanel).not.toHaveBeenCalled();
  });

  it("neither returns nor toggles closed a dialog of the kind for another worktree", async () => {
    const active = await openDialog({});

    const other = await openDialog({ worktreeId: "wt-1", toggle: true });

    expect(other).not.toBe(active);
    expect(dialogStack()).toEqual([other]);
    expect(frames()[other]?.worktreeId).toBe("wt-1");
  });

  it("refuses a PTY-backed kind before touching the open dialogs", async () => {
    await usePanelDialogStore.getState().openPanelDialog({ kind: "review", requestedId: "r1" });
    registryMock.getPanelKindConfig.mockReturnValue({
      id: "acme.shell",
      extensionId: "acme",
      hasPty: true,
    });

    await expect(setup({ kind: "acme.shell", presentation: "dialog" })).rejects.toThrow(
      /PTY-backed/
    );
    expect(dialogStack()).toEqual(["r1"]);
    expect(addPanel).toHaveBeenCalledTimes(1);
  });

  it("replaces a dialog of another kind", async () => {
    await usePanelDialogStore.getState().openPanelDialog({ kind: "review", requestedId: "r1" });

    const panelId = await openDialog({});

    expect(dialogStack()).toEqual([panelId]);
    expect(removePanel).toHaveBeenCalledWith("r1");
  });

  it("still validates the worktree before presenting", async () => {
    await expect(
      setup({ kind: "acme.dash", presentation: "dialog", worktreeId: "wt-other" })
    ).rejects.toThrow(/does not belong to the current project/);
    expect(dialogStack()).toEqual([]);
  });

  it("throws when the dialog panel cannot be created", async () => {
    addPanel.mockResolvedValue(null);
    await expect(setup({ kind: "acme.dash", presentation: "dialog" })).rejects.toThrow(
      /Failed to open plugin panel/
    );
    expect(dialogStack()).toEqual([]);
  });

  it("rejects an unknown size", async () => {
    await expect(
      setup({ kind: "acme.dash", presentation: "dialog", size: "huge" })
    ).rejects.toThrow();
    expect(addPanel).not.toHaveBeenCalled();
  });

  it.each([{ toggle: true }, { size: "workspace" }, { presentation: "panel", toggle: true }])(
    "rejects dialog-only args without presentation: dialog (%o)",
    async (extra) => {
      await expect(setup({ kind: "acme.dash", ...extra })).rejects.toThrow(/only with/);
      expect(activateTerminal).not.toHaveBeenCalled();
      expect(addPanel).not.toHaveBeenCalled();
    }
  );

  it("accepts toggle: false on a panel open", async () => {
    const result = await setup({ kind: "acme.dash", toggle: false });
    expect(result).toEqual({ panelId: "p-grid" });
  });
});

function focus(panelId: string) {
  const actions: ActionRegistry = new Map();
  registerPanelCoreActions(actions, {} as unknown as ActionCallbacks);
  const factory = actions.get("panel.focus");
  if (!factory) throw new Error("panel.focus not registered");
  return (factory() as AnyActionDefinition).run({ panelId }, {} as never);
}

/** `focusedId` is the SELECTION pointer; DOM focus is tracked separately. */
function seedPanels(focusedId: string | null) {
  panelStoreMock.getState.mockReturnValue({
    panelsById: {
      "panel-a": { id: "panel-a", location: "grid" },
      "panel-gone": { id: "panel-gone", location: "trash" },
    },
    focusedId,
    activateTerminal,
  });
}

describe("panel.focus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    focusPanelInput.mockReturnValue(true);
    seedPanels(null);
  });

  it("selects the panel and hands it DOM focus", async () => {
    await focus("panel-a");

    expect(activateTerminal).toHaveBeenCalledWith("panel-a");
    expect(focusPanelInput).toHaveBeenCalledWith("panel-a");
  });

  it("still re-focuses a panel that is already the selected one", async () => {
    // The regression: selection and focus are separate states. Clicking a run
    // that is already selected but whose keyboard focus has drifted elsewhere
    // (the worktree list, the sidebar) leaves `activateTerminal` with nothing
    // to change, so the pane's focus effect never re-runs and the click does
    // visibly nothing.
    seedPanels("panel-a");

    await focus("panel-a");

    expect(focusPanelInput).toHaveBeenCalledWith("panel-a");
  });

  it("rejects a panel that no longer exists rather than focusing nothing", async () => {
    await expect(focus("panel-missing")).rejects.toThrow();
    expect(focusPanelInput).not.toHaveBeenCalled();
  });

  it("rejects a trashed panel", async () => {
    await expect(focus("panel-gone")).rejects.toThrow();
    expect(activateTerminal).not.toHaveBeenCalled();
    expect(focusPanelInput).not.toHaveBeenCalled();
  });

  it("does not fail when the pane cannot take focus yet", async () => {
    // A pane that is not mounted reports false. That path is covered by its
    // own mount-time effect, so the action must not treat it as an error.
    focusPanelInput.mockReturnValue(false);

    await expect(focus("panel-a")).resolves.not.toThrow();
    expect(activateTerminal).toHaveBeenCalledWith("panel-a");
  });
});

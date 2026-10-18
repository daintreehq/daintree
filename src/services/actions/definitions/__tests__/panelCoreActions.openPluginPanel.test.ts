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
}));
vi.mock("@/components/Panel/panelFocusRegistry", () => ({ focusPanelInput }));

import { registerPanelCoreActions } from "../panelCoreActions";
import { usePanelDialogStore } from "@/store/panelDialogStore";

const addPanel = vi.fn();
const activateTerminal = vi.fn();
const removePanel = vi.fn();

/** Worktrees the current project owns, as `callbacks.getWorktrees()` sees them. */
let worktrees: Array<{ id: string }> = [];

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

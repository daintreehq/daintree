// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const registryMock = vi.hoisted(() => ({ getPanelKindConfig: vi.fn() }));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/diagnosticsStore", () => ({ useDiagnosticsStore: { getState: vi.fn() } }));
vi.mock("@/store/errorStore", () => ({ useErrorStore: { getState: vi.fn() } }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: { getState: vi.fn() } }));
vi.mock("@shared/config/panelKindRegistry", () => ({
  getPanelKindConfig: registryMock.getPanelKindConfig,
}));

import { registerPanelCoreActions } from "../panelCoreActions";

const addPanel = vi.fn();
const activateTerminal = vi.fn();

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

describe("panel.openPluginPanel", () => {
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

  it("rejects rather than falling back to the active worktree", async () => {
    await expect(setup({ kind: "acme.dash", worktreeId: "wt-other" })).rejects.toThrow();
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("rejects a supplied worktreeId when no worktrees have loaded yet", async () => {
    // Membership can't be established, so it can't be granted — bypassing the
    // check on an empty list would re-admit arbitrary ids.
    worktrees = [];
    await expect(setup({ kind: "acme.dash", worktreeId: "wt-1" })).rejects.toThrow(
      /does not belong to the current project/
    );
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("does not consult the worktree list when no worktreeId is supplied", async () => {
    // The default path must keep working while a project is still loading.
    worktrees = [];
    await setup({ kind: "acme.dash" });
    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel.mock.calls[0]![0].worktreeId).toBe("wt-active");
  });

  it("does not reuse a panel in a foreign worktree by rejecting before the lookup", async () => {
    panelStoreMock.getState.mockReturnValue({
      panelIds: ["p-foreign"],
      panelsById: {
        "p-foreign": {
          id: "p-foreign",
          kind: "acme.dash",
          worktreeId: "wt-other",
          location: "grid",
        },
      },
      addPanel,
      activateTerminal,
    });

    await expect(setup({ kind: "acme.dash", worktreeId: "wt-other" })).rejects.toThrow();
    expect(activateTerminal).not.toHaveBeenCalled();
  });
});

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

function setup(args?: unknown) {
  const actions: ActionRegistry = new Map();
  const callbacks = {
    getActiveWorktreeId: () => "wt-active",
  } as unknown as ActionCallbacks;
  registerPanelCoreActions(actions, callbacks);
  const factory = actions.get("panel.openPluginPanel");
  if (!factory) throw new Error("panel.openPluginPanel not registered");
  const def = factory() as AnyActionDefinition;
  return def.run(args, {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
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
});

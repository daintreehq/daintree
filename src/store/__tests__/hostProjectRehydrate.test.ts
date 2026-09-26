// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, drafts, selection } = vi.hoisted(() => {
  const store = {
    panelsById: {} as Record<string, Record<string, unknown>>,
    addPanel: vi.fn(async (args: { requestedId?: string; kind?: string }) => {
      const id = args.requestedId ?? "new";
      store.panelsById[id] = { id, kind: args.kind };
      return id;
    }),
    restoreTerminalOrder: vi.fn(),
    hydrateTabGroups: vi.fn(),
    removePanel: vi.fn(),
  };
  const drafts = {
    local: {} as Record<string, string>,
    getProjectDraftInputs: vi.fn(() => ({ ...drafts.local })),
    restoreProjectDraftInputs: vi.fn(),
  };
  const selection = { setActiveWorktree: vi.fn() };
  return { store, drafts, selection };
});

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => store } }));
vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: { getState: () => drafts },
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => selection },
}));
vi.mock("@/utils/stateHydration/statePatcher", () => ({
  inferKind: (saved: { kind?: string }) => saved.kind ?? "terminal",
  buildArgsForNonPtyRecreation: (saved: { id: string; location?: string }, kind: string) => ({
    kind,
    requestedId: saved.id,
    location: saved.location,
  }),
}));

import { rehydrateHostProjectState } from "../hostProjectRehydrate";
import {
  resetStoreAccessorsForTesting,
  setWorktreeIdSetAccessor,
  setWorktreeSelectionAccessor,
} from "../storeAccessors";

const hydrate = vi.fn();

function hostSaved(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "proj-1",
    project: { id: "proj-1", path: "/srv/proj-1" },
    appState: {
      activeWorktreeId: "wt-feature",
      terminals: [
        { id: "t1", kind: "terminal", location: "grid" },
        { id: "browser-1", kind: "browser", location: "grid" },
        { id: "notes", kind: "file", location: "dock" },
        { id: "gone", kind: "browser", location: "trash" },
      ],
    },
    tabGroups: [{ id: "g1", location: "grid", panelIds: ["t1", "browser-1"] }],
    draftInputs: { t1: "host draft", t2: "only on the host" },
    ...overrides,
  };
}

const current = () => true;

beforeEach(() => {
  vi.clearAllMocks();
  store.panelsById = {
    t1: { id: "t1", kind: "terminal" },
    local: { id: "local", kind: "browser" },
  };
  drafts.local = { t1: "typed here" };
  resetStoreAccessorsForTesting();
  setWorktreeSelectionAccessor(() => ({ activeWorktreeId: "wt-main", restoreWorktreeId: null }));
  setWorktreeIdSetAccessor(() => new Set(["wt-main", "wt-feature"]));
  Object.defineProperty(window, "electron", {
    value: { app: { hydrate } },
    writable: true,
    configurable: true,
  });
});

describe("rehydrateHostProjectState", () => {
  it("after a takeover: shows the host's saved panels in its order, groups, worktree and drafts, keeping everything live", async () => {
    hydrate.mockResolvedValue(hostSaved());
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });

    // Only the panels the view lacks, never a terminal (that would start a process) or a trashed one.
    expect(store.addPanel.mock.calls.map(([args]) => args.requestedId)).toEqual([
      "browser-1",
      "notes",
    ]);
    expect(store.addPanel.mock.calls[1]![0]).toMatchObject({
      location: "dock",
      bypassLimits: true,
    });
    expect(store.removePanel).not.toHaveBeenCalled();
    expect(store.restoreTerminalOrder).toHaveBeenCalledWith(["t1", "browser-1", "notes"]);
    expect(store.hydrateTabGroups).toHaveBeenCalledWith(
      [{ id: "g1", location: "grid", panelIds: ["t1", "browser-1"] }],
      { skipPersist: true }
    );
    expect(selection.setActiveWorktree).toHaveBeenCalledWith("wt-feature", { persist: false });
    // Drafts are host-owned: the host's wins.
    expect(drafts.restoreProjectDraftInputs).toHaveBeenCalledWith("proj-1", {
      t1: "host draft",
      t2: "only on the host",
    });
  });

  it("for the driver back on a fresh session: fills in what's missing, keeping what it changed while away", async () => {
    hydrate.mockResolvedValue(hostSaved());
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: false });

    expect(store.addPanel).toHaveBeenCalledTimes(2);
    expect(store.restoreTerminalOrder).not.toHaveBeenCalled();
    expect(store.hydrateTabGroups).not.toHaveBeenCalled();
    expect(selection.setActiveWorktree).not.toHaveBeenCalled();
    expect(drafts.restoreProjectDraftInputs).toHaveBeenCalledWith("proj-1", {
      t2: "only on the host",
    });
  });

  it("never overwrites a draft typed while the host's answer was on its way", async () => {
    hydrate.mockImplementation(async () => {
      drafts.local = { t1: "typed after taking over" };
      return hostSaved();
    });
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });
    expect(drafts.restoreProjectDraftInputs).toHaveBeenCalledWith("proj-1", {
      t2: "only on the host",
    });
  });

  it("ignores a worktree this view doesn't know", async () => {
    hydrate.mockResolvedValue(
      hostSaved({ appState: { activeWorktreeId: "wt-unknown", terminals: [] } })
    );
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });
    expect(selection.setActiveWorktree).not.toHaveBeenCalled();
  });

  it("applies nothing for another workspace's answer or once overtaken", async () => {
    hydrate.mockResolvedValue(hostSaved({ workspaceId: "proj-2" }));
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });
    hydrate.mockResolvedValue(hostSaved());
    await rehydrateHostProjectState("proj-1", { isCurrent: () => false, authoritative: true });

    expect(store.addPanel).not.toHaveBeenCalled();
    expect(store.hydrateTabGroups).not.toHaveBeenCalled();
    expect(drafts.restoreProjectDraftInputs).not.toHaveBeenCalled();
  });
});

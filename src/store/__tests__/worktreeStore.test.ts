import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@shared/types/panel";

const {
  appSetStateMock,
  applyRendererPolicyMock,
  recordMruMock,
  setFocusedMock,
  logErrorWithContextMock,
  focusStateGetterMock,
  subscribeMock,
  panelSetStateMock,
} = vi.hoisted(() => ({
  appSetStateMock: vi.fn().mockResolvedValue(undefined),
  applyRendererPolicyMock: vi.fn(),
  recordMruMock: vi.fn(),
  setFocusedMock: vi.fn(),
  logErrorWithContextMock: vi.fn(),
  focusStateGetterMock: vi.fn(() => ({ isFocusMode: false })),
  subscribeMock: vi.fn(() => vi.fn()),
  panelSetStateMock: vi.fn(),
}));

type MockTerminal = {
  id: string;
  worktreeId?: string;
  location?: "grid" | "dock" | "trash" | "background";
};
const terminalStoreState = {
  panelsById: {} as Record<string, MockTerminal>,
  panelIds: [] as string[],
  activeDockTerminalId: null as string | null,
  focusedId: null as string | null,
  mruList: [] as string[],
  maximizedId: null as string | null,
  maximizeTarget: null as { type: string; id: string } | null,
  preMaximizeLayout: null as { gridCols: number } | null,
  recordMru: recordMruMock,
  setFocused: setFocusedMock,
};
panelSetStateMock.mockImplementation((patch: Record<string, unknown>) => {
  Object.assign(terminalStoreState, patch);
});
function setMockTerminals(terminals: MockTerminal[]) {
  terminalStoreState.panelsById = Object.fromEntries(terminals.map((t) => [t.id, t]));
  terminalStoreState.panelIds = terminals.map((t) => t.id);
}

vi.mock("@/clients", () => ({
  appClient: {
    setState: appSetStateMock,
  },
  projectClient: {
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    applyRendererPolicy: applyRendererPolicyMock,
  },
}));

vi.mock("@/utils/errorContext", () => ({
  logErrorWithContext: logErrorWithContextMock,
}));

vi.mock("@/store/focusStore", () => ({
  useFocusStore: {
    getState: focusStateGetterMock,
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: vi.fn(() => terminalStoreState),
    setState: panelSetStateMock,
    subscribe: subscribeMock,
  },
}));

import {
  useWorktreeSelectionStore,
  setFleetArmedIdsGetter,
  setFleetLastArmedIdGetter,
} from "../worktreeStore";

let armedIdsForFleet = new Set<string>();
setFleetArmedIdsGetter(() => armedIdsForFleet);
let lastArmedIdForFleet: string | null = null;
setFleetLastArmedIdGetter(() => lastArmedIdForFleet);

describe("worktreeStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorktreeSelectionStore.getState().reset();
    terminalStoreState.panelsById = {};
    terminalStoreState.panelIds = [];
    terminalStoreState.activeDockTerminalId = null;
    terminalStoreState.focusedId = null;
    terminalStoreState.mruList = [];
    terminalStoreState.maximizedId = null;
    terminalStoreState.maximizeTarget = null;
    terminalStoreState.preMaximizeLayout = null;
    // clearAllMocks() wipes the panelSetStateMock implementation too, so
    // reinstall it on every test — otherwise panelSetStateMock becomes a
    // noop and the maximize-clear assertions silently miss behavior drift.
    panelSetStateMock.mockImplementation((patch: Record<string, unknown>) => {
      Object.assign(terminalStoreState, patch);
    });
    focusStateGetterMock.mockReturnValue({ isFocusMode: false });
  });

  it("openCreateDialog does not throw when window is unavailable", () => {
    const originalWindow = (globalThis as { window?: Window }).window;
    // @ts-expect-error - test intentionally removes browser global
    delete globalThis.window;

    focusStateGetterMock.mockReturnValue({ isFocusMode: true });

    expect(() =>
      useWorktreeSelectionStore.getState().openCreateDialog({
        number: 123,
        title: "x",
        url: "https://github.com/org/repo/issues/123",
        state: "OPEN",
        updatedAt: new Date().toISOString(),
        author: { login: "tester", avatarUrl: "https://example.com/avatar.png" },
        assignees: [],
        commentCount: 0,
      })
    ).not.toThrow();

    if (originalWindow) {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
        writable: true,
      });
    }
  });

  it("openCreateDialogForPR opens dialog with PR context and clears issue context", () => {
    const pr = {
      number: 99,
      title: "PR title",
      url: "https://github.com/org/repo/pull/99",
      state: "OPEN" as const,
      isDraft: false,
      updatedAt: new Date().toISOString(),
      author: { login: "alice", avatarUrl: "" },
      headRefName: "feature/pr-branch",
      isFork: false,
    };

    useWorktreeSelectionStore.getState().openCreateDialogForPR(pr);

    const { createDialog } = useWorktreeSelectionStore.getState();
    expect(createDialog.isOpen).toBe(true);
    expect(createDialog.initialPR).toEqual(pr);
    expect(createDialog.initialIssue).toBeNull();
  });

  it("openCreateDialog clears PR context when opening for an issue", () => {
    const pr = {
      number: 99,
      title: "PR title",
      url: "https://github.com/org/repo/pull/99",
      state: "OPEN" as const,
      isDraft: false,
      updatedAt: new Date().toISOString(),
      author: { login: "alice", avatarUrl: "" },
      headRefName: "feature/pr-branch",
    };
    useWorktreeSelectionStore.getState().openCreateDialogForPR(pr);

    const issue = {
      number: 123,
      title: "Issue title",
      url: "https://github.com/org/repo/issues/123",
      state: "OPEN" as const,
      updatedAt: new Date().toISOString(),
      author: { login: "bob", avatarUrl: "" },
      assignees: [],
      commentCount: 0,
    };
    useWorktreeSelectionStore.getState().openCreateDialog(issue);

    const { createDialog } = useWorktreeSelectionStore.getState();
    expect(createDialog.initialIssue).toEqual(issue);
    expect(createDialog.initialPR).toBeNull();
  });

  it("closeCreateDialog clears both issue and PR context", () => {
    const pr = {
      number: 99,
      title: "PR title",
      url: "https://github.com/org/repo/pull/99",
      state: "OPEN" as const,
      isDraft: false,
      updatedAt: new Date().toISOString(),
      author: { login: "alice", avatarUrl: "" },
    };
    useWorktreeSelectionStore.getState().openCreateDialogForPR(pr);
    useWorktreeSelectionStore.getState().closeCreateDialog();

    const { createDialog } = useWorktreeSelectionStore.getState();
    expect(createDialog.isOpen).toBe(false);
    expect(createDialog.initialPR).toBeNull();
    expect(createDialog.initialIssue).toBeNull();
  });

  it("openCreateDialogForPR does not throw when window is unavailable", () => {
    const originalWindow = (globalThis as { window?: Window }).window;
    // @ts-expect-error - test intentionally removes browser global
    delete globalThis.window;

    focusStateGetterMock.mockReturnValue({ isFocusMode: true });

    expect(() =>
      useWorktreeSelectionStore.getState().openCreateDialogForPR({
        number: 5,
        title: "fork pr",
        url: "https://github.com/org/repo/pull/5",
        state: "OPEN",
        isDraft: false,
        updatedAt: new Date().toISOString(),
        author: { login: "tester", avatarUrl: "" },
      })
    ).not.toThrow();

    if (originalWindow) {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
        writable: true,
      });
    }
  });

  it("clears stale pending worktree selection without reapplying renderer policy", async () => {
    useWorktreeSelectionStore.setState({
      activeWorktreeId: "wt-b",
      pendingWorktreeId: "wt-a",
      _policyGeneration: 4,
    });

    useWorktreeSelectionStore.getState().applyPendingWorktreeSelection("wt-a");
    await Promise.resolve();
    await Promise.resolve();

    expect(useWorktreeSelectionStore.getState().pendingWorktreeId).toBeNull();
    expect(applyRendererPolicyMock).not.toHaveBeenCalled();
  });

  it("applies pending worktree selection only for the still-active worktree", async () => {
    setMockTerminals([
      { id: "term-a", worktreeId: "wt-a", location: "grid" },
      { id: "term-b", worktreeId: "wt-b", location: "grid" },
      { id: "dock-global", location: "dock" },
    ]);
    useWorktreeSelectionStore.setState({
      activeWorktreeId: "wt-a",
      pendingWorktreeId: "wt-a",
      _policyGeneration: 7,
    });

    useWorktreeSelectionStore.getState().applyPendingWorktreeSelection("wt-a");
    await vi.waitFor(() => {
      expect(applyRendererPolicyMock).toHaveBeenCalledTimes(3);
    });

    expect(useWorktreeSelectionStore.getState().pendingWorktreeId).toBeNull();
    expect(applyRendererPolicyMock.mock.calls).toEqual([
      ["term-a", TerminalRefreshTier.VISIBLE],
      ["term-b", TerminalRefreshTier.BACKGROUND],
      ["dock-global", TerminalRefreshTier.BACKGROUND],
    ]);
  });

  it("ignores stale renderer policy work from an earlier selection", async () => {
    setMockTerminals([
      { id: "term-a", worktreeId: "wt-a", location: "grid" },
      { id: "term-b", worktreeId: "wt-b", location: "grid" },
    ]);

    useWorktreeSelectionStore.getState().selectWorktree("wt-a");
    useWorktreeSelectionStore.getState().selectWorktree("wt-b");
    await vi.waitFor(() => {
      expect(applyRendererPolicyMock).toHaveBeenCalledTimes(2);
    });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-b");
    expect(applyRendererPolicyMock.mock.calls).toEqual([
      ["term-a", TerminalRefreshTier.BACKGROUND],
      ["term-b", TerminalRefreshTier.VISIBLE],
    ]);
  });

  it("setActiveWorktree syncs focusedWorktreeId to clear stale focus", () => {
    useWorktreeSelectionStore.setState({
      activeWorktreeId: "wt-a",
      focusedWorktreeId: "wt-b",
      expandedTerminals: new Set(["t1"]),
    });

    useWorktreeSelectionStore.getState().setActiveWorktree("wt-a");

    const state = useWorktreeSelectionStore.getState();
    expect(state.activeWorktreeId).toBe("wt-a");
    expect(state.focusedWorktreeId).toBe("wt-a");
    // Same-ID path preserves expandedTerminals
    expect(state.expandedTerminals.has("t1")).toBe(true);
  });

  it("setActiveWorktree(null) clears both activeWorktreeId and focusedWorktreeId", () => {
    useWorktreeSelectionStore.setState({
      activeWorktreeId: "wt-a",
      focusedWorktreeId: "wt-a",
    });

    useWorktreeSelectionStore.getState().setActiveWorktree(null);

    const state = useWorktreeSelectionStore.getState();
    expect(state.activeWorktreeId).toBeNull();
    expect(state.focusedWorktreeId).toBeNull();
  });

  it("does not restore stale terminal focus after a newer worktree selection wins", async () => {
    setMockTerminals([
      { id: "term-a", worktreeId: "wt-a", location: "grid" },
      { id: "term-b", worktreeId: "wt-b", location: "grid" },
    ]);
    useWorktreeSelectionStore.getState().trackTerminalFocus("wt-a", "term-a");

    useWorktreeSelectionStore.getState().selectWorktree("wt-a");
    useWorktreeSelectionStore.getState().selectWorktree("wt-b");
    await Promise.resolve();
    await Promise.resolve();

    expect(setFocusedMock).not.toHaveBeenCalledWith("term-a");
  });

  describe("fleet scope", () => {
    it("starts inactive with no previous worktree captured", () => {
      const state = useWorktreeSelectionStore.getState();
      expect(state.isFleetScopeActive).toBe(false);
      expect(state._previousActiveWorktreeId).toBeNull();
    });

    it("enterFleetScope captures current activeWorktreeId", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-active" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      const state = useWorktreeSelectionStore.getState();
      expect(state.isFleetScopeActive).toBe(true);
      expect(state._previousActiveWorktreeId).toBe("wt-active");
    });

    it("enterFleetScope is idempotent — repeated calls preserve the original capture", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-original" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-changed" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      expect(useWorktreeSelectionStore.getState()._previousActiveWorktreeId).toBe("wt-original");
    });

    it("exitFleetScope restores the previously captured activeWorktreeId", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-original" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      useWorktreeSelectionStore.getState().exitFleetScope();
      const state = useWorktreeSelectionStore.getState();
      expect(state.isFleetScopeActive).toBe(false);
      expect(state._previousActiveWorktreeId).toBeNull();
      expect(state.activeWorktreeId).toBe("wt-original");
    });

    it("exitFleetScope persists the restored activeWorktreeId", async () => {
      // Unique id to avoid module-level persistActiveWorktree dedup bleeding
      // from earlier tests that touched "wt-original" via setActiveWorktree.
      const restoreId = "wt-fleet-exit-persist";
      useWorktreeSelectionStore.setState({ activeWorktreeId: restoreId });
      useWorktreeSelectionStore.getState().enterFleetScope();
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      appSetStateMock.mockClear();
      useWorktreeSelectionStore.getState().exitFleetScope();
      // persistActiveWorktree loads the clients module via dynamic import,
      // so the setState call is deferred to a microtask.
      await Promise.resolve();
      await Promise.resolve();
      expect(appSetStateMock).toHaveBeenCalledWith({ activeWorktreeId: restoreId });
    });

    it("exitFleetScope reapplies terminal streaming policy for the restored worktree", async () => {
      setMockTerminals([
        { id: "term-a", worktreeId: "wt-original", location: "grid" },
        { id: "term-b", worktreeId: "wt-other", location: "grid" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-original" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      applyRendererPolicyMock.mockClear();
      useWorktreeSelectionStore.getState().exitFleetScope();
      await Promise.resolve();
      await Promise.resolve();
      expect(applyRendererPolicyMock).toHaveBeenCalledWith("term-a", TerminalRefreshTier.VISIBLE);
      expect(applyRendererPolicyMock).toHaveBeenCalledWith(
        "term-b",
        TerminalRefreshTier.BACKGROUND
      );
    });

    it("exitFleetScope is a no-op when scope is not active", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-current" });
      useWorktreeSelectionStore.getState().exitFleetScope();
      const state = useWorktreeSelectionStore.getState();
      expect(state.isFleetScopeActive).toBe(false);
      expect(state.activeWorktreeId).toBe("wt-current");
    });

    it("reset clears fleet scope state", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-active" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      useWorktreeSelectionStore.getState().reset();
      const state = useWorktreeSelectionStore.getState();
      expect(state.isFleetScopeActive).toBe(false);
      expect(state._previousActiveWorktreeId).toBeNull();
    });

    it("enterFleetScope clears any active maximize so the scope grid is visible", async () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-with-maximize" });
      terminalStoreState.maximizedId = "term-maxed";
      terminalStoreState.maximizeTarget = { type: "panel", id: "term-maxed" };
      terminalStoreState.preMaximizeLayout = { gridCols: 2 };

      useWorktreeSelectionStore.getState().enterFleetScope();
      await Promise.resolve();
      await Promise.resolve();

      expect(panelSetStateMock).toHaveBeenCalledWith({
        maximizedId: null,
        maximizeTarget: null,
        preMaximizeLayout: null,
      });
      expect(terminalStoreState.maximizedId).toBeNull();
      expect(terminalStoreState.maximizeTarget).toBeNull();
      expect(terminalStoreState.preMaximizeLayout).toBeNull();
    });

    it("exitFleetScope clears any lingering preMaximizeLayout snapshot", async () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre-scope" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      await Promise.resolve();
      await Promise.resolve();

      terminalStoreState.preMaximizeLayout = { gridCols: 3 };
      panelSetStateMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope();
      await Promise.resolve();
      await Promise.resolve();

      expect(panelSetStateMock).toHaveBeenCalledWith({ preMaximizeLayout: null });
      expect(terminalStoreState.preMaximizeLayout).toBeNull();
    });

    it("enterFleetScope's deferred maximize-clear bails if scope was exited first", async () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-race" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      // Exit scope synchronously before the deferred .then() resolves.
      useWorktreeSelectionStore.getState().exitFleetScope();

      // Simulate the user manually re-maximizing a panel after the exit.
      terminalStoreState.maximizedId = "term-user-maxed";
      terminalStoreState.maximizeTarget = { type: "panel", id: "term-user-maxed" };
      panelSetStateMock.mockClear();

      // Flush the microtask queue so the deferred import/then runs.
      await Promise.resolve();
      await Promise.resolve();

      // The enterFleetScope .then() MUST NOT wipe the user's new maximize.
      expect(panelSetStateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ maximizedId: null })
      );
      expect(terminalStoreState.maximizedId).toBe("term-user-maxed");
    });

    it("exitFleetScope focuses the primary armed terminal when it lives in the restore worktree", async () => {
      setMockTerminals([
        { id: "term-active", worktreeId: "wt-pre", location: "grid" },
        { id: "term-primary", worktreeId: "wt-pre", location: "grid" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      lastArmedIdForFleet = "term-primary";
      setFocusedMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope();
      await Promise.resolve();
      await Promise.resolve();

      expect(setFocusedMock).toHaveBeenCalledWith("term-primary");
      lastArmedIdForFleet = null;
    });

    it("exitFleetScope does not call setFocused when lastArmedId is null", async () => {
      setMockTerminals([{ id: "term-active", worktreeId: "wt-pre", location: "grid" }]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      lastArmedIdForFleet = null;
      setFocusedMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope();
      await Promise.resolve();
      await Promise.resolve();

      expect(setFocusedMock).not.toHaveBeenCalled();
    });

    it("exitFleetScope does not focus a cross-worktree primary — avoids orchestrator switch-back", async () => {
      // Restoring `activeWorktreeId` to `wt-pre` then focusing a terminal in
      // `wt-other` would trigger rendererStoreOrchestrator's focusedId
      // subscription, which calls selectWorktree(terminal.worktreeId) and
      // undoes the scope-exit restore.
      setMockTerminals([
        { id: "term-active", worktreeId: "wt-pre", location: "grid" },
        { id: "term-primary", worktreeId: "wt-other", location: "grid" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      lastArmedIdForFleet = "term-primary";
      setFocusedMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope();
      await Promise.resolve();
      await Promise.resolve();

      expect(setFocusedMock).not.toHaveBeenCalledWith("term-primary");
      lastArmedIdForFleet = null;
    });

    it("exitFleetScope skips focus restore when the primary terminal is trashed", async () => {
      setMockTerminals([
        { id: "term-active", worktreeId: "wt-pre", location: "grid" },
        { id: "term-primary", worktreeId: "wt-pre", location: "trash" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      lastArmedIdForFleet = "term-primary";
      setFocusedMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope();
      await Promise.resolve();
      await Promise.resolve();

      expect(setFocusedMock).not.toHaveBeenCalled();
      lastArmedIdForFleet = null;
    });

    it("exitFleetScope skips focus restore when the primary terminal is docked", async () => {
      setMockTerminals([
        { id: "term-active", worktreeId: "wt-pre", location: "grid" },
        { id: "term-primary", worktreeId: "wt-pre", location: "dock" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      lastArmedIdForFleet = "term-primary";
      setFocusedMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope();
      await Promise.resolve();
      await Promise.resolve();

      expect(setFocusedMock).not.toHaveBeenCalled();
      lastArmedIdForFleet = null;
    });

    it("exitFleetScope skips focus restore if policy generation advances first", async () => {
      setMockTerminals([
        { id: "term-active", worktreeId: "wt-pre", location: "grid" },
        { id: "term-primary", worktreeId: "wt-pre", location: "grid" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre" });
      useWorktreeSelectionStore.getState().enterFleetScope();
      lastArmedIdForFleet = "term-primary";
      setFocusedMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope();
      // Simulate a newer store change (e.g. another worktree switch) that
      // bumps _policyGeneration before the deferred focus-restore resolves.
      useWorktreeSelectionStore.setState((s) => ({ _policyGeneration: s._policyGeneration + 5 }));
      await Promise.resolve();
      await Promise.resolve();

      expect(setFocusedMock).not.toHaveBeenCalledWith("term-primary");
      lastArmedIdForFleet = null;
    });

    it("enterFleetScope pins armed cross-worktree terminals to VISIBLE", async () => {
      setMockTerminals([
        { id: "term-active", worktreeId: "wt-pre-scope", location: "grid" },
        { id: "term-armed-remote", worktreeId: "wt-other", location: "grid" },
        { id: "term-idle-remote", worktreeId: "wt-other", location: "grid" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre-scope" });
      armedIdsForFleet = new Set(["term-armed-remote"]);
      applyRendererPolicyMock.mockClear();

      useWorktreeSelectionStore.getState().enterFleetScope();
      await Promise.resolve();
      await Promise.resolve();

      expect(applyRendererPolicyMock).toHaveBeenCalledWith(
        "term-active",
        TerminalRefreshTier.VISIBLE
      );
      expect(applyRendererPolicyMock).toHaveBeenCalledWith(
        "term-armed-remote",
        TerminalRefreshTier.VISIBLE
      );
      expect(applyRendererPolicyMock).toHaveBeenCalledWith(
        "term-idle-remote",
        TerminalRefreshTier.BACKGROUND
      );
      armedIdsForFleet = new Set();
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@shared/types/panel";
import type { FleetScopeToken } from "@shared/types/worktree";

const {
  appSetStateMock,
  applyRendererPolicyMock,
  wakeMock,
  recordMruMock,
  setFocusedMock,
  logErrorWithContextMock,
  focusStateGetterMock,
  clearSidebarGestureMock,
  subscribeMock,
  panelSetStateMock,
} = vi.hoisted(() => ({
  appSetStateMock: vi.fn().mockResolvedValue(undefined),
  applyRendererPolicyMock: vi.fn(),
  wakeMock: vi.fn(),
  recordMruMock: vi.fn(),
  setFocusedMock: vi.fn(),
  logErrorWithContextMock: vi.fn(),
  focusStateGetterMock: vi.fn(() => ({
    isFocusMode: false,
    gestureSidebarHidden: false,
    gestureAssistantHidden: false,
    clearSidebarGesture: () => {},
  })),
  clearSidebarGestureMock: vi.fn(),
  subscribeMock: vi.fn(() => vi.fn()),
  panelSetStateMock: vi.fn(),
}));

type MockTerminal = {
  id: string;
  kind?: "terminal" | "browser" | "dev-preview" | "notes";
  worktreeId?: string;
  location?: "grid" | "dock" | "trash" | "background";
  hasPty?: boolean;
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
    wake: wakeMock,
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

import { useWorktreeSelectionStore } from "../worktreeStore";
import { setFleetArmedIdsAccessor, setFleetLastArmedIdAccessor } from "../storeAccessors";

let armedIdsForFleet = new Set<string>();
setFleetArmedIdsAccessor(() => armedIdsForFleet);
let lastArmedIdForFleet: string | null = null;
setFleetLastArmedIdAccessor(() => lastArmedIdForFleet);

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
    focusStateGetterMock.mockReturnValue({
      isFocusMode: false,
      gestureSidebarHidden: false,
      gestureAssistantHidden: false,
      clearSidebarGesture: clearSidebarGestureMock,
    });
    clearSidebarGestureMock.mockReset();
  });

  it("openCreateDialog does not throw when window is unavailable", () => {
    const originalWindow = (globalThis as { window?: Window }).window;
    // @ts-expect-error - test intentionally removes browser global
    delete globalThis.window;

    focusStateGetterMock.mockReturnValue({
      isFocusMode: true,
      gestureSidebarHidden: true,
      gestureAssistantHidden: false,
      clearSidebarGesture: clearSidebarGestureMock,
    });

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

  it("openBulkCreateDialog stores onComplete callback", () => {
    const onComplete = vi.fn();
    const issue = {
      number: 1,
      title: "issue",
      url: "https://github.com/org/repo/issues/1",
      state: "OPEN" as const,
      updatedAt: new Date().toISOString(),
      author: { login: "u", avatarUrl: "" },
      assignees: [],
      commentCount: 0,
    };
    useWorktreeSelectionStore.getState().openBulkCreateDialog([issue], onComplete);

    const { bulkCreateDialog } = useWorktreeSelectionStore.getState();
    expect(bulkCreateDialog.isOpen).toBe(true);
    expect(bulkCreateDialog.mode).toBe("issue");
    expect(bulkCreateDialog.onComplete).toBe(onComplete);
  });

  it("openBulkCreateDialogForPRs stores onComplete callback", () => {
    const onComplete = vi.fn();
    const pr = {
      number: 1,
      title: "pr",
      url: "https://github.com/org/repo/pull/1",
      state: "OPEN" as const,
      isDraft: false,
      updatedAt: new Date().toISOString(),
      author: { login: "u", avatarUrl: "" },
      headRefName: "feature/pr",
    };
    useWorktreeSelectionStore.getState().openBulkCreateDialogForPRs([pr], onComplete);

    const { bulkCreateDialog } = useWorktreeSelectionStore.getState();
    expect(bulkCreateDialog.isOpen).toBe(true);
    expect(bulkCreateDialog.mode).toBe("pr");
    expect(bulkCreateDialog.onComplete).toBe(onComplete);
  });

  it("closeBulkCreateDialog clears stored onComplete to prevent stale retention", () => {
    const onComplete = vi.fn();
    useWorktreeSelectionStore.getState().openBulkCreateDialog([], onComplete);
    useWorktreeSelectionStore.getState().closeBulkCreateDialog();

    const { bulkCreateDialog } = useWorktreeSelectionStore.getState();
    expect(bulkCreateDialog.isOpen).toBe(false);
    expect(bulkCreateDialog.onComplete).toBeUndefined();
  });

  it("opening bulk dialog twice replaces onComplete — no stale callback carryover", () => {
    const cbA = vi.fn();
    const cbB = vi.fn();
    useWorktreeSelectionStore.getState().openBulkCreateDialog([], cbA);
    useWorktreeSelectionStore.getState().closeBulkCreateDialog();
    useWorktreeSelectionStore.getState().openBulkCreateDialog([], cbB);

    const { bulkCreateDialog } = useWorktreeSelectionStore.getState();
    expect(bulkCreateDialog.onComplete).toBe(cbB);
    expect(bulkCreateDialog.onComplete).not.toBe(cbA);
  });

  it("openCreateDialogForPR does not throw when window is unavailable", () => {
    const originalWindow = (globalThis as { window?: Window }).window;
    // @ts-expect-error - test intentionally removes browser global
    delete globalThis.window;

    focusStateGetterMock.mockReturnValue({
      isFocusMode: true,
      gestureSidebarHidden: true,
      gestureAssistantHidden: false,
      clearSidebarGesture: clearSidebarGestureMock,
    });

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

  it("clears stale pending worktree selection without reapplying renderer policy", () => {
    useWorktreeSelectionStore.setState({
      activeWorktreeId: "wt-b",
      pendingWorktreeId: "wt-a",
      _policyGeneration: 4,
    });

    useWorktreeSelectionStore.getState().applyPendingWorktreeSelection("wt-a");

    expect(useWorktreeSelectionStore.getState().pendingWorktreeId).toBeNull();
    expect(applyRendererPolicyMock).not.toHaveBeenCalled();
  });

  it("applies pending worktree selection only for the still-active worktree", () => {
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

    expect(applyRendererPolicyMock).toHaveBeenCalledTimes(3);
    expect(useWorktreeSelectionStore.getState().pendingWorktreeId).toBeNull();
    expect(applyRendererPolicyMock.mock.calls).toEqual([
      ["term-a", TerminalRefreshTier.VISIBLE],
      ["term-b", TerminalRefreshTier.BACKGROUND],
      ["dock-global", TerminalRefreshTier.BACKGROUND],
    ]);
    expect(wakeMock).toHaveBeenCalledTimes(1);
    expect(wakeMock).toHaveBeenCalledWith("term-a");
  });

  it("applies renderer policy synchronously per selection, leaving the latest winner correct", async () => {
    setMockTerminals([
      { id: "term-a", worktreeId: "wt-a", location: "grid" },
      { id: "term-b", worktreeId: "wt-b", location: "grid" },
    ]);

    // Post-#8402 the policy runs in-tick, so back-to-back selections each
    // complete fully rather than the first being dropped by a stale-microtask
    // generation guard. The net result must still leave the latest winner
    // (wt-b) VISIBLE and the previous worktree BACKGROUND.
    useWorktreeSelectionStore.getState().selectWorktree("wt-a");
    useWorktreeSelectionStore.getState().selectWorktree("wt-b");

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-b");
    expect(applyRendererPolicyMock.mock.calls).toEqual([
      ["term-a", TerminalRefreshTier.VISIBLE],
      ["term-b", TerminalRefreshTier.BACKGROUND],
      ["term-a", TerminalRefreshTier.BACKGROUND],
      ["term-b", TerminalRefreshTier.VISIBLE],
    ]);
    // The final wake reflects the winning selection.
    expect(wakeMock.mock.calls).toEqual([["term-a"], ["term-b"]]);

    // Proof-by-drain: the old dynamic import left deferred work on the
    // microtask queue. Flushing must produce no additional policy/focus
    // calls — confirming nothing is queued post-#8402.
    const policyCallsBeforeDrain = applyRendererPolicyMock.mock.calls.length;
    const setFocusedCallsBeforeDrain = setFocusedMock.mock.calls.length;
    await Promise.resolve();
    await Promise.resolve();
    expect(applyRendererPolicyMock.mock.calls.length).toBe(policyCallsBeforeDrain);
    expect(setFocusedMock.mock.calls.length).toBe(setFocusedCallsBeforeDrain);
  });

  it("wakes active worktree PTY terminals even when policy tier is already visible", () => {
    setMockTerminals([
      { id: "agent-a", worktreeId: "wt-a", location: "grid", kind: "terminal" },
      { id: "plain-a", worktreeId: "wt-a", location: "grid", kind: "terminal" },
      { id: "browser-a", worktreeId: "wt-a", location: "grid", kind: "browser" },
      { id: "dead-a", worktreeId: "wt-a", location: "grid", kind: "terminal", hasPty: false },
      { id: "term-b", worktreeId: "wt-b", location: "grid", kind: "terminal" },
    ]);

    useWorktreeSelectionStore.getState().selectWorktree("wt-a");

    expect(applyRendererPolicyMock).toHaveBeenCalledTimes(5);

    expect(wakeMock.mock.calls).toEqual([["agent-a"], ["plain-a"]]);
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

  describe("pendingCreations", () => {
    it("addPendingCreation seeds a creating entry keyed by path", () => {
      useWorktreeSelectionStore
        .getState()
        .addPendingCreation("/abs/path", { branch: "feature/foo" });
      const entry = useWorktreeSelectionStore.getState().pendingCreations.get("/abs/path");
      expect(entry).toBeDefined();
      expect(entry?.branch).toBe("feature/foo");
      expect(entry?.status).toBe("creating");
      expect(entry?.startedAt).toBeGreaterThan(0);
    });

    it("addPendingCreation is idempotent for in-flight creations", () => {
      useWorktreeSelectionStore
        .getState()
        .addPendingCreation("/abs/path", { branch: "feature/foo" });
      const firstStartedAt = useWorktreeSelectionStore
        .getState()
        .pendingCreations.get("/abs/path")?.startedAt;
      useWorktreeSelectionStore
        .getState()
        .addPendingCreation("/abs/path", { branch: "feature/bar" });
      const entry = useWorktreeSelectionStore.getState().pendingCreations.get("/abs/path");
      // First write wins for in-flight; branch and startedAt unchanged.
      expect(entry?.branch).toBe("feature/foo");
      expect(entry?.startedAt).toBe(firstStartedAt);
    });

    it("addPendingCreation replaces an error entry so retry resets status", () => {
      useWorktreeSelectionStore
        .getState()
        .addPendingCreation("/abs/path", { branch: "feature/foo" });
      useWorktreeSelectionStore.getState().failPendingCreation("/abs/path", "boom");
      useWorktreeSelectionStore
        .getState()
        .addPendingCreation("/abs/path", { branch: "feature/foo" });
      const entry = useWorktreeSelectionStore.getState().pendingCreations.get("/abs/path");
      expect(entry?.status).toBe("creating");
      expect(entry?.error).toBeUndefined();
    });

    it("resolvePendingCreation removes the entry", () => {
      useWorktreeSelectionStore
        .getState()
        .addPendingCreation("/abs/path", { branch: "feature/foo" });
      useWorktreeSelectionStore.getState().resolvePendingCreation("/abs/path");
      expect(useWorktreeSelectionStore.getState().pendingCreations.has("/abs/path")).toBe(false);
    });

    it("resolvePendingCreation is a no-op when no entry matches", () => {
      const before = useWorktreeSelectionStore.getState().pendingCreations;
      useWorktreeSelectionStore.getState().resolvePendingCreation("/unknown");
      // No state churn — same Map reference.
      expect(useWorktreeSelectionStore.getState().pendingCreations).toBe(before);
    });

    it("failPendingCreation flips status to error and records the message", () => {
      useWorktreeSelectionStore
        .getState()
        .addPendingCreation("/abs/path", { branch: "feature/foo" });
      useWorktreeSelectionStore.getState().failPendingCreation("/abs/path", "permission denied");
      const entry = useWorktreeSelectionStore.getState().pendingCreations.get("/abs/path");
      expect(entry?.status).toBe("error");
      expect(entry?.error).toBe("permission denied");
    });

    it("failPendingCreation on an unknown path is a no-op", () => {
      const before = useWorktreeSelectionStore.getState().pendingCreations;
      useWorktreeSelectionStore.getState().failPendingCreation("/unknown", "boom");
      expect(useWorktreeSelectionStore.getState().pendingCreations).toBe(before);
    });

    it("dismissPendingCreation removes the entry regardless of status", () => {
      useWorktreeSelectionStore
        .getState()
        .addPendingCreation("/abs/path", { branch: "feature/foo" });
      useWorktreeSelectionStore.getState().failPendingCreation("/abs/path", "boom");
      useWorktreeSelectionStore.getState().dismissPendingCreation("/abs/path");
      expect(useWorktreeSelectionStore.getState().pendingCreations.has("/abs/path")).toBe(false);
    });

    it("reset clears all pending creations", () => {
      useWorktreeSelectionStore.getState().addPendingCreation("/abs/a", { branch: "feature/a" });
      useWorktreeSelectionStore.getState().addPendingCreation("/abs/b", { branch: "feature/b" });
      useWorktreeSelectionStore.getState().reset();
      expect(useWorktreeSelectionStore.getState().pendingCreations.size).toBe(0);
    });
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

  it("restores each worktree's own tracked terminal and does not re-focus the previous one", () => {
    setMockTerminals([
      { id: "term-a", worktreeId: "wt-a", location: "grid" },
      { id: "term-b", worktreeId: "wt-b", location: "grid" },
    ]);
    useWorktreeSelectionStore.getState().trackTerminalFocus("wt-a", "term-a");
    useWorktreeSelectionStore.getState().trackTerminalFocus("wt-b", "term-b");

    // Post-#8402 focus restore runs in-tick: selecting wt-a focuses its own
    // tracked terminal immediately.
    useWorktreeSelectionStore.getState().selectWorktree("wt-a");
    expect(setFocusedMock).toHaveBeenCalledWith("term-a");

    setFocusedMock.mockClear();

    // Switching to wt-b must restore wt-b's terminal, never re-focus wt-a's.
    useWorktreeSelectionStore.getState().selectWorktree("wt-b");
    expect(setFocusedMock).toHaveBeenCalledWith("term-b");
    expect(setFocusedMock).not.toHaveBeenCalledWith("term-a");
  });

  describe("fleet scope", () => {
    it("starts inactive with no previous worktree or token captured", () => {
      const state = useWorktreeSelectionStore.getState();
      expect(state.isFleetScopeActive).toBe(false);
      expect(state._previousActiveWorktreeId).toBeNull();
      expect(state._fleetScopeToken).toBeNull();
    });

    it("enterFleetScope captures current activeWorktreeId and mints a token", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-active" });
      const token = useWorktreeSelectionStore.getState().enterFleetScope();
      const state = useWorktreeSelectionStore.getState();
      expect(state.isFleetScopeActive).toBe(true);
      expect(state._previousActiveWorktreeId).toBe("wt-active");
      expect(typeof token).toBe("string");
      expect(state._fleetScopeToken).toBe(token);
    });

    it("enterFleetScope is idempotent — repeated calls preserve the capture and return the same token", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-original" });
      const token1 = useWorktreeSelectionStore.getState().enterFleetScope();
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-changed" });
      const token2 = useWorktreeSelectionStore.getState().enterFleetScope();
      expect(useWorktreeSelectionStore.getState()._previousActiveWorktreeId).toBe("wt-original");
      expect(token2).toBe(token1);
    });

    it("exitFleetScope restores the previously captured activeWorktreeId", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-original" });
      const token = useWorktreeSelectionStore.getState().enterFleetScope();
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      useWorktreeSelectionStore.getState().exitFleetScope(token);
      const state = useWorktreeSelectionStore.getState();
      expect(state.isFleetScopeActive).toBe(false);
      expect(state._previousActiveWorktreeId).toBeNull();
      expect(state._fleetScopeToken).toBeNull();
      expect(state.activeWorktreeId).toBe("wt-original");
    });

    it("exitFleetScope with a stale token from a superseded scope is a no-op", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-first" });
      const staleToken = useWorktreeSelectionStore.getState().enterFleetScope();
      useWorktreeSelectionStore.getState().exitFleetScope(staleToken);
      // A fresh scope is entered, minting a new token.
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-second" });
      const liveToken = useWorktreeSelectionStore.getState().enterFleetScope();
      expect(liveToken).not.toBe(staleToken);

      // The stale exit (e.g. its async caller fired late) must not tear down
      // the live scope or restore against the wrong worktree.
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      useWorktreeSelectionStore.getState().exitFleetScope(staleToken);
      const state = useWorktreeSelectionStore.getState();
      expect(state.isFleetScopeActive).toBe(true);
      expect(state._fleetScopeToken).toBe(liveToken);
      expect(state.activeWorktreeId).toBeNull();
    });

    it("exitFleetScope persists the restored activeWorktreeId", async () => {
      // Unique id to avoid module-level persistActiveWorktree dedup bleeding
      // from earlier tests that touched "wt-original" via setActiveWorktree.
      const restoreId = "wt-fleet-exit-persist";
      useWorktreeSelectionStore.setState({ activeWorktreeId: restoreId });
      const token = useWorktreeSelectionStore.getState().enterFleetScope();
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      appSetStateMock.mockClear();
      useWorktreeSelectionStore.getState().exitFleetScope(token);
      // persistActiveWorktree loads the clients module via dynamic import,
      // so the setState call is deferred to a microtask.
      await Promise.resolve();
      await Promise.resolve();
      expect(appSetStateMock).toHaveBeenCalledWith({ activeWorktreeId: restoreId });
    });

    it("exitFleetScope reapplies terminal streaming policy for the restored worktree", () => {
      setMockTerminals([
        { id: "term-a", worktreeId: "wt-original", location: "grid" },
        { id: "term-b", worktreeId: "wt-other", location: "grid" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-original" });
      const token = useWorktreeSelectionStore.getState().enterFleetScope();
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      applyRendererPolicyMock.mockClear();
      useWorktreeSelectionStore.getState().exitFleetScope(token);
      expect(applyRendererPolicyMock).toHaveBeenCalledWith("term-a", TerminalRefreshTier.VISIBLE);
      expect(applyRendererPolicyMock).toHaveBeenCalledWith(
        "term-b",
        TerminalRefreshTier.BACKGROUND
      );
    });

    it("exitFleetScope is a no-op when scope is not active", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-current" });
      useWorktreeSelectionStore
        .getState()
        .exitFleetScope("orphan-token" as unknown as FleetScopeToken);
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
      expect(state._fleetScopeToken).toBeNull();
    });

    it("enterFleetScope clears any active maximize so the scope grid is visible", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-with-maximize" });
      terminalStoreState.maximizedId = "term-maxed";
      terminalStoreState.maximizeTarget = { type: "panel", id: "term-maxed" };
      terminalStoreState.preMaximizeLayout = { gridCols: 2 };

      useWorktreeSelectionStore.getState().enterFleetScope();

      expect(panelSetStateMock).toHaveBeenCalledWith({
        maximizedId: null,
        maximizeTarget: null,
        preMaximizeLayout: null,
      });
      expect(terminalStoreState.maximizedId).toBeNull();
      expect(terminalStoreState.maximizeTarget).toBeNull();
      expect(terminalStoreState.preMaximizeLayout).toBeNull();
    });

    it("exitFleetScope clears any lingering preMaximizeLayout snapshot", () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre-scope" });
      const token = useWorktreeSelectionStore.getState().enterFleetScope();

      terminalStoreState.preMaximizeLayout = { gridCols: 3 };
      panelSetStateMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope(token);

      expect(panelSetStateMock).toHaveBeenCalledWith({ preMaximizeLayout: null });
      expect(terminalStoreState.preMaximizeLayout).toBeNull();
    });

    it("enterFleetScope clears maximize in-tick so a later user maximize is preserved", async () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-race" });
      const token = useWorktreeSelectionStore.getState().enterFleetScope();
      // Post-#8402 the maximize-clear is synchronous — it has already fired by
      // the time enterFleetScope() returns. No deferred .then() lingers.
      useWorktreeSelectionStore.getState().exitFleetScope(token);

      // The user manually re-maximizes a panel after the enter/exit cycle.
      terminalStoreState.maximizedId = "term-user-maxed";
      terminalStoreState.maximizeTarget = { type: "panel", id: "term-user-maxed" };
      panelSetStateMock.mockClear();

      // Proof-by-drain: flush the microtask queue to prove no deferred .then()
      // from the old dynamic-import path is still pending to wipe the maximize.
      await Promise.resolve();
      await Promise.resolve();

      expect(panelSetStateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ maximizedId: null })
      );
      expect(terminalStoreState.maximizedId).toBe("term-user-maxed");
    });

    it("exitFleetScope focuses the primary armed terminal when it lives in the restore worktree", () => {
      setMockTerminals([
        { id: "term-active", worktreeId: "wt-pre", location: "grid" },
        { id: "term-primary", worktreeId: "wt-pre", location: "grid" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre" });
      const token = useWorktreeSelectionStore.getState().enterFleetScope();
      lastArmedIdForFleet = "term-primary";
      setFocusedMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope(token);

      expect(setFocusedMock).toHaveBeenCalledWith("term-primary");
      lastArmedIdForFleet = null;
    });

    it("exitFleetScope does not call setFocused when lastArmedId is null", () => {
      setMockTerminals([{ id: "term-active", worktreeId: "wt-pre", location: "grid" }]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre" });
      const token = useWorktreeSelectionStore.getState().enterFleetScope();
      lastArmedIdForFleet = null;
      setFocusedMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope(token);

      expect(setFocusedMock).not.toHaveBeenCalled();
    });

    it("exitFleetScope does not focus a cross-worktree primary — avoids orchestrator switch-back", () => {
      // Restoring `activeWorktreeId` to `wt-pre` then focusing a terminal in
      // `wt-other` would trigger rendererStoreOrchestrator's focusedId
      // subscription, which calls selectWorktree(terminal.worktreeId) and
      // undoes the scope-exit restore.
      setMockTerminals([
        { id: "term-active", worktreeId: "wt-pre", location: "grid" },
        { id: "term-primary", worktreeId: "wt-other", location: "grid" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre" });
      const token = useWorktreeSelectionStore.getState().enterFleetScope();
      lastArmedIdForFleet = "term-primary";
      setFocusedMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope(token);

      expect(setFocusedMock).not.toHaveBeenCalledWith("term-primary");
      lastArmedIdForFleet = null;
    });

    it("exitFleetScope skips focus restore when the primary terminal is trashed", () => {
      setMockTerminals([
        { id: "term-active", worktreeId: "wt-pre", location: "grid" },
        { id: "term-primary", worktreeId: "wt-pre", location: "trash" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre" });
      const token = useWorktreeSelectionStore.getState().enterFleetScope();
      lastArmedIdForFleet = "term-primary";
      setFocusedMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope(token);

      expect(setFocusedMock).not.toHaveBeenCalled();
      lastArmedIdForFleet = null;
    });

    it("exitFleetScope skips focus restore when the primary terminal is docked", () => {
      setMockTerminals([
        { id: "term-active", worktreeId: "wt-pre", location: "grid" },
        { id: "term-primary", worktreeId: "wt-pre", location: "dock" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre" });
      const token = useWorktreeSelectionStore.getState().enterFleetScope();
      lastArmedIdForFleet = "term-primary";
      setFocusedMock.mockClear();

      useWorktreeSelectionStore.getState().exitFleetScope(token);

      expect(setFocusedMock).not.toHaveBeenCalled();
      lastArmedIdForFleet = null;
    });

    it("enterFleetScope pins armed cross-worktree terminals to VISIBLE", () => {
      setMockTerminals([
        { id: "term-active", worktreeId: "wt-pre-scope", location: "grid" },
        { id: "term-armed-remote", worktreeId: "wt-other", location: "grid" },
        { id: "term-idle-remote", worktreeId: "wt-other", location: "grid" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-pre-scope" });
      armedIdsForFleet = new Set(["term-armed-remote"]);
      applyRendererPolicyMock.mockClear();

      useWorktreeSelectionStore.getState().enterFleetScope();

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
      expect(wakeMock).toHaveBeenCalledWith("term-active");
      expect(wakeMock).toHaveBeenCalledWith("term-armed-remote");
      expect(wakeMock).not.toHaveBeenCalledWith("term-idle-remote");
      armedIdsForFleet = new Set();
    });
  });
});

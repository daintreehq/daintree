import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@shared/types/panel";
import type { FleetScopeToken } from "@shared/types/worktree";
import type { Issue, PR } from "@shared/types/forge";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 123,
    title: "Issue title",
    body: "",
    state: "open",
    rawState: "OPEN",
    url: "https://github.com/org/repo/issues/123",
    author: { login: "tester", avatarUrl: "", rawData: null },
    assignees: [],
    labels: [],
    commentCount: 0,
    createdAt: 0,
    updatedAt: 0,
    rawData: null,
    ...overrides,
  };
}

function makePR(overrides: Partial<PR> = {}): PR {
  return {
    number: 99,
    title: "PR title",
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: "https://github.com/org/repo/pull/99",
    author: { login: "alice", avatarUrl: "", rawData: null },
    baseRef: "main",
    headRef: "feature/pr-branch",
    createdAt: 0,
    updatedAt: 0,
    rawData: null,
    ...overrides,
  };
}

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
type MockTabGroup = {
  id: string;
  location: "grid" | "dock";
  worktreeId?: string;
  activeTabId: string;
  panelIds: string[];
};
type MockMaximizeTarget = { type: "panel" | "group"; id: string } | null;
type MockPreMaximizeLayout = {
  gridCols: number;
  gridItemCount: number;
  worktreeId: string | undefined;
} | null;
const terminalStoreState = {
  panelsById: {} as Record<string, MockTerminal>,
  panelIds: [] as string[],
  tabGroups: new Map<string, MockTabGroup>(),
  activeDockTerminalId: null as string | null,
  focusedId: null as string | null,
  mruList: [] as string[],
  maximizedId: null as string | null,
  maximizeTarget: null as MockMaximizeTarget,
  preMaximizeLayout: null as MockPreMaximizeLayout,
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
    terminalStoreState.tabGroups = new Map();
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
      useWorktreeSelectionStore.getState().openCreateDialog(makeIssue({ title: "x" }))
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
    const pr = makePR();

    useWorktreeSelectionStore.getState().openCreateDialogForPR(pr);

    const { createDialog } = useWorktreeSelectionStore.getState();
    expect(createDialog.isOpen).toBe(true);
    expect(createDialog.initialPR).toEqual(pr);
    expect(createDialog.initialIssue).toBeNull();
  });

  it("openCreateDialog clears PR context when opening for an issue", () => {
    const pr = makePR();
    useWorktreeSelectionStore.getState().openCreateDialogForPR(pr);

    const issue = makeIssue();
    useWorktreeSelectionStore.getState().openCreateDialog(issue);

    const { createDialog } = useWorktreeSelectionStore.getState();
    expect(createDialog.initialIssue).toEqual(issue);
    expect(createDialog.initialPR).toBeNull();
  });

  it("closeCreateDialog clears both issue and PR context", () => {
    const pr = makePR();
    useWorktreeSelectionStore.getState().openCreateDialogForPR(pr);
    useWorktreeSelectionStore.getState().closeCreateDialog();

    const { createDialog } = useWorktreeSelectionStore.getState();
    expect(createDialog.isOpen).toBe(false);
    expect(createDialog.initialPR).toBeNull();
    expect(createDialog.initialIssue).toBeNull();
  });

  it("openBulkCreateDialog stores onComplete callback", () => {
    const onComplete = vi.fn();
    const issue = makeIssue({ number: 1, title: "issue" });
    useWorktreeSelectionStore.getState().openBulkCreateDialog([issue], onComplete);

    const { bulkCreateDialog } = useWorktreeSelectionStore.getState();
    expect(bulkCreateDialog.isOpen).toBe(true);
    expect(bulkCreateDialog.mode).toBe("issue");
    expect(bulkCreateDialog.onComplete).toBe(onComplete);
  });

  it("openBulkCreateDialogForPRs stores onComplete callback", () => {
    const onComplete = vi.fn();
    const pr = makePR({ number: 1, title: "pr", headRef: "feature/pr" });
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
      useWorktreeSelectionStore
        .getState()
        .openCreateDialogForPR(makePR({ number: 5, title: "fork pr" }))
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

  describe("durable restore selection (#9512)", () => {
    it("selectWorktree (default user source) records the durable restore target", () => {
      useWorktreeSelectionStore.getState().selectWorktree("wt-user-pick");

      const state = useWorktreeSelectionStore.getState();
      expect(state.activeWorktreeId).toBe("wt-user-pick");
      expect(state.restoreWorktreeId).toBe("wt-user-pick");
    });

    it("selectWorktree with source 'focus' updates active but NOT the restore target", async () => {
      // Seed a deliberate selection first.
      useWorktreeSelectionStore.getState().selectWorktree("wt-root");
      recordMruMock.mockClear();
      appSetStateMock.mockClear();

      // A terminal in a temp worktree gains focus → incidental promotion.
      useWorktreeSelectionStore.getState().selectWorktree("wt-temp-pr", { source: "focus" });
      // persistActiveWorktree defers its setState through a dynamic import; drain.
      await Promise.resolve();
      await Promise.resolve();

      const state = useWorktreeSelectionStore.getState();
      expect(state.activeWorktreeId).toBe("wt-temp-pr");
      // The durable selection stays on root, so the project round-trips to root.
      expect(state.restoreWorktreeId).toBe("wt-root");
      // Incidental promotion must not pollute the worktree MRU…
      expect(recordMruMock).not.toHaveBeenCalledWith("worktree:wt-temp-pr");
      // …nor persist the temp worktree to the main-process store.
      expect(appSetStateMock).not.toHaveBeenCalledWith({ activeWorktreeId: "wt-temp-pr" });
    });

    it("setActiveWorktree records the durable restore target for a concrete id", () => {
      useWorktreeSelectionStore.getState().setActiveWorktree("wt-card-click");

      const state = useWorktreeSelectionStore.getState();
      expect(state.activeWorktreeId).toBe("wt-card-click");
      expect(state.restoreWorktreeId).toBe("wt-card-click");
    });

    it("setActiveWorktree(null) clears the restore target when the cleared worktree WAS durable", () => {
      // The active worktree is also the durable selection (a feature worktree
      // the user deliberately selected), then it gets removed.
      useWorktreeSelectionStore.getState().setActiveWorktree("wt-feature");
      expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBe("wt-feature");

      useWorktreeSelectionStore.getState().setActiveWorktree(null);

      const state = useWorktreeSelectionStore.getState();
      expect(state.activeWorktreeId).toBeNull();
      expect(state.restoreWorktreeId).toBeNull();
    });

    it("setActiveWorktree(null) preserves the restore target when a focus-promoted worktree is cleared", () => {
      // Durable selection = root; a temp worktree is only incidentally active.
      useWorktreeSelectionStore.getState().selectWorktree("wt-root");
      useWorktreeSelectionStore.getState().selectWorktree("wt-temp-pr", { source: "focus" });
      expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBe("wt-root");

      // The temp worktree is torn down → active cleared.
      useWorktreeSelectionStore.getState().setActiveWorktree(null);

      const state = useWorktreeSelectionStore.getState();
      expect(state.activeWorktreeId).toBeNull();
      // Root remains the restore target so switch-back lands on root.
      expect(state.restoreWorktreeId).toBe("wt-root");
    });

    it("re-selecting the already-active worktree as a user action upgrades it to durable", () => {
      // Worktree became active only via focus promotion (no durable selection).
      useWorktreeSelectionStore.getState().selectWorktree("wt-temp", { source: "focus" });
      expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBeNull();

      // User then deliberately clicks the same worktree.
      useWorktreeSelectionStore.getState().selectWorktree("wt-temp");

      expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBe("wt-temp");
    });

    it("setActiveWorktree(null) leaves an already-null restore target untouched", () => {
      // A worktree became active only via focus promotion; no durable selection
      // was ever made.
      useWorktreeSelectionStore.getState().selectWorktree("wt-temp", { source: "focus" });
      expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBeNull();

      // The incidentally-active worktree is removed.
      useWorktreeSelectionStore.getState().setActiveWorktree(null);

      expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBeNull();
    });

    it("reset clears the restore target", () => {
      useWorktreeSelectionStore.getState().selectWorktree("wt-x");
      expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBe("wt-x");

      useWorktreeSelectionStore.getState().reset();

      expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBeNull();
    });
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

    it("preserves the durable restore selection across a fleet-scope cycle after a focus promotion (#9512)", () => {
      // User deliberately selects root, then a temp worktree gains focus
      // (incidental). The durable selection is root; the active is temp.
      useWorktreeSelectionStore.getState().selectWorktree("wt-root");
      useWorktreeSelectionStore.getState().selectWorktree("wt-temp", { source: "focus" });
      expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-temp");
      expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBe("wt-root");

      const token = useWorktreeSelectionStore.getState().enterFleetScope();
      useWorktreeSelectionStore.getState().exitFleetScope(token);

      // Exiting scope restores the pre-scope active worktree, but the durable
      // restore target must remain root so switch-back lands on root.
      const state = useWorktreeSelectionStore.getState();
      expect(state.activeWorktreeId).toBe("wt-temp");
      expect(state.restoreWorktreeId).toBe("wt-root");
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
      terminalStoreState.preMaximizeLayout = {
        gridCols: 2,
        gridItemCount: 2,
        worktreeId: "wt-with-maximize",
      };

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

      terminalStoreState.preMaximizeLayout = {
        gridCols: 3,
        gridItemCount: 3,
        worktreeId: "wt-pre-scope",
      };
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

  describe("per-worktree maximize (#11183)", () => {
    /** Put `panelId` on screen full-size in whichever worktree is active. */
    function maximizePanel(panelId: string, layout?: MockPreMaximizeLayout) {
      terminalStoreState.maximizedId = panelId;
      terminalStoreState.maximizeTarget = { type: "panel", id: panelId };
      terminalStoreState.preMaximizeLayout = layout ?? null;
    }
    function maximizeGroup(panelId: string, groupId: string) {
      terminalStoreState.maximizedId = panelId;
      terminalStoreState.maximizeTarget = { type: "group", id: groupId };
      terminalStoreState.preMaximizeLayout = null;
    }
    function stashedFor(worktreeId: string) {
      return useWorktreeSelectionStore.getState().maximizeByWorktree.get(worktreeId);
    }
    /** Two worktrees, one grid panel each. */
    function twoWorktrees() {
      setMockTerminals([
        { id: "a1", worktreeId: "wt-a", location: "grid" },
        { id: "a2", worktreeId: "wt-a", location: "grid" },
        { id: "b1", worktreeId: "wt-b", location: "grid" },
        { id: "b2", worktreeId: "wt-b", location: "grid" },
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-a" });
    }

    it("clears the maximize when switching to a worktree that doesn't own the panel", () => {
      twoWorktrees();
      maximizePanel("a1");

      useWorktreeSelectionStore.getState().selectWorktree("wt-b");

      // The whole bug: leaving `a1` in the flat fields makes ContentGrid take
      // its maximize branch and find nothing in wt-b's grid — a blank screen.
      expect(terminalStoreState.maximizedId).toBeNull();
      expect(terminalStoreState.maximizeTarget).toBeNull();
    });

    it("restores each worktree's own maximize across a round trip", () => {
      twoWorktrees();
      maximizePanel("a1", { gridCols: 3, gridItemCount: 4, worktreeId: "wt-a" });

      useWorktreeSelectionStore.getState().selectWorktree("wt-b");
      maximizePanel("b1");
      useWorktreeSelectionStore.getState().selectWorktree("wt-a");

      expect(terminalStoreState.maximizedId).toBe("a1");
      expect(terminalStoreState.maximizeTarget).toEqual({ type: "panel", id: "a1" });
      // The column count captured before wt-a maximized rides along, so
      // unmaximizing here restores wt-a's layout rather than recomputing it.
      expect(terminalStoreState.preMaximizeLayout).toMatchObject({
        gridCols: 3,
        worktreeId: "wt-a",
      });

      useWorktreeSelectionStore.getState().selectWorktree("wt-b");
      expect(terminalStoreState.maximizedId).toBe("b1");
    });

    it("moves a worktree's maximize out of the map once it is active", () => {
      twoWorktrees();
      maximizePanel("a1");

      useWorktreeSelectionStore.getState().selectWorktree("wt-b");
      expect(stashedFor("wt-a")?.maximizedId).toBe("a1");

      useWorktreeSelectionStore.getState().selectWorktree("wt-a");
      // A worktree's maximize lives in exactly one place. Now that wt-a is
      // active again the flat fields own it; a lingering slot would resurrect a
      // stale maximize the next time wt-a is switched into.
      expect(stashedFor("wt-a")).toBeUndefined();
    });

    it("writes all three maximize fields in a single panel-store patch", () => {
      twoWorktrees();
      maximizePanel("a1", { gridCols: 2, gridItemCount: 3, worktreeId: "wt-a" });
      panelSetStateMock.mockClear();

      useWorktreeSelectionStore.getState().selectWorktree("wt-b");

      // Dropping only the id strands the target and the next toggleMaximize
      // reads it as an unmaximize request (#9935) — the trio must move together.
      const patch = panelSetStateMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(Object.keys(patch).sort()).toEqual([
        "maximizeTarget",
        "maximizedId",
        "preMaximizeLayout",
      ]);
    });

    it("does not round-trip the live maximize when re-activating the current worktree", () => {
      twoWorktrees();
      maximizePanel("a1");

      useWorktreeSelectionStore.getState().setActiveWorktree("wt-a");

      expect(terminalStoreState.maximizedId).toBe("a1");
      expect(stashedFor("wt-a")).toBeUndefined();
    });

    it("stashes nothing for a worktree that was left unmaximized", () => {
      twoWorktrees();
      // `exitMaximize` deliberately preserves preMaximizeLayout, so a worktree
      // can be left with a layout snapshot and no maximize. That is not a
      // maximize and must not become one on the way back.
      terminalStoreState.preMaximizeLayout = { gridCols: 4, gridItemCount: 4, worktreeId: "wt-a" };

      useWorktreeSelectionStore.getState().selectWorktree("wt-b");

      expect(stashedFor("wt-a")).toBeUndefined();
      expect(terminalStoreState.preMaximizeLayout).toBeNull();
    });

    it("replaces the map reference on every write so subscribers are notified", () => {
      twoWorktrees();
      maximizePanel("a1");
      const before = useWorktreeSelectionStore.getState().maximizeByWorktree;

      useWorktreeSelectionStore.getState().selectWorktree("wt-b");

      // Zustand 5 only notifies on a new reference — an in-place Map.set() is
      // invisible to selectors.
      expect(useWorktreeSelectionStore.getState().maximizeByWorktree).not.toBe(before);
    });

    it("reset drops every stashed maximize", () => {
      twoWorktrees();
      maximizePanel("a1");
      useWorktreeSelectionStore.getState().selectWorktree("wt-b");

      useWorktreeSelectionStore.getState().reset();

      expect(useWorktreeSelectionStore.getState().maximizeByWorktree.size).toBe(0);
    });

    describe("stale stashes are never written back", () => {
      /** Maximize a1 in wt-a, then leave — wt-a's maximize is now stashed. */
      function stashWtA() {
        twoWorktrees();
        maximizePanel("a1");
        useWorktreeSelectionStore.getState().selectWorktree("wt-b");
      }

      it.each([
        ["the panel was trashed", () => (terminalStoreState.panelsById["a1"]!.location = "trash")],
        ["the panel was docked", () => (terminalStoreState.panelsById["a1"]!.location = "dock")],
        [
          "the panel was backgrounded",
          () => (terminalStoreState.panelsById["a1"]!.location = "background"),
        ],
        [
          "the panel moved to another worktree",
          () => (terminalStoreState.panelsById["a1"]!.worktreeId = "wt-b"),
        ],
        [
          "the panel is gone entirely",
          () => setMockTerminals([{ id: "b1", worktreeId: "wt-b", location: "grid" }]),
        ],
      ])("clears rather than restoring when %s", (_case, invalidate) => {
        stashWtA();
        invalidate();

        useWorktreeSelectionStore.getState().selectWorktree("wt-a");

        // Restoring any of these blanks the grid all over again: none of them
        // can satisfy ContentGrid's maximize branch.
        expect(terminalStoreState.maximizedId).toBeNull();
        expect(terminalStoreState.maximizeTarget).toBeNull();
        expect(stashedFor("wt-a")).toBeUndefined();
      });

      it("drops a foreign layout snapshot but keeps the maximize itself", () => {
        twoWorktrees();
        maximizePanel("a1", { gridCols: 5, gridItemCount: 2, worktreeId: "wt-b" });

        useWorktreeSelectionStore.getState().selectWorktree("wt-b");
        useWorktreeSelectionStore.getState().selectWorktree("wt-a");

        expect(terminalStoreState.maximizedId).toBe("a1");
        expect(terminalStoreState.preMaximizeLayout).toBeNull();
      });
    });

    describe("group targets", () => {
      function groupedWtA(panelIds: string[], location: "grid" | "dock" = "grid") {
        twoWorktrees();
        terminalStoreState.tabGroups.set("g1", {
          id: "g1",
          location,
          worktreeId: "wt-a",
          activeTabId: panelIds[0]!,
          panelIds,
        });
        maximizeGroup("a1", "g1");
      }

      it("restores a maximized group", () => {
        groupedWtA(["a1", "a2"]);

        useWorktreeSelectionStore.getState().selectWorktree("wt-b");
        useWorktreeSelectionStore.getState().selectWorktree("wt-a");

        expect(terminalStoreState.maximizeTarget).toEqual({ type: "group", id: "g1" });
        expect(terminalStoreState.maximizedId).toBe("a1");
      });

      it("downgrades to a panel maximize when the group shrank to one member", () => {
        groupedWtA(["a1", "a2"]);
        useWorktreeSelectionStore.getState().selectWorktree("wt-b");
        terminalStoreState.tabGroups.get("g1")!.panelIds = ["a1"];

        useWorktreeSelectionStore.getState().selectWorktree("wt-a");

        // A one-member group renders no tab strip, so the surviving panel is
        // still shown — just as a plain panel maximize.
        expect(terminalStoreState.maximizeTarget).toEqual({ type: "panel", id: "a1" });
      });

      it("clears when the group dissolved while the worktree was inactive", () => {
        groupedWtA(["a1", "a2"]);
        useWorktreeSelectionStore.getState().selectWorktree("wt-b");
        terminalStoreState.tabGroups.delete("g1");

        useWorktreeSelectionStore.getState().selectWorktree("wt-a");

        expect(terminalStoreState.maximizeTarget).toBeNull();
      });

      it("clears when the group moved to the dock", () => {
        groupedWtA(["a1", "a2"]);
        useWorktreeSelectionStore.getState().selectWorktree("wt-b");
        terminalStoreState.tabGroups.get("g1")!.location = "dock";

        useWorktreeSelectionStore.getState().selectWorktree("wt-a");

        // ContentGrid only ever resolves grid groups — a docked one renders as
        // an empty group and blanks the screen.
        expect(terminalStoreState.maximizeTarget).toBeNull();
      });
    });

    describe("focus promotions reveal the panel they promoted for", () => {
      /** wt-b has b1 maximized and stashed; wt-a is active. */
      function stashWtB() {
        twoWorktrees();
        useWorktreeSelectionStore.getState().selectWorktree("wt-b");
        maximizePanel("b1");
        useWorktreeSelectionStore.getState().selectWorktree("wt-a");
      }

      it("does not bury the panel a focus promotion was fired to reveal", () => {
        stashWtB();
        // A draft/spawn lands on b2 and focuses it, which promotes wt-b. Its
        // stashed maximize covers b1 — restoring it would hide b2 behind a
        // fullscreen b1, defeating the reveal (useTypeAnywhere, panelSpawning,
        // recipeStore all rely on this).
        terminalStoreState.focusedId = "b2";

        useWorktreeSelectionStore.getState().selectWorktree("wt-b", { source: "focus" });

        expect(terminalStoreState.maximizedId).toBeNull();
        expect(stashedFor("wt-b")).toBeUndefined();
      });

      it("restores when the promotion targets the maximized panel itself", () => {
        stashWtB();
        // Navigating straight back to b1 (quick switcher, HelpPanel): the
        // maximize *is* how b1 gets revealed, so dropping it would silently
        // destroy the user's maximize.
        terminalStoreState.focusedId = "b1";

        useWorktreeSelectionStore.getState().selectWorktree("wt-b", { source: "focus" });

        expect(terminalStoreState.maximizedId).toBe("b1");
      });

      it("restores when the promotion targets a member of the maximized group", () => {
        twoWorktrees();
        useWorktreeSelectionStore.getState().selectWorktree("wt-b");
        terminalStoreState.tabGroups.set("g2", {
          id: "g2",
          location: "grid",
          worktreeId: "wt-b",
          activeTabId: "b1",
          panelIds: ["b1", "b2"],
        });
        maximizeGroup("b1", "g2");
        useWorktreeSelectionStore.getState().selectWorktree("wt-a");
        // b2 is a tab inside the maximized group, so the group shows it.
        terminalStoreState.focusedId = "b2";

        useWorktreeSelectionStore.getState().selectWorktree("wt-b", { source: "focus" });

        expect(terminalStoreState.maximizeTarget).toEqual({ type: "group", id: "g2" });
      });
    });

    it("does not restore a maximize into fleet scope", () => {
      twoWorktrees();
      maximizePanel("a1");
      useWorktreeSelectionStore.getState().selectWorktree("wt-b");
      useWorktreeSelectionStore.setState({ isFleetScopeActive: true });

      useWorktreeSelectionStore.getState().selectWorktree("wt-a");

      // A maximize shadows the fleet grid — the exact reason enterFleetScope
      // clears the trio on the way in.
      expect(terminalStoreState.maximizedId).toBeNull();
    });
  });
});

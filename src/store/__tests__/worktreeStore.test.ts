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
} = vi.hoisted(() => ({
  appSetStateMock: vi.fn().mockResolvedValue(undefined),
  applyRendererPolicyMock: vi.fn(),
  recordMruMock: vi.fn(),
  setFocusedMock: vi.fn(),
  logErrorWithContextMock: vi.fn(),
  focusStateGetterMock: vi.fn(() => ({ isFocusMode: false })),
  subscribeMock: vi.fn(() => vi.fn()),
}));

const terminalStoreState = {
  terminals: [] as Array<{
    id: string;
    worktreeId?: string;
    location?: "grid" | "dock" | "trash";
  }>,
  activeDockTerminalId: null as string | null,
  focusedId: null as string | null,
  mruList: [] as string[],
  recordMru: recordMruMock,
  setFocused: setFocusedMock,
};

vi.mock("@/clients", () => ({
  appClient: {
    setState: appSetStateMock,
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

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: {
    getState: vi.fn(() => terminalStoreState),
    subscribe: subscribeMock,
  },
}));

import { useWorktreeSelectionStore } from "../worktreeStore";

describe("worktreeStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorktreeSelectionStore.getState().reset();
    terminalStoreState.terminals = [];
    terminalStoreState.activeDockTerminalId = null;
    terminalStoreState.focusedId = null;
    terminalStoreState.mruList = [];
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
    terminalStoreState.terminals = [
      { id: "term-a", worktreeId: "wt-a", location: "grid" },
      { id: "term-b", worktreeId: "wt-b", location: "grid" },
      { id: "dock-global", location: "dock" },
    ];
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
    terminalStoreState.terminals = [
      { id: "term-a", worktreeId: "wt-a", location: "grid" },
      { id: "term-b", worktreeId: "wt-b", location: "grid" },
    ];

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

  it("does not restore stale terminal focus after a newer worktree selection wins", async () => {
    terminalStoreState.terminals = [
      { id: "term-a", worktreeId: "wt-a", location: "grid" },
      { id: "term-b", worktreeId: "wt-b", location: "grid" },
    ];
    useWorktreeSelectionStore.getState().trackTerminalFocus("wt-a", "term-a");

    useWorktreeSelectionStore.getState().selectWorktree("wt-a");
    useWorktreeSelectionStore.getState().selectWorktree("wt-b");
    await Promise.resolve();
    await Promise.resolve();

    expect(setFocusedMock).not.toHaveBeenCalledWith("term-a");
  });
});

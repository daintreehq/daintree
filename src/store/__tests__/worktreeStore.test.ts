import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  appSetStateMock,
  applyRendererPolicyMock,
  logErrorWithContextMock,
  focusStateGetterMock,
  subscribeMock,
} = vi.hoisted(() => ({
  appSetStateMock: vi.fn().mockResolvedValue(undefined),
  applyRendererPolicyMock: vi.fn(),
  logErrorWithContextMock: vi.fn(),
  focusStateGetterMock: vi.fn(() => ({ isFocusMode: false })),
  subscribeMock: vi.fn(() => vi.fn()),
}));

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
    getState: vi.fn(() => ({
      terminals: [],
      activeDockTerminalId: null,
      focusedId: null,
    })),
    subscribe: subscribeMock,
  },
}));

import {
  cleanupWorktreeFocusTracking,
  setupWorktreeFocusTracking,
  useWorktreeSelectionStore,
} from "../worktreeStore";

describe("worktreeStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupWorktreeFocusTracking();
    useWorktreeSelectionStore.getState().reset();
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

  it("cancels pending focus-tracking setup when cleanup runs before async import resolves", async () => {
    const cleanup = setupWorktreeFocusTracking();
    cleanup();
    await Promise.resolve();
    await Promise.resolve();

    expect(subscribeMock).not.toHaveBeenCalled();
  });
});

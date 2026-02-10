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

  it("cancels pending focus-tracking setup when cleanup runs before async import resolves", async () => {
    const cleanup = setupWorktreeFocusTracking();
    cleanup();
    await Promise.resolve();
    await Promise.resolve();

    expect(subscribeMock).not.toHaveBeenCalled();
  });
});

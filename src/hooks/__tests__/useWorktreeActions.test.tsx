// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";

const {
  dispatchMock,
  addErrorMock,
  addNotificationMock,
  updateNotificationMock,
  addErrorStoreMock,
} = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  addErrorMock: vi.fn(),
  addNotificationMock: vi.fn(() => "toast-123"),
  updateNotificationMock: vi.fn(),
  addErrorStoreMock: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: dispatchMock,
  },
}));

vi.mock("@/store", () => ({
  useErrorStore: Object.assign(
    (selector: (state: { addError: typeof addErrorMock }) => unknown) =>
      selector({ addError: addErrorMock }),
    { getState: () => ({ addError: addErrorStoreMock }) }
  ),
}));

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: {
    getState: () => ({
      addNotification: addNotificationMock,
      updateNotification: updateNotificationMock,
    }),
  },
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: {
    getState: () => ({
      generateRecipeFromActiveTerminals: vi.fn(() => []),
    }),
  },
}));

import {
  useWorktreeActions,
  formatCopyResultMessage,
  copyContextWithFeedback,
} from "../useWorktreeActions";

describe("useWorktreeActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses safe fallback when copyTree payload omits fileCount", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: {},
    });

    const { result } = renderHook(() => useWorktreeActions());

    const worktree: WorktreeState = {
      id: "wt-1",
      worktreeId: "wt-1",
      path: "/repo/wt-1",
      name: "wt-1",
      branch: "main",
      isCurrent: false,
      isMainWorktree: true,
      worktreeChanges: null,
      lastActivityTimestamp: null,
    };

    const message = await result.current.handleCopyTree(worktree);

    expect(message).toBe("Copied 0 files to clipboard");
  });

  it("handleLaunchAgent dispatches agent.launch through the ActionService", () => {
    dispatchMock.mockResolvedValueOnce({ ok: true, result: { terminalId: "term-1" } });

    const { result } = renderHook(() => useWorktreeActions());
    result.current.handleLaunchAgent("wt-1", "claude");

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "claude", worktreeId: "wt-1", location: "grid" },
      { source: "user" }
    );
  });

  it("handleLaunchAgent dispatches agent.launch for dev-preview panels", () => {
    dispatchMock.mockResolvedValueOnce({ ok: true, result: { terminalId: "term-dev" } });

    const { result } = renderHook(() => useWorktreeActions());
    result.current.handleLaunchAgent("wt-1", "dev-preview");

    expect(dispatchMock).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "dev-preview", worktreeId: "wt-1", location: "grid" },
      { source: "user" }
    );
  });
});

describe("formatCopyResultMessage", () => {
  it("formats message with file count, size, and format", () => {
    expect(
      formatCopyResultMessage({ fileCount: 42, stats: { totalSize: 1024 }, format: "xml" })
    ).toBe("Copied 42 files (1 KB) as XML to clipboard");
  });

  it("handles missing stats", () => {
    expect(formatCopyResultMessage({ fileCount: 5 })).toBe("Copied 5 files to clipboard");
  });

  it("handles missing fileCount gracefully", () => {
    expect(formatCopyResultMessage({} as { fileCount: number })).toBe(
      "Copied 0 files to clipboard"
    );
  });
});

describe("copyContextWithFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addNotificationMock.mockReturnValue("toast-123");
  });

  it("shows info toast then updates to success on full context copy", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: { fileCount: 10, stats: { totalSize: 2048 }, format: "xml" },
    });

    await copyContextWithFeedback("wt-1");

    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", message: "Copying context…" })
    );
    expect(updateNotificationMock).toHaveBeenCalledWith(
      "toast-123",
      expect.objectContaining({ type: "success", duration: 3000 })
    );
  });

  it("passes modified option to dispatch", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: { fileCount: 3, stats: null, format: "xml" },
    });

    await copyContextWithFeedback("wt-1", { modified: true });

    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Copying modified files…" })
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.copyTree",
      { worktreeId: "wt-1", modified: true },
      { source: "context-menu" }
    );
  });

  it("shows 'No files to copy' when result is null", async () => {
    dispatchMock.mockResolvedValueOnce({ ok: true, result: null });

    await copyContextWithFeedback("wt-1");

    expect(updateNotificationMock).toHaveBeenCalledWith(
      "toast-123",
      expect.objectContaining({ type: "info", message: "No files to copy" })
    );
  });

  it("shows error toast and adds to error store on dispatch failure", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: false,
      error: { message: "Something went wrong" },
    });

    await copyContextWithFeedback("wt-1");

    expect(updateNotificationMock).toHaveBeenCalledWith(
      "toast-123",
      expect.objectContaining({
        type: "error",
        message: "Copy context failed: Something went wrong",
      })
    );
    expect(addErrorStoreMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Copy context failed: Something went wrong" })
    );
  });

  it("handles thrown errors gracefully", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("Network error"));

    await copyContextWithFeedback("wt-1");

    expect(updateNotificationMock).toHaveBeenCalledWith(
      "toast-123",
      expect.objectContaining({
        type: "error",
        message: "Copy context failed: Network error",
      })
    );
  });
});

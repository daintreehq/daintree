// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useWorktreeDevServerSession } from "../useWorktreeDevServerSession";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";

function makeSession(worktreeId: string): DevPreviewSessionState {
  return {
    panelId: "p1",
    projectId: "proj",
    worktreeId,
    status: "running",
    url: "http://localhost:5173",
    predictedUrl: null,
    error: null,
    terminalId: null,
    isRestarting: false,
    generation: 0,
    updatedAt: 1,
  };
}

describe("useWorktreeDevServerSession", () => {
  let getByWorktree: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useWorktreeDevServerStore.getState().reset();
    getByWorktree = vi.fn();
    // Define on the real window (don't spread it — `document` lives on the
    // prototype and would be lost, breaking RTL's `waitFor`).
    Object.defineProperty(window, "electron", {
      value: { devPreview: { getByWorktree } },
      configurable: true,
      writable: true,
    });
  });

  it("hydrates the store on a cache miss", async () => {
    getByWorktree.mockResolvedValue(makeSession("w1"));
    const { result } = renderHook(() => useWorktreeDevServerSession("w1"));
    await waitFor(() => {
      expect(result.current?.status).toBe("running");
    });
    expect(getByWorktree).toHaveBeenCalledWith({ worktreeId: "w1" });
  });

  it("does not call getByWorktree when the store already has the entry", () => {
    useWorktreeDevServerStore.getState().setSession("w1", makeSession("w1"));
    renderHook(() => useWorktreeDevServerSession("w1"));
    expect(getByWorktree).not.toHaveBeenCalled();
  });

  it("does not write a stored session after unmount", async () => {
    let resolve!: (v: DevPreviewSessionState | null) => void;
    getByWorktree.mockReturnValue(
      new Promise<DevPreviewSessionState | null>((r) => {
        resolve = r;
      })
    );
    const { unmount } = renderHook(() => useWorktreeDevServerSession("w1"));
    unmount();
    resolve(makeSession("w1"));
    await Promise.resolve();
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1).toBeUndefined();
  });

  it("does not write when getByWorktree resolves null (no session)", async () => {
    getByWorktree.mockResolvedValue(null);
    renderHook(() => useWorktreeDevServerSession("w1"));
    await waitFor(() => {
      expect(getByWorktree).toHaveBeenCalled();
    });
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1).toBeUndefined();
  });
});

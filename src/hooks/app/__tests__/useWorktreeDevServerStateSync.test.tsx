// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWorktreeDevServerStateSync } from "../useWorktreeDevServerStateSync";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";
import type {
  DevPreviewSessionState,
  DevPreviewStateChangedPayload,
  DevPreviewSessionStatus,
} from "@shared/types/ipc/devPreview";

type Listener = (payload: DevPreviewStateChangedPayload) => void;

function makeSession(
  worktreeId: string | undefined,
  status: DevPreviewSessionStatus,
  updatedAt = 1
): DevPreviewSessionState {
  return {
    panelId: "p1",
    projectId: "proj",
    worktreeId,
    status,
    url: null,
    predictedUrl: null,
    error: null,
    terminalId: null,
    isRestarting: false,
    generation: 0,
    updatedAt,
  };
}

describe("useWorktreeDevServerStateSync", () => {
  let listeners: Listener[];
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listeners = [];
    unsubscribe = vi.fn();
    useWorktreeDevServerStore.getState().reset();
    vi.stubGlobal("window", {
      ...window,
      electron: {
        devPreview: {
          onStateChanged: (cb: Listener) => {
            listeners.push(cb);
            return unsubscribe;
          },
        },
      },
    });
  });

  function emit(payload: DevPreviewStateChangedPayload) {
    for (const l of listeners) l(payload);
  }

  it("writes broadcasts with a worktreeId into the store", () => {
    renderHook(() => useWorktreeDevServerStateSync());
    emit({ state: makeSession("w1", "running") });
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1.status).toBe("running");
  });

  it("skips broadcasts that have no worktreeId", () => {
    renderHook(() => useWorktreeDevServerStateSync());
    emit({ state: makeSession(undefined, "running") });
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId).toEqual({});
  });

  it("skips broadcasts whose worktreeId is only whitespace", () => {
    renderHook(() => useWorktreeDevServerStateSync());
    emit({ state: makeSession("   ", "running") });
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId).toEqual({});
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useWorktreeDevServerStateSync());
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

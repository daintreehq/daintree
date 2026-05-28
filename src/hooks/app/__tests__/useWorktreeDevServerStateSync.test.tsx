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
  let unsubscribe: () => void;

  beforeEach(() => {
    listeners = [];
    unsubscribe = vi.fn() as () => void;
    useWorktreeDevServerStore.getState().reset();
    vi.stubGlobal("window", {
      ...window,
      electron: {
        devPreview: {
          onStateChanged: (cb: Listener) => {
            listeners.push(cb);
            // Mirror the real IPC contract: the returned cleanup detaches the
            // handler so no further payloads are delivered.
            return () => {
              unsubscribe();
              const i = listeners.indexOf(cb);
              if (i >= 0) listeners.splice(i, 1);
            };
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
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1?.status).toBe("running");
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

  it("does not mutate the store from a broadcast delivered after unmount", () => {
    const { unmount } = renderHook(() => useWorktreeDevServerStateSync());
    unmount();
    // The cleanup detached the handler, so a late broadcast reaches no listener.
    emit({ state: makeSession("w1", "running") });
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId).toEqual({});
  });
});

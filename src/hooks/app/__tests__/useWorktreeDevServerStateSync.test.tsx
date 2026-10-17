// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWorktreeDevServerStateSync } from "../useWorktreeDevServerStateSync";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";
import { notifyHostResync } from "@/store/hostResyncSignal";
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
  let sessions: DevPreviewSessionState[];

  beforeEach(() => {
    listeners = [];
    sessions = [];
    useWorktreeDevServerStore.getState().reset();
    vi.stubGlobal("window", {
      ...window,
      electron: {
        devPreview: {
          getAllSessions: async () => sessions,
          onStateChanged: (cb: Listener) => {
            listeners.push(cb);
            // Mirror the real IPC contract: the returned cleanup detaches the
            // handler so no further payloads are delivered.
            return () => {
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

  it("does not mutate the store from a broadcast delivered after unmount", () => {
    const { unmount } = renderHook(() => useWorktreeDevServerStateSync());
    unmount();
    // The cleanup detached the handler, so a late broadcast reaches no listener.
    emit({ state: makeSession("w1", "running") });
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId).toEqual({});
  });

  it("takes the host's current sessions after a resync, for broadcasts lost while the link was down", async () => {
    renderHook(() => useWorktreeDevServerStateSync());
    emit({ state: makeSession("w1", "starting") });
    sessions = [makeSession("w1", "running", 2), makeSession(undefined, "running", 2)];
    notifyHostResync();
    await vi.waitFor(() =>
      expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1?.status).toBe("running")
    );
    expect(Object.keys(useWorktreeDevServerStore.getState().sessionsByWorktreeId)).toEqual(["w1"]);
  });

  it("drops a session the host no longer has after a resync, keeping one that changed meanwhile", async () => {
    renderHook(() => useWorktreeDevServerStateSync());
    emit({ state: makeSession("w1", "running", 1) });
    emit({ state: makeSession("w2", "running", 1) });
    let answer!: (value: DevPreviewSessionState[]) => void;
    (window.electron.devPreview as { getAllSessions: () => Promise<unknown> }).getAllSessions =
      () => new Promise((resolve) => (answer = resolve));
    notifyHostResync();
    // w2 starts again while the snapshot is out, in the same millisecond it was taken.
    emit({ state: makeSession("w2", "starting", 2) });
    answer([makeSession("w2", "stopped", 2)]);
    await vi.waitFor(() =>
      expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1).toBeUndefined()
    );
    // The broadcast that arrived meanwhile is newer than the snapshot.
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId.w2?.status).toBe("starting");
  });
});

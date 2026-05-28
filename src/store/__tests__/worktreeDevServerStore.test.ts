import { beforeEach, describe, expect, it } from "vitest";
import { useWorktreeDevServerStore } from "../worktreeDevServerStore";
import type { DevPreviewSessionState, DevPreviewSessionStatus } from "@shared/types/ipc/devPreview";

function makeSession(
  overrides: Partial<DevPreviewSessionState> & {
    worktreeId: string;
    status: DevPreviewSessionStatus;
    updatedAt: number;
  }
): DevPreviewSessionState {
  return {
    panelId: `panel-${overrides.worktreeId}`,
    projectId: "proj-1",
    url: null,
    predictedUrl: null,
    error: null,
    terminalId: null,
    isRestarting: false,
    generation: 0,
    ...overrides,
  };
}

describe("worktreeDevServerStore", () => {
  beforeEach(() => {
    useWorktreeDevServerStore.getState().reset();
  });

  it("stores a session keyed by worktreeId", () => {
    const session = makeSession({ worktreeId: "w1", status: "running", updatedAt: 100 });
    useWorktreeDevServerStore.getState().setSession("w1", session);
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1).toEqual(session);
  });

  it("applies a newer update over an older one", () => {
    const store = useWorktreeDevServerStore.getState();
    store.setSession("w1", makeSession({ worktreeId: "w1", status: "starting", updatedAt: 100 }));
    store.setSession("w1", makeSession({ worktreeId: "w1", status: "running", updatedAt: 200 }));
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1.status).toBe("running");
  });

  it("rejects a stale write whose updatedAt is older than the stored entry", () => {
    const store = useWorktreeDevServerStore.getState();
    // Live broadcast lands first…
    store.setSession("w1", makeSession({ worktreeId: "w1", status: "running", updatedAt: 200 }));
    const before = useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1;
    // …then a slow getByWorktree hydration resolves with an older snapshot.
    store.setSession("w1", makeSession({ worktreeId: "w1", status: "starting", updatedAt: 100 }));
    const after = useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1;
    expect(after.status).toBe("running");
    // Same object reference — no needless re-render from the dropped write.
    expect(after).toBe(before);
  });

  it("applies an equal-timestamp write (last-write-wins for same-ms transitions)", () => {
    const store = useWorktreeDevServerStore.getState();
    store.setSession("w1", makeSession({ worktreeId: "w1", status: "starting", updatedAt: 100 }));
    // A synchronous spawn failure can flip starting→error within the same ms;
    // the latter transition must not be dropped.
    store.setSession("w1", makeSession({ worktreeId: "w1", status: "error", updatedAt: 100 }));
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1.status).toBe("error");
  });

  it("removeSession deletes the entry", () => {
    const store = useWorktreeDevServerStore.getState();
    store.setSession("w1", makeSession({ worktreeId: "w1", status: "running", updatedAt: 100 }));
    store.removeSession("w1");
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId.w1).toBeUndefined();
  });

  it("reset clears all sessions", () => {
    const store = useWorktreeDevServerStore.getState();
    store.setSession("w1", makeSession({ worktreeId: "w1", status: "running", updatedAt: 100 }));
    store.setSession("w2", makeSession({ worktreeId: "w2", status: "error", updatedAt: 100 }));
    store.reset();
    expect(useWorktreeDevServerStore.getState().sessionsByWorktreeId).toEqual({});
  });
});

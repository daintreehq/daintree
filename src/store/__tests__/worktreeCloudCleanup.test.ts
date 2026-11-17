import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeSnapshot } from "@shared/types";
import type { CloudWorktreeCleanupOutcome } from "@shared/types/cloudHosts";

const {
  calls,
  worktreeClientDeleteMock,
  closeTerminalsForWorktreeMock,
  notifyMock,
  prepareMock,
  settleMock,
  retryMock,
} = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    worktreeClientDeleteMock: vi.fn(async (..._args: unknown[]) => {
      calls.push("delete");
    }),
    closeTerminalsForWorktreeMock: vi.fn(async () => {
      calls.push("close-terminals");
    }),
    notifyMock: vi.fn(),
    prepareMock: vi.fn(async (..._args: unknown[]) => {
      calls.push("prepare");
    }),
    settleMock: vi.fn(async (..._args: unknown[]): Promise<CloudWorktreeCleanupOutcome[]> => {
      calls.push("settle");
      return [];
    }),
    retryMock: vi.fn(async () => {}),
  };
});

(globalThis as Record<string, unknown>).window = globalThis.window ?? {};
(window as unknown as Record<string, unknown>).electron = {
  ...((window as unknown as Record<string, unknown>).electron ?? {}),
  devPreview: {
    getByWorktree: vi.fn().mockResolvedValue(null),
    stopByWorktree: vi.fn().mockResolvedValue(undefined),
    getAllSessions: vi.fn().mockResolvedValue([]),
  },
};

vi.mock("@/clients", async () => {
  const actual = await vi.importActual<typeof import("@/clients")>("@/clients");
  return {
    ...actual,
    worktreeClient: { ...actual.worktreeClient, delete: worktreeClientDeleteMock },
  };
});

vi.mock("@/clients/cloudHostsClient", () => ({
  cloudHostsClient: {
    prepareWorktreeCleanup: prepareMock,
    settleWorktreeCleanup: settleMock,
    retryWorktreeCleanup: retryMock,
  },
}));

vi.mock("@/components/Worktree/worktreeDeleteHelper", () => ({
  captureWorktreeTerminalSnapshot: () => [],
  closeTerminalsForWorktree: closeTerminalsForWorktreeMock,
  restoreClosedTerminals: vi.fn(async () => {}),
}));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

vi.mock("@/store/devPreviewResumeSignal", () => ({ resumeDevPreviews: vi.fn(async () => {}) }));

import { createWorktreeStore } from "@/store/createWorktreeStore";
import { CLOUD_CLEANUP_REFUSED } from "@/store/worktreeCloudCleanup";

const CLEANUP = {
  worktree: { hostId: null, projectId: "0f1e2d3c", worktreeId: "wt-1" },
  machines: [{ hostId: "login-host", resourceId: "bx_23456789", choice: "delete" as const }],
};

function snapshot(id: string): WorktreeSnapshot {
  return {
    id,
    name: id,
    branch: "feature/login",
    path: `/repo/${id}`,
    isCurrent: false,
    isMainWorktree: false,
    modifiedCount: 0,
    changes: [],
    summary: "",
    mood: null,
    gitDir: "",
  } as unknown as WorktreeSnapshot;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function storeWithWorktree() {
  const store = createWorktreeStore();
  store.getState().applySnapshot([snapshot("wt-1")], { epoch: "e", seq: 1 });
  return store;
}

describe("a worktree delete with its cloud machines (#17360)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("writes the choice down before anything closes, and settles it once the delete is done", async () => {
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { closeTerminals: true, cloudCleanup: CLEANUP });
    await flush();
    expect(calls).toEqual(["prepare", "close-terminals", "delete", "settle"]);
    // One id names the delete throughout: written with it, sent with it, settled with it.
    const sent = worktreeClientDeleteMock.mock.calls[0]![1] as { mutationId: string };
    expect(sent.mutationId).toEqual(expect.any(String));
    expect(prepareMock).toHaveBeenCalledWith(CLEANUP.worktree, CLEANUP.machines, sent.mutationId);
    expect(settleMock).toHaveBeenCalledTimes(1);
    expect(settleMock).toHaveBeenCalledWith(CLEANUP.worktree, true, sent.mutationId);
  });

  it("stops the delete when the choice can't be written down, and asks for review on Retry", async () => {
    prepareMock.mockRejectedValueOnce(new Error("The machine changed since you confirmed."));
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { closeTerminals: true, cloudCleanup: CLEANUP });
    await flush();
    expect(calls).toEqual([]);
    expect(closeTerminalsForWorktreeMock).not.toHaveBeenCalled();
    expect(worktreeClientDeleteMock).not.toHaveBeenCalled();
    expect(settleMock).not.toHaveBeenCalled();
    expect(store.getState().deleteErrors.get("wt-1")).toContain(CLOUD_CLEANUP_REFUSED);
    // Never replayed by itself on a reconnect.
    expect([...store.getState().mutationOutbox.values()][0]?.status).toBe("failed");
    // What was on offer may have changed: the dialog asks again rather than resending it.
    expect(store.getState().retryDelete("wt-1")).toBe("needs-review");
    await flush();
    expect(prepareMock).toHaveBeenCalledTimes(1);
  });

  it("settles a refused delete as not deleted, and writes the same choice again on Retry", async () => {
    worktreeClientDeleteMock.mockImplementationOnce(async () => {
      calls.push("delete");
      throw new Error("git error: unmerged paths");
    });
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { cloudCleanup: CLEANUP });
    await flush();
    expect(calls).toEqual(["prepare", "delete", "settle"]);
    expect(settleMock).toHaveBeenCalledWith(CLEANUP.worktree, false, expect.any(String));

    calls.length = 0;
    expect(store.getState().retryDelete("wt-1")).toBe("dispatched");
    await flush();
    expect(calls).toEqual(["prepare", "delete", "settle"]);
    expect(prepareMock).toHaveBeenLastCalledWith(
      CLEANUP.worktree,
      CLEANUP.machines,
      prepareMock.mock.calls[0]![2]
    );
    expect(settleMock).toHaveBeenLastCalledWith(CLEANUP.worktree, true, expect.any(String));
  });

  it("leaves the outcome unknown when the host went away mid-delete", async () => {
    worktreeClientDeleteMock.mockRejectedValueOnce(new Error("HOST_EXITED: workspace host exited"));
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { cloudCleanup: CLEANUP });
    await flush();
    expect(settleMock).toHaveBeenCalledWith(CLEANUP.worktree, null, expect.any(String));
  });

  it("settles as deleted when only the branch step failed after the worktree went", async () => {
    let fail: (reason: unknown) => void = () => {};
    worktreeClientDeleteMock.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (fail = reject))
    );
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { cloudCleanup: CLEANUP });
    await flush();
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 });
    fail(new Error("Worktree removed. Couldn't delete branch 'feature/login': locked ref"));
    await flush();
    expect(settleMock).toHaveBeenCalledTimes(1);
    expect(settleMock).toHaveBeenCalledWith(CLEANUP.worktree, true, expect.any(String));
  });

  it("settles as unknown when the card went but the failure doesn't say the worktree did", async () => {
    let fail: (reason: unknown) => void = () => {};
    worktreeClientDeleteMock.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (fail = reject))
    );
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { cloudCleanup: CLEANUP });
    await flush();
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 });
    fail(new Error("git error: unmerged paths"));
    await flush();
    expect(settleMock).toHaveBeenCalledWith(CLEANUP.worktree, null, expect.any(String));
  });

  it("leaves the outcome unknown when the request ran out of time", async () => {
    worktreeClientDeleteMock.mockRejectedValueOnce(
      new Error("[BrokerError|TIMEOUT] Request timed out after 30000ms")
    );
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { cloudCleanup: CLEANUP });
    await flush();
    expect(settleMock).toHaveBeenCalledWith(CLEANUP.worktree, null, expect.any(String));
  });

  it("takes 'Worktree removed.' only at the start of a failure as the worktree going", async () => {
    worktreeClientDeleteMock.mockRejectedValueOnce(
      new Error("Refusing: '/repo/Worktree removed. old/nested' is a nested worktree")
    );
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { cloudCleanup: CLEANUP });
    await flush();
    expect(settleMock).toHaveBeenCalledWith(CLEANUP.worktree, false, expect.any(String));
  });

  it("settles a parked delete whose worktree is missing after a reconnect as unknown", async () => {
    worktreeClientDeleteMock.mockRejectedValueOnce(new Error("HOST_EXITED: workspace host exited"));
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { cloudCleanup: CLEANUP });
    await flush();
    const [entry] = [...store.getState().mutationOutbox.values()];
    expect(entry?.status).toBe("pending");
    settleMock.mockClear();
    // The reconnect's list no longer has it: only its monitor is known to be gone.
    store.getState().applySnapshot([], { epoch: "e", seq: 3 });
    store.getState().replayOutboxAfterReconnect();
    expect(settleMock).toHaveBeenCalledTimes(1);
    expect(settleMock).toHaveBeenCalledWith(CLEANUP.worktree, null, entry!.mutationId);
    expect(worktreeClientDeleteMock).toHaveBeenCalledTimes(1);
  });

  it("settles a delete the host acknowledged after the renderer lost its answer", async () => {
    worktreeClientDeleteMock.mockRejectedValueOnce(new Error("HOST_EXITED: workspace host exited"));
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { cloudCleanup: CLEANUP });
    await flush();
    const [entry] = [...store.getState().mutationOutbox.values()];
    settleMock.mockClear();
    store.getState().pruneAcknowledgedMutations([entry!.mutationId]);
    expect(settleMock).toHaveBeenCalledTimes(1);
    expect(settleMock).toHaveBeenCalledWith(CLEANUP.worktree, true, entry!.mutationId);
  });

  it("says once that a machine's delete failed, with Retry", async () => {
    settleMock.mockResolvedValueOnce([
      {
        hostId: "login-host",
        machineName: "login-box",
        choice: "delete",
        error: "Boat didn't answer.",
      },
    ]);
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { cloudCleanup: CLEANUP });
    await flush();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0] as {
      type: string;
      title: string;
      message: string;
      action: { label: string; onClick: () => void };
    };
    expect(payload).toMatchObject({ type: "error", title: "Couldn't delete cloud machine" });
    expect(payload.message).toContain("'login-box' wasn't deleted: Boat didn't answer.");
    expect(payload.action.label).toBe("Retry");
    payload.action.onClick();
    expect(retryMock).toHaveBeenCalledWith("login-host");
  });

  it("asks nothing of cloud hosts for a worktree with no machines", async () => {
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { closeTerminals: true });
    await flush();
    expect(worktreeClientDeleteMock).toHaveBeenCalledTimes(1);
    expect(prepareMock).not.toHaveBeenCalled();
    expect(settleMock).not.toHaveBeenCalled();
  });
});

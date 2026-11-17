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
    worktreeClientDeleteMock: vi.fn(async () => {
      calls.push("delete");
    }),
    closeTerminalsForWorktreeMock: vi.fn(async () => {
      calls.push("close-terminals");
    }),
    notifyMock: vi.fn(),
    prepareMock: vi.fn(async () => {
      calls.push("prepare");
    }),
    settleMock: vi.fn(async (): Promise<CloudWorktreeCleanupOutcome[]> => []),
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
    expect(calls).toEqual(["prepare", "close-terminals", "delete"]);
    expect(prepareMock).toHaveBeenCalledWith(CLEANUP.worktree, CLEANUP.machines);
    expect(settleMock).toHaveBeenCalledWith(CLEANUP.worktree, true);
  });

  it("stops the delete when the choice can't be written down", async () => {
    prepareMock.mockRejectedValueOnce(new Error("Cloud hosts aren't ready yet."));
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { closeTerminals: true, cloudCleanup: CLEANUP });
    await flush();
    expect(closeTerminalsForWorktreeMock).not.toHaveBeenCalled();
    expect(worktreeClientDeleteMock).not.toHaveBeenCalled();
    expect(settleMock).not.toHaveBeenCalled();
    expect(store.getState().deleteErrors.get("wt-1")).toContain(
      "Couldn't record what happens to its cloud machine"
    );
  });

  it("settles a failed delete as not deleted, and writes the choice again on Retry", async () => {
    worktreeClientDeleteMock.mockRejectedValueOnce(new Error("git error: unmerged paths"));
    const store = storeWithWorktree();
    store.getState().startDelete("wt-1", { cloudCleanup: CLEANUP });
    await flush();
    expect(settleMock).toHaveBeenCalledWith(CLEANUP.worktree, false);

    store.getState().retryDelete("wt-1");
    await flush();
    expect(prepareMock).toHaveBeenCalledTimes(2);
    expect(settleMock).toHaveBeenLastCalledWith(CLEANUP.worktree, true);
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

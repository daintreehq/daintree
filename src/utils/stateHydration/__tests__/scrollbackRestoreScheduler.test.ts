// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
}));

const fetchAndRestoreMock = vi.fn();
const getMock = vi.fn();
const notifyRestoreSettledWaitersMock = vi.fn();
const notifyScrollbackRestoreListenersMock = vi.fn();

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: (id: string) => getMock(id),
    fetchAndRestore: (id: string) => fetchAndRestoreMock(id),
    notifyRestoreSettledWaiters: (id: string) => notifyRestoreSettledWaitersMock(id),
    notifyScrollbackRestoreListeners: () => notifyScrollbackRestoreListenersMock(),
  },
}));

const setScrollbackRestoreErrorMock = vi.fn();
const clearScrollbackRestoreErrorMock = vi.fn();

vi.mock("@/store", () => ({
  usePanelStore: {
    getState: () => ({
      setScrollbackRestoreError: setScrollbackRestoreErrorMock,
      clearScrollbackRestoreError: clearScrollbackRestoreErrorMock,
    }),
  },
}));

const scheduleBackgroundFetchAndRestoreMock = vi.fn();

vi.mock("../batchScheduler", async () => {
  const actual = await vi.importActual<typeof import("../batchScheduler")>("../batchScheduler");
  return {
    ...actual,
    scheduleBackgroundFetchAndRestore: (fn: () => Promise<void>) =>
      scheduleBackgroundFetchAndRestoreMock(fn),
  };
});

const {
  scheduleScrollbackRestore,
  retryFailedScrollbackRestoreBatch,
  resetScrollbackRestoreBatch,
} = await import("../scrollbackRestoreScheduler");

function getScheduledDoRestore(callIndex = 0): () => Promise<void> {
  const cb = scheduleBackgroundFetchAndRestoreMock.mock.calls[callIndex]?.[0];
  return cb as () => Promise<void>;
}

interface FakeManaged {
  scrollbackRestoreState: "none" | "pending" | "in-progress" | "done";
  hostElement?: HTMLElement | null;
  listeners: Array<() => void>;
  lastScrollbackRestoreError?: TerminalScrollbackRestoreError;
}

function fakeManaged(state: FakeManaged["scrollbackRestoreState"] = "none"): FakeManaged {
  return {
    scrollbackRestoreState: state,
    listeners: [],
  };
}

beforeEach(() => {
  fetchAndRestoreMock.mockReset();
  getMock.mockReset();
  scheduleBackgroundFetchAndRestoreMock.mockReset();
  setScrollbackRestoreErrorMock.mockReset();
  notifyRestoreSettledWaitersMock.mockReset();
  clearScrollbackRestoreErrorMock.mockReset();
  notifyScrollbackRestoreListenersMock.mockReset();
  resetScrollbackRestoreBatch();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("scheduleScrollbackRestore — gating", () => {
  it("skips terminals that are not registered in terminalInstanceService", () => {
    getMock.mockReturnValue(undefined);
    scheduleScrollbackRestore(
      [{ terminalId: "missing", label: "x", location: "grid" }],
      () => true
    );
    expect(scheduleBackgroundFetchAndRestoreMock).not.toHaveBeenCalled();
  });

  it("skips terminals whose scrollbackRestoreState is not 'none'", () => {
    getMock.mockReturnValue(fakeManaged("pending"));
    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => true);
    expect(scheduleBackgroundFetchAndRestoreMock).not.toHaveBeenCalled();
  });

  it("transitions state from 'none' to 'pending' before scheduling", () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => true);
    expect(managed.scrollbackRestoreState).toBe("pending");
    expect(scheduleBackgroundFetchAndRestoreMock).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleScrollbackRestore — background mode", () => {
  it("invokes scheduler.postTask path; doRestore calls fetchAndRestore and marks done", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    fetchAndRestoreMock.mockResolvedValue(undefined);

    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => true);

    expect(scheduleBackgroundFetchAndRestoreMock).toHaveBeenCalledTimes(1);
    await getScheduledDoRestore()();

    expect(fetchAndRestoreMock).toHaveBeenCalledWith("t1");
    expect(managed.scrollbackRestoreState).toBe("done");
    expect(setScrollbackRestoreErrorMock).not.toHaveBeenCalled();
  });

  it("doRestore bails when isCurrent returns false and resets state to 'none' so retry remains possible (#8535 regression)", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);

    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => false);

    await getScheduledDoRestore()();

    expect(fetchAndRestoreMock).not.toHaveBeenCalled();
    // Without the reset, the scheduler's entry guard
    // (state !== "none" → continue) would permanently strand the terminal
    // after the user navigates away and back.
    expect(managed.scrollbackRestoreState).toBe("none");
  });

  it("doRestore bails when terminal instance is replaced (LRU swap detection) and resets state to 'none'", async () => {
    const original = fakeManaged("none");
    getMock.mockReturnValueOnce(original); // initial schedule call

    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => true);

    // Now simulate swap: get() returns a different object inside doRestore
    const replacement = fakeManaged("none");
    getMock.mockReturnValueOnce(replacement);

    await getScheduledDoRestore()();

    expect(fetchAndRestoreMock).not.toHaveBeenCalled();
    expect(original.scrollbackRestoreState).toBe("none");
  });

  it("after isCurrent() bail, a subsequent scheduleScrollbackRestore call picks the terminal up again", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);

    // First call: isCurrent → false. doRestore bails and resets state.
    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => false);
    await getScheduledDoRestore(0)();
    expect(managed.scrollbackRestoreState).toBe("none");

    // Second call (user navigated back): isCurrent → true. The entry guard
    // now passes because state was reset. fetchAndRestore should run.
    fetchAndRestoreMock.mockResolvedValue(undefined);
    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => true);
    expect(scheduleBackgroundFetchAndRestoreMock).toHaveBeenCalledTimes(2);
    await getScheduledDoRestore(1)();
    expect(fetchAndRestoreMock).toHaveBeenCalledWith("t1");
    expect(managed.scrollbackRestoreState).toBe("done");
  });

  it("doRestore bails when scrollbackRestoreState diverged from 'pending' (mid-flight cancel)", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);

    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => true);

    // External code re-set state away from pending before doRestore fires
    managed.scrollbackRestoreState = "done";

    await getScheduledDoRestore()();

    expect(fetchAndRestoreMock).not.toHaveBeenCalled();
  });

  it("resets state to 'none' on fetchAndRestore rejection (IPC error path)", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    fetchAndRestoreMock.mockRejectedValue(new Error("nope"));

    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => true);

    await getScheduledDoRestore()();

    expect(managed.scrollbackRestoreState).toBe("none");
    expect(setScrollbackRestoreErrorMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ type: "error", message: "nope" })
    );
  });

  it("surfaces lastScrollbackRestoreError to the panel store when fetchAndRestore returns silently after a replay failure (#8535)", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    // Simulate the controller swallowing a write timeout: fetchAndRestore
    // resolves (returns false internally) but stashes a classified error on
    // managed.lastScrollbackRestoreError.
    fetchAndRestoreMock.mockImplementation(async () => {
      managed.lastScrollbackRestoreError = {
        type: "timeout",
        message: "Write timeout",
        timestamp: 123,
      };
      return false;
    });

    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => true);

    await getScheduledDoRestore()();

    expect(managed.scrollbackRestoreState).toBe("none");
    expect(setScrollbackRestoreErrorMock).toHaveBeenCalledWith("t1", {
      type: "timeout",
      message: "Write timeout",
      timestamp: 123,
    });
  });

  it("does not emit to panel store if isCurrent flips to false before the failure handler reads it", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    let currentFlag = true;
    fetchAndRestoreMock.mockImplementation(async () => {
      managed.lastScrollbackRestoreError = {
        type: "parse",
        message: "boom",
        timestamp: 1,
      };
      // Simulate a project switch happening during the IPC await window.
      currentFlag = false;
      return false;
    });

    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "x", location: "grid" }],
      () => currentFlag
    );

    await getScheduledDoRestore()();

    expect(setScrollbackRestoreErrorMock).not.toHaveBeenCalled();
    // State still resets so a future restore can retry.
    expect(managed.scrollbackRestoreState).toBe("none");
  });
});

describe("scheduleScrollbackRestore — fully-settled notification", () => {
  it("notifies settled waiters after a clean restore (success path)", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    fetchAndRestoreMock.mockResolvedValue(undefined);

    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => true);
    await getScheduledDoRestore()();

    expect(managed.scrollbackRestoreState).toBe("done");
    expect(notifyRestoreSettledWaitersMock).toHaveBeenCalledWith("t1");
  });

  it("notifies settled waiters after a swallowed replay failure", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    fetchAndRestoreMock.mockImplementation(async () => {
      managed.lastScrollbackRestoreError = { type: "timeout", message: "boom", timestamp: 1 };
      return false;
    });

    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => true);
    await getScheduledDoRestore()();

    expect(managed.scrollbackRestoreState).toBe("none");
    expect(notifyRestoreSettledWaitersMock).toHaveBeenCalledWith("t1");
  });

  it("notifies settled waiters after an IPC-level rejection", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    fetchAndRestoreMock.mockRejectedValue(new Error("nope"));

    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => true);
    await getScheduledDoRestore()();

    expect(notifyRestoreSettledWaitersMock).toHaveBeenCalledWith("t1");
  });

  it("notifies settled waiters when restore bails before starting (isCurrent → false)", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);

    scheduleScrollbackRestore([{ terminalId: "t1", label: "x", location: "grid" }], () => false);
    await getScheduledDoRestore()();

    expect(managed.scrollbackRestoreState).toBe("none");
    expect(notifyRestoreSettledWaitersMock).toHaveBeenCalledWith("t1");
  });
});

describe("scheduleScrollbackRestore — listener notifications", () => {
  it("notifies once after the initial batch of 'pending' transitions", () => {
    getMock.mockImplementation(() => fakeManaged("none"));
    scheduleScrollbackRestore(
      [
        { terminalId: "t1", label: "a", location: "grid" },
        { terminalId: "t2", label: "b", location: "grid" },
      ],
      () => true
    );
    // A single batch notify for the two pending transitions, not one per task.
    expect(notifyScrollbackRestoreListenersMock).toHaveBeenCalledTimes(1);
  });

  it("does not notify when no task passes the schedule gate", () => {
    getMock.mockReturnValue(fakeManaged("done"));
    scheduleScrollbackRestore([{ terminalId: "t1", label: "a", location: "grid" }], () => true);
    expect(notifyScrollbackRestoreListenersMock).not.toHaveBeenCalled();
  });

  it("notifies on the in-progress and done transitions during a successful restore", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    fetchAndRestoreMock.mockResolvedValue(undefined);

    scheduleScrollbackRestore([{ terminalId: "t1", label: "a", location: "grid" }], () => true);
    notifyScrollbackRestoreListenersMock.mockClear(); // drop the pending-batch notify

    await getScheduledDoRestore()();

    // One notify for in-progress, one for done.
    expect(notifyScrollbackRestoreListenersMock).toHaveBeenCalledTimes(2);
    expect(managed.scrollbackRestoreState).toBe("done");
  });

  it("notifies on the failure transition when a restore error surfaces", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    fetchAndRestoreMock.mockImplementation(async () => {
      managed.lastScrollbackRestoreError = { type: "timeout", message: "slow", timestamp: 1 };
      return false;
    });

    scheduleScrollbackRestore([{ terminalId: "t1", label: "a", location: "grid" }], () => true);
    notifyScrollbackRestoreListenersMock.mockClear();

    await getScheduledDoRestore()();

    // in-progress + failure-reset transitions both notify.
    expect(notifyScrollbackRestoreListenersMock).toHaveBeenCalledTimes(2);
    expect(managed.scrollbackRestoreState).toBe("none");
  });
});

describe("retryFailedScrollbackRestoreBatch", () => {
  it("clears stored errors and re-queues only the captured failed tasks", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    fetchAndRestoreMock.mockImplementation(async () => {
      managed.lastScrollbackRestoreError = { type: "error", message: "boom", timestamp: 1 };
      return false;
    });

    // Original schedule captures the task, then fails (state resets to "none").
    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "first", location: "grid", worktreeId: "wt-1" }],
      () => true
    );
    await getScheduledDoRestore(0)();
    expect(managed.scrollbackRestoreState).toBe("none");

    // Retry: clears error, re-submits the captured task definition. A real
    // fetchAndRestore resets lastScrollbackRestoreError at the start of a fresh
    // attempt (TerminalRestoreController), so model that here.
    fetchAndRestoreMock.mockReset();
    fetchAndRestoreMock.mockImplementation(async () => {
      managed.lastScrollbackRestoreError = undefined;
    });
    retryFailedScrollbackRestoreBatch(["t1"]);

    expect(clearScrollbackRestoreErrorMock).toHaveBeenCalledWith("t1");
    expect(scheduleBackgroundFetchAndRestoreMock).toHaveBeenCalledTimes(2);

    await getScheduledDoRestore(1)();
    expect(fetchAndRestoreMock).toHaveBeenCalledWith("t1");
    expect(managed.scrollbackRestoreState).toBe("done");
  });

  it("does not clear the error or schedule when no captured task matches", () => {
    // The failure banner is the only recovery affordance — never dismiss it
    // without queuing an actual retry.
    retryFailedScrollbackRestoreBatch(["unknown"]);
    expect(clearScrollbackRestoreErrorMock).not.toHaveBeenCalled();
    expect(scheduleBackgroundFetchAndRestoreMock).not.toHaveBeenCalled();
  });

  it("does not re-queue a still-restoring terminal (scheduler gate holds)", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    fetchAndRestoreMock.mockResolvedValue(undefined);

    scheduleScrollbackRestore([{ terminalId: "t1", label: "a", location: "grid" }], () => true);
    // Task captured but terminal is now "done" — a spurious retry must no-op.
    await getScheduledDoRestore(0)();
    expect(managed.scrollbackRestoreState).toBe("done");

    scheduleBackgroundFetchAndRestoreMock.mockClear();
    retryFailedScrollbackRestoreBatch(["t1"]);
    expect(clearScrollbackRestoreErrorMock).toHaveBeenCalledWith("t1");
    expect(scheduleBackgroundFetchAndRestoreMock).not.toHaveBeenCalled();
  });
});

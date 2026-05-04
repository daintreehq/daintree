// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
}));

const fetchAndRestoreMock = vi.fn();
const getMock = vi.fn();

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: (id: string) => getMock(id),
    fetchAndRestore: (id: string) => fetchAndRestoreMock(id),
  },
}));

const scheduleBackgroundFetchAndRestoreMock = vi.fn();
const registerLazyScrollRestoreMock = vi.fn();

vi.mock("../batchScheduler", async () => {
  const actual = await vi.importActual<typeof import("../batchScheduler")>("../batchScheduler");
  return {
    ...actual,
    scheduleBackgroundFetchAndRestore: (fn: () => Promise<void>) =>
      scheduleBackgroundFetchAndRestoreMock(fn),
    registerLazyScrollRestore: (managed: unknown, fn: () => Promise<void>) =>
      registerLazyScrollRestoreMock(managed, fn),
  };
});

const { scheduleScrollbackRestore } = await import("../scrollbackRestoreScheduler");

function getScheduledDoRestore(callIndex = 0): () => Promise<void> {
  const cb = scheduleBackgroundFetchAndRestoreMock.mock.calls[callIndex]?.[0];
  return cb as () => Promise<void>;
}

interface FakeManaged {
  scrollbackRestoreState: "none" | "pending" | "in-progress" | "done";
  hostElement?: HTMLElement | null;
  listeners: Array<() => void>;
  scrollbackRestoreDisposable?: { dispose: () => void };
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
  registerLazyScrollRestoreMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("scheduleScrollbackRestore — gating", () => {
  it("skips terminals that are not registered in terminalInstanceService", () => {
    getMock.mockReturnValue(undefined);
    scheduleScrollbackRestore(
      [{ terminalId: "missing", label: "x", location: "grid" }],
      () => true,
      "background"
    );
    expect(scheduleBackgroundFetchAndRestoreMock).not.toHaveBeenCalled();
    expect(registerLazyScrollRestoreMock).not.toHaveBeenCalled();
  });

  it("skips terminals whose scrollbackRestoreState is not 'none'", () => {
    getMock.mockReturnValue(fakeManaged("pending"));
    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "x", location: "grid" }],
      () => true,
      "background"
    );
    expect(scheduleBackgroundFetchAndRestoreMock).not.toHaveBeenCalled();
  });

  it("transitions state from 'none' to 'pending' before scheduling", () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "x", location: "grid" }],
      () => true,
      "background"
    );
    expect(managed.scrollbackRestoreState).toBe("pending");
    expect(scheduleBackgroundFetchAndRestoreMock).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleScrollbackRestore — background mode", () => {
  it("invokes scheduler.postTask path; doRestore calls fetchAndRestore and marks done", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    fetchAndRestoreMock.mockResolvedValue(undefined);

    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "x", location: "grid" }],
      () => true,
      "background"
    );

    expect(scheduleBackgroundFetchAndRestoreMock).toHaveBeenCalledTimes(1);
    await getScheduledDoRestore()();

    expect(fetchAndRestoreMock).toHaveBeenCalledWith("t1");
    expect(managed.scrollbackRestoreState).toBe("done");
  });

  it("doRestore bails when isCurrent returns false (no fetch, state stays pending)", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);

    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "x", location: "grid" }],
      () => false,
      "background"
    );

    await getScheduledDoRestore()();

    expect(fetchAndRestoreMock).not.toHaveBeenCalled();
    expect(managed.scrollbackRestoreState).toBe("pending");
  });

  it("doRestore bails when terminal instance is replaced (LRU swap detection)", async () => {
    const original = fakeManaged("none");
    getMock.mockReturnValueOnce(original); // initial schedule call

    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "x", location: "grid" }],
      () => true,
      "background"
    );

    // Now simulate swap: get() returns a different object inside doRestore
    const replacement = fakeManaged("none");
    getMock.mockReturnValueOnce(replacement);

    await getScheduledDoRestore()();

    expect(fetchAndRestoreMock).not.toHaveBeenCalled();
    expect(original.scrollbackRestoreState).toBe("pending");
  });

  it("doRestore bails when scrollbackRestoreState diverged from 'pending' (mid-flight cancel)", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);

    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "x", location: "grid" }],
      () => true,
      "background"
    );

    // External code re-set state away from pending before doRestore fires
    managed.scrollbackRestoreState = "done";

    await getScheduledDoRestore()();

    expect(fetchAndRestoreMock).not.toHaveBeenCalled();
  });

  it("resets state to 'none' on fetchAndRestore failure (so it can be retried)", async () => {
    const managed = fakeManaged("none");
    getMock.mockReturnValue(managed);
    fetchAndRestoreMock.mockRejectedValue(new Error("nope"));

    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "x", location: "grid" }],
      () => true,
      "background"
    );

    await getScheduledDoRestore()();

    expect(managed.scrollbackRestoreState).toBe("none");
  });
});

describe("scheduleScrollbackRestore — lazy mode", () => {
  it("registers lazy scroll restore when hostElement is present", () => {
    const dispose = vi.fn();
    registerLazyScrollRestoreMock.mockReturnValue({ dispose });

    const managed = fakeManaged("none");
    managed.hostElement = document.createElement("div");
    getMock.mockReturnValue(managed);

    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "x", location: "grid" }],
      () => true,
      "lazy"
    );

    expect(registerLazyScrollRestoreMock).toHaveBeenCalledTimes(1);
    expect(scheduleBackgroundFetchAndRestoreMock).not.toHaveBeenCalled();
    expect(managed.scrollbackRestoreDisposable).toEqual({ dispose });
    expect(managed.listeners).toHaveLength(1);
  });

  it("falls back to background scheduling when hostElement is missing in lazy mode", () => {
    const managed = fakeManaged("none");
    managed.hostElement = null;
    getMock.mockReturnValue(managed);

    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "x", location: "grid" }],
      () => true,
      "lazy"
    );

    expect(scheduleBackgroundFetchAndRestoreMock).toHaveBeenCalledTimes(1);
    expect(registerLazyScrollRestoreMock).not.toHaveBeenCalled();
  });

  it("registered listener cleanup invokes the disposable.dispose()", () => {
    const dispose = vi.fn();
    registerLazyScrollRestoreMock.mockReturnValue({ dispose });

    const managed = fakeManaged("none");
    managed.hostElement = document.createElement("div");
    getMock.mockReturnValue(managed);

    scheduleScrollbackRestore(
      [{ terminalId: "t1", label: "x", location: "grid" }],
      () => true,
      "lazy"
    );

    // Invoke the cleanup the scheduler pushed onto listeners[]
    const cleanup = managed.listeners[0]!;
    cleanup();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

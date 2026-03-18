import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scheduleDeferredSnapshotRestore } from "../batchScheduler";

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
}));

const globalAny = global as Record<string, unknown>;

describe("scheduleDeferredSnapshotRestore", () => {
  let postTaskCallbacks: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    postTaskCallbacks = [];

    vi.stubGlobal("scheduler", {
      postTask: vi.fn((cb: () => unknown, _opts?: unknown) => {
        postTaskCallbacks.push(cb as () => void);
        return Promise.resolve();
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    postTaskCallbacks = [];
  });

  it("calls scheduler.postTask with background priority when available", () => {
    const runRestore = vi.fn().mockResolvedValue(undefined);

    scheduleDeferredSnapshotRestore(runRestore);

    const schedulerMock = globalAny["scheduler"] as { postTask: ReturnType<typeof vi.fn> };
    expect(schedulerMock.postTask).toHaveBeenCalledWith(expect.any(Function), {
      priority: "background",
    });
    expect(runRestore).not.toHaveBeenCalled();

    postTaskCallbacks.forEach((cb) => cb());
    expect(runRestore).toHaveBeenCalledTimes(1);
  });

  it("falls back to setTimeout when scheduler is unavailable", () => {
    globalAny["scheduler"] = undefined;

    const timeouts: Array<() => void> = [];
    const origSetTimeout = global.setTimeout;
    global.setTimeout = vi.fn((cb: () => void) => {
      timeouts.push(cb);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const runRestore = vi.fn().mockResolvedValue(undefined);

    scheduleDeferredSnapshotRestore(runRestore);

    expect(global.setTimeout).toHaveBeenCalled();
    expect(runRestore).not.toHaveBeenCalled();

    timeouts.forEach((cb) => cb());
    expect(runRestore).toHaveBeenCalledTimes(1);

    global.setTimeout = origSetTimeout;
  });

  it("logs a warning when runRestore rejects", async () => {
    const { logWarn } = await import("@/utils/logger");
    const error = new Error("restore failed");
    const runRestore = vi.fn().mockRejectedValue(error);

    scheduleDeferredSnapshotRestore(runRestore);
    postTaskCallbacks.forEach((cb) => cb());

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(logWarn).toHaveBeenCalledWith(
      "Deferred terminal snapshot restore failed",
      expect.objectContaining({ error })
    );
  });
});

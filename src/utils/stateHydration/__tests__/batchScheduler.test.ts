import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scheduleBackgroundFetchAndRestore, getRestoreBatchParams } from "../batchScheduler";
import type { ResourceProfile } from "@shared/types/resourceProfile";

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
}));

const globalAny = global as Record<string, unknown>;

describe("scheduleBackgroundFetchAndRestore", () => {
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
    const restoreFn = vi.fn().mockResolvedValue(undefined);

    scheduleBackgroundFetchAndRestore(restoreFn);

    const schedulerMock = globalAny["scheduler"] as { postTask: ReturnType<typeof vi.fn> };
    expect(schedulerMock.postTask).toHaveBeenCalledWith(expect.any(Function), {
      priority: "background",
    });
    expect(restoreFn).not.toHaveBeenCalled();

    postTaskCallbacks.forEach((cb) => cb());
    expect(restoreFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to setTimeout when scheduler is unavailable", () => {
    globalAny["scheduler"] = undefined;

    const timeouts: Array<() => void> = [];
    const origSetTimeout = global.setTimeout;
    global.setTimeout = vi.fn((cb: () => void) => {
      timeouts.push(cb);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const restoreFn = vi.fn().mockResolvedValue(undefined);

    scheduleBackgroundFetchAndRestore(restoreFn);

    expect(global.setTimeout).toHaveBeenCalled();
    expect(restoreFn).not.toHaveBeenCalled();

    timeouts.forEach((cb) => cb());
    expect(restoreFn).toHaveBeenCalledTimes(1);

    global.setTimeout = origSetTimeout;
  });

  it("logs a warning when restoreFn rejects", async () => {
    const { logWarn } = await import("@/utils/logger");
    const error = new Error("restore failed");
    const restoreFn = vi.fn().mockRejectedValue(error);

    scheduleBackgroundFetchAndRestore(restoreFn);
    postTaskCallbacks.forEach((cb) => cb());

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(logWarn).toHaveBeenCalledWith(
      "Background scrollback restore failed",
      expect.objectContaining({ error })
    );
  });
});

describe("getRestoreBatchParams", () => {
  it("scales batch size up and delay down as the profile gets more capable", () => {
    const performance = getRestoreBatchParams("performance");
    const balanced = getRestoreBatchParams("balanced");
    const efficiency = getRestoreBatchParams("efficiency");

    // Monotonic: more capable profile => larger batches, shorter gaps.
    expect(performance.batchSize).toBeGreaterThan(balanced.batchSize);
    expect(balanced.batchSize).toBeGreaterThan(efficiency.batchSize);
    expect(performance.delayMs).toBeLessThan(balanced.delayMs);
    expect(balanced.delayMs).toBeLessThan(efficiency.delayMs);
  });

  it("keeps every batch size positive and below the fd-leak ceiling (#9544)", () => {
    for (const profile of ["performance", "balanced", "efficiency"] as ResourceProfile[]) {
      const { batchSize, delayMs } = getRestoreBatchParams(profile);
      expect(batchSize).toBeGreaterThan(0);
      expect(batchSize).toBeLessThanOrEqual(8);
      expect(delayMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("falls back to the balanced params for missing or unknown profiles", () => {
    const balanced = getRestoreBatchParams("balanced");
    expect(getRestoreBatchParams(undefined)).toEqual(balanced);
    expect(getRestoreBatchParams(null)).toEqual(balanced);
    expect(getRestoreBatchParams("nonsense" as ResourceProfile)).toEqual(balanced);
  });
});

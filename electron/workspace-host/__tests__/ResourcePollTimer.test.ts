import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResourcePollTimer, type ResourcePollTimerHost } from "../ResourcePollTimer.js";

interface MutableHost {
  isRunning: boolean;
  pollingEnabled: boolean;
  hasResourceConfig: boolean;
  hasStatusCommand: boolean;
  resourcePollIntervalMs: number;
  worktreeId: string;
  onResourceStatusPoll: ReturnType<typeof vi.fn>;
}

function makeHost(overrides: Partial<MutableHost> = {}): MutableHost {
  return {
    isRunning: true,
    pollingEnabled: true,
    hasResourceConfig: true,
    hasStatusCommand: true,
    resourcePollIntervalMs: 30_000,
    worktreeId: "/test/worktree",
    onResourceStatusPoll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ResourcePollTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("schedules at the configured interval", async () => {
    const host = makeHost({ resourcePollIntervalMs: 30_000 });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(host.onResourceStatusPoll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(1);
    expect(host.onResourceStatusPoll).toHaveBeenCalledWith("/test/worktree");
  });

  it("auto-reschedules itself after each callback", async () => {
    const host = makeHost({ resourcePollIntervalMs: 10_000 });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_001);
    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_001);
    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(3);
  });

  it("is idempotent — multiple schedule() calls do not stack timers", async () => {
    const host = makeHost();
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    timer.schedule();
    timer.schedule();
    await vi.advanceTimersByTimeAsync(31_000);

    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(1);
  });

  it("does not schedule when interval is 0 (disabled)", () => {
    const host = makeHost({ resourcePollIntervalMs: 0 });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    vi.advanceTimersByTime(60_000);

    expect(host.onResourceStatusPoll).not.toHaveBeenCalled();
  });

  it("does not schedule when hasResourceConfig is false", () => {
    const host = makeHost({ hasResourceConfig: false });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    vi.advanceTimersByTime(60_000);

    expect(host.onResourceStatusPoll).not.toHaveBeenCalled();
  });

  it("does not schedule when hasStatusCommand is false", () => {
    const host = makeHost({ hasStatusCommand: false });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    vi.advanceTimersByTime(60_000);

    expect(host.onResourceStatusPoll).not.toHaveBeenCalled();
  });

  it("re-checks gating flags at fire time, not just at schedule time", async () => {
    const host = makeHost({ resourcePollIntervalMs: 1_000 });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    // Before the timer fires, flip a gating flag.
    host.hasStatusCommand = false;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(host.onResourceStatusPoll).not.toHaveBeenCalled();
  });

  it("clear() cancels an armed timer without disposing", async () => {
    const host = makeHost({ resourcePollIntervalMs: 10_000 });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    timer.clear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(host.onResourceStatusPoll).not.toHaveBeenCalled();

    // Re-arm after clear.
    timer.schedule();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(1);
  });

  it("clear() prevents further callbacks even if a timer fires", async () => {
    const host = makeHost({ resourcePollIntervalMs: 5_000 });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    timer.clear();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(host.onResourceStatusPoll).not.toHaveBeenCalled();
  });

  it("clear() prevents post-callback rescheduling", async () => {
    const host = makeHost({ resourcePollIntervalMs: 5_000 });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(1);

    timer.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(1);
  });

  it("swallows callback exceptions and continues rescheduling", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let callCount = 0;
    const host = makeHost({
      resourcePollIntervalMs: 5_000,
      onResourceStatusPoll: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error("provider error");
        return Promise.resolve();
      }),
    });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // After error, next round should still run.
    await vi.advanceTimersByTimeAsync(5_001);
    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(2);
  });

  it("does not callback when host.isRunning becomes false before fire time", async () => {
    const host = makeHost({ resourcePollIntervalMs: 1_000 });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    host.isRunning = false;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(host.onResourceStatusPoll).not.toHaveBeenCalled();
  });

  it("does not schedule while polling is paused", async () => {
    const host = makeHost({ pollingEnabled: false, resourcePollIntervalMs: 1_000 });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(host.onResourceStatusPoll).not.toHaveBeenCalled();
  });

  it("does not re-arm when a poll in flight at pause completes", async () => {
    let resolvePoll!: () => void;
    const host = makeHost({
      resourcePollIntervalMs: 1_000,
      onResourceStatusPoll: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePoll = resolve;
          })
      ),
    });
    const timer = new ResourcePollTimer(host as ResourcePollTimerHost);

    timer.schedule();
    await vi.advanceTimersByTimeAsync(1_101);
    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(1);

    host.pollingEnabled = false;
    resolvePoll();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(host.onResourceStatusPoll).toHaveBeenCalledTimes(1);
  });
});

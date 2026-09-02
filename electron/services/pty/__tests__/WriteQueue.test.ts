import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WriteQueue, type WriteQueueOptions } from "../WriteQueue.js";
import type { TerminalSubmitStatusState } from "../../../../shared/types/pty-host.js";

/** Mirrors the production constants in WriteQueue.ts. Kept as local literals
 *  rather than imported so a change to the real thresholds shows up as a test
 *  failure to think about, not a silently-tracking pair of numbers. */
const SLOW_MS = 3000;
const STALLED_MS = 30000;

type MutableOptions = {
  isExited: { value: boolean };
  lastOutputTime: { value: number };
  performSubmit: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  onWriteError: ReturnType<typeof vi.fn>;
  statuses: TerminalSubmitStatusState[];
  options: WriteQueueOptions;
};

function makeOptions(): MutableOptions {
  const isExited = { value: false };
  const lastOutputTime = { value: Date.now() };
  const performSubmit = vi.fn<(text: string) => Promise<void>>(async () => {});
  const onWriteError = vi.fn();
  const statuses: TerminalSubmitStatusState[] = [];
  return {
    isExited,
    lastOutputTime,
    performSubmit,
    onWriteError,
    statuses,
    options: {
      isExited: () => isExited.value,
      lastOutputTime: () => lastOutputTime.value,
      performSubmit: (text) => performSubmit(text),
      onWriteError: (e, ctx) => onWriteError(e, ctx),
      onSubmitStatus: (state) => statuses.push(state),
    },
  };
}

/** A submit that never settles, for exercising the slow/stalled thresholds. */
function neverSettles(): Promise<void> {
  return new Promise<void>(() => {});
}

describe("WriteQueue.submit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes performSubmit for each queued text in FIFO order", async () => {
    const m = makeOptions();
    const order: string[] = [];
    m.performSubmit.mockImplementation(async (text) => {
      order.push(text);
    });
    const wq = new WriteQueue(m.options);

    wq.submit("first");
    wq.submit("second");
    wq.submit("third");

    await vi.runAllTimersAsync();
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("absorbs a performSubmit rejection without abandoning the queue", async () => {
    // A rejected submit is finished — it will never write again — so the lane
    // is safe to drain. This is the one case that differs from a slow submit,
    // which is still holding the composer and must NOT be followed.
    const m = makeOptions();
    const seen: string[] = [];
    m.performSubmit.mockImplementation(async (text) => {
      seen.push(text);
      if (text === "boom") throw new Error("submit failed");
    });
    const wq = new WriteQueue(m.options);

    wq.submit("boom");
    wq.submit("after");

    await vi.runAllTimersAsync();

    expect(seen).toEqual(["boom", "after"]);
    expect(m.onWriteError).toHaveBeenCalledOnce();
    expect(m.onWriteError.mock.calls[0]?.[1]).toEqual({ operation: "performSubmit" });
  });

  it("serialises overlapping submits — second performSubmit waits for the first to resolve", async () => {
    const m = makeOptions();
    let firstResolve!: () => void;
    let firstStarted = false;
    let secondStarted = false;
    m.performSubmit.mockImplementation((text) => {
      if (text === "a") {
        firstStarted = true;
        return new Promise<void>((r) => {
          firstResolve = r;
        });
      }
      secondStarted = true;
      return Promise.resolve();
    });

    const wq = new WriteQueue(m.options);
    wq.submit("a");
    wq.submit("b");

    // Allow the scheduler to call into the first performer.
    await Promise.resolve();
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(false);

    firstResolve();
    await vi.runAllTimersAsync();
    expect(secondStarted).toBe(true);
  });
});

describe("WriteQueue.cancelPendingInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops queued submits without stranding the in-flight slot", async () => {
    const m = makeOptions();
    let releaseFirst: (() => void) | undefined;
    m.performSubmit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        })
    );
    const queue = new WriteQueue(m.options);

    queue.submit("first");
    queue.submit("second");
    await Promise.resolve();
    expect(m.performSubmit).toHaveBeenCalledTimes(1);

    queue.cancelPendingInput();
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(0);

    // "second" was dropped, and the freed in-flight slot still accepts work.
    expect(m.performSubmit).toHaveBeenCalledTimes(1);
    m.performSubmit.mockImplementation(async () => {});
    queue.submit("third");
    await vi.advanceTimersByTimeAsync(0);
    expect(m.performSubmit).toHaveBeenCalledWith("third");
  });

  it("leaves the queue usable, unlike dispose", async () => {
    // The distinction the shutdown input lock depends on (#11851): the lock is
    // released when teardown ends, and on a teardown that resolved without
    // killing the pane the queue has to still accept input.
    const m = makeOptions();
    const queue = new WriteQueue(m.options);

    queue.submit("before-cancel");
    queue.cancelPendingInput();
    m.performSubmit.mockClear();

    queue.submit("after-cancel");
    await vi.runAllTimersAsync();
    expect(m.performSubmit).toHaveBeenCalledWith("after-cancel");
  });

  it("retracts a reported status instead of stranding it, and stops escalating", async () => {
    // Escalating to "stalled" mid-shutdown would report a problem the user can
    // do nothing about. But dropping the timer WITHOUT a closing event would
    // leave the pill up on a submit nothing is tracking any more, so the
    // retraction is what keeps the renderer from getting stuck.
    const m = makeOptions();
    m.performSubmit.mockImplementation(neverSettles);
    const queue = new WriteQueue(m.options);

    queue.submit("stuck");
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(m.statuses).toEqual(["slow"]);

    queue.cancelPendingInput();
    expect(m.statuses).toEqual(["slow", "settled"]);

    await vi.advanceTimersByTimeAsync(STALLED_MS);
    expect(m.statuses).toEqual(["slow", "settled"]);
  });

  it("stays silent on cancel when nothing was ever reported", async () => {
    const m = makeOptions();
    m.performSubmit.mockImplementation(neverSettles);
    const queue = new WriteQueue(m.options);

    queue.submit("stuck");
    queue.cancelPendingInput();

    expect(m.statuses).toEqual([]);
  });
});

describe("WriteQueue.dispose", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is idempotent", () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);

    expect(() => {
      wq.dispose();
      wq.dispose();
    }).not.toThrow();
  });

  it("drops further submit calls", async () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);
    wq.dispose();

    wq.submit("nope");

    await vi.runAllTimersAsync();
    expect(m.performSubmit).not.toHaveBeenCalled();
  });

  it("schedules no timers in the constructor (no submit, no work)", () => {
    const m = makeOptions();
    new WriteQueue(m.options);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("silences a pending slow-submit report", async () => {
    const m = makeOptions();
    m.performSubmit.mockImplementation(neverSettles);
    const wq = new WriteQueue(m.options);

    wq.submit("stuck");
    // Disposed before the slow threshold is ever reached.
    wq.dispose();
    await vi.advanceTimersByTimeAsync(STALLED_MS);

    expect(m.statuses).toEqual([]);
  });
});

describe("WriteQueue.waitForOutputSettle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns once enough quiet time has elapsed", async () => {
    const m = makeOptions();
    const start = Date.now();
    m.lastOutputTime.value = start;
    const wq = new WriteQueue(m.options);

    let resolved = false;
    void wq.waitForOutputSettle({ debounceMs: 100, maxWaitMs: 1000, pollMs: 25 }).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(resolved).toBe(true);
  });

  it("returns when maxWaitMs elapses even if output keeps arriving", async () => {
    const m = makeOptions();
    m.lastOutputTime.value = Date.now();
    const wq = new WriteQueue(m.options);

    let resolved = false;
    void wq.waitForOutputSettle({ debounceMs: 500, maxWaitMs: 200, pollMs: 25 }).then(() => {
      resolved = true;
    });

    // Advance in increments while bumping lastOutputTime so debounce never trips.
    for (let i = 0; i < 10; i++) {
      m.lastOutputTime.value = Date.now();
      await vi.advanceTimersByTimeAsync(30);
    }
    expect(resolved).toBe(true);
  });

  it("caps the final poll at the remaining debounce and max-wait windows", async () => {
    const debounceOptions = makeOptions();
    const debounceQueue = new WriteQueue(debounceOptions.options);
    let debounceResolved = false;
    void debounceQueue
      .waitForOutputSettle({ debounceMs: 100, maxWaitMs: 1000, pollMs: 60 })
      .then(() => {
        debounceResolved = true;
      });

    await vi.advanceTimersByTimeAsync(99);
    expect(debounceResolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(debounceResolved).toBe(true);

    const maxWaitOptions = makeOptions();
    maxWaitOptions.lastOutputTime.value = Date.now();
    const maxWaitQueue = new WriteQueue(maxWaitOptions.options);
    let maxWaitResolved = false;
    void maxWaitQueue
      .waitForOutputSettle({ debounceMs: 500, maxWaitMs: 200, pollMs: 75 })
      .then(() => {
        maxWaitResolved = true;
      });

    for (let elapsed = 0; elapsed < 199; elapsed += 25) {
      maxWaitOptions.lastOutputTime.value = Date.now();
      await vi.advanceTimersByTimeAsync(Math.min(25, 199 - elapsed));
    }
    expect(maxWaitResolved).toBe(false);
    maxWaitOptions.lastOutputTime.value = Date.now();
    await vi.advanceTimersByTimeAsync(1);
    expect(maxWaitResolved).toBe(true);
  });
});

// #11875. The slow-submit timer reports; it does not release the submit lane.
// These replace the old "submit timeout" suite, which asserted the opposite —
// that the queue kept draining and cleared `submitInFlight` once the 3000ms
// timer fired. That behaviour was the bug: it let the next submit write its
// body into a composer the abandoned submit still owned.
describe("WriteQueue slow-submit reporting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT start the next submit when the slow threshold passes", async () => {
    const m = makeOptions();
    const seen: string[] = [];
    m.performSubmit.mockImplementation((text) => {
      seen.push(text);
      return text === "stuck" ? neverSettles() : Promise.resolve();
    });
    const wq = new WriteQueue(m.options);

    wq.submit("stuck");
    wq.submit("after");

    await vi.advanceTimersByTimeAsync(SLOW_MS * 2);

    // The lane stays owned by the stuck submit. This is the whole fix.
    expect(seen).toEqual(["stuck"]);
    expect(m.onWriteError).not.toHaveBeenCalled();
  });

  it("reports slow without manufacturing an error", async () => {
    const m = makeOptions();
    m.performSubmit.mockImplementation(neverSettles);
    const wq = new WriteQueue(m.options);

    wq.submit("stuck");

    await vi.advanceTimersByTimeAsync(SLOW_MS - 1);
    expect(m.statuses).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(m.statuses).toEqual(["slow"]);
    expect(m.onWriteError).not.toHaveBeenCalled();
  });

  it("escalates to stalled at the total threshold, not slow + stalled", async () => {
    const m = makeOptions();
    m.performSubmit.mockImplementation(neverSettles);
    const wq = new WriteQueue(m.options);

    wq.submit("stuck");

    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(m.statuses).toEqual(["slow"]);

    // One tick short of STALLED_MS total.
    await vi.advanceTimersByTimeAsync(STALLED_MS - SLOW_MS - 1);
    expect(m.statuses).toEqual(["slow"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(m.statuses).toEqual(["slow", "stalled"]);
  });

  it("anchors the stalled deadline to the submit's start, not to when slow fired", async () => {
    // Re-arming for a fixed remainder would drift: a blocked event loop that
    // delays the slow callback would push stalled out by the same amount. The
    // contract is STALLED_MS measured from the submit, so once the clock is
    // already past that point stalled is due immediately.
    const m = makeOptions();
    m.performSubmit.mockImplementation(neverSettles);
    const wq = new WriteQueue(m.options);

    wq.submit("stuck");

    // Jump the wall clock past the stalled deadline while the slow timer is
    // still pending, then let it fire.
    vi.setSystemTime(Date.now() + STALLED_MS);
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(m.statuses).toEqual(["slow"]);

    // Deadline already passed, so escalation is due immediately rather than
    // another full window away — 1ms is enough, 27_000ms would not be.
    await vi.advanceTimersByTimeAsync(1);
    expect(m.statuses).toEqual(["slow", "stalled"]);
  });

  it("reports settled when a slow submit finally completes, then drains the queue", async () => {
    const m = makeOptions();
    let release!: () => void;
    const seen: string[] = [];
    m.performSubmit.mockImplementation((text) => {
      seen.push(text);
      if (text === "slowly") {
        return new Promise<void>((r) => {
          release = r;
        });
      }
      return Promise.resolve();
    });
    const wq = new WriteQueue(m.options);

    wq.submit("slowly");
    wq.submit("after");

    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(m.statuses).toEqual(["slow"]);
    expect(seen).toEqual(["slowly"]);

    release();
    await vi.runAllTimersAsync();

    expect(m.statuses).toEqual(["slow", "settled"]);
    expect(seen).toEqual(["slowly", "after"]);
  });

  it("stays silent for a submit that completes inside the threshold", async () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);

    wq.submit("quick");
    await vi.runAllTimersAsync();

    expect(m.statuses).toEqual([]);
  });

  it("leaves no timer armed once a submit settles", async () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);

    wq.submit("quick");
    await vi.runAllTimersAsync();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports failed when performSubmit rejects, and reports the original error once", async () => {
    const m = makeOptions();
    m.performSubmit.mockImplementation(async () => {
      throw new Error("PTY write failed");
    });
    const wq = new WriteQueue(m.options);

    wq.submit("boom");
    await vi.runAllTimersAsync();

    expect(m.statuses).toEqual(["failed"]);
    expect(m.onWriteError).toHaveBeenCalledTimes(1);
    const err = m.onWriteError.mock.calls[0]?.[0] as Error;
    expect(err.message).toBe("PTY write failed");
  });

  it("reports slow then failed when a slow submit eventually rejects", async () => {
    const m = makeOptions();
    let fail!: (reason?: unknown) => void;
    m.performSubmit.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        })
    );
    const wq = new WriteQueue(m.options);

    wq.submit("late-reject");
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(m.statuses).toEqual(["slow"]);

    fail(new Error("PTY write failed"));
    await vi.runAllTimersAsync();

    expect(m.statuses).toEqual(["slow", "failed"]);
    expect(m.onWriteError).toHaveBeenCalledTimes(1);
  });

  it("survives a status sink that throws", async () => {
    // The sink runs inside a timer callback in the pty-host; letting it throw
    // would take the whole utility process down.
    const m = makeOptions();
    m.performSubmit.mockImplementation(neverSettles);
    const wq = new WriteQueue({
      ...m.options,
      onSubmitStatus: () => {
        throw new Error("sink exploded");
      },
    });

    wq.submit("stuck");
    await vi.advanceTimersByTimeAsync(SLOW_MS);

    // Reaching here at all is the assertion: a throwing sink neither escaped
    // the timer callback nor stopped the queue accepting further work.
    m.performSubmit.mockImplementation(async () => {});
    wq.cancelPendingInput();
    expect(() => wq.submit("still-usable")).not.toThrow();
  });
});

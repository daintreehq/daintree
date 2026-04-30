import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WriteQueue, type WriteQueueOptions } from "../WriteQueue.js";
import { WRITE_INTERVAL_MS, WRITE_MAX_CHUNK_SIZE } from "../types.js";

type MutableOptions = {
  writeToPty: ReturnType<typeof vi.fn<(data: string) => void>>;
  isExited: { value: boolean };
  lastOutputTime: { value: number };
  performSubmit: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  onWriteError: ReturnType<typeof vi.fn>;
  options: WriteQueueOptions;
};

function makeOptions(): MutableOptions {
  const isExited = { value: false };
  const lastOutputTime = { value: Date.now() };
  const writeToPty = vi.fn<(data: string) => void>();
  const performSubmit = vi.fn<(text: string) => Promise<void>>(async () => {});
  const onWriteError = vi.fn();
  return {
    writeToPty,
    isExited,
    lastOutputTime,
    performSubmit,
    onWriteError,
    options: {
      writeToPty: (data) => writeToPty(data),
      isExited: () => isExited.value,
      lastOutputTime: () => lastOutputTime.value,
      performSubmit: (text) => performSubmit(text),
      onWriteError: (e, ctx) => onWriteError(e, ctx),
    },
  };
}

describe("WriteQueue.enqueueChunked", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a single small payload synchronously", () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);

    wq.enqueueChunked("hello");

    expect(m.writeToPty).toHaveBeenCalledTimes(1);
    expect(m.writeToPty).toHaveBeenCalledWith("hello");
  });

  it("paces large payloads at WRITE_INTERVAL_MS between chunks", async () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);
    // Force at least three chunks.
    const big = "x".repeat(WRITE_MAX_CHUNK_SIZE * 3);

    wq.enqueueChunked(big);

    // First chunk fires synchronously.
    expect(m.writeToPty).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WRITE_INTERVAL_MS);
    expect(m.writeToPty).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(WRITE_INTERVAL_MS);
    expect(m.writeToPty).toHaveBeenCalledTimes(3);

    // Reassembled order matches input.
    const written = m.writeToPty.mock.calls.map((c) => c[0]).join("");
    expect(written).toBe(big);
  });

  it("preserves order when a second enqueueChunked arrives while the first is still pacing", async () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);
    const first = "a".repeat(WRITE_MAX_CHUNK_SIZE * 3);
    const second = "b".repeat(WRITE_MAX_CHUNK_SIZE * 2);

    wq.enqueueChunked(first);
    // After one interval, the second chunk of `first` has fired but the
    // queue is still draining. Append `second` mid-flight.
    await vi.advanceTimersByTimeAsync(WRITE_INTERVAL_MS);
    wq.enqueueChunked(second);

    await vi.runAllTimersAsync();

    const written = m.writeToPty.mock.calls.map((c) => c[0]).join("");
    expect(written).toBe(first + second);
  });

  it("ignores empty payloads", () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);

    wq.enqueueChunked("");

    expect(m.writeToPty).not.toHaveBeenCalled();
  });

  it("stops writing once isExited turns true mid-drain", async () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);
    const big = "x".repeat(WRITE_MAX_CHUNK_SIZE * 3);

    wq.enqueueChunked(big);
    expect(m.writeToPty).toHaveBeenCalledTimes(1);

    m.isExited.value = true;
    await vi.advanceTimersByTimeAsync(WRITE_INTERVAL_MS * 5);

    // No further writes after exit.
    expect(m.writeToPty).toHaveBeenCalledTimes(1);
  });

  it("routes writeToPty exceptions to onWriteError without throwing", () => {
    const m = makeOptions();
    m.writeToPty.mockImplementation(() => {
      throw new Error("EBADF");
    });
    const wq = new WriteQueue(m.options);

    expect(() => wq.enqueueChunked("oops")).not.toThrow();
    expect(m.onWriteError).toHaveBeenCalledOnce();
    expect(m.onWriteError.mock.calls[0]?.[1]).toEqual({ operation: "write(chunk)" });
  });
});

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

describe("WriteQueue.waitForInputWriteDrain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when nothing is queued", async () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);

    await expect(wq.waitForInputWriteDrain()).resolves.toBeUndefined();
  });

  it("resolves after the chunked queue empties", async () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);
    wq.enqueueChunked("x".repeat(WRITE_MAX_CHUNK_SIZE * 2));

    let resolved = false;
    void wq.waitForInputWriteDrain().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(WRITE_INTERVAL_MS * 5);
    expect(resolved).toBe(true);
  });

  it("resolves promptly when dispose() fires mid-drain", async () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);
    wq.enqueueChunked("x".repeat(WRITE_MAX_CHUNK_SIZE * 5));

    let resolved = false;
    void wq.waitForInputWriteDrain().then(() => {
      resolved = true;
    });

    wq.dispose();
    // The polling loop uses setTimeout(check, 0). Flush microtasks + the
    // 0-ms timer so the resolver runs.
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
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

  it("drops further enqueueChunked and submit calls", async () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);
    wq.dispose();

    wq.enqueueChunked("nope");
    wq.submit("nope");

    await vi.runAllTimersAsync();
    expect(m.writeToPty).not.toHaveBeenCalled();
    expect(m.performSubmit).not.toHaveBeenCalled();
  });

  it("cancels the pacing timer so no further writes fire after dispose", async () => {
    const m = makeOptions();
    const wq = new WriteQueue(m.options);
    wq.enqueueChunked("x".repeat(WRITE_MAX_CHUNK_SIZE * 4));
    expect(m.writeToPty).toHaveBeenCalledTimes(1);

    wq.dispose();
    await vi.advanceTimersByTimeAsync(WRITE_INTERVAL_MS * 10);
    expect(m.writeToPty).toHaveBeenCalledTimes(1);
  });

  it("does not start a write timer in the constructor (no enqueue, no work)", () => {
    const m = makeOptions();
    new WriteQueue(m.options);
    // No timers should have been scheduled yet.
    expect(vi.getTimerCount()).toBe(0);
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
});

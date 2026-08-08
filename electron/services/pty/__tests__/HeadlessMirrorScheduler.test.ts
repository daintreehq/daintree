import { describe, it, expect, vi } from "vitest";
import { HeadlessMirrorScheduler } from "../HeadlessMirrorScheduler.js";

const FEED_SLICE_CHARS = 16 * 1024;
const AGGREGATE_INFLIGHT_CHARS = 128 * 1024;

type WriteCall = { data: string; cb?: () => void };

/** Mirror stub that records writes; parse callbacks fire only when released. */
function createParkedMirror() {
  const calls: WriteCall[] = [];
  return {
    calls,
    write(data: string, cb?: () => void) {
      calls.push({ data, cb });
    },
    /** Fire parse callbacks for all recorded writes, in order. */
    release() {
      const pending = calls.splice(0, calls.length);
      for (const call of pending) call.cb?.();
    },
  };
}

/** Mirror stub whose parse completes synchronously (like a drained fake). */
function createEagerMirror() {
  const written: string[] = [];
  return {
    written,
    write(data: string, cb?: () => void) {
      written.push(data);
      cb?.();
    },
  };
}

function flushTicks(): Promise<void> {
  // Two setImmediate turns: one for the drain tick, one for any re-arm.
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

describe("HeadlessMirrorScheduler", () => {
  it("feeds an idle terminal synchronously (fast path)", () => {
    const scheduler = new HeadlessMirrorScheduler();
    const mirror = createEagerMirror();
    const onParsed = vi.fn();

    scheduler.enqueue("t1", mirror, "hello", onParsed);

    expect(mirror.written).toEqual(["hello"]);
    expect(onParsed).toHaveBeenCalledTimes(1);
    expect(scheduler.inFlightChars()).toBe(0);
  });

  it("slices large chunks into bounded write entries, callback on the last", () => {
    const scheduler = new HeadlessMirrorScheduler();
    const mirror = createParkedMirror();
    const onParsed = vi.fn();
    const data = "x".repeat(FEED_SLICE_CHARS * 2 + 100);

    scheduler.enqueue("t1", mirror, data, onParsed);

    // Invariants: multiple bounded entries whose reassembly is the original.
    expect(mirror.calls.length).toBeGreaterThan(1);
    for (const call of mirror.calls) {
      expect(call.data.length).toBeLessThanOrEqual(FEED_SLICE_CHARS);
    }
    expect(mirror.calls.map((c) => c.data).join("")).toBe(data);
    // The caller's callback fires only when the FINAL slice parses.
    for (let i = 0; i < mirror.calls.length - 1; i++) {
      mirror.calls[i]!.cb?.();
    }
    expect(onParsed).not.toHaveBeenCalled();
    mirror.calls[mirror.calls.length - 1]!.cb?.();
    expect(onParsed).toHaveBeenCalledTimes(1);
  });

  it("does not split a surrogate pair at a slice boundary", () => {
    const scheduler = new HeadlessMirrorScheduler();
    const mirror = createParkedMirror();
    // Place a surrogate pair straddling the slice boundary.
    const data = "a".repeat(FEED_SLICE_CHARS - 1) + "\u{1F600}" + "b".repeat(10);

    scheduler.enqueue("t1", mirror, data);

    const first = mirror.calls[0]!.data;
    expect(first.length).toBe(FEED_SLICE_CHARS - 1);
    const second = mirror.calls[1]!.data;
    expect(second.codePointAt(0)).toBe(0x1f600);
  });

  it("holds feeds past the aggregate in-flight cap and resumes on parse completion", async () => {
    const scheduler = new HeadlessMirrorScheduler();
    const mirror = createParkedMirror();

    scheduler.enqueue("t1", mirror, "x".repeat(AGGREGATE_INFLIGHT_CHARS));
    const fedWrites = mirror.calls.length;
    expect(scheduler.inFlightChars()).toBe(AGGREGATE_INFLIGHT_CHARS);

    scheduler.enqueue("t1", mirror, "held-data");
    await flushTicks();
    // Cap reached: the second chunk must not have been fed.
    expect(mirror.calls.length).toBe(fedWrites);
    expect(scheduler.queuedChars("t1")).toBe("held-data".length);

    mirror.release();
    await flushTicks();
    expect(scheduler.queuedChars("t1")).toBe(0);
    expect(mirror.calls.map((c) => c.data)).toContain("held-data");
  });

  it("preserves per-terminal FIFO order across held feeds", async () => {
    const scheduler = new HeadlessMirrorScheduler();
    const blocker = createParkedMirror();
    const mirror = createParkedMirror();

    // Saturate the aggregate cap via another terminal.
    scheduler.enqueue("blocker", blocker, "x".repeat(AGGREGATE_INFLIGHT_CHARS));
    scheduler.enqueue("t1", mirror, "first");
    scheduler.enqueue("t1", mirror, "second");

    blocker.release();
    await flushTicks();

    const t1Data = mirror.calls.map((c) => c.data);
    expect(t1Data).toEqual(["first", "second"]);
  });

  it("round-robins terminals so one hot queue cannot monopolize a tick", async () => {
    const scheduler = new HeadlessMirrorScheduler();
    const blocker = createParkedMirror();
    const hot = createParkedMirror();
    const quiet = createParkedMirror();

    scheduler.enqueue("blocker", blocker, "x".repeat(AGGREGATE_INFLIGHT_CHARS));
    // Both now queue behind the cap.
    scheduler.enqueue("hot", hot, "h".repeat(FEED_SLICE_CHARS * 8));
    scheduler.enqueue("quiet", quiet, "q");

    blocker.release();
    await flushTicks();

    // The quiet terminal got service even though the hot one queued first
    // and alone exceeds the per-tick budget.
    expect(quiet.calls.length).toBe(1);
  });

  it("flush fires only after everything queued has parsed", async () => {
    const scheduler = new HeadlessMirrorScheduler();
    const mirror = createParkedMirror();
    const onFlushed = vi.fn();

    scheduler.enqueue("t1", mirror, "x".repeat(AGGREGATE_INFLIGHT_CHARS));
    scheduler.enqueue("t1", mirror, "tail");
    scheduler.flush("t1", mirror, onFlushed);

    await flushTicks();
    expect(onFlushed).not.toHaveBeenCalled();

    mirror.release();
    await flushTicks();
    // Tail + sentinel are now fed; their callbacks are parked — release them.
    mirror.release();
    await flushTicks();
    expect(onFlushed).toHaveBeenCalledTimes(1);
  });

  it("flush on an idle queue delegates to a sentinel mirror write", () => {
    const scheduler = new HeadlessMirrorScheduler();
    const mirror = createEagerMirror();
    const onFlushed = vi.fn();

    scheduler.enqueue("t1", mirror, "data");
    scheduler.flush("t1", mirror, onFlushed);

    expect(mirror.written).toEqual(["data", ""]);
    expect(onFlushed).toHaveBeenCalledTimes(1);
  });

  it("flush with no registered queue still drain-waits via the provided mirror", () => {
    // Session restore writes directly to the mirror before the scheduler ever
    // sees the terminal — the sentinel must go to the mirror, not fire early.
    const scheduler = new HeadlessMirrorScheduler();
    const mirror = createParkedMirror();
    const onFlushed = vi.fn();

    scheduler.flush("never-enqueued", mirror, onFlushed);

    expect(mirror.calls.map((c) => c.data)).toEqual([""]);
    expect(onFlushed).not.toHaveBeenCalled();
    mirror.release();
    expect(onFlushed).toHaveBeenCalledTimes(1);
  });

  it("clear on the cap-holding terminal unblocks other queued terminals", async () => {
    const scheduler = new HeadlessMirrorScheduler();
    const hog = createParkedMirror();
    const waiting = createParkedMirror();

    scheduler.enqueue("hog", hog, "x".repeat(AGGREGATE_INFLIGHT_CHARS));
    scheduler.enqueue("waiting", waiting, "blocked");
    await flushTicks();
    expect(waiting.calls.length).toBe(0);

    // Dispose the hog: its parse callbacks are now inert, so clear() itself
    // must re-arm the drain or "waiting" would strand forever.
    scheduler.clear("hog");
    await flushTicks();
    expect(waiting.calls.map((c) => c.data)).toEqual(["blocked"]);
  });

  it("never exceeds the aggregate in-flight cap when releasing queued slices", async () => {
    const scheduler = new HeadlessMirrorScheduler();
    const near = createParkedMirror();
    const extra = createParkedMirror();

    // Fill to one slice below the cap, then queue one more slice elsewhere.
    scheduler.enqueue("near", near, "x".repeat(AGGREGATE_INFLIGHT_CHARS - 100));
    scheduler.enqueue("extra", extra, "y".repeat(200));
    await flushTicks();

    // 200 chars would cross the cap — the tick must hold it back entirely.
    expect(extra.calls.length).toBe(0);
    expect(scheduler.inFlightChars()).toBe(AGGREGATE_INFLIGHT_CHARS - 100);

    near.release();
    await flushTicks();
    expect(extra.calls.map((c) => c.data)).toEqual(["y".repeat(200)]);
  });

  it("clear drops queued feeds without firing callbacks and releases accounting", async () => {
    const scheduler = new HeadlessMirrorScheduler();
    const mirror = createParkedMirror();
    const other = createEagerMirror();
    const onParsed = vi.fn();

    scheduler.enqueue("t1", mirror, "x".repeat(AGGREGATE_INFLIGHT_CHARS));
    scheduler.enqueue("t1", mirror, "dropped", onParsed);
    scheduler.clear("t1");

    expect(scheduler.inFlightChars()).toBe(0);
    expect(scheduler.queuedChars("t1")).toBe(0);

    // Aggregate accounting was released: another terminal feeds immediately.
    scheduler.enqueue("t2", other, "goes-through");
    expect(other.written).toEqual(["goes-through"]);

    // Late parse callbacks from the cleared queue are inert.
    mirror.release();
    await flushTicks();
    expect(onParsed).not.toHaveBeenCalled();
    expect(scheduler.inFlightChars()).toBe(0);
  });

  describe("drainThenResize (#11719)", () => {
    it("feeds everything queued to the mirror before the resize runs", async () => {
      const scheduler = new HeadlessMirrorScheduler();
      const blocker = createParkedMirror();
      const mirror = createParkedMirror();
      const order: string[] = [];

      // Saturate the aggregate cap so t1's feeds are genuinely held back.
      scheduler.enqueue("blocker", blocker, "x".repeat(AGGREGATE_INFLIGHT_CHARS));
      scheduler.enqueue("t1", mirror, "old-width-A");
      scheduler.enqueue("t1", mirror, "old-width-B");
      await flushTicks();
      expect(mirror.calls.length).toBe(0);

      scheduler.drainThenResize("t1", mirror, () => order.push("resize"));

      // Every held slice reached the mirror, in order, ahead of the resize —
      // xterm's own pre-resize flushSync then parses them at the old grid.
      order.unshift(...mirror.calls.map((c) => c.data));
      expect(order).toEqual(["old-width-A", "old-width-B", "resize"]);
      expect(scheduler.queuedChars("t1")).toBe(0);
    });

    it("drains past the aggregate cap rather than leaving old-grid bytes queued", async () => {
      const scheduler = new HeadlessMirrorScheduler();
      const mirror = createParkedMirror();

      // More than the cap can hold in flight at once: pacing must yield to
      // ordering here, because no tick can run before the caller's resize.
      const backlog = "z".repeat(AGGREGATE_INFLIGHT_CHARS * 2);
      scheduler.enqueue("t1", mirror, backlog);
      await flushTicks();
      expect(scheduler.queuedChars("t1")).toBeGreaterThan(0);

      scheduler.drainThenResize("t1", mirror, () => {});

      expect(scheduler.queuedChars("t1")).toBe(0);
      expect(mirror.calls.map((c) => c.data).join("")).toBe(backlog);
    });

    it("keeps output enqueued during the resize out of the mirror", () => {
      const scheduler = new HeadlessMirrorScheduler();
      const mirror = createEagerMirror();

      // A parse callback firing inside the resize enqueues fresh post-resize
      // output. Taking the synchronous fast path would put new-grid bytes into
      // the write buffer xterm is still draining at the OLD grid.
      scheduler.drainThenResize("t1", mirror, () => {
        scheduler.enqueue("t1", mirror, "post-resize");
      });

      expect(mirror.written).not.toContain("post-resize");
      expect(scheduler.queuedChars("t1")).toBe("post-resize".length);
    });

    it("releases output deferred by the guard on a later tick", async () => {
      const scheduler = new HeadlessMirrorScheduler();
      const mirror = createEagerMirror();

      scheduler.drainThenResize("t1", mirror, () => {
        scheduler.enqueue("t1", mirror, "post-resize");
      });
      await flushTicks();

      // Deferred, not dropped — and now parsed at the new grid, which is the
      // grid it was emitted at.
      expect(mirror.written).toContain("post-resize");
      expect(scheduler.queuedChars("t1")).toBe(0);
    });

    it("skips the resize when a failing write tears the queue down mid-drain", async () => {
      const scheduler = new HeadlessMirrorScheduler();
      const blocker = createParkedMirror();
      const applyResize = vi.fn();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const broken = {
        write() {
          throw new Error("torn down");
        },
      };

      scheduler.enqueue("blocker", blocker, "x".repeat(AGGREGATE_INFLIGHT_CHARS));
      scheduler.enqueue("t1", broken, "queued");
      await flushTicks();

      expect(scheduler.drainThenResize("t1", broken, applyResize)).toBe(false);
      expect(applyResize).not.toHaveBeenCalled();
      // The torn-down queue released its accounting rather than wedging the cap.
      expect(scheduler.queuedChars("t1")).toBe(0);
      consoleError.mockRestore();
    });

    it("still applies the resize for a terminal the scheduler never saw", () => {
      // Session restore writes straight to the mirror at construction, so a
      // terminal can reach a resize with no queue registered at all.
      const scheduler = new HeadlessMirrorScheduler();
      const mirror = createEagerMirror();
      const applyResize = vi.fn();

      expect(scheduler.drainThenResize("never-enqueued", mirror, applyResize)).toBe(true);
      expect(applyResize).toHaveBeenCalledTimes(1);
    });
  });

  it("recovers accounting when a mirror write throws", () => {
    const scheduler = new HeadlessMirrorScheduler();
    const broken = {
      write() {
        throw new Error("torn down");
      },
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    scheduler.enqueue("t1", broken, "boom");
    expect(scheduler.inFlightChars()).toBe(0);
    expect(scheduler.queuedChars("t1")).toBe(0);

    const healthy = createEagerMirror();
    scheduler.enqueue("t2", healthy, "fine");
    expect(healthy.written).toEqual(["fine"]);
    consoleError.mockRestore();
  });
});

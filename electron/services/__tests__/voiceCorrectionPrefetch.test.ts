import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CorrectionPrefetcher, prefetchKey } from "../voiceCorrectionPrefetch.js";

interface Started {
  key: string;
  signal: AbortSignal;
  onText: (text: string) => void;
  resolve: (value: string) => void;
}

function harness() {
  const prefetcher = new CorrectionPrefetcher<Promise<string>>();
  const started: Started[] = [];
  const request = (key: string) => ({
    key,
    start: (onText: (text: string) => void, signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        started.push({ key, signal, onText, resolve });
      }),
  });
  return { prefetcher, started, request };
}

describe("CorrectionPrefetcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands the stop the run its prefetch started, once", async () => {
    const { prefetcher, started, request } = harness();
    prefetcher.replace("view:s1", [request("a")]);

    const taken = prefetcher.take("view:s1", "a");
    expect(taken).not.toBeNull();
    started[0]!.resolve("cleaned");
    await expect(taken!.value).resolves.toBe("cleaned");
    expect(prefetcher.take("view:s1", "a")).toBeNull();
    expect(started[0]!.signal.aborted).toBe(false);
  });

  it("never lets a run the stop took lapse, and lets the stop cancel it", () => {
    const { prefetcher, started, request } = harness();
    prefetcher.replace("view:s1", [request("a")]);
    const taken = prefetcher.take("view:s1", "a")!;

    vi.advanceTimersByTime(60_000);
    expect(started[0]!.signal.aborted).toBe(false);
    taken.cancel();
    expect(started[0]!.signal.aborted).toBe(true);
  });

  it("misses a request it never prefetched, or one another owner made", () => {
    const { prefetcher, request } = harness();
    prefetcher.replace("view:s1", [request("a")]);

    expect(prefetcher.take("view:s1", "b")).toBeNull();
    expect(prefetcher.take("view:s2", "a")).toBeNull();
    expect(prefetcher.take("view:s1", "a")).not.toBeNull();
  });

  it("keeps a passage still asked for and cancels the ones the dictation moved past", () => {
    const { prefetcher, started, request } = harness();
    expect(prefetcher.replace("view:s1", [request("a"), request("b")])).toBe(2);
    expect(prefetcher.replace("view:s1", [request("a"), request("c")])).toBe(1);

    expect(started.map((s) => s.key)).toEqual(["a", "b", "c"]);
    expect(started.map((s) => s.signal.aborted)).toEqual([false, true, false]);
    expect(prefetcher.take("view:s1", "b")).toBeNull();
    expect(prefetcher.take("view:s1", "a")).not.toBeNull();
  });

  it("starts no more new runs than its budget allows", () => {
    const { prefetcher, started, request } = harness();
    expect(prefetcher.replace("view:s1", [request("a"), request("b")], 1)).toBe(1);
    expect(started.map((s) => s.key)).toEqual(["a"]);
    // One it already has costs nothing to keep.
    expect(prefetcher.replace("view:s1", [request("a")], 0)).toBe(0);
    expect(prefetcher.take("view:s1", "a")).not.toBeNull();
  });

  it("leaves another owner's prefetches alone when one owner's change", () => {
    const { prefetcher, started, request } = harness();
    prefetcher.replace("view:s1", [request("a")]);
    prefetcher.replace("view:s2", [request("b")]);
    prefetcher.replace("view:s1", []);

    expect(started.map((s) => s.signal.aborted)).toEqual([true, false]);
    expect(prefetcher.take("view:s2", "b")).not.toBeNull();
  });

  it("shows the stop the text streamed so far, then what streams after", () => {
    const { prefetcher, started, request } = harness();
    prefetcher.replace("view:s1", [request("a")]);
    started[0]!.onText("Run the");

    const taken = prefetcher.take("view:s1", "a")!;
    expect(taken.latest).toBe("Run the");
    // Streamed after the take, before the stop joined.
    started[0]!.onText("Run the tests");
    const heard: string[] = [];
    taken.follow((text) => heard.push(text));
    started[0]!.onText("Run the tests now");
    expect(heard).toEqual(["Run the tests", "Run the tests now"]);
  });

  it("cancels a prefetch no stop took before it went stale", () => {
    const { prefetcher, started, request } = harness();
    prefetcher.replace("view:s1", [request("a")]);

    vi.advanceTimersByTime(29_999);
    expect(started[0]!.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(started[0]!.signal.aborted).toBe(true);
    expect(prefetcher.take("view:s1", "a")).toBeNull();
    expect(prefetcher.size).toBe(0);
  });

  it("cancels everything an owner holds when its session ends without a stop", () => {
    const { prefetcher, started, request } = harness();
    prefetcher.replace("view:s1", [request("a"), request("b")]);
    prefetcher.clear("view:s1");

    expect(started.every((s) => s.signal.aborted)).toBe(true);
    expect(prefetcher.size).toBe(0);
  });

  it("cancels everything when it goes away", () => {
    const { prefetcher, started, request } = harness();
    prefetcher.replace("view:s1", [request("a")]);
    prefetcher.replace("view:s2", [request("b")]);
    prefetcher.dispose();

    expect(started.every((s) => s.signal.aborted)).toBe(true);
    expect(prefetcher.size).toBe(0);
  });

  it("holds at most six passages per owner and 24 in all, cancelling the oldest", () => {
    const { prefetcher, started, request } = harness();
    const keys = Array.from({ length: 8 }, (_, i) => `k${i}`);
    expect(prefetcher.replace("view:s0", keys.map(request))).toBe(6);

    for (let owner = 1; owner < 30; owner++) prefetcher.replace(`view:s${owner}`, [request("a")]);
    expect(prefetcher.size).toBe(24);
    expect(started[0]!.signal.aborted).toBe(true);
    expect(started.at(-1)!.signal.aborted).toBe(false);
  });
});

describe("prefetchKey", () => {
  const request = { rawText: "run the tests", startsPrompt: true, sessionId: "s1" };

  it("matches the stop's request whatever stream it reports under", () => {
    expect(prefetchKey({ ...request, streamId: "x" }, { model: "m" })).toBe(
      prefetchKey(request, { model: "m" })
    );
  });

  it("matches the same request whatever order its fields arrive in", () => {
    expect(prefetchKey({ sessionId: "s1", startsPrompt: true, rawText: "run the tests" }, {})).toBe(
      prefetchKey(request, {})
    );
  });

  it("tells apart requests that differ in their words, context or settings", () => {
    const key = prefetchKey(request, { model: "m" });
    expect(prefetchKey({ ...request, rawText: "run the test" }, { model: "m" })).not.toBe(key);
    expect(prefetchKey({ ...request, recentPrompts: ["fix it"] }, { model: "m" })).not.toBe(key);
    expect(prefetchKey(request, { model: "n" })).not.toBe(key);
  });
});

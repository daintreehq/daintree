import { describe, expect, it, vi } from "vitest";
import type { Issue } from "../../../shared/types/forge.js";
import { IssueLookupCoalescer } from "../IssueLookupCoalescer.js";

const ISSUE = { number: 7, title: "Seven" } as Issue;
const MINUTE = 60_000;

function setup() {
  let now = 1_000_000;
  const coalescer = new IssueLookupCoalescer(() => now);
  return {
    coalescer,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("IssueLookupCoalescer", () => {
  it("shares one request between callers asking at the same time", async () => {
    const { coalescer } = setup();
    const pending = deferred<Issue | null>();
    const request = vi.fn(() => pending.promise);

    const a = coalescer.lookup("k", request);
    const b = coalescer.lookup("k", request);
    pending.resolve(ISSUE);

    expect(await a).toEqual({ kind: "found", issue: ISSUE });
    expect(await b).toEqual({ kind: "found", issue: ISSUE });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps different keys apart", async () => {
    const { coalescer } = setup();
    const request = vi.fn(async () => ISSUE);
    await Promise.all([coalescer.lookup("a", request), coalescer.lookup("b", request)]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("remembers a found issue only while it is being fetched", async () => {
    const { coalescer } = setup();
    const request = vi.fn(async () => ISSUE);
    await coalescer.lookup("k", request);
    await coalescer.lookup("k", request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(coalescer.size).toBe(0);
  });

  it("holds a not-found verdict on a doubling delay capped at thirty minutes", async () => {
    const { coalescer, advance } = setup();
    const request = vi.fn(async () => null);
    const expectedDelays = [5, 10, 20, 30, 30].map((m) => m * MINUTE);

    expect(await coalescer.lookup("k", request)).toEqual({ kind: "missing", cached: false });
    for (const [i, delay] of expectedDelays.entries()) {
      advance(delay - 1);
      expect(await coalescer.lookup("k", request)).toEqual({ kind: "missing", cached: true });
      expect(request).toHaveBeenCalledTimes(i + 1);
      advance(1);
      expect(await coalescer.lookup("k", request)).toEqual({ kind: "missing", cached: false });
      expect(request).toHaveBeenCalledTimes(i + 2);
    }
  });

  it("defers after a failure, on a shorter delay, without claiming the issue is missing", async () => {
    const { coalescer, advance } = setup();
    const request = vi.fn(async (): Promise<Issue | null> => {
      throw new Error("offline");
    });

    expect(await coalescer.lookup("k", request)).toEqual({ kind: "error" });
    expect(await coalescer.lookup("k", request)).toEqual({ kind: "deferred" });
    advance(MINUTE);
    expect(await coalescer.lookup("k", request)).toEqual({ kind: "error" });
    // The second failure holds for two minutes.
    advance(MINUTE);
    expect(await coalescer.lookup("k", request)).toEqual({ kind: "deferred" });
    advance(MINUTE);
    request.mockResolvedValueOnce(ISSUE);
    expect(await coalescer.lookup("k", request)).toEqual({ kind: "found", issue: ISSUE });
  });

  it("treats a request that throws synchronously as a failed lookup", async () => {
    const { coalescer } = setup();
    const result = await coalescer.lookup("k", () => {
      throw new Error("bridge gone");
    });
    expect(result).toEqual({ kind: "error" });
  });

  it("makes verdicts due on forgetVerdicts but lets a pending lookup finish for its joiners", async () => {
    const { coalescer } = setup();
    await coalescer.lookup("missing", async () => null);
    const pending = deferred<Issue | null>();
    const request = vi.fn(() => pending.promise);
    const first = coalescer.lookup("pending", request);

    coalescer.forgetVerdicts();

    const joined = coalescer.lookup("pending", request);
    pending.resolve(ISSUE);
    expect(await first).toEqual({ kind: "found", issue: ISSUE });
    expect(await joined).toEqual({ kind: "found", issue: ISSUE });
    expect(request).toHaveBeenCalledTimes(1);
    const retry = vi.fn(async () => null);
    expect(await coalescer.lookup("missing", retry)).toEqual({ kind: "missing", cached: false });
  });

  it("detaches a pending lookup on clear and never lets it touch later verdicts", async () => {
    const { coalescer } = setup();
    const stale = deferred<Issue | null>();
    const before = coalescer.lookup("k", () => stale.promise);
    const startedAt = coalescer.generation;

    coalescer.clear();
    expect(coalescer.generation).not.toBe(startedAt);

    const fresh = vi.fn(async () => null);
    expect(await coalescer.lookup("k", fresh)).toEqual({ kind: "missing", cached: false });
    expect(fresh).toHaveBeenCalledTimes(1);

    // The detached lookup lands as "found" after the fresh miss. Recording it
    // would delete the fresh verdict and send the next poll to the provider.
    stale.resolve(ISSUE);
    expect(await before).toEqual({ kind: "found", issue: ISSUE });
    const next = vi.fn(async () => ISSUE);
    expect(await coalescer.lookup("k", next)).toEqual({ kind: "missing", cached: true });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns to its bound once a burst of pending lookups settles", async () => {
    const { coalescer } = setup();
    const pending = Array.from({ length: 300 }, (_, i) => {
      const answer = deferred<Issue | null>();
      return { answer, result: coalescer.lookup(`k${i}`, () => answer.promise) };
    });
    // Nothing in flight can be evicted.
    expect(coalescer.size).toBe(300);

    for (const { answer } of pending) answer.resolve(null);
    await Promise.all(pending.map(({ result }) => result));

    expect(coalescer.size).toBeLessThanOrEqual(256);
  });

  it("bounds how many identities it remembers", async () => {
    const { coalescer } = setup();
    for (let i = 0; i < 1_000; i++) await coalescer.lookup(`k${i}`, async () => null);
    expect(coalescer.size).toBeLessThanOrEqual(256);
    // The newest verdict survives the eviction.
    const request = vi.fn(async () => null);
    expect(await coalescer.lookup("k999", request)).toEqual({ kind: "missing", cached: true });
    expect(request).not.toHaveBeenCalled();
  });
});

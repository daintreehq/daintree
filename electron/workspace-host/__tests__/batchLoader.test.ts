import { describe, it, expect, vi } from "vitest";

import { BatchLoader, type BatchLoadFn } from "../batchLoader.js";

/**
 * Drain microtasks + nextTick + any timers. The loader schedules via
 * `Promise.resolve().then(() => process.nextTick(dispatch))`, and a batch
 * function may itself await, so a single macrotask hop after the current jobs
 * settle everything pending.
 */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("BatchLoader", () => {
  it("coalesces synchronously-enqueued loads into one batch call and dedups repeats", async () => {
    const batchFn = vi.fn<BatchLoadFn<string, string>>(async (keys) => keys.map((k) => `v:${k}`));
    const loader = new BatchLoader(batchFn);

    const a = loader.load("a");
    const b = loader.load("b");
    const aAgain = loader.load("a");

    await expect(a).resolves.toBe("v:a");
    await expect(b).resolves.toBe("v:b");
    await expect(aAgain).resolves.toBe("v:a");

    expect(batchFn).toHaveBeenCalledTimes(1);
    expect(batchFn).toHaveBeenCalledWith(["a", "b"]);
  });

  it("does NOT coalesce across awaits (documents the caller trap)", async () => {
    const batchFn = vi.fn<BatchLoadFn<string, string>>(async (keys) => keys.map((k) => `v:${k}`));
    const loader = new BatchLoader(batchFn);

    await loader.load("a");
    await loader.load("b");

    expect(batchFn).toHaveBeenCalledTimes(2);
    expect(batchFn).toHaveBeenNthCalledWith(1, ["a"]);
    expect(batchFn).toHaveBeenNthCalledWith(2, ["b"]);
  });

  it("isolates per-key errors: an Error in a slot rejects only that key", async () => {
    const loader = new BatchLoader<string, string>(async (keys) =>
      keys.map((k) => (k === "bad" ? new Error("boom") : `v:${k}`))
    );

    const ok = loader.load("good");
    const bad = loader.load("bad");

    await expect(ok).resolves.toBe("v:good");
    await expect(bad).rejects.toThrow("boom");
  });

  it("rejects every pending key when the batch function throws", async () => {
    const loader = new BatchLoader<string, string>(async () => {
      throw new Error("whole batch failed");
    });

    const a = loader.load("a");
    const b = loader.load("b");

    await expect(a).rejects.toThrow("whole batch failed");
    await expect(b).rejects.toThrow("whole batch failed");
  });

  it("rejects every pending key when the result array length mismatches", async () => {
    const loader = new BatchLoader<string, string>(async () => ["only-one"]);

    const a = loader.load("a");
    const b = loader.load("b");

    await expect(a).rejects.toThrow(/returned 1 results for 2 keys/);
    await expect(b).rejects.toThrow(/returned 1 results for 2 keys/);
  });

  it("chunks at maxBatchSize, firing concurrent batch calls", async () => {
    const batchFn = vi.fn<BatchLoadFn<number, number>>(async (keys) => keys.map((k) => k * 10));
    const loader = new BatchLoader(batchFn, { maxBatchSize: 2 });

    const results = await Promise.all([loader.load(1), loader.load(2), loader.load(3)]);

    expect(results).toEqual([10, 20, 30]);
    expect(batchFn).toHaveBeenCalledTimes(2);
    expect(batchFn).toHaveBeenNthCalledWith(1, [1, 2]);
    expect(batchFn).toHaveBeenNthCalledWith(2, [3]);
  });

  it("re-fetches a settled key on the next tick (no persistent cache)", async () => {
    const batchFn = vi.fn<BatchLoadFn<string, string>>(async (keys) => keys.map((k) => `v:${k}`));
    const loader = new BatchLoader(batchFn);

    await loader.load("a");
    await loader.load("a");

    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("dispose() rejects all pending loads", async () => {
    let resolveBatch!: (values: string[]) => void;
    const loader = new BatchLoader<string, string>(
      () => new Promise<string[]>((resolve) => (resolveBatch = resolve))
    );

    const a = loader.load("a");
    const b = loader.load("b");
    await flush(); // let dispatch fire so the batch fn is in flight

    loader.dispose();

    await expect(a).rejects.toThrow("BatchLoader disposed");
    await expect(b).rejects.toThrow("BatchLoader disposed");

    // A late-arriving batch result after dispose must not throw or re-settle.
    resolveBatch(["v:a", "v:b"]);
    await flush();
  });

  it("rejects synchronously when load() is called after dispose", async () => {
    const loader = new BatchLoader<string, string>(async (keys) => keys.map((k) => k));
    loader.dispose();

    await expect(loader.load("a")).rejects.toThrow("BatchLoader disposed");
  });

  it("never calls the batch function when nothing is loaded", async () => {
    const batchFn = vi.fn<BatchLoadFn<string, string>>(async (keys) => keys.map((k) => k));
    new BatchLoader(batchFn);

    await flush();

    expect(batchFn).not.toHaveBeenCalled();
  });

  it("supports a custom cacheKeyFn for object keys", async () => {
    const batchFn = vi.fn<BatchLoadFn<{ id: number }, number>>(async (keys) =>
      keys.map((k) => k.id)
    );
    const loader = new BatchLoader(batchFn, { cacheKeyFn: (k) => String(k.id) });

    const [a, b] = await Promise.all([loader.load({ id: 1 }), loader.load({ id: 1 })]);

    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(batchFn).toHaveBeenCalledTimes(1);
    expect(batchFn).toHaveBeenCalledWith([{ id: 1 }]);
  });
});

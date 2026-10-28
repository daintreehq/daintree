import { describe, expect, it } from "vitest";
import type { ReviewComparisonResult } from "../../../../../shared/types/reviewComparison.js";
import type { CompareReviewPointOptions } from "../compareReviewPoint.js";
import { ReviewComparisons } from "../reviewComparisons.js";

const DONE: ReviewComparisonResult = {
  state: "different-branch",
  reviewed: { kind: "detached", commit: "a".repeat(40) },
  current: { kind: "detached", commit: "b".repeat(40) },
};

/** A fake comparison that runs until it's released or its signal fires, like the real one. */
function controllableRun() {
  const calls: Array<{ cwd: string; signal: AbortSignal; release: () => void }> = [];
  let active = 0;
  let maxActive = 0;
  const run = (cwd: string, _point: unknown, options: CompareReviewPointOptions = {}) => {
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise<ReviewComparisonResult>((resolve) => {
      const signal = options.signal as AbortSignal;
      const finish = (result: ReviewComparisonResult) => {
        active--;
        resolve(result);
      };
      signal.addEventListener("abort", () =>
        finish({ state: "failed", reason: "cancelled", message: "cancelled" })
      );
      calls.push({ cwd, signal, release: () => finish(DONE) });
    });
  };
  return { run, calls, maxActive: () => maxActive };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("ReviewComparisons", () => {
  it("supersedes the comparison in flight and starts the next once it has stopped", async () => {
    const fake = controllableRun();
    const queue = new ReviewComparisons(fake.run);

    const first = queue.compare("/repo", {});
    await flush();
    const second = queue.compare("/repo/", {});

    expect(await first).toMatchObject({ state: "failed", reason: "superseded" });
    await flush();
    expect(fake.calls).toHaveLength(2);
    fake.calls[1]?.release();
    expect(await second).toBe(DONE);
    expect(fake.maxActive()).toBe(1);
  });

  it("never runs a request superseded while it waited, nor answers with a superseded result", async () => {
    const fake = controllableRun();
    // A first comparison that ignores its signal for a while, as a stalled read would.
    let releaseFirst = () => {};
    let call = 0;
    const queue = new ReviewComparisons((cwd, point, options) => {
      if (call++ === 0) return new Promise((resolve) => (releaseFirst = () => resolve(DONE)));
      return fake.run(cwd, point, options);
    });

    const first = queue.compare("/repo", {});
    await flush();
    const second = queue.compare("/repo", {});
    const third = queue.compare("/repo", {});
    releaseFirst();

    expect(await first).toMatchObject({ state: "failed", reason: "superseded" });
    expect(await second).toMatchObject({ state: "failed", reason: "superseded" });
    await flush();
    expect(call).toBe(2);
    fake.calls[0]?.release();
    expect(await third).toBe(DONE);
  });

  it("runs different worktrees side by side", async () => {
    const fake = controllableRun();
    const queue = new ReviewComparisons(fake.run);

    const a = queue.compare("/a", {});
    const b = queue.compare("/b", {});
    await flush();

    expect(fake.calls.map((entry) => entry.cwd)).toEqual(["/a", "/b"]);
    fake.calls.forEach((entry) => entry.release());
    expect(await a).toBe(DONE);
    expect(await b).toBe(DONE);
  });

  it("answers the caller's own cancellation as cancelled", async () => {
    const fake = controllableRun();
    const queue = new ReviewComparisons(fake.run);
    const controller = new AbortController();

    const pending = queue.compare("/repo", {}, { signal: controller.signal });
    await flush();
    controller.abort();

    expect(await pending).toMatchObject({ state: "failed", reason: "cancelled" });
    const already = queue.compare("/repo", {}, { signal: controller.signal });
    expect(await already).toMatchObject({ state: "failed", reason: "cancelled" });
    expect(fake.calls).toHaveLength(1);
  });
});

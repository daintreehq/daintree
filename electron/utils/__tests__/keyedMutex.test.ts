import { beforeEach, describe, expect, it } from "vitest";
import { __resetKeyedMutexForTests, isKeyBusy, runExclusive } from "../keyedMutex.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("keyedMutex", () => {
  beforeEach(() => {
    __resetKeyedMutexForTests();
  });

  it("runs jobs for one key strictly in order", async () => {
    const order: string[] = [];
    const first = runExclusive("k", async () => {
      order.push("first:start");
      await tick();
      order.push("first:end");
      return 1;
    });
    const second = runExclusive("k", async () => {
      order.push("second:start");
      return 2;
    });
    expect(isKeyBusy("k")).toBe(true);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    await tick();
    expect(isKeyBusy("k")).toBe(false);
  });

  it("does not make different keys wait on each other", async () => {
    let release: () => void = () => {};
    const blocked = runExclusive("a", () => new Promise<void>((resolve) => (release = resolve)));
    const other = runExclusive("b", async () => "b-done");
    await expect(other).resolves.toBe("b-done");
    release();
    await blocked;
  });

  it("a rejected job surfaces to its caller and never poisons the queue", async () => {
    const failing = runExclusive("k", async () => {
      throw new Error("boom");
    });
    const next = runExclusive("k", async () => "after");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("after");
    // The tail's own cleanup runs a microtask after the job settles.
    await tick();
    expect(isKeyBusy("k")).toBe(false);
  });

  it("a job finishing after a newer one was queued does not drop the newer link", async () => {
    let releaseFirst: () => void = () => {};
    const first = runExclusive("k", () => new Promise<void>((resolve) => (releaseFirst = resolve)));
    const ran: string[] = [];
    const second = runExclusive("k", async () => {
      ran.push("second");
    });
    // Jobs start on a microtask; let the first one hand out its release.
    await tick();
    releaseFirst();
    await first;
    // The first job's cleanup must leave the second job's tail in place.
    expect(isKeyBusy("k")).toBe(true);
    await second;
    expect(ran).toEqual(["second"]);
    await tick();
    expect(isKeyBusy("k")).toBe(false);
  });
});

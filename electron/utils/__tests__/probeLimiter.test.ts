import { describe, expect, it, vi } from "vitest";
import { createProbeLimiter } from "../probeLimiter.js";

describe("createProbeLimiter", () => {
  it("keeps each limiter's slots its own, so one's hung task can't starve another", async () => {
    const optional = createProbeLimiter(1);
    const required = createProbeLimiter(1);
    void optional.withSlot(() => new Promise(() => {}));

    await expect(required.withSlot(async () => "ran")).resolves.toBe("ran");
  });

  it("queues past its limit and runs in turn when a slot frees", async () => {
    const limiter = createProbeLimiter(1);
    let finishFirst!: (value: string) => void;
    const first = limiter.withSlot(
      () =>
        new Promise<string>((resolve) => {
          finishFirst = resolve;
        })
    );
    const second = limiter.withSlot(async () => "second");
    expect(limiter.queueDepth()).toBe(1);

    finishFirst("first");
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(limiter.queueDepth()).toBe(0);
  });

  it("drops a queued task when its signal aborts, without ever running it", async () => {
    const limiter = createProbeLimiter(1);
    void limiter.withSlot(() => new Promise(() => {}));
    const controller = new AbortController();
    const task = vi.fn(async () => "never");

    const queued = limiter.withSlot(task, controller.signal);
    controller.abort(new Error("deadline"));

    await expect(queued).rejects.toThrow("deadline");
    expect(limiter.queueDepth()).toBe(0);
    expect(task).not.toHaveBeenCalled();
  });
});

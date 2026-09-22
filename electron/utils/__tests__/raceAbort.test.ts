import { describe, expect, it, vi } from "vitest";
import { raceAbort } from "../raceAbort.js";

describe("raceAbort", () => {
  it("passes the work through when there is no signal", async () => {
    await expect(raceAbort(Promise.resolve(1), undefined, "aborted")).resolves.toBe(1);
  });

  it("settles with the work's value when it finishes first", async () => {
    const controller = new AbortController();
    await expect(raceAbort(Promise.resolve(1), controller.signal, "aborted")).resolves.toBe(1);
  });

  it("propagates the work's rejection when it finishes first", async () => {
    const controller = new AbortController();
    await expect(
      raceAbort(Promise.reject(new Error("boom")), controller.signal, "aborted")
    ).rejects.toThrow("boom");
  });

  it("settles on abort without waiting for work that never finishes", async () => {
    const controller = new AbortController();
    const pending = raceAbort(new Promise<number>(() => {}), controller.signal, "aborted");
    controller.abort();
    await expect(pending).resolves.toBe("aborted");
  });

  it("settles immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      raceAbort(new Promise<number>(() => {}), controller.signal, "aborted")
    ).resolves.toBe("aborted");
  });

  it("swallows a rejection that arrives after the abort", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const controller = new AbortController();
      let fail: (error: Error) => void = () => {};
      const work = new Promise<number>((_resolve, reject) => (fail = reject));
      const pending = raceAbort(work, controller.signal, "aborted");
      controller.abort();
      await expect(pending).resolves.toBe("aborted");
      fail(new Error("late"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("removes its abort listener once the work settles", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await raceAbort(Promise.resolve(1), controller.signal, "aborted");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

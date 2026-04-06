import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "../debounce";

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("executes only the latest call arguments after wait", async () => {
    const spy = vi.fn();
    const fn = debounce(spy, 100);

    fn("first");
    vi.advanceTimersByTime(50);
    fn("second");
    vi.advanceTimersByTime(99);

    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("second");
  });

  it("cancel prevents pending execution", async () => {
    const spy = vi.fn();
    const fn = debounce(spy, 100);

    fn("value");
    fn.cancel();
    vi.advanceTimersByTime(200);
    await Promise.resolve();

    expect(spy).not.toHaveBeenCalled();
  });

  it("flush executes pending callback immediately and only once", async () => {
    const spy = vi.fn();
    const fn = debounce(spy, 100);

    fn("value");
    fn.flush();
    await Promise.resolve();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("value");

    vi.advanceTimersByTime(200);
    await Promise.resolve();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("flush with no pending call is a no-op", async () => {
    const spy = vi.fn();
    const fn = debounce(spy, 100);

    fn.flush();
    await Promise.resolve();

    expect(spy).not.toHaveBeenCalled();
  });

  it("catches callback errors and logs them without throwing", async () => {
    const fn = debounce(() => {
      throw new Error("boom");
    }, 100);

    fn();
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(console.error).toHaveBeenCalledWith(
      "Debounce execution failed:",
      expect.objectContaining({ message: "boom" })
    );
  });

  it("flush awaits an already-running async callback", async () => {
    vi.useRealTimers();
    let resolve!: () => void;
    const barrier = new Promise<void>((r) => {
      resolve = r;
    });
    const spy = vi.fn(() => barrier);

    const fn = debounce(spy, 0);
    fn();

    // Let the timeout fire so the async func starts
    await new Promise((r) => setTimeout(r, 10));
    expect(spy).toHaveBeenCalledTimes(1);

    // flush should wait for the running promise
    let flushed = false;
    const flushP = fn.flush().then(() => {
      flushed = true;
    });

    // Not flushed yet — callback still running
    await Promise.resolve();
    expect(flushed).toBe(false);

    // Resolve the callback
    resolve();
    await flushP;
    expect(flushed).toBe(true);
    // func was NOT called a second time
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("flush stores its execution so a second flush can await it", async () => {
    vi.useRealTimers();
    let resolve!: () => void;
    const barrier = new Promise<void>((r) => {
      resolve = r;
    });
    const spy = vi.fn(() => barrier);

    const fn = debounce(spy, 0);
    fn();

    // flush triggers the pending call (async func)
    const flush1 = fn.flush();
    // second flush should await the same in-flight execution
    const flush2 = fn.flush();

    resolve();
    await flush1;
    await flush2;
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

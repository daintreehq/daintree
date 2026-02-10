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
});

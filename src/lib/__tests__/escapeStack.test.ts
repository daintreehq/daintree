import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  registerEscape,
  updateHandler,
  dispatchEscape,
  hasHandlers,
  registerEscapeFallback,
  dispatchEscapeFallback,
  _resetForTests,
} from "../escapeStack";

beforeEach(() => {
  _resetForTests();
});

describe("escapeStack", () => {
  it("returns false when dispatching on empty stack", () => {
    expect(dispatchEscape()).toBe(false);
    expect(hasHandlers()).toBe(false);
  });

  it("invokes the topmost handler (LIFO order)", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerEscape(first);
    registerEscape(second);

    dispatchEscape();

    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("peeks without popping — same handler fires on repeated dispatch", () => {
    const handler = vi.fn();
    registerEscape(handler);

    dispatchEscape();
    dispatchEscape();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("unregister removes entry and exposes next handler", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerEscape(first);
    const { unregister } = registerEscape(second);

    unregister();
    dispatchEscape();

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("double unregister is safe", () => {
    const handler = vi.fn();
    const { unregister } = registerEscape(handler);

    unregister();
    unregister();

    expect(hasHandlers()).toBe(false);
  });

  it("updateHandler changes the callback for an existing entry", () => {
    const original = vi.fn();
    const updated = vi.fn();
    const { id } = registerEscape(original);

    updateHandler(id, updated);
    dispatchEscape();

    expect(updated).toHaveBeenCalledOnce();
    expect(original).not.toHaveBeenCalled();
  });

  it("updateHandler with unknown id is a no-op", () => {
    const handler = vi.fn();
    registerEscape(handler);

    updateHandler(Symbol("unknown"), vi.fn());
    dispatchEscape();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("survives a throwing handler and still returns true", () => {
    const throwing = () => {
      throw new Error("boom");
    };
    registerEscape(throwing);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(dispatchEscape()).toBe(true);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("unregister middle entry preserves order of remaining", () => {
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    registerEscape(first);
    const mid = registerEscape(second);
    registerEscape(third);

    mid.unregister();
    dispatchEscape();

    expect(third).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  });
});

describe("escape fallbacks", () => {
  it("are not counted as stack handlers", () => {
    registerEscapeFallback(() => true);

    expect(hasHandlers()).toBe(false);
    expect(dispatchEscape()).toBe(false);
  });

  it("report false when none is registered or none acts", () => {
    expect(dispatchEscapeFallback()).toBe(false);

    const idle = vi.fn(() => false);
    registerEscapeFallback(idle);

    expect(dispatchEscapeFallback()).toBe(false);
    expect(idle).toHaveBeenCalledOnce();
  });

  it("pass over idle fallbacks, newest first, and stop at the first that acts", () => {
    const calls: string[] = [];
    const fallback = (name: string, acts: boolean) => () => {
      calls.push(name);
      return acts;
    };
    registerEscapeFallback(fallback("oldest", true));
    registerEscapeFallback(fallback("middle", true));
    registerEscapeFallback(fallback("newest", false));

    expect(dispatchEscapeFallback()).toBe(true);
    expect(calls).toEqual(["newest", "middle"]);
  });

  it("unregister removes only that registration, even of a shared callback", () => {
    const shared = vi.fn(() => true);
    const between = vi.fn(() => false);
    registerEscapeFallback(shared);
    registerEscapeFallback(between);
    const unregister = registerEscapeFallback(shared);

    unregister();
    unregister();
    dispatchEscapeFallback();

    // `between` is idle, so the press reaches the first registration of `shared`.
    expect(between).toHaveBeenCalledOnce();
    expect(shared).toHaveBeenCalledOnce();
  });

  it("count a throwing fallback as handled and go no further", () => {
    const older = vi.fn(() => true);
    registerEscapeFallback(older);
    registerEscapeFallback(() => {
      throw new Error("boom");
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(dispatchEscapeFallback()).toBe(true);
    expect(consoleSpy).toHaveBeenCalled();
    expect(older).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisposableStore, toDisposable } from "../disposable";

describe("toDisposable", () => {
  it("invokes the wrapped function on dispose()", () => {
    const fn = vi.fn();
    const d = toDisposable(fn);

    d.dispose();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("invokes the wrapped function at most once", () => {
    const fn = vi.fn();
    const d = toDisposable(fn);

    d.dispose();
    d.dispose();
    d.dispose();

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("DisposableStore", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the same disposable instance from add()", () => {
    const store = new DisposableStore();
    const d = toDisposable(() => {});

    const returned = store.add(d);

    expect(returned).toBe(d);
  });

  it("disposes entries in reverse registration order", () => {
    const store = new DisposableStore();
    const order: string[] = [];
    store.add(toDisposable(() => order.push("first")));
    store.add(toDisposable(() => order.push("second")));
    store.add(toDisposable(() => order.push("third")));

    store.dispose();

    expect(order).toEqual(["third", "second", "first"]);
  });

  it("dispose() is idempotent — entries fire exactly once across repeated calls", () => {
    const store = new DisposableStore();
    const fn = vi.fn();
    store.add(toDisposable(fn));

    store.dispose();
    store.dispose();
    store.dispose();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clear() disposes current entries and leaves the store reusable", () => {
    const store = new DisposableStore();
    const first = vi.fn();
    const second = vi.fn();
    store.add(toDisposable(first));

    store.clear();
    expect(first).toHaveBeenCalledTimes(1);

    store.add(toDisposable(second));
    store.dispose();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("dispose() after clear() does not re-fire already-disposed entries", () => {
    const store = new DisposableStore();
    const fn = vi.fn();
    store.add(toDisposable(fn));

    store.clear();
    store.dispose();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("add() after dispose() warns and leaks the registration", () => {
    const store = new DisposableStore();
    store.dispose();
    const leaked = vi.fn();

    const returned = store.add(toDisposable(leaked));
    store.dispose();

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(leaked).not.toHaveBeenCalled();
    // Caller still gets the disposable back — consistent add() contract
    // so call sites can dispose it manually if they choose.
    expect(returned).toBeDefined();
    returned.dispose();
    expect(leaked).toHaveBeenCalledTimes(1);
  });

  it("is itself an IDisposable — can be nested inside another store", () => {
    const outer = new DisposableStore();
    const inner = new DisposableStore();
    const inside = vi.fn();
    inner.add(toDisposable(inside));
    outer.add(inner);

    outer.dispose();

    expect(inside).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  Disposable,
  DisposableStore,
  MutableDisposable,
  toDisposable,
  type IDisposable,
} from "../lifecycle.js";

describe("toDisposable", () => {
  it("wraps a function as an IDisposable that calls it on dispose()", () => {
    const fn = vi.fn();
    const d = toDisposable(fn);
    d.dispose();
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("DisposableStore", () => {
  it("disposes all registered children on dispose()", () => {
    const store = new DisposableStore();
    const a = vi.fn();
    const b = vi.fn();
    store.add(toDisposable(a));
    store.add(toDisposable(b));
    store.dispose();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("dispose() is idempotent", () => {
    const store = new DisposableStore();
    const a = vi.fn();
    store.add(toDisposable(a));
    store.dispose();
    store.dispose();
    expect(a).toHaveBeenCalledOnce();
  });

  it("a child throwing does not skip later children", () => {
    const store = new DisposableStore();
    const middle = vi.fn();
    const last = vi.fn();
    store.add(
      toDisposable(() => {
        throw new Error("boom");
      })
    );
    store.add(toDisposable(middle));
    store.add(toDisposable(last));
    expect(() => store.dispose()).not.toThrow();
    expect(middle).toHaveBeenCalledOnce();
    expect(last).toHaveBeenCalledOnce();
  });

  it("returns the registered disposable from add() for inline use", () => {
    const store = new DisposableStore();
    const child = toDisposable(() => {});
    expect(store.add(child)).toBe(child);
  });

  it("supports nested stores — disposing the parent disposes the child store", () => {
    const parent = new DisposableStore();
    const child = parent.add(new DisposableStore());
    const fn = vi.fn();
    child.add(toDisposable(fn));
    parent.dispose();
    expect(fn).toHaveBeenCalledOnce();
    expect(child.isDisposed).toBe(true);
  });

  it("add-after-dispose immediately disposes the new item and logs an error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = new DisposableStore();
      store.dispose();
      const late = vi.fn();
      const handle = store.add(toDisposable(late));
      expect(late).toHaveBeenCalledOnce();
      expect(errSpy).toHaveBeenCalled();
      // The store does not retain the late item.
      expect(store.size).toBe(0);
      // add() still returns the same handle so callers can chain.
      expect(handle.dispose).toBeDefined();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("re-entrant dispose() during a child's dispose() is safe", () => {
    // Snapshot-before-iterate also makes it safe for a child to call
    // store.dispose() during its own teardown — _isDisposed is set first,
    // so the re-entrant call is a no-op and does not double-invoke siblings.
    const store = new DisposableStore();
    const sibling = vi.fn();
    store.add(
      toDisposable(() => {
        store.dispose();
      })
    );
    store.add(toDisposable(sibling));

    store.dispose();
    expect(sibling).toHaveBeenCalledOnce();
    expect(store.isDisposed).toBe(true);
  });

  it("clear() disposes all children but keeps the store usable", () => {
    const store = new DisposableStore();
    const a = vi.fn();
    store.add(toDisposable(a));
    store.clear();
    expect(a).toHaveBeenCalledOnce();
    expect(store.isDisposed).toBe(false);

    const b = vi.fn();
    store.add(toDisposable(b));
    store.dispose();
    expect(b).toHaveBeenCalledOnce();
  });
});

describe("MutableDisposable", () => {
  it("auto-disposes the previous value when reassigned", () => {
    const slot = new MutableDisposable<IDisposable>();
    const a = vi.fn();
    const b = vi.fn();
    slot.value = toDisposable(a);
    slot.value = toDisposable(b);
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("assigning the same value is a no-op", () => {
    const slot = new MutableDisposable<IDisposable>();
    const fn = vi.fn();
    const handle = toDisposable(fn);
    slot.value = handle;
    slot.value = handle;
    expect(fn).not.toHaveBeenCalled();
  });

  it("clear() disposes the current value", () => {
    const slot = new MutableDisposable<IDisposable>();
    const fn = vi.fn();
    slot.value = toDisposable(fn);
    slot.clear();
    expect(fn).toHaveBeenCalledOnce();
    expect(slot.value).toBeUndefined();
  });

  it("dispose() disposes the current value and ignores future assignments", () => {
    const slot = new MutableDisposable<IDisposable>();
    const a = vi.fn();
    slot.value = toDisposable(a);
    slot.dispose();
    expect(a).toHaveBeenCalledOnce();

    const b = vi.fn();
    slot.value = toDisposable(b);
    // After dispose, incoming values are immediately disposed and not retained.
    expect(b).toHaveBeenCalledOnce();
    expect(slot.value).toBeUndefined();
  });

  it("clearing an empty slot does not throw", () => {
    const slot = new MutableDisposable<IDisposable>();
    expect(() => slot.clear()).not.toThrow();
  });
});

describe("Disposable base class", () => {
  it("_register adds a child that disposes when dispose() runs", () => {
    class Service extends Disposable {
      readonly child: IDisposable;
      constructor(onDispose: () => void) {
        super();
        this.child = this._register(toDisposable(onDispose));
      }
    }
    const fn = vi.fn();
    const svc = new Service(fn);
    svc.dispose();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("dispose() is idempotent", () => {
    class Service extends Disposable {
      constructor(onDispose: () => void) {
        super();
        this._register(toDisposable(onDispose));
      }
    }
    const fn = vi.fn();
    const svc = new Service(fn);
    svc.dispose();
    svc.dispose();
    expect(fn).toHaveBeenCalledOnce();
  });
});

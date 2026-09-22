// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
  type MockInstance,
} from "vitest";
import * as reactEntry from "../react.js";
import { createViewScope, type ViewScope, type ViewScopeStats } from "../react/createViewScope.js";

function fakeGl(options: { lost?: boolean; extension?: boolean } = {}) {
  const loseContext = vi.fn();
  const gl = {
    isContextLost: vi.fn(() => options.lost ?? false),
    getExtension: vi.fn((name: string) =>
      name === "WEBGL_lose_context" && options.extension !== false ? { loseContext } : null
    ),
  };
  return { gl: gl as unknown as WebGLRenderingContext, loseContext };
}

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createViewScope lifetime", () => {
  it("is exported as a runtime value from the react entry", () => {
    expect(typeof reactEntry.createViewScope).toBe("function");
  });

  it("releases everything when the view's signal aborts, and aborts its own signal first", () => {
    const upstream = new AbortController();
    const scope = createViewScope(upstream.signal);
    const order: string[] = [];
    scope.signal.addEventListener("abort", () => order.push("signal"));
    scope.add(() => order.push("add"));

    const reason = new Error("attempt over");
    upstream.abort(reason);

    expect(order).toEqual(["signal", "add"]);
    expect(scope.disposed).toBe(true);
    expect(scope.signal.reason).toBe(reason);
  });

  it("releases newest first across resource kinds", () => {
    const scope = createViewScope(new AbortController().signal);
    const order: string[] = [];
    scope.observe({ disconnect: () => order.push("observer") });
    scope.worker({ terminate: () => order.push("worker") });
    scope.add(() => order.push("disposer"));

    scope.dispose();

    expect(order).toEqual(["disposer", "worker", "observer"]);
  });

  it("disposes once no matter how often it is asked", () => {
    const upstream = new AbortController();
    const scope = createViewScope(upstream.signal);
    const disposer = vi.fn();
    scope.add(disposer);

    scope.dispose();
    scope.dispose();
    upstream.abort();

    expect(disposer).toHaveBeenCalledTimes(1);
    expect(scope.stats().released).toBe(1);
  });

  it("detaches from the view's signal on manual disposal", () => {
    const upstream = new AbortController();
    const add = vi.spyOn(upstream.signal, "addEventListener");
    const remove = vi.spyOn(upstream.signal, "removeEventListener");
    const scope = createViewScope(upstream.signal);

    scope.dispose();

    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
  });

  it("is born disposed when the signal already aborted, without listening to it", () => {
    const upstream = new AbortController();
    upstream.abort("gone");
    const add = vi.spyOn(upstream.signal, "addEventListener");
    const onReport = vi.fn();

    const scope = createViewScope(upstream.signal, { onReport });

    expect(scope.disposed).toBe(true);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe("gone");
    expect(add).not.toHaveBeenCalled();
    expect(onReport).toHaveBeenCalledWith({
      active: 0,
      released: 0,
      cleanupErrors: 0,
      lateRegistrations: 0,
    });
  });

  it("keeps independent scopes on one signal independent", () => {
    const upstream = new AbortController();
    const first = createViewScope(upstream.signal);
    const second = createViewScope(upstream.signal);
    const firstDisposer = vi.fn();
    const secondDisposer = vi.fn();
    first.add(firstDisposer);
    second.add(secondDisposer);

    first.dispose();
    expect(secondDisposer).not.toHaveBeenCalled();

    upstream.abort();
    expect(firstDisposer).toHaveBeenCalledTimes(1);
    expect(secondDisposer).toHaveBeenCalledTimes(1);
  });

  it("works as an effect cleanup passed unbound", () => {
    const scope = createViewScope(new AbortController().signal);
    const disposer = vi.fn();
    scope.add(disposer);
    const cleanup = scope.dispose;

    cleanup();

    expect(disposer).toHaveBeenCalledTimes(1);
  });
});

describe("createViewScope failure isolation", () => {
  it("keeps releasing after a cleanup throws, and never throws from dispose", () => {
    const scope = createViewScope(new AbortController().signal);
    const after = vi.fn();
    const before = vi.fn();
    scope.add(before);
    scope.add(() => {
      throw new Error("boom");
    });
    scope.add(after);

    expect(() => scope.dispose()).not.toThrow();

    expect(after).toHaveBeenCalledTimes(1);
    expect(before).toHaveBeenCalledTimes(1);
    expect(scope.stats()).toMatchObject({ released: 2, cleanupErrors: 1 });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toMatch(/^@daintreehq\/plugin-sdk\/react:/);
  });

  it("never retries a cleanup that threw", () => {
    const upstream = new AbortController();
    const scope = createViewScope(upstream.signal);
    const failing = vi.fn(() => {
      throw new Error("boom");
    });
    const cancel = scope.add(failing);

    scope.dispose();
    cancel();
    upstream.abort();

    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("survives a throwing onReport", () => {
    const scope = createViewScope(new AbortController().signal, {
      onReport: () => {
        throw new Error("report failed");
      },
    });
    const disposer = vi.fn();
    scope.add(disposer);

    expect(() => scope.dispose()).not.toThrow();
    expect(disposer).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});

describe("createViewScope late registration", () => {
  it("releases adopted resources on arrival and counts them", () => {
    const scope = createViewScope(new AbortController().signal);
    scope.dispose();
    const disconnect = vi.fn();
    const terminate = vi.fn();
    const disposer = vi.fn();
    const { gl, loseContext } = fakeGl();

    scope.observe({ disconnect });
    scope.worker({ terminate });
    scope.webgl(gl);
    const cancel = scope.add(disposer);
    cancel();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(loseContext).toHaveBeenCalledTimes(1);
    expect(disposer).toHaveBeenCalledTimes(1);
    expect(scope.stats()).toEqual({
      active: 0,
      released: 4,
      cleanupErrors: 0,
      lateRegistrations: 4,
    });
  });

  it("never starts late timers, frames or listeners", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    const scope = createViewScope(new AbortController().signal);
    scope.dispose();
    const callback = vi.fn();
    const target = new EventTarget();

    scope.setTimeout(callback, 10);
    scope.setInterval(callback, 10);
    scope.requestAnimationFrame(callback);
    scope.listen(target, "ping", callback);
    vi.advanceTimersByTime(50);
    target.dispatchEvent(new Event("ping"));

    expect(callback).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
    expect(scope.stats()).toMatchObject({ lateRegistrations: 4, active: 0 });
  });

  it("warns once per scope, however many late registrations follow", () => {
    const scope = createViewScope(new AbortController().signal);
    scope.dispose();

    scope.add(() => {});
    scope.add(() => {});

    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(String(consoleWarn.mock.calls[0][0])).toMatch(/^@daintreehq\/plugin-sdk\/react:/);
  });

  it("releases a registration made by another cleanup during disposal", () => {
    const scope = createViewScope(new AbortController().signal);
    const lateDisposer = vi.fn();
    scope.add(() => scope.add(lateDisposer));

    scope.dispose();

    expect(lateDisposer).toHaveBeenCalledTimes(1);
    expect(scope.stats().lateRegistrations).toBe(1);
  });

  it("hands back an already-revoked URL for a late objectURL", () => {
    const createObjectURL = vi.fn(() => "blob:late");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(class {}, { createObjectURL, revokeObjectURL }));
    const scope = createViewScope(new AbortController().signal);
    scope.dispose();

    expect(scope.objectURL(new Blob(["x"]))).toBe("blob:late");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:late");
  });
});

describe("createViewScope diagnostics", () => {
  it("reports once, after the first disposal, and keeps counting in stats()", () => {
    const onReport = vi.fn();
    const upstream = new AbortController();
    const scope = createViewScope(upstream.signal, { onReport });
    scope.add(() => {});
    scope.add(() => {});

    upstream.abort();
    scope.dispose();
    scope.add(() => {});

    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledWith({
      active: 0,
      released: 2,
      cleanupErrors: 0,
      lateRegistrations: 0,
    });
    expect(scope.stats()).toEqual({
      active: 0,
      released: 3,
      cleanupErrors: 0,
      lateRegistrations: 1,
    });
  });

  it("returns a detached snapshot from stats()", () => {
    const scope = createViewScope(new AbortController().signal);
    const before = scope.stats();
    scope.add(() => {});

    expect(before.active).toBe(0);
    expect(scope.stats().active).toBe(1);
  });

  it("counts an early cancellation as released and forgets it", () => {
    const scope = createViewScope(new AbortController().signal);
    const disposer = vi.fn();
    const cancel = scope.add(disposer);

    cancel();
    cancel();
    scope.dispose();

    expect(disposer).toHaveBeenCalledTimes(1);
    expect(scope.stats()).toMatchObject({ active: 0, released: 1 });
  });
});

describe("createViewScope timers and frames", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });

  it("forgets a timeout once it fires, before running the callback", () => {
    const scope = createViewScope(new AbortController().signal);
    let activeDuringCallback = -1;
    const callback = vi.fn((a: number, b: string) => {
      activeDuringCallback = scope.stats().active;
      expect([a, b]).toEqual([1, "two"]);
    });

    scope.setTimeout(callback, 10, 1, "two");
    expect(scope.stats().active).toBe(1);
    vi.advanceTimersByTime(10);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(activeDuringCallback).toBe(0);
    expect(scope.stats()).toMatchObject({ active: 0, released: 0 });
  });

  it("forgets a timeout whose callback throws", () => {
    const scope = createViewScope(new AbortController().signal);
    scope.setTimeout(() => {
      throw new Error("callback failed");
    }, 5);

    expect(() => vi.advanceTimersByTime(5)).toThrow("callback failed");
    expect(scope.stats().active).toBe(0);
  });

  it("clears a pending timeout on disposal and on cancel", () => {
    const scope = createViewScope(new AbortController().signal);
    const disposed = vi.fn();
    const cancelled = vi.fn();
    const cancel = scope.setTimeout(cancelled, 10);
    scope.setTimeout(disposed, 10);

    cancel();
    scope.dispose();
    vi.advanceTimersByTime(20);

    expect(cancelled).not.toHaveBeenCalled();
    expect(disposed).not.toHaveBeenCalled();
    expect(scope.stats()).toMatchObject({ active: 0, released: 2 });
  });

  it("keeps an interval registered until it is released", () => {
    const scope = createViewScope(new AbortController().signal);
    const tick = vi.fn();
    scope.setInterval(tick, 10, "arg");

    vi.advanceTimersByTime(30);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(tick).toHaveBeenCalledWith("arg");
    expect(scope.stats().active).toBe(1);

    scope.dispose();
    vi.advanceTimersByTime(30);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("forgets a fired frame, so a render loop does not accumulate registrations", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        frames.set(nextId, cb);
        return nextId++;
      })
    );
    const cancelAnimationFrame = vi.fn((id: number) => frames.delete(id));
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const flush = (time: number) => {
      const pending = [...frames.values()];
      frames.clear();
      for (const cb of pending) cb(time);
    };
    const scope = createViewScope(new AbortController().signal);
    const times: number[] = [];
    const loop = (time: number) => {
      times.push(time);
      scope.requestAnimationFrame(loop);
    };
    scope.requestAnimationFrame(loop);

    flush(16);
    flush(32);
    flush(48);

    expect(times).toEqual([16, 32, 48]);
    expect(scope.stats().active).toBe(1);

    scope.dispose();
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(scope.stats()).toMatchObject({ active: 0, released: 1 });
  });
});

describe("createViewScope listeners", () => {
  it("removes listeners on disposal, including capture-phase ones", () => {
    const target = document.createElement("div");
    const scope = createViewScope(new AbortController().signal);
    const bubble = vi.fn();
    const capture = vi.fn();
    const options: AddEventListenerOptions = { capture: true };
    scope.listen(target, "click", bubble);
    scope.listen(target, "click", capture, options);
    // Mutating the options after registration must not change what disposal removes.
    options.capture = false;

    target.dispatchEvent(new Event("click"));
    scope.dispose();
    target.dispatchEvent(new Event("click"));

    expect(bubble).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("calls a function listener with the target as this, and a listener object's handleEvent", () => {
    const target = document.createElement("div");
    const scope = createViewScope(new AbortController().signal);
    const listener = vi.fn();
    const object = { handleEvent: vi.fn() };
    scope.listen(target, "click", listener);
    scope.listen(target, "custom", object);

    target.dispatchEvent(new Event("click"));
    const custom = new Event("custom");
    target.dispatchEvent(custom);

    expect(listener.mock.contexts[0]).toBe(target);
    expect(object.handleEvent).toHaveBeenCalledWith(custom);
    expect(object.handleEvent.mock.contexts[0]).toBe(object);
  });

  it("treats each call as an independent subscription", () => {
    const target = new EventTarget();
    const scope = createViewScope(new AbortController().signal);
    const listener = vi.fn();
    const first = scope.listen(target, "ping", listener);
    scope.listen(target, "ping", listener);

    target.dispatchEvent(new Event("ping"));
    first();
    target.dispatchEvent(new Event("ping"));

    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("leaves a listener the view registered outside the scope alone", () => {
    const target = new EventTarget();
    const scope = createViewScope(new AbortController().signal);
    const listener = vi.fn();
    target.addEventListener("ping", listener);
    scope.listen(target, "ping", listener);

    scope.dispose();
    target.dispatchEvent(new Event("ping"));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("forgets a once listener as it fires", () => {
    const target = new EventTarget();
    const scope = createViewScope(new AbortController().signal);
    const listener = vi.fn(() => {
      expect(scope.stats().active).toBe(0);
    });
    scope.listen(target, "ping", listener, { once: true });

    target.dispatchEvent(new Event("ping"));
    target.dispatchEvent(new Event("ping"));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(scope.stats()).toMatchObject({ active: 0, released: 0 });
  });

  it("honours the caller's own signal and forgets the listener when it aborts", () => {
    const target = new EventTarget();
    const scope = createViewScope(new AbortController().signal);
    const caller = new AbortController();
    const removeAbort = vi.spyOn(caller.signal, "removeEventListener");
    const listener = vi.fn();
    scope.listen(target, "ping", listener, { signal: caller.signal });

    caller.abort();
    target.dispatchEvent(new Event("ping"));

    expect(listener).not.toHaveBeenCalled();
    expect(scope.stats()).toMatchObject({ active: 0, released: 0 });

    scope.dispose();
    expect(removeAbort).toHaveBeenCalled();
  });

  it("detaches from the caller's signal when the scope releases the listener", () => {
    const target = new EventTarget();
    const scope = createViewScope(new AbortController().signal);
    const caller = new AbortController();
    const addAbort = vi.spyOn(caller.signal, "addEventListener");
    const removeAbort = vi.spyOn(caller.signal, "removeEventListener");
    scope.listen(target, "ping", () => {}, { signal: caller.signal });

    scope.dispose();

    expect(removeAbort).toHaveBeenCalledWith("abort", addAbort.mock.calls[0][1]);
  });

  it("subscribes nothing when the caller's signal already aborted", () => {
    const target = new EventTarget();
    const scope = createViewScope(new AbortController().signal);
    const caller = new AbortController();
    caller.abort();
    const listener = vi.fn();

    scope.listen(target, "ping", listener, { signal: caller.signal });
    target.dispatchEvent(new Event("ping"));

    expect(listener).not.toHaveBeenCalled();
    expect(scope.stats()).toMatchObject({ active: 0, lateRegistrations: 0 });
  });

  it("passes passive through only when the caller set it", () => {
    // An element rather than a bare EventTarget: jsdom derives the default
    // `passive` for wheel events from the target's owner document.
    const target = document.createElement("div");
    const add = vi.spyOn(target, "addEventListener");
    const scope = createViewScope(new AbortController().signal);

    scope.listen(target, "wheel", () => {});
    scope.listen(target, "wheel", () => {}, { passive: false });

    expect(add.mock.calls[0][2]).toEqual({ capture: false });
    expect(add.mock.calls[1][2]).toEqual({ capture: false, passive: false });
  });
});

describe("createViewScope adopted resources", () => {
  it("revokes an object URL it created", () => {
    const createObjectURL = vi.fn(() => "blob:owned");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(class {}, { createObjectURL, revokeObjectURL }));
    const scope = createViewScope(new AbortController().signal);
    const blob = new Blob(["x"]);

    expect(scope.objectURL(blob)).toBe("blob:owned");
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    scope.dispose();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:owned");
  });

  it("loses a live WebGL context through WEBGL_lose_context", () => {
    const scope = createViewScope(new AbortController().signal);
    const { gl, loseContext } = fakeGl();

    expect(scope.webgl(gl)).toBe(gl);
    scope.dispose();

    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("leaves an already-lost context alone", () => {
    const scope = createViewScope(new AbortController().signal);
    const { gl, loseContext } = fakeGl({ lost: true });
    scope.webgl(gl);

    scope.dispose();

    expect(loseContext).not.toHaveBeenCalled();
    expect(scope.stats().cleanupErrors).toBe(0);
  });

  it("tolerates a context without the extension", () => {
    const scope = createViewScope(new AbortController().signal);
    const { gl } = fakeGl({ extension: false });
    scope.webgl(gl);

    scope.dispose();

    expect(scope.stats()).toMatchObject({ released: 1, cleanupErrors: 0 });
  });

  it("isolates a throwing native cleanup", () => {
    const scope = createViewScope(new AbortController().signal);
    const terminate = vi.fn();
    scope.worker({ terminate });
    scope.observe({
      disconnect: () => {
        throw new Error("disconnect failed");
      },
    });

    scope.dispose();

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(scope.stats()).toMatchObject({ released: 1, cleanupErrors: 1 });
  });
});

describe("createViewScope types", () => {
  it("preserves the types of adopted resources", () => {
    const scope: ViewScope = createViewScope(new AbortController().signal);
    const observer = { disconnect: () => {} } as unknown as ResizeObserver;
    const gl = fakeGl().gl as unknown as WebGL2RenderingContext;
    expectTypeOf(scope.observe(observer)).toEqualTypeOf<ResizeObserver>();
    expectTypeOf(scope.webgl(gl)).toEqualTypeOf<WebGL2RenderingContext>();
    expectTypeOf(scope.setTimeout).returns.toEqualTypeOf<() => void>();
    expectTypeOf(scope.stats()).toEqualTypeOf<ViewScopeStats>();
    scope.dispose();
  });

  it("checks callback arguments and event types at the call site", () => {
    const scope = createViewScope(new AbortController().signal);
    scope.setTimeout((count: number) => expectTypeOf(count).toBeNumber(), 0, 1);
    // @ts-expect-error — the argument does not match the callback's parameter.
    scope.setTimeout((count: number) => count, 0, "one");
    scope.listen(window, "keydown", (event) => expectTypeOf(event).toEqualTypeOf<KeyboardEvent>());
    scope.listen(document, "visibilitychange", (event) =>
      expectTypeOf(event).toEqualTypeOf<Event>()
    );
    scope.listen(document.body, "pointerdown", (event) =>
      expectTypeOf(event).toEqualTypeOf<PointerEvent>()
    );
    scope.dispose();
  });
});

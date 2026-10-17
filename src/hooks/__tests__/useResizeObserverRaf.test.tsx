// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useResizeObserverRaf } from "../useResizeObserverRaf";

function createEntry(width: number, height: number): ResizeObserverEntry {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return {
    contentRect: { width, height, x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0 },
    target: document.createElement("div"),
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  } as unknown as ResizeObserverEntry;
}

describe("useResizeObserverRaf", () => {
  let observerCallback: ((entries: ResizeObserverEntry[]) => void) | null = null;
  let observers: ResizeObserver[] = [];
  let rafCallbacks: (() => void)[] = [];
  let rafIdCounter = 0;

  beforeEach(() => {
    observerCallback = null;
    observers = [];
    rafCallbacks = [];
    rafIdCounter = 0;

    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function ResizeObserverMock(
        this: ResizeObserver | void,
        cb: (entries: ResizeObserverEntry[]) => void
      ) {
        observerCallback = cb;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const obs = {
          observe: vi.fn(),
          unobserve: vi.fn(),
          disconnect: vi.fn(() => {
            observerCallback = null;
          }),
        } as unknown as ResizeObserver;
        observers.push(obs);
        return obs;
      })
    );

    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: () => void) => {
        const id = ++rafIdCounter;
        rafCallbacks.push(cb);
        return id;
      })
    );

    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((_id: number) => {
        rafCallbacks = rafCallbacks.filter(() => false);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushRaf() {
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    for (const cb of cbs) {
      cb();
    }
  }

  function TestWrapper({
    onResize,
    element,
  }: {
    onResize: (entry: ResizeObserverEntry) => void;
    element: HTMLElement | null;
  }) {
    useResizeObserverRaf(element, onResize);
    return null;
  }

  it("calls onResize after rAF flush with the latest entry", () => {
    const el = document.createElement("div");
    const onResize = vi.fn();

    renderHook(() => TestWrapper({ onResize, element: el }));

    observerCallback!([createEntry(100, 200)]);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    flushRaf();
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(
      expect.objectContaining({ contentRect: expect.objectContaining({ width: 100, height: 200 }) })
    );
  });

  it("coalesces multiple observations to the latest entry per frame", () => {
    const el = document.createElement("div");
    const onResize = vi.fn();

    renderHook(() => TestWrapper({ onResize, element: el }));

    observerCallback!([createEntry(100, 200)]);
    observerCallback!([createEntry(300, 400)]);
    observerCallback!([createEntry(500, 600)]);

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    flushRaf();
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(
      expect.objectContaining({ contentRect: expect.objectContaining({ width: 500, height: 600 }) })
    );
  });

  it("disconnects observer and cancels rAF on unmount", () => {
    const el = document.createElement("div");
    const onResize = vi.fn();

    const { unmount } = renderHook(() => TestWrapper({ onResize, element: el }));

    observerCallback!([createEntry(100, 200)]);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    unmount();
    expect(observers[0]?.disconnect).toHaveBeenCalled();
    // rAF canceled; onResize never fires
    expect(onResize).toHaveBeenCalledTimes(0);
  });

  it("re-subscribes when element becomes non-null after mount", () => {
    const onResize = vi.fn();
    const el = document.createElement("div");

    const { rerender } = renderHook(
      ({ element }: { element: HTMLElement | null }) => TestWrapper({ onResize, element }),
      { initialProps: { element: null as HTMLElement | null } }
    );

    expect(ResizeObserver).not.toHaveBeenCalled();

    rerender({ element: el });

    expect(ResizeObserver).toHaveBeenCalledTimes(1);
    expect(observers[0]?.observe).toHaveBeenCalledWith(el);
  });

  it("no-ops when entry array is empty", () => {
    const el = document.createElement("div");
    const onResize = vi.fn();

    renderHook(() => TestWrapper({ onResize, element: el }));

    observerCallback!([]);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});

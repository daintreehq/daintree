// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";
import { useTabOverflow } from "../useTabOverflow";

type IOEntry = { target: HTMLElement; isIntersecting: boolean };

interface IORecord {
  callback: (entries: IOEntry[]) => void;
  observe: (el: HTMLElement) => void;
  disconnect: () => void;
  observed: Set<HTMLElement>;
  options?: IntersectionObserverInit;
}

let lastIO: IORecord | null = null;

class MockIntersectionObserver {
  callback: (entries: IOEntry[]) => void;
  observed = new Set<HTMLElement>();
  options?: IntersectionObserverInit;

  constructor(callback: (entries: IOEntry[]) => void, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    lastIO = {
      callback,
      observe: (el) => this.observe(el),
      disconnect: () => this.disconnect(),
      observed: this.observed,
      options,
    };
  }

  observe(el: HTMLElement): void {
    this.observed.add(el);
  }

  unobserve(el: HTMLElement): void {
    this.observed.delete(el);
  }

  disconnect(): void {
    this.observed.clear();
    if (lastIO?.observed === this.observed) lastIO = null;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

beforeEach(() => {
  lastIO = null;
  // @ts-expect-error - injecting mock
  globalThis.IntersectionObserver = MockIntersectionObserver;
});

function setupContainer(ids: string[]): HTMLDivElement {
  const container = document.createElement("div");
  for (const id of ids) {
    const child = document.createElement("div");
    child.setAttribute("data-tab-id", id);
    container.appendChild(child);
  }
  document.body.appendChild(container);
  return container;
}

function emit(entries: { id: string; visible: boolean }[]) {
  if (!lastIO) throw new Error("No IntersectionObserver was created");
  const observed = Array.from(lastIO.observed);
  const ioEntries: IOEntry[] = entries.map((e) => {
    const target = observed.find((el) => el.dataset.tabId === e.id);
    if (!target) throw new Error(`No observed target for tab id ${e.id}`);
    return { target, isIntersecting: e.visible };
  });
  act(() => {
    lastIO!.callback(ioEntries);
  });
}

describe("useTabOverflow", () => {
  it("returns an empty set when no tabs are clipped", () => {
    const container = setupContainer(["a", "b"]);
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(container);
      return useTabOverflow(ref, ["a", "b"]);
    });
    expect(result.current.size).toBe(0);
  });

  it("adds tab ids reported as not intersecting and removes them when they re-intersect", () => {
    const container = setupContainer(["a", "b", "c"]);
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(container);
      return useTabOverflow(ref, ["a", "b", "c"]);
    });

    emit([
      { id: "a", visible: true },
      { id: "b", visible: false },
      { id: "c", visible: false },
    ]);
    expect(Array.from(result.current).sort()).toEqual(["b", "c"]);

    emit([{ id: "b", visible: true }]);
    expect(Array.from(result.current).sort()).toEqual(["c"]);
  });

  it("observes every child with a data-tab-id attribute", () => {
    const container = setupContainer(["a", "b", "c"]);
    renderHook(() => {
      const ref = useRef<HTMLElement | null>(container);
      return useTabOverflow(ref, ["a", "b", "c"]);
    });
    expect(lastIO?.observed.size).toBe(3);
  });

  it("uses threshold 0.98 (Chromium subpixel rounding gotcha)", () => {
    const container = setupContainer(["a"]);
    renderHook(() => {
      const ref = useRef<HTMLElement | null>(container);
      return useTabOverflow(ref, ["a"]);
    });
    expect(lastIO?.options?.threshold).toBe(0.98);
  });

  it("scopes the observer root to the container", () => {
    const container = setupContainer(["a"]);
    renderHook(() => {
      const ref = useRef<HTMLElement | null>(container);
      return useTabOverflow(ref, ["a"]);
    });
    expect(lastIO?.options?.root).toBe(container);
  });

  it("does nothing when IntersectionObserver is unavailable", () => {
    // @ts-expect-error - intentionally removing mock
    delete globalThis.IntersectionObserver;
    const container = setupContainer(["a", "b"]);
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(container);
      return useTabOverflow(ref, ["a", "b"]);
    });
    expect(result.current.size).toBe(0);
  });
});

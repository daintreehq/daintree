// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { createRef } from "react";
import { PathTail } from "../PathTail";

let observers: MockResizeObserver[] = [];

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  report(targets: Element[]) {
    this.callback(
      targets.map((target) => ({ target }) as ResizeObserverEntry),
      this as unknown as ResizeObserver
    );
  }
}

function setWidth(el: Element, width: number) {
  el.getBoundingClientRect = () => ({ width }) as DOMRect;
}

/** Sizes the box and the path inside it, as layout would. */
function lay(tail: Element, box: number, path: number) {
  setWidth(tail, box);
  setWidth(tail.querySelector("bdi")!, path);
}

describe("PathTail", () => {
  const OriginalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    observers = [];
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.stubGlobal("ResizeObserver", OriginalResizeObserver);
  });

  it("keeps the path whole and isolated from the clipping direction", () => {
    const path = "src/components/Settings/AgentSettings/";
    const { container } = render(<PathTail data-testid="dir">{path}</PathTail>);
    const span = container.querySelector("[data-testid='dir']")!;
    // Only the box runs right-to-left; the path's own order must not flip.
    expect(span.textContent).toBe(path);
    expect(span.querySelector("bdi")?.textContent).toBe(path);
  });

  it("forces the path left-to-right even when it starts with an RTL segment", () => {
    // A bare <bdi> takes its direction from the first strong character, so a
    // Hebrew-leading directory would render its separators on the wrong side.
    const { container } = render(<PathTail>{"א/src/"}</PathTail>);
    expect(container.querySelector("bdi")?.getAttribute("dir")).toBe("ltr");
  });

  it("marks the box cut only while the path is wider than it", () => {
    const { container } = render(<PathTail>{"src/renderer/store/"}</PathTail>);
    const tail = container.firstElementChild!;
    const [observer] = observers;
    expect(observer.observe).toHaveBeenCalledWith(tail);

    lay(tail, 80, 120);
    observer.report([tail]);
    expect(tail.hasAttribute("data-cut")).toBe(true);

    lay(tail, 120, 120);
    observer.report([tail]);
    expect(tail.hasAttribute("data-cut")).toBe(false);
  });

  it("counts a path over by less than a pixel as cut", () => {
    // scrollWidth and clientWidth round to whole pixels and would call this a
    // fit, leaving the native ellipsis in place for this one row.
    const { container } = render(<PathTail>{"docs/architecture/"}</PathTail>);
    const tail = container.firstElementChild!;

    lay(tail, 100, 100.4);
    observers[0].report([tail]);
    expect(tail.hasAttribute("data-cut")).toBe(true);
  });

  it("reads every box in a batch before marking any", () => {
    const { container } = render(
      <>
        <PathTail>{"a/b/"}</PathTail>
        <PathTail>{"c/d/"}</PathTail>
      </>
    );
    const tails = [...container.querySelectorAll(".path-tail")];
    const log: string[] = [];
    for (const tail of tails) {
      lay(tail, 10, 20);
      for (const el of [tail, tail.querySelector("bdi")!]) {
        const read = el.getBoundingClientRect;
        el.getBoundingClientRect = () => {
          log.push("read");
          return read();
        };
      }
      const write = tail.toggleAttribute.bind(tail);
      tail.toggleAttribute = (name, force) => {
        log.push("write");
        return write(name, force);
      };
    }

    observers[0].report(tails);
    expect(log).toEqual(["read", "read", "read", "read", "write", "write"]);
  });

  it("observes afresh when the path changes, not on every render", () => {
    const { container, rerender } = render(<PathTail className="a">{"src/a/"}</PathTail>);
    const tail = container.firstElementChild!;
    // The only box leaving drops the shared observer, so count across all.
    const observed = () => observers.flatMap((o) => o.observe.mock.calls.map(([el]) => el));
    const unobserved = () => observers.flatMap((o) => o.unobserve.mock.calls.map(([el]) => el));
    expect(observed()).toEqual([tail]);

    rerender(<PathTail className="b">{"src/a/"}</PathTail>);
    expect(observed()).toEqual([tail]);

    // A fresh observation reports at once, which re-measures a box that kept
    // its width while its path changed.
    rerender(<PathTail className="b">{"src/components/ReviewHub/"}</PathTail>);
    expect(unobserved()).toEqual([tail]);
    expect(observed()).toEqual([tail, tail]);
  });

  it("lets the shared observer go once the last box unmounts", () => {
    const first = render(<PathTail>{"a/"}</PathTail>);
    const second = render(<PathTail>{"b/"}</PathTail>);
    const [observer] = observers;
    expect(observers).toHaveLength(1);

    first.unmount();
    expect(observer.unobserve).toHaveBeenCalledTimes(1);
    expect(observer.disconnect).not.toHaveBeenCalled();

    second.unmount();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("hands the box to the caller's object and callback refs", () => {
    const objectRef = createRef<HTMLSpanElement>();
    const callbackRef = vi.fn();
    const { container } = render(
      <>
        <PathTail ref={objectRef}>{"a/"}</PathTail>
        <PathTail ref={callbackRef}>{"b/"}</PathTail>
      </>
    );
    const [first, second] = container.querySelectorAll(".path-tail");
    expect(objectRef.current).toBe(first);
    expect(callbackRef).toHaveBeenCalledWith(second);
  });
});

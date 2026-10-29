// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { StrictMode, createRef } from "react";
import { PathTail } from "../PathTail";

let observers: MockResizeObserver[] = [];

class MockResizeObserver {
  observe = vi.fn<(el: Element) => void>();
  unobserve = vi.fn<(el: Element) => void>();
  disconnect = vi.fn<() => void>();
  constructor(readonly callback: (entries: { target: Element }[]) => void) {
    observers.push(this);
  }
  report(targets: Element[]) {
    this.callback(targets.map((target) => ({ target })));
  }
}

const observed = () => observers.flatMap((o) => o.observe.mock.calls.map(([el]) => el));
const unobserved = () => observers.flatMap((o) => o.unobserve.mock.calls.map(([el]) => el));
const current = () => observers.at(-1)!;

function setWidth(el: Element, width: number) {
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: width,
    width,
    height: 0,
    toJSON: () => ({}),
  });
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
    expect(observed()).toEqual([tail]);

    lay(tail, 80, 120);
    current().report([tail]);
    expect(tail.hasAttribute("data-cut")).toBe(true);

    lay(tail, 120, 120);
    current().report([tail]);
    expect(tail.hasAttribute("data-cut")).toBe(false);

    lay(tail, 80, 120);
    current().report([tail]);
    lay(tail, 200, 120);
    current().report([tail]);
    expect(tail.hasAttribute("data-cut")).toBe(false);
  });

  it("counts a path over by under a pixel as cut, but not one Blink still fits", () => {
    // scrollWidth and clientWidth round to whole pixels and would call 0.3px
    // over a fit, leaving the native ellipsis in place for that row.
    const { container } = render(<PathTail>{"docs/architecture/"}</PathTail>);
    const tail = container.firstElementChild!;

    lay(tail, 100, 100.3);
    current().report([tail]);
    expect(tail.hasAttribute("data-cut")).toBe(true);

    // One layout unit over still fits, and Blink draws no ellipsis there; a
    // marker would sit on the path's first glyph.
    lay(tail, 100, 100 + 1 / 64);
    current().report([tail]);
    expect(tail.hasAttribute("data-cut")).toBe(false);
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

    current().report(tails);
    expect(log).toEqual(["read", "read", "read", "read", "write", "write"]);
    expect(tails.every((tail) => tail.hasAttribute("data-cut"))).toBe(true);
  });

  it("observes afresh when the path or its classes change, not on every render", () => {
    const { container, rerender } = render(<PathTail className="a">{"src/a/"}</PathTail>);
    const tail = container.firstElementChild!;
    expect(observed()).toEqual([tail]);

    rerender(
      <PathTail className="a" title="src/a/">
        {"src/a/"}
      </PathTail>
    );
    expect(observed()).toEqual([tail]);

    // Either can carry the path across the cut in a box that keeps its width,
    // and only a new observation reports a box whose size did not change.
    rerender(<PathTail className="b">{"src/a/"}</PathTail>);
    expect(unobserved()).toEqual([tail]);
    expect(observed()).toEqual([tail, tail]);

    rerender(<PathTail className="b">{"src/components/ReviewHub/"}</PathTail>);
    expect(unobserved()).toEqual([tail, tail]);
    expect(observed()).toEqual([tail, tail, tail]);
  });

  it("observes every box afresh when a font finishes loading, until the last leaves", () => {
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
    try {
      const { container, unmount } = render(
        <>
          <PathTail>{"a/"}</PathTail>
          <PathTail>{"b/"}</PathTail>
        </>
      );
      const tails = [...container.querySelectorAll(".path-tail")];
      const observer = current();
      observer.observe.mockClear();

      fonts.dispatchEvent(new Event("loadingdone"));
      expect(observer.unobserve.mock.calls.map(([el]) => el)).toEqual(tails);
      expect(observer.observe.mock.calls.map(([el]) => el)).toEqual(tails);

      unmount();
      const after = observed().length;
      fonts.dispatchEvent(new Event("loadingdone"));
      expect(observed()).toHaveLength(after);
    } finally {
      Reflect.deleteProperty(document, "fonts");
    }
  });

  it("lets the shared observer go once the last box unmounts", () => {
    const first = render(<PathTail>{"a/"}</PathTail>);
    const second = render(<PathTail>{"b/"}</PathTail>);
    const observer = current();
    expect(observers).toHaveLength(1);

    first.unmount();
    expect(observer.unobserve).toHaveBeenCalledTimes(1);
    expect(observer.disconnect).not.toHaveBeenCalled();

    second.unmount();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("balances its observations under StrictMode's double effects", () => {
    const { container, unmount } = render(
      <StrictMode>
        <PathTail>{"a/"}</PathTail>
      </StrictMode>
    );
    const tail = container.firstElementChild!;
    expect(current().observe).toHaveBeenLastCalledWith(tail);
    expect(current().disconnect).not.toHaveBeenCalled();

    unmount();
    expect(observers.every((o) => o.disconnect.mock.calls.length === 1)).toBe(true);
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

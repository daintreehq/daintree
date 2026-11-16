// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useTruncationDetection } from "../useTruncationDetection";

type Callback = (entries: Array<{ target: Element }>) => void;

let callback: Callback | null = null;
const observed = new Set<Element>();

class FakeResizeObserver {
  constructor(cb: Callback) {
    callback = cb;
  }
  observe(el: Element) {
    observed.add(el);
  }
  unobserve(el: Element) {
    observed.delete(el);
  }
  disconnect() {
    observed.clear();
  }
}

function Label({ id, onTruncated }: { id: string; onTruncated: (v: boolean) => void }) {
  const { ref, isTruncated } = useTruncationDetection();
  onTruncated(isTruncated);
  return (
    <span ref={ref} data-testid={id}>
      text
    </span>
  );
}

function setWidths(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
}

describe("useTruncationDetection", () => {
  beforeEach(() => {
    callback = null;
    observed.clear();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("measures only the elements a resize notification names", () => {
    const a = vi.fn();
    const b = vi.fn();
    const { getByTestId } = render(
      <>
        <Label id="a" onTruncated={a} />
        <Label id="b" onTruncated={b} />
      </>
    );
    const elA = getByTestId("a");
    const elB = getByTestId("b");
    const readsA = vi.fn(() => 200);
    const readsB = vi.fn(() => 200);
    Object.defineProperty(elA, "scrollWidth", { configurable: true, get: readsA });
    Object.defineProperty(elB, "scrollWidth", { configurable: true, get: readsB });
    Object.defineProperty(elA, "clientWidth", { configurable: true, value: 100 });
    Object.defineProperty(elB, "clientWidth", { configurable: true, value: 100 });
    readsA.mockClear();
    readsB.mockClear();

    act(() => {
      callback!([{ target: elA }]);
    });

    expect(readsA).toHaveBeenCalled();
    expect(readsB).not.toHaveBeenCalled();
    expect(a).toHaveBeenLastCalledWith(true);
    expect(b).toHaveBeenLastCalledWith(false);
  });

  it("clears truncation when the notified element no longer overflows", () => {
    const seen = vi.fn();
    const { getByTestId } = render(<Label id="a" onTruncated={seen} />);
    const el = getByTestId("a");

    setWidths(el, 200, 100);
    act(() => callback!([{ target: el }]));
    expect(seen).toHaveBeenLastCalledWith(true);

    setWidths(el, 100, 100);
    act(() => callback!([{ target: el }]));
    expect(seen).toHaveBeenLastCalledWith(false);
  });

  it("stops observing an element when its label unmounts", () => {
    const { getByTestId, unmount } = render(<Label id="a" onTruncated={() => {}} />);
    const el = getByTestId("a");
    expect(observed.has(el)).toBe(true);
    unmount();
    expect(observed.has(el)).toBe(false);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { useRef } from "react";
import { render, cleanup } from "@testing-library/react";
import { useHorizontalScrollControls } from "../useHorizontalScrollControls";

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);

const scrollCalls: ScrollToOptions[] = [];

function Rail({ mapVerticalWheel, overflow }: { mapVerticalWheel?: boolean; overflow: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useHorizontalScrollControls(ref, { mapVerticalWheel });
  return (
    <div
      data-testid="rail"
      ref={(el) => {
        ref.current = el;
        if (!el) return;
        Object.defineProperty(el, "clientWidth", { configurable: true, value: 400 });
        Object.defineProperty(el, "scrollWidth", {
          configurable: true,
          value: overflow ? 1000 : 400,
        });
        Object.defineProperty(el, "scrollBy", {
          configurable: true,
          value: (options: ScrollToOptions) => {
            scrollCalls.push(options);
          },
        });
      }}
    />
  );
}

function wheel(el: Element, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

afterEach(() => {
  cleanup();
  scrollCalls.length = 0;
});

describe("useHorizontalScrollControls — vertical wheel mapping", () => {
  it("turns a vertical-only notch into instant horizontal scrolling and keeps it on the rail", () => {
    const { getByTestId } = render(<Rail mapVerticalWheel overflow />);
    const rail = getByTestId("rail");
    const event = wheel(rail, { deltaY: 100 });
    expect(event.defaultPrevented).toBe(true);
    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0]?.left).toBeGreaterThan(0);
    // Smooth scrolling would restart from mid-flight on every notch and eat it.
    expect(scrollCalls[0]?.behavior).toBe("instant");
  });

  it("leaves trackpad pans and pinch-zoom to the browser", () => {
    const { getByTestId } = render(<Rail mapVerticalWheel overflow />);
    const rail = getByTestId("rail");
    for (const init of [
      { deltaX: 12, deltaY: 30 },
      { deltaX: -4, deltaY: 0 },
      { deltaY: 10, ctrlKey: true },
    ]) {
      expect(wheel(rail, init).defaultPrevented).toBe(false);
    }
    expect(scrollCalls).toHaveLength(0);
  });

  it("does nothing when the rail does not overflow", () => {
    const { getByTestId } = render(<Rail mapVerticalWheel overflow={false} />);
    const rail = getByTestId("rail");
    expect(wheel(rail, { deltaY: 100 }).defaultPrevented).toBe(false);
    expect(scrollCalls).toHaveLength(0);
  });

  it("is opt-in — rails that did not ask keep native wheel behaviour", () => {
    const { getByTestId } = render(<Rail overflow />);
    const rail = getByTestId("rail");
    expect(wheel(rail, { deltaY: 100 }).defaultPrevented).toBe(false);
    expect(scrollCalls).toHaveLength(0);
  });
});

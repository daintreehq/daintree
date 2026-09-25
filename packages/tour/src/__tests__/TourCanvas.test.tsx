// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOUR_CANVAS, TourCanvas } from "../kit.js";

let resize: (() => void) | null = null;
let width = 1280;

beforeEach(() => {
  width = 1280;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {
        resize = null;
      }
    }
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Holds state across renders, so a remount shows as a reset count. */
function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <button data-counter={label} onClick={() => setCount((n) => n + 1)}>
      {count}
    </button>
  );
}

const canvasOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-tour-canvas]")!;

describe("TourCanvas", () => {
  it("scales the fixed canvas to the frame's width, and follows a resize", () => {
    const { container } = render(<TourCanvas>scene</TourCanvas>);
    const canvas = canvasOf(container);
    expect(canvas.style.width).toBe(`${TOUR_CANVAS.width}px`);
    expect(canvas.style.height).toBe(`${TOUR_CANVAS.height}px`);
    expect(canvas.style.scale).toBe("2");

    width = 320;
    act(() => resize?.());
    expect(canvas.style.scale).toBe("0.5");
  });

  it("draws the overlay outside the scaled canvas", () => {
    const { container } = render(
      <TourCanvas overlay={<span data-overlay="" />}>
        <span data-scene="" />
      </TourCanvas>
    );
    const overlay = container.querySelector("[data-overlay]")!;
    expect(canvasOf(container).contains(overlay)).toBe(false);
    expect(canvasOf(container).querySelector("[data-scene]")).not.toBeNull();
  });

  it("remounts the canvas, and only the canvas, when its key changes", () => {
    const stage = (key: string) => (
      <TourCanvas canvasKey={key} overlay={<Counter label="overlay" />}>
        <Counter label="scene" />
      </TourCanvas>
    );
    const { container, rerender } = render(stage("one"));
    const count = (label: string) =>
      container.querySelector<HTMLButtonElement>(`[data-counter="${label}"]`)!;
    act(() => count("scene").click());
    act(() => count("overlay").click());

    rerender(stage("two"));
    expect(count("scene").textContent).toBe("0");
    expect(count("overlay").textContent).toBe("1");
  });

  it("hands its frame to a ref", () => {
    let frame: HTMLDivElement | null = null;
    const { container } = render(
      <TourCanvas
        ref={(el) => {
          frame = el;
        }}
      />
    );
    expect(frame).toBe(container.firstElementChild);
  });
});

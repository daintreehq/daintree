// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { RefreshCw } from "lucide-react";
import { SpinningIcon } from "../SpinningIcon";
import { UI_SPIN_CYCLE_MS } from "@/lib/animationUtils";

/** The HTML wrapper that carries the rotation. */
function spinnerOf(container: HTMLElement): HTMLSpanElement {
  const wrapper = container.firstElementChild;
  if (!(wrapper instanceof HTMLSpanElement)) throw new Error("no wrapper rendered");
  return wrapper;
}

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("no svg rendered");
  return svg;
}

function isSpinning(container: HTMLElement): boolean {
  return spinnerOf(container).classList.contains("animate-spin");
}

/** jsdom never runs CSS animations, so the real `animationiteration` never
 *  fires. Dispatch it manually at the rotation boundary the component waits on. */
function fireIteration(target: Element): void {
  act(() => {
    target.dispatchEvent(new Event("animationiteration", { bubbles: true }));
  });
}

describe("SpinningIcon", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not spin when inactive", () => {
    const { container } = render(<SpinningIcon icon={RefreshCw} active={false} />);
    expect(isSpinning(container)).toBe(false);
  });

  it("spins from the first render when mounted active", () => {
    const { container } = render(<SpinningIcon icon={RefreshCw} active={true} />);
    expect(isSpinning(container)).toBe(true);
  });

  it("starts spinning immediately on the rising edge", () => {
    const { container, rerender } = render(<SpinningIcon icon={RefreshCw} active={false} />);
    expect(isSpinning(container)).toBe(false);
    rerender(<SpinningIcon icon={RefreshCw} active={true} />);
    expect(isSpinning(container)).toBe(true);
  });

  it("keeps spinning across rotation boundaries while active", () => {
    const { container } = render(<SpinningIcon icon={RefreshCw} active={true} />);
    const spinner = spinnerOf(container);
    fireIteration(spinner);
    fireIteration(spinner);
    expect(isSpinning(container)).toBe(true);
  });

  it("holds the spin past a fast completion until the next rotation boundary, then stops", () => {
    const { container, rerender } = render(<SpinningIcon icon={RefreshCw} active={true} />);
    const spinner = spinnerOf(container);
    // Operation resolves — but the current rotation must finish first.
    rerender(<SpinningIcon icon={RefreshCw} active={false} />);
    expect(isSpinning(container)).toBe(true);
    // The rotation completes: class is removed exactly at the 360° boundary.
    fireIteration(spinner);
    expect(isSpinning(container)).toBe(false);
  });

  it("guarantees a rotation even when the active window is a single commit", () => {
    // Models an instant refresh: active is observably true for exactly one
    // render before flipping false. The spin must still hold until a boundary.
    const { container, rerender } = render(<SpinningIcon icon={RefreshCw} active={false} />);
    rerender(<SpinningIcon icon={RefreshCw} active={true} />);
    rerender(<SpinningIcon icon={RefreshCw} active={false} />);
    expect(isSpinning(container)).toBe(true);
    fireIteration(spinnerOf(container));
    expect(isSpinning(container)).toBe(false);
  });

  it("only stops on the first boundary after the operation ends, not before", () => {
    const { container, rerender } = render(<SpinningIcon icon={RefreshCw} active={true} />);
    const spinner = spinnerOf(container);
    // Long operation: several boundaries pass while still active.
    fireIteration(spinner);
    fireIteration(spinner);
    expect(isSpinning(container)).toBe(true);
    rerender(<SpinningIcon icon={RefreshCw} active={false} />);
    // Still spinning until the next boundary.
    expect(isSpinning(container)).toBe(true);
    fireIteration(spinner);
    expect(isSpinning(container)).toBe(false);
  });

  it("clears the spin via the backstop timer when no iteration event fires", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<SpinningIcon icon={RefreshCw} active={true} />);
    rerender(<SpinningIcon icon={RefreshCw} active={false} />);
    expect(isSpinning(container)).toBe(true);
    // Reduced-motion / performance mode suppresses the CSS animation, so no
    // `animationiteration` ever fires — the backstop must release the spin.
    act(() => {
      vi.advanceTimersByTime(UI_SPIN_CYCLE_MS);
    });
    expect(isSpinning(container)).toBe(false);
  });

  it("does not stop early: the backstop has not fired before one full cycle", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<SpinningIcon icon={RefreshCw} active={true} />);
    rerender(<SpinningIcon icon={RefreshCw} active={false} />);
    act(() => {
      vi.advanceTimersByTime(UI_SPIN_CYCLE_MS - 1);
    });
    expect(isSpinning(container)).toBe(true);
  });

  it("cancels a pending stop when the operation restarts before completion", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<SpinningIcon icon={RefreshCw} active={true} />);
    const spinner = spinnerOf(container);
    rerender(<SpinningIcon icon={RefreshCw} active={false} />);
    // Re-activated during the finishing tail.
    rerender(<SpinningIcon icon={RefreshCw} active={true} />);
    // The stale stop request must not fire on the next boundary...
    fireIteration(spinner);
    expect(isSpinning(container)).toBe(true);
    // ...nor via the (now-cancelled) backstop timer.
    act(() => {
      vi.advanceTimersByTime(UI_SPIN_CYCLE_MS * 2);
    });
    expect(isSpinning(container)).toBe(true);
  });

  it("ignores an iteration bubbling from a descendant node", () => {
    const { container, rerender } = render(<SpinningIcon icon={RefreshCw} active={true} />);
    const spinner = spinnerOf(container);
    rerender(<SpinningIcon icon={RefreshCw} active={false} />);
    // A bubbling animationiteration whose target is the icon or one of its
    // paths, not the spinning wrapper, must not be mistaken for its boundary.
    fireIteration(svgOf(container));
    const path = svgOf(container).querySelector("path");
    expect(path).not.toBeNull();
    if (path) fireIteration(path);
    expect(isSpinning(container)).toBe(true);
    // The real boundary (target === wrapper) still stops it.
    fireIteration(spinner);
    expect(isSpinning(container)).toBe(false);
  });

  it("forwards Lucide props and className to the icon", () => {
    const { container } = render(
      <SpinningIcon icon={RefreshCw} active={true} className="w-3.5 h-3.5" size={14} />
    );
    const svg = svgOf(container);
    expect(svg.classList.contains("w-3.5")).toBe(true);
    expect(svg.classList.contains("h-3.5")).toBe(true);
    expect(svg.getAttribute("width")).toBe("14");
  });

  it("never animates the svg itself, which Chromium cannot composite", () => {
    const { container, rerender } = render(<SpinningIcon icon={RefreshCw} active={true} />);
    expect(isSpinning(container)).toBe(true);
    expect(svgOf(container).classList.contains("animate-spin")).toBe(false);
    rerender(<SpinningIcon icon={RefreshCw} active={false} />);
    expect(svgOf(container).classList.contains("animate-spin")).toBe(false);
  });

  it("puts placement classes on the rotating wrapper, not inside it", () => {
    const { container } = render(
      <SpinningIcon icon={RefreshCw} active={true} wrapperClassName="mr-1.5" />
    );
    expect(spinnerOf(container).classList.contains("mr-1.5")).toBe(true);
    expect(svgOf(container).classList.contains("mr-1.5")).toBe(false);
  });

  it("clears the backstop timer on unmount", () => {
    vi.useFakeTimers();
    const { rerender, unmount } = render(<SpinningIcon icon={RefreshCw} active={true} />);
    rerender(<SpinningIcon icon={RefreshCw} active={false} />);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    // No pending timer callback fires into an unmounted tree.
    act(() => {
      vi.advanceTimersByTime(UI_SPIN_CYCLE_MS * 2);
    });
  });

  it("collapses the backstop to 0ms under performance mode", () => {
    vi.useFakeTimers();
    document.body.dataset.performanceMode = "true";
    try {
      const { container, rerender } = render(<SpinningIcon icon={RefreshCw} active={true} />);
      rerender(<SpinningIcon icon={RefreshCw} active={false} />);
      // Perf mode suppresses the CSS animation (no iteration event) AND collapses
      // JS timers to 0 — so the spin releases on the next flush, not after a full
      // 1s cycle. Advancing 1ms (far short of UI_SPIN_CYCLE_MS) proves the floor.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(isSpinning(container)).toBe(false);
    } finally {
      delete document.body.dataset.performanceMode;
    }
  });

  it("ignores an animationiteration from a different animation on the same node", () => {
    if (typeof AnimationEvent === "undefined") return; // jsdom without AnimationEvent
    const { container, rerender } = render(<SpinningIcon icon={RefreshCw} active={true} />);
    const spinner = spinnerOf(container);
    rerender(<SpinningIcon icon={RefreshCw} active={false} />);
    // A second looping animation (not Tailwind's `spin`) reaching its own
    // boundary must not stop the refresh spin at an arbitrary phase.
    act(() => {
      spinner.dispatchEvent(
        new AnimationEvent("animationiteration", { animationName: "pulse", bubbles: true })
      );
    });
    expect(isSpinning(container)).toBe(true);
    // The real `spin` boundary still stops it.
    act(() => {
      spinner.dispatchEvent(
        new AnimationEvent("animationiteration", { animationName: "spin", bubbles: true })
      );
    });
    expect(isSpinning(container)).toBe(false);
  });
});

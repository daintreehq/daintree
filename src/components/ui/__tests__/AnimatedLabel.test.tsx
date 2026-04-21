/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { AnimatedLabel } from "../AnimatedLabel";

describe("AnimatedLabel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the current label", () => {
    const { container } = render(<AnimatedLabel label="Copy" />);
    expect(container.textContent).toBe("Copy");
  });

  it("does not animate on mount", () => {
    const { container } = render(<AnimatedLabel label="3" />);
    const animating = container.querySelector(".animate-label-swap-in, .animate-label-swap-out");
    expect(animating).toBeNull();
  });

  it("swaps in/out classes when the label changes", () => {
    const { container, rerender } = render(<AnimatedLabel label="Copy" />);
    rerender(<AnimatedLabel label="Copied" />);

    const incoming = container.querySelector(".animate-label-swap-in");
    const outgoing = container.querySelector(".animate-label-swap-out");
    expect(incoming).not.toBeNull();
    expect(outgoing).not.toBeNull();
    expect(incoming?.textContent).toBe("Copied");
    expect(outgoing?.textContent).toBe("Copy");
  });

  it("marks the outgoing span aria-hidden", () => {
    const { container, rerender } = render(<AnimatedLabel label="1" />);
    rerender(<AnimatedLabel label="2" />);

    const outgoing = container.querySelector(".animate-label-swap-out");
    expect(outgoing?.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not animate on rerender with the same label", () => {
    const { container, rerender } = render(<AnimatedLabel label="42" />);
    rerender(<AnimatedLabel label="42" />);

    const animating = container.querySelector(".animate-label-swap-in, .animate-label-swap-out");
    expect(animating).toBeNull();
  });

  it("animates when animateKey changes even if label stays the same", () => {
    const { container, rerender } = render(<AnimatedLabel label="3" animateKey="a" />);
    rerender(<AnimatedLabel label="3" animateKey="b" />);

    const animating = container.querySelector(".animate-label-swap-in");
    expect(animating).not.toBeNull();
  });

  it("clears animation classes after the safety timeout", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<AnimatedLabel label="Copy" />);
      rerender(<AnimatedLabel label="Copied" />);
      expect(container.querySelector(".animate-label-swap-in")).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(260);
      });

      expect(container.querySelector(".animate-label-swap-in")).toBeNull();
      expect(container.querySelector(".animate-label-swap-out")).toBeNull();
      expect(container.textContent).toBe("Copied");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-animates on each subsequent label change", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<AnimatedLabel label="1" />);
      rerender(<AnimatedLabel label="2" />);
      expect(container.querySelector(".animate-label-swap-in")?.textContent).toBe("2");

      act(() => {
        vi.advanceTimersByTime(260);
      });

      rerender(<AnimatedLabel label="3" />);
      expect(container.querySelector(".animate-label-swap-in")?.textContent).toBe("3");
      expect(container.querySelector(".animate-label-swap-out")?.textContent).toBe("2");
    } finally {
      vi.useRealTimers();
    }
  });
});

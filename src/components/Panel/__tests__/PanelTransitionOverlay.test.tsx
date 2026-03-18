// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { PanelTransitionOverlay, triggerPanelTransition } from "../PanelTransitionOverlay";
import type { TransitionRect } from "../PanelTransitionOverlay";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

const sourceRect: TransitionRect = { x: 100, y: 100, width: 400, height: 300 };
const targetRect: TransitionRect = { x: 50, y: 500, width: 80, height: 40 };

describe("PanelTransitionOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false }),
    );
    document.body.removeAttribute("data-performance-mode");

    vi.spyOn(performance, "now").mockReturnValue(1000);

    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applies minimize duration and easing to ghost element", () => {
    const onComplete = vi.fn();
    const { container } = render(
      <PanelTransitionOverlay onTransitionComplete={onComplete} />,
    );

    act(() => {
      triggerPanelTransition("panel-1", "minimize", sourceRect, targetRect);
    });

    const ghost = container.querySelector("[class*='absolute']") as HTMLElement;
    expect(ghost).not.toBeNull();
    expect(ghost.style.transitionDuration).toBe("120ms");
    expect(ghost.style.transitionTimingFunction).toBe(
      "cubic-bezier(0.3, 0, 0.8, 0.15)",
    );
  });

  it("applies restore duration and easing to ghost element", () => {
    const onComplete = vi.fn();
    const { container } = render(
      <PanelTransitionOverlay onTransitionComplete={onComplete} />,
    );

    act(() => {
      triggerPanelTransition("panel-1", "restore", sourceRect, targetRect);
    });

    const ghost = container.querySelector("[class*='absolute']") as HTMLElement;
    expect(ghost).not.toBeNull();
    expect(ghost.style.transitionDuration).toBe("200ms");
    expect(ghost.style.transitionTimingFunction).toBe(
      "cubic-bezier(0.16, 1, 0.3, 1)",
    );
  });

  it("calls onTransitionComplete after minimize duration (120ms)", () => {
    const onComplete = vi.fn();
    render(<PanelTransitionOverlay onTransitionComplete={onComplete} />);

    act(() => {
      triggerPanelTransition("panel-1", "minimize", sourceRect, targetRect);
    });

    expect(onComplete).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(onComplete).toHaveBeenCalledWith("panel-1");
  });

  it("calls onTransitionComplete after restore duration (200ms)", () => {
    const onComplete = vi.fn();
    render(<PanelTransitionOverlay onTransitionComplete={onComplete} />);

    act(() => {
      triggerPanelTransition("panel-1", "restore", sourceRect, targetRect);
    });

    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(onComplete).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(onComplete).toHaveBeenCalledWith("panel-1");
  });
});

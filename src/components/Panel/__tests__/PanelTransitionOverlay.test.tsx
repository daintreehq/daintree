// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { PanelTransitionOverlay, triggerPanelTransition } from "../PanelTransitionOverlay";
import type { TransitionDirection, TransitionRect } from "../PanelTransitionOverlay";
import {
  getPanelTransitionDuration,
  PANEL_MINIMIZE_EASING,
  PANEL_RESTORE_EASING,
} from "@/lib/animationUtils";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

const sourceRect: TransitionRect = { x: 100, y: 100, width: 400, height: 300 };
const targetRect: TransitionRect = { x: 50, y: 500, width: 80, height: 40 };

interface FakeAnimation {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  finish: () => void;
  cancel: ReturnType<typeof vi.fn>;
  finished: Promise<void>;
}

let animations: FakeAnimation[];
let frames: FrameRequestCallback[];

function runFrames(count: number) {
  for (let i = 0; i < count; i++) {
    const pending = frames;
    frames = [];
    act(() => pending.forEach((cb) => cb(0)));
  }
}

function ghost(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-panel-transition-ghost]");
}

function px(value: number) {
  return `${value}px`;
}

function box(rect: TransitionRect) {
  return { left: px(rect.x), top: px(rect.y), width: px(rect.width), height: px(rect.height) };
}

function fire(
  direction: TransitionDirection,
  target: TransitionRect | (() => TransitionRect | null)
) {
  act(() => {
    triggerPanelTransition("panel-1", direction, sourceRect, target, "Codex");
  });
}

describe("PanelTransitionOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    animations = [];
    frames = [];
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    document.body.removeAttribute("data-reduce-animations");
    document.body.removeAttribute("data-performance-mode");
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value(keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: unknown) {
        let finish!: () => void;
        let fail!: (reason: unknown) => void;
        const finished = new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
        finished.catch(() => undefined);
        const animation: FakeAnimation = {
          keyframes: Array.isArray(keyframes) ? keyframes : [],
          options: typeof options === "object" && options !== null ? options : {},
          finish,
          cancel: vi.fn(() => fail(new DOMException("cancelled", "AbortError"))),
          finished,
        };
        animations.push(animation);
        return animation;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  it.each([
    ["data-reduce-animations", () => document.body.setAttribute("data-reduce-animations", "true")],
    ["data-performance-mode", () => document.body.setAttribute("data-performance-mode", "true")],
    [
      "prefers-reduced-motion",
      () => vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true })),
    ],
  ])("renders no ghost when %s is on", (_name, enable) => {
    enable();
    const { container } = render(<PanelTransitionOverlay />);
    fire("minimize", targetRect);
    expect(ghost(container)).toBeNull();
    expect(animations).toHaveLength(0);
  });

  it("parks the ghost on the source box, invisible, before it is armed", () => {
    const { container } = render(<PanelTransitionOverlay />);
    fire("minimize", () => null);
    const el = ghost(container)!;
    expect(el).not.toBeNull();
    expect({
      left: el.style.left,
      top: el.style.top,
      width: el.style.width,
      height: el.style.height,
    }).toEqual(box(sourceRect));
    expect(el.style.opacity).toBe("0");
  });

  it.each(["minimize", "restore"] as const)(
    "%s flies from the source box to the resolved target box on the direction's tier",
    (direction) => {
      render(<PanelTransitionOverlay />);
      fire(direction, targetRect);
      expect(animations).toHaveLength(1);
      const [anim] = animations;
      const first = anim!.keyframes[0]!;
      const last = anim!.keyframes[anim!.keyframes.length - 1]!;
      expect({
        left: first.left,
        top: first.top,
        width: first.width,
        height: first.height,
      }).toEqual(box(sourceRect));
      expect({ left: last.left, top: last.top, width: last.width, height: last.height }).toEqual(
        box(targetRect)
      );
      expect(anim!.options.duration).toBe(getPanelTransitionDuration(direction));
      expect(anim!.options.easing).toBe(
        direction === "minimize" ? PANEL_MINIMIZE_EASING : PANEL_RESTORE_EASING
      );
    }
  );

  it("keeps a minimizing ghost solid until it is most of the way there, and dissolves on arrival", () => {
    render(<PanelTransitionOverlay />);
    fire("minimize", targetRect);
    const stops = animations[0]!.keyframes.map((k) => ({
      offset: Number(k.offset),
      opacity: Number(k.opacity),
    }));
    expect(stops[0]!.opacity).toBe(1);
    expect(stops[stops.length - 1]!.opacity).toBe(0);
    for (const stop of stops) {
      if (stop.offset < 0.5) expect(stop.opacity).toBe(1);
    }
  });

  it("aims at a target that only exists after the move commits", () => {
    const { container } = render(<PanelTransitionOverlay />);
    let committed = false;
    fire("minimize", () => (committed ? targetRect : null));
    expect(animations).toHaveLength(0);
    committed = true;
    runFrames(1);
    expect(animations).toHaveLength(1);
    expect(ghost(container)).not.toBeNull();
  });

  it("drops a flight whose target never appears, without reporting it as complete", () => {
    const onComplete = vi.fn();
    const { container } = render(<PanelTransitionOverlay onTransitionComplete={onComplete} />);
    fire("minimize", () => null);
    runFrames(10);
    expect(animations).toHaveLength(0);
    expect(ghost(container)).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("stays on screen for the whole flight and completes from the animation itself", async () => {
    const onComplete = vi.fn();
    const { container } = render(<PanelTransitionOverlay onTransitionComplete={onComplete} />);
    fire("minimize", targetRect);
    act(() => {
      vi.advanceTimersByTime(getPanelTransitionDuration("minimize"));
    });
    expect(ghost(container)).not.toBeNull();
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      animations[0]!.finish();
      await animations[0]!.finished;
    });
    expect(ghost(container)).toBeNull();
    expect(onComplete).toHaveBeenCalledWith("panel-1");
  });

  it("does not strand the ghost when the animation never reports finishing", () => {
    const { container } = render(<PanelTransitionOverlay />);
    fire("restore", targetRect);
    act(() => {
      vi.advanceTimersByTime(getPanelTransitionDuration("restore") * 2);
    });
    expect(ghost(container)).toBeNull();
  });

  it("replaces an in-flight ghost for the same pane rather than stacking a second", () => {
    const { container } = render(<PanelTransitionOverlay />);
    fire("minimize", targetRect);
    fire("restore", targetRect);
    expect(animations[0]!.cancel).toHaveBeenCalled();
    expect(container.querySelectorAll("[data-panel-transition-ghost]")).toHaveLength(1);
    expect(ghost(container)!.getAttribute("data-panel-transition-ghost")).toBe("restore");
  });

  it("lets flights for different panes run side by side", () => {
    const { container } = render(<PanelTransitionOverlay />);
    act(() => {
      triggerPanelTransition("a", "minimize", sourceRect, targetRect);
      triggerPanelTransition("b", "minimize", sourceRect, targetRect);
    });
    expect(container.querySelectorAll("[data-panel-transition-ghost]")).toHaveLength(2);
    expect(animations.every((a) => a.cancel.mock.calls.length === 0)).toBe(true);
  });

  it("keeps a flight running when the parent re-renders with a new completion callback", () => {
    const { rerender } = render(<PanelTransitionOverlay onTransitionComplete={() => {}} />);
    fire("minimize", targetRect);
    rerender(<PanelTransitionOverlay onTransitionComplete={() => {}} />);
    expect(animations).toHaveLength(1);
    expect(animations[0]!.cancel).not.toHaveBeenCalled();
  });
});

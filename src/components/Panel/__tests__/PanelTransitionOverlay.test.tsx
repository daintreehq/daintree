// @vitest-environment jsdom
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { PanelTransitionOverlay, triggerPanelTransition } from "../PanelTransitionOverlay";
import type {
  TransitionDirection,
  TransitionRect,
  TransitionTarget,
} from "../PanelTransitionOverlay";
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

class FakeEffect {
  constructor(public keyframes: Keyframe[]) {}
  setKeyframes(keyframes: Keyframe[]) {
    this.keyframes = keyframes;
  }
}

interface FakeAnimation {
  target: Element;
  effect: FakeEffect;
  options: KeyframeAnimationOptions;
  id: string;
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

function isGeometry(a: FakeAnimation): boolean {
  return a.effect.keyframes.some((k) => k.left !== undefined);
}

/** The animation that moves the ghost's box (the one keyed on `left`). */
function geometry(): FakeAnimation {
  return animations.find(isGeometry)!;
}

function opacityTrack(target: Element): Array<{ offset: number; opacity: number }> {
  const track = animations.find(
    (a) => a.target === target && a.effect.keyframes.some((k) => k.opacity !== undefined)
  )!;
  return track.effect.keyframes.map((k) => ({
    offset: Number(k.offset),
    opacity: Number(k.opacity),
  }));
}

function px(value: number) {
  return `${value}px`;
}

function box(rect: TransitionRect) {
  return { left: px(rect.x), top: px(rect.y), width: px(rect.width), height: px(rect.height) };
}

function boxOf(keyframe: Keyframe) {
  return {
    left: keyframe.left,
    top: keyframe.top,
    width: keyframe.width,
    height: keyframe.height,
  };
}

function fire(direction: TransitionDirection, target: TransitionTarget) {
  act(() => {
    triggerPanelTransition("panel-1", direction, sourceRect, target, "Codex");
  });
}

function elementAt(rect: TransitionRect): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "getBoundingClientRect", { value: () => ({ ...rect }) });
  document.body.appendChild(el);
  return el;
}

describe("PanelTransitionOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    animations = [];
    frames = [];
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    vi.stubGlobal("KeyframeEffect", FakeEffect);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    document.body.removeAttribute("data-reduce-animations");
    document.body.removeAttribute("data-performance-mode");
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value(
        this: Element,
        keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
        options?: unknown
      ) {
        let finish!: () => void;
        let fail!: (reason: unknown) => void;
        const finished = new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
        finished.catch(() => undefined);
        const animation: FakeAnimation = {
          target: this,
          effect: new FakeEffect(Array.isArray(keyframes) ? keyframes : []),
          options: typeof options === "object" && options !== null ? options : {},
          id: "",
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
    Reflect.deleteProperty(Element.prototype, "animate");
    document.body.innerHTML = "";
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
      const keyframes = geometry().effect.keyframes;
      expect(boxOf(keyframes[0]!)).toEqual(box(sourceRect));
      expect(boxOf(keyframes[keyframes.length - 1]!)).toEqual(box(targetRect));
      expect(geometry().options.duration).toBe(getPanelTransitionDuration(direction));
      expect(geometry().options.easing).toBe(
        direction === "minimize" ? PANEL_MINIMIZE_EASING : PANEL_RESTORE_EASING
      );
    }
  );

  it("times every fade on the clock, never on the geometry's steep easing", () => {
    render(<PanelTransitionOverlay />);
    fire("restore", targetRect);
    const fades = animations.filter((a) => a.effect.keyframes.some((k) => k.opacity !== undefined));
    expect(fades.length).toBeGreaterThan(0);
    for (const fade of fades) expect(fade.options.easing).toBe("linear");
  });

  it("keeps a minimizing ghost solid for most of the flight, and dissolves on arrival", () => {
    const { container } = render(<PanelTransitionOverlay />);
    fire("minimize", targetRect);
    const stops = opacityTrack(ghost(container)!);
    expect(stops[0]!.opacity).toBe(1);
    expect(stops[stops.length - 1]!.opacity).toBe(0);
    for (const stop of stops) if (stop.offset < 0.75) expect(stop.opacity).toBe(1);
  });

  it("sheds a restoring ghost's title before its container starts to fade", () => {
    const { container } = render(<PanelTransitionOverlay />);
    fire("restore", targetRect);
    const el = ghost(container)!;
    const titleStops = opacityTrack(el.firstElementChild!);
    const containerStops = opacityTrack(el);
    const titleGone = titleStops.find((s) => s.opacity === 0)!.offset;
    const containerFading = containerStops.filter((s) => s.opacity === 1).at(-1)!.offset;
    expect(containerStops[0]!.opacity).toBe(1);
    expect(titleGone).toBeLessThanOrEqual(containerFading);
  });

  it("aims at a target that only exists after the move commits", () => {
    const { container } = render(<PanelTransitionOverlay />);
    let committed = false;
    fire("minimize", () => (committed ? targetRect : null));
    expect(animations).toHaveLength(0);
    committed = true;
    runFrames(1);
    expect(geometry()).toBeDefined();
    expect(ghost(container)).not.toBeNull();
  });

  it("drops a flight whose target never appears, without reporting it as complete", () => {
    const onComplete = vi.fn();
    const { container } = render(<PanelTransitionOverlay onTransitionComplete={onComplete} />);
    fire("minimize", () => null);
    runFrames(20);
    expect(animations).toHaveLength(0);
    expect(ghost(container)).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("follows a destination that moves mid-flight without restarting the clock", () => {
    render(<PanelTransitionOverlay />);
    let current = targetRect;
    fire("minimize", () => current);
    const flight = geometry();
    current = { ...targetRect, x: targetRect.x + 240 };
    runFrames(1);
    const keyframes = flight.effect.keyframes;
    expect(boxOf(keyframes[0]!)).toEqual(box(sourceRect));
    expect(boxOf(keyframes[keyframes.length - 1]!)).toEqual(box(current));
    expect(animations.filter(isGeometry)).toHaveLength(1);
  });

  it("calls a flight off when its destination disappears mid-flight", async () => {
    const onComplete = vi.fn();
    const { container } = render(<PanelTransitionOverlay onTransitionComplete={onComplete} />);
    let present = true;
    fire("minimize", () => (present ? targetRect : null));
    present = false;
    runFrames(1);
    await act(async () => {
      await geometry().finished.catch(() => undefined);
    });
    expect(geometry().cancel).toHaveBeenCalled();
    expect(ghost(container)).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("marks the chip that receives a minimized pane, adding to its own shadow", () => {
    render(<PanelTransitionOverlay />);
    const chip = elementAt(targetRect);
    fire("minimize", () => chip);
    const cue = animations.find((a) => a.target === chip);
    expect(cue).toBeDefined();
    expect(cue!.options.composite).toBe("add");
    const shadows = cue!.effect.keyframes.map((k) => String(k.boxShadow));
    expect(shadows[0]).toContain("transparent");
    expect(shadows[shadows.length - 1]).toContain("transparent");
    expect(shadows.some((s) => !s.includes("transparent"))).toBe(true);
  });

  it("does not mark the grid pane a restore lands on", () => {
    render(<PanelTransitionOverlay />);
    const pane = elementAt(targetRect);
    fire("restore", () => pane);
    expect(animations.some((a) => a.target === pane)).toBe(false);
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
      geometry().finish();
      await geometry().finished;
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

  it("survives its effect being torn down and re-run, as StrictMode does on mount", async () => {
    const onComplete = vi.fn();
    const { container } = render(
      <StrictMode>
        <PanelTransitionOverlay onTransitionComplete={onComplete} />
      </StrictMode>
    );
    fire("minimize", targetRect);
    await act(async () => {
      await Promise.allSettled(
        animations.filter((a) => a.cancel.mock.calls.length > 0).map((a) => a.finished)
      );
    });
    expect(animations.some((a) => a.cancel.mock.calls.length > 0)).toBe(true);
    expect(ghost(container)).not.toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("replaces an in-flight ghost for the same pane rather than stacking a second", () => {
    const { container } = render(<PanelTransitionOverlay />);
    fire("minimize", targetRect);
    const first = geometry();
    fire("restore", targetRect);
    expect(first.cancel).toHaveBeenCalled();
    expect(container.querySelectorAll("[data-panel-transition-ghost]")).toHaveLength(1);
    expect(ghost(container)!.getAttribute("data-panel-transition-ghost")).toBe("restore");
  });

  it("replaces an in-flight ghost that shares an identity, whichever pane asked", () => {
    const { container } = render(<PanelTransitionOverlay />);
    act(() => {
      triggerPanelTransition("a", "minimize", sourceRect, targetRect, "", "group:g");
      triggerPanelTransition("b", "restore", sourceRect, targetRect, "", "group:g");
    });
    expect(container.querySelectorAll("[data-panel-transition-ghost]")).toHaveLength(1);
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
    expect(animations.every((a) => a.cancel.mock.calls.length === 0)).toBe(true);
  });
});

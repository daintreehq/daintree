// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PANEL_MINIMIZE_DURATION } from "@/lib/animationUtils";
import { RELEASING_CLASS, useHeightHold } from "../useHeightHold";

/** Past the release transition's fallback timer. */
const PAST_SETTLE_MS = PANEL_MINIMIZE_DURATION + 200;

function rectOfHeight(height: number): DOMRect {
  return {
    height,
    width: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

/** jsdom lays nothing out, so the test supplies the measured height. */
function measuring(node: HTMLElement, height: number): void {
  node.getBoundingClientRect = vi.fn<() => DOMRect>(() => rectOfHeight(height));
}

function mountBody(height: number): HTMLDivElement {
  const node = document.createElement("div");
  measuring(node, height);
  document.body.appendChild(node);
  return node;
}

function setup(height: number) {
  const node = mountBody(height);
  const hook = renderHook(() => useHeightHold());
  hook.result.current.bodyRef.current = node;
  return { node, hook };
}

/** Steps exactly one animation frame, rather than guessing a frame cadence. */
function nextFrame(): void {
  act(() => void vi.advanceTimersToNextFrame());
}

/** Arms a pin and drives it all the way into its settle transition. */
function holdAndRelease(height = 500) {
  const context = setup(height);
  act(() => context.hook.result.current.hold());
  act(() => context.hook.result.current.handleRendered());
  nextFrame();
  nextFrame();
  return context;
}

function transitionEnd(target: EventTarget, propertyName: string): void {
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  act(() => void target.dispatchEvent(event));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useHeightHold", () => {
  describe("pinning", () => {
    it("pins the measured height, rounding up so no sub-pixel shrink slips through", () => {
      const { node, hook } = setup(421.4);

      act(() => hook.result.current.hold());

      expect(node.style.minHeight).toBe("422px");
    });

    it("applies the pin without the release transition, so it lands in the swap's own frame", () => {
      const { node, hook } = setup(500);

      act(() => hook.result.current.hold());

      expect(node.classList.contains(RELEASING_CLASS)).toBe(false);
    });

    it("does not pin a box that has no laid-out height", () => {
      const { node, hook } = setup(0);

      act(() => hook.result.current.hold());

      expect(node.style.minHeight).toBe("");
    });

    it("survives with no node to measure", () => {
      const hook = renderHook(() => useHeightHold());

      act(() => hook.result.current.hold());
      act(() => hook.result.current.handleRendered());
      act(() => hook.result.current.cancel());

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("release", () => {
    it("keeps the pin until the rendered document has both laid out and painted", () => {
      const { node, hook } = setup(500);

      act(() => hook.result.current.hold());
      act(() => hook.result.current.handleRendered());
      expect(node.style.minHeight).toBe("500px");

      // One frame is layout only; releasing here hands the dialog a pre-layout
      // height, which is the jump this exists to prevent.
      nextFrame();
      expect(node.style.minHeight).toBe("500px");

      nextFrame();
      expect(node.style.minHeight).toBe("");
    });

    it("animates the settle so a shorter document doesn't snap", () => {
      const { node } = holdAndRelease();

      expect(node.classList.contains(RELEASING_CLASS)).toBe(true);
    });

    it("drops the release transition once it has settled", () => {
      const { node } = holdAndRelease();
      expect(node.classList.contains(RELEASING_CLASS)).toBe(true);

      act(() => void vi.advanceTimersByTime(PAST_SETTLE_MS));

      expect(node.classList.contains(RELEASING_CLASS)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("finishes early when the settle transition reports completion", () => {
      const { node } = holdAndRelease();

      transitionEnd(node, "min-height");

      expect(node.classList.contains(RELEASING_CLASS)).toBe(false);
      // The fallback timer is disarmed by the event, not left to fire later.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores a transition that finished on a descendant", () => {
      const { node } = holdAndRelease();
      const child = document.createElement("div");
      node.appendChild(child);

      // transitionend bubbles, so an inner animation must not end the settle.
      transitionEnd(child, "min-height");

      expect(node.classList.contains(RELEASING_CLASS)).toBe(true);
    });

    it("ignores a transition on some other property", () => {
      const { node } = holdAndRelease();

      transitionEnd(node, "opacity");

      expect(node.classList.contains(RELEASING_CLASS)).toBe(true);
    });

    it("holds indefinitely when the rendered signal never arrives", () => {
      const { node, hook } = setup(500);

      act(() => hook.result.current.hold());
      act(() => void vi.advanceTimersByTime(60_000));

      // A deadline here would drop the pin mid-load and collapse the dialog to
      // the skeleton — the original bug, merely delayed.
      expect(node.style.minHeight).toBe("500px");
    });

    it("queues one release for a document that reports more than once", () => {
      const { node, hook } = setup(500);

      act(() => hook.result.current.hold());
      // StrictMode double-invokes the reporting effect.
      act(() => hook.result.current.handleRendered());
      act(() => hook.result.current.handleRendered());
      nextFrame();
      nextFrame();

      expect(node.style.minHeight).toBe("");
      // A second release lifecycle would arm a second settle timer.
      expect(vi.getTimerCount()).toBe(1);
    });

    it("ignores a rendered signal that arrives with no pin in flight", () => {
      const { node, hook } = setup(500);

      act(() => hook.result.current.handleRendered());
      nextFrame();
      nextFrame();

      expect(node.classList.contains(RELEASING_CLASS)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("cancellation", () => {
    it("cancels straight to the content height, with no settle transition", () => {
      const { node, hook } = setup(500);

      act(() => hook.result.current.hold());
      act(() => hook.result.current.cancel());

      expect(node.style.minHeight).toBe("");
      // Reverting to source, which supplies its own height immediately — an
      // animated climb-down would lag behind the content.
      expect(node.classList.contains(RELEASING_CLASS)).toBe(false);
    });

    it("cancels a pin that is already mid-settle", () => {
      const { node, hook } = holdAndRelease();
      expect(node.classList.contains(RELEASING_CLASS)).toBe(true);

      act(() => hook.result.current.cancel());

      // `release` clears `active` before the transition starts, so a cancel
      // keyed on `active` would strand the class and its timer here.
      expect(node.classList.contains(RELEASING_CLASS)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not let a superseded release drop a newer pin", () => {
      const { node, hook } = setup(500);

      act(() => hook.result.current.hold());
      act(() => hook.result.current.handleRendered());
      nextFrame();

      // A second toggle lands between the two confirmation frames.
      measuring(node, 800);
      act(() => hook.result.current.hold());
      nextFrame();
      nextFrame();

      expect(node.style.minHeight).toBe("800px");
    });

    it("re-pins cleanly over a settle that is still running", () => {
      const { node, hook } = holdAndRelease(500);

      measuring(node, 800);
      act(() => hook.result.current.hold());

      expect(node.style.minHeight).toBe("800px");
      expect(node.classList.contains(RELEASING_CLASS)).toBe(false);

      // The superseded settle must not reach back and clear the new pin.
      transitionEnd(node, "min-height");
      act(() => void vi.advanceTimersByTime(PAST_SETTLE_MS));
      expect(node.style.minHeight).toBe("800px");
    });

    it("takes its listener off the node it attached to, not whichever is current", () => {
      const { node: first, hook } = holdAndRelease(500);
      const second = mountBody(800);

      // Swapping the ref mid-settle must not strand the first node's listener.
      hook.result.current.bodyRef.current = second;
      act(() => hook.result.current.hold());

      transitionEnd(first, "min-height");

      expect(second.style.minHeight).toBe("800px");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops a pending release from firing after unmount", () => {
      const { node, hook } = setup(500);

      act(() => hook.result.current.hold());
      act(() => hook.result.current.handleRendered());
      hook.unmount();
      act(() => void vi.advanceTimersByTime(PAST_SETTLE_MS));

      expect(node.style.minHeight).toBe("500px");
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

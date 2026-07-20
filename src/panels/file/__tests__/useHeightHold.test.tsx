// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PANEL_MINIMIZE_DURATION } from "@/lib/animationUtils";
import { RELEASING_CLASS, useHeightHold } from "../useHeightHold";

/** Two animation frames plus slack — enough for the release to be queued. */
const TWO_FRAMES_MS = 40;
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

/** A real, attached node whose measured height the test controls. */
function mountBody(height: number): HTMLDivElement {
  const node = document.createElement("div");
  node.getBoundingClientRect = vi.fn<() => DOMRect>(() => rectOfHeight(height));
  document.body.appendChild(node);
  return node;
}

function setup(height: number) {
  const node = mountBody(height);
  const hook = renderHook(() => useHeightHold());
  hook.result.current.bodyRef.current = node;
  return { node, hook };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useHeightHold", () => {
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

  it("keeps the pin while the rendered document is still laying out", () => {
    const { node, hook } = setup(500);

    act(() => hook.result.current.hold());
    act(() => hook.result.current.handleRendered());

    // Queued, not yet run: releasing in the commit's own frame would hand the
    // dialog a pre-layout height.
    expect(node.style.minHeight).toBe("500px");
  });

  it("releases once the rendered document has laid out and painted", () => {
    const { node, hook } = setup(500);

    act(() => hook.result.current.hold());
    act(() => hook.result.current.handleRendered());
    act(() => void vi.advanceTimersByTime(TWO_FRAMES_MS));

    expect(node.style.minHeight).toBe("");
    expect(node.classList.contains(RELEASING_CLASS)).toBe(true);
  });

  it("drops the release transition once it has settled", () => {
    const { node, hook } = setup(500);

    act(() => hook.result.current.hold());
    act(() => hook.result.current.handleRendered());
    act(() => void vi.advanceTimersByTime(TWO_FRAMES_MS));
    act(() => void vi.advanceTimersByTime(PAST_SETTLE_MS));

    expect(node.classList.contains(RELEASING_CLASS)).toBe(false);
  });

  it("releases a pin that never gets a rendered signal", () => {
    const { node, hook } = setup(500);

    act(() => hook.result.current.hold());
    expect(node.style.minHeight).toBe("500px");

    // A chunk that never resolves must not pin the dialog for the session.
    act(() => void vi.advanceTimersByTime(10_000));

    expect(node.style.minHeight).toBe("");
  });

  it("cancels straight to the content height, with no settle transition", () => {
    const { node, hook } = setup(500);

    act(() => hook.result.current.hold());
    act(() => hook.result.current.cancel());

    expect(node.style.minHeight).toBe("");
    // Reverting to source, which supplies its own height immediately — an
    // animated climb-down would lag behind the content.
    expect(node.classList.contains(RELEASING_CLASS)).toBe(false);
  });

  it("does not let a superseded release drop a newer pin", () => {
    const node = mountBody(500);
    const hook = renderHook(() => useHeightHold());
    hook.result.current.bodyRef.current = node;

    act(() => hook.result.current.hold());
    act(() => hook.result.current.handleRendered());

    // A second toggle lands between the two confirmation frames.
    node.getBoundingClientRect = vi.fn<() => DOMRect>(() => rectOfHeight(800));
    act(() => hook.result.current.hold());
    act(() => void vi.advanceTimersByTime(TWO_FRAMES_MS));

    expect(node.style.minHeight).toBe("800px");
  });

  it("stops a pending release from firing after unmount", () => {
    const { node, hook } = setup(500);

    act(() => hook.result.current.hold());
    hook.unmount();

    // The cap timer must not survive the panel that armed it.
    expect(() => act(() => void vi.advanceTimersByTime(10_000))).not.toThrow();
    expect(node.style.minHeight).toBe("500px");
  });
});

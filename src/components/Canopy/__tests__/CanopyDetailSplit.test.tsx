// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanopyStore } from "@/store/canopyStore";
import { CanopyDetailSplit } from "../CanopyDetailSplit";
import { CANOPY_DOCK_MIN_WIDTH, CANOPY_DOCK_SIDE_BY_SIDE_MIN } from "../canopyDockWidth";

/** Every observer the split made, so a test can say the window resized. */
const observers: Array<() => void> = [];
class ResizeObserverStub {
  private readonly notify: () => void;
  constructor(callback: ResizeObserverCallback) {
    this.notify = () => callback([], this);
    observers.push(this.notify);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    const at = observers.indexOf(this.notify);
    if (at >= 0) observers.splice(at, 1);
  }
}
const originalResizeObserver = globalThis.ResizeObserver;
beforeAll(() => {
  globalThis.ResizeObserver = ResizeObserverStub;
});
afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
});

function resized() {
  act(() => {
    for (const callback of [...observers]) callback();
  });
}

/** How many times each pane mounted: a remount reopens its terminal's stream. */
const mounts = { agent: 0, assistant: 0 };
function Pane({ name }: { name: "agent" | "assistant" }) {
  useEffect(() => {
    mounts[name] += 1;
  }, [name]);
  return <div data-testid={name} />;
}

/** The widths the layout measures: the split's own, and the docked pane's. */
let widths = { split: 1200, dock: 480 };

beforeEach(() => {
  widths = { split: 1200, dock: 480 };
  mounts.agent = 0;
  mounts.assistant = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    const width = this.hasAttribute("data-canopy-global")
      ? widths.dock
      : this.hasAttribute("data-canopy-detail-split")
        ? widths.split
        : 0;
    return {
      x: 0,
      y: 0,
      width,
      height: 600,
      top: 0,
      left: 0,
      right: width,
      bottom: 600,
      toJSON: () => ({}),
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useCanopyStore.setState({ dockWidth: null, dockDrag: null });
  window.localStorage.removeItem("daintree-canopy-dock-width");
});

const split = () => document.querySelector<HTMLElement>("[data-canopy-detail-split]");
const edge = () => document.querySelector<HTMLElement>("[data-testid=canopy-dock-resize]");

function renderPair() {
  return render(
    <CanopyDetailSplit dock={<Pane name="assistant" />}>
      <Pane name="agent" />
    </CanopyDetailSplit>
  );
}

describe("CanopyDetailSplit (#16214)", () => {
  it("sits the agent and the assistant side by side, the assistant's edge between them", () => {
    renderPair();
    expect(split()!.getAttribute("data-canopy-detail-split")).toBe("side-by-side");
    const order = [...split()!.children].map(
      (child) =>
        child.getAttribute("data-testid") ?? child.firstElementChild?.getAttribute("data-testid")
    );
    expect(order).toEqual(["agent", "canopy-dock-resize", "assistant"]);
  });

  it("stacks them, with no edge to drag, where there isn't room for both", () => {
    widths.split = CANOPY_DOCK_SIDE_BY_SIDE_MIN - 1;
    renderPair();
    expect(split()!.getAttribute("data-canopy-detail-split")).toBe("stacked");
    expect(edge()).toBeNull();
  });

  it("stacks as the window narrows and sits them side by side again as it widens, remounting neither", () => {
    renderPair();
    widths.split = CANOPY_DOCK_SIDE_BY_SIDE_MIN - 1;
    resized();
    expect(split()!.getAttribute("data-canopy-detail-split")).toBe("stacked");
    expect(edge()).toBeNull();
    widths.split = 1200;
    resized();
    expect(split()!.getAttribute("data-canopy-detail-split")).toBe("side-by-side");
    expect(edge()).not.toBeNull();
    expect(mounts).toEqual({ agent: 1, assistant: 1 });
  });

  it("keeps the assistant mounted as the agent beside it comes and goes", () => {
    const { rerender } = renderPair();
    rerender(<CanopyDetailSplit dock={<Pane name="assistant" />}>{null}</CanopyDetailSplit>);
    rerender(
      <CanopyDetailSplit dock={<Pane name="assistant" />}>
        <Pane name="agent" />
      </CanopyDetailSplit>
    );
    expect(mounts.assistant).toBe(1);
    rerender(<CanopyDetailSplit dock={null}>{<Pane name="agent" />}</CanopyDetailSplit>);
    expect(mounts.agent).toBe(2);
  });

  it("lands a drag under way when the panes stack beneath it", () => {
    renderPair();
    fireEvent.mouseDown(edge()!, { button: 0, clientX: 700 });
    fireEvent.mouseMove(document, { clientX: 650 });
    widths.split = CANOPY_DOCK_SIDE_BY_SIDE_MIN - 1;
    resized();
    expect(useCanopyStore.getState().dockDrag).toBeNull();
    expect(document.body.style.cursor).toBe("");
  });

  it("gives either one the whole area alone", () => {
    const { rerender } = render(
      <CanopyDetailSplit dock={null}>{<div data-testid="agent" />}</CanopyDetailSplit>
    );
    expect(split()).toBeNull();
    expect(edge()).toBeNull();
    rerender(<CanopyDetailSplit dock={<div data-testid="assistant" />}>{null}</CanopyDetailSplit>);
    expect(split()).toBeNull();
    expect(document.querySelector("[data-testid=assistant]")).not.toBeNull();
  });

  it("widens the assistant leftward from the keyboard, and resets on a double-click", () => {
    renderPair();
    fireEvent.keyDown(edge()!, { key: "ArrowLeft" });
    expect(useCanopyStore.getState().dockWidth).toBe(widths.dock + 10);
    fireEvent.keyDown(edge()!, { key: "ArrowRight", shiftKey: true });
    expect(useCanopyStore.getState().dockWidth).toBe(widths.dock - 50);
    fireEvent.doubleClick(edge()!);
    expect(useCanopyStore.getState().dockWidth).toBeNull();
  });

  it("shows the width live while dragged and keeps it once the edge lands", () => {
    renderPair();
    fireEvent.mouseDown(edge()!, { button: 0, clientX: 700 });
    expect(useCanopyStore.getState().dockDrag).toBe(widths.dock);
    fireEvent.mouseMove(document, { clientX: 600 });
    expect(useCanopyStore.getState().dockDrag).toBe(widths.dock + 100);
    expect(
      split()!
        .querySelector<HTMLElement>("[data-canopy-global]")!
        .style.getPropertyValue("--canopy-dock-width")
    ).toBe(`${widths.dock + 100}px`);
    fireEvent.mouseUp(document);
    expect(useCanopyStore.getState().dockDrag).toBeNull();
    expect(useCanopyStore.getState().dockWidth).toBe(widths.dock + 100);
  });

  it("never drags the assistant narrower than its minimum", () => {
    renderPair();
    fireEvent.mouseDown(edge()!, { button: 0, clientX: 700 });
    fireEvent.mouseMove(document, { clientX: 2000 });
    fireEvent.mouseUp(document);
    expect(useCanopyStore.getState().dockWidth).toBe(CANOPY_DOCK_MIN_WIDTH);
  });

  it("lands a drag under way when the dock goes, so the terminals' hold lifts", () => {
    const { rerender } = renderPair();
    fireEvent.mouseDown(edge()!, { button: 0, clientX: 700 });
    fireEvent.mouseMove(document, { clientX: 650 });
    expect(useCanopyStore.getState().dockDrag).not.toBeNull();
    act(() => {
      rerender(<CanopyDetailSplit dock={null}>{<div data-testid="agent" />}</CanopyDetailSplit>);
    });
    expect(useCanopyStore.getState().dockDrag).toBeNull();
    expect(document.body.style.cursor).toBe("");
  });
});

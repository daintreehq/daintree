// @vitest-environment jsdom
/**
 * The overflow budget follows a button that changes width inside a row whose
 * own box doesn't move (#15931): the forge pill holds its full width while its
 * provider resolves, then settles into the narrower commits-only pill, and the
 * buttons that width evicted have to come back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import type { AnyToolbarButtonId } from "@shared/types/toolbar";
import { useToolbarOverflow } from "../useToolbarOverflow";

let rowWidth = 260;
const IDS: AnyToolbarButtonId[] = ["voice-recording", "forge-stats", "canopy", "settings"];
const widths = new Map<string, number>();
const observers = new Set<FakeResizeObserver>();

class FakeResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
  /** Delivers a resize of `target` the way the browser does: only to observers watching it. */
  deliver(target: Element) {
    if (!this.targets.has(target)) return;
    const entry: ResizeObserverEntry = {
      target,
      contentRect: target.getBoundingClientRect(),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    };
    this.callback([entry], this);
  }
}

function resize(target: Element) {
  for (const observer of [...observers]) observer.deliver(target);
}

function Row() {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const { rightOverflow } = useToolbarOverflow(leftRef, rightRef, [], IDS);
  return (
    <>
      <div ref={leftRef} />
      <div ref={rightRef} data-row="right" data-overflow={rightOverflow.join(" ")}>
        {IDS.map((id) => (
          <div key={id} data-toolbar-button-id={id} />
        ))}
      </div>
    </>
  );
}

const rightRow = () => document.querySelector<HTMLElement>('[data-row="right"]')!;
const rightOverflow = () => rightRow().dataset.overflow ?? "";
const forgePill = () => document.querySelector('[data-toolbar-button-id="forge-stats"]')!;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return widths.get(this.dataset.toolbarButtonId ?? "") ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    return DOMRect.fromRect({ width: this.dataset.row === "right" ? rowWidth : 0, height: 32 });
  });
  rowWidth = 260;
  for (const id of IDS) widths.set(id, 36);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observers.clear();
  widths.clear();
});

describe("useToolbarOverflow when a button changes width in place", () => {
  it("brings back what the wider pill evicted once it settles narrower", () => {
    widths.set("forge-stats", 208);
    render(<Row />);
    expect(rightOverflow()).not.toBe("");

    widths.set("forge-stats", 70);
    act(() => resize(forgePill()));

    expect(rightOverflow()).toBe("");
  });

  it("evicts when a button grows past the room the row has", () => {
    widths.set("forge-stats", 70);
    render(<Row />);
    expect(rightOverflow()).toBe("");

    widths.set("forge-stats", 208);
    act(() => resize(forgePill()));

    expect(rightOverflow()).not.toBe("");
  });

  it("restores once the pill settles even after the row grew a little in between", () => {
    widths.set("forge-stats", 208);
    render(<Row />);
    const held = rightOverflow();
    expect(held).not.toBe("");

    rowWidth = 261;
    act(() => resize(rightRow()));
    expect(rightOverflow()).toBe(held);

    widths.set("forge-stats", 70);
    act(() => resize(forgePill()));

    expect(rightOverflow()).toBe("");
  });

  it("keeps the row's own hysteresis while no button changes width", () => {
    widths.set("forge-stats", 208);
    render(<Row />);
    const held = rightOverflow();
    expect(held).not.toBe("");

    // Room for one more 36px button, but short of the restore buffer.
    rowWidth = 281;
    act(() => resize(rightRow()));

    expect(rightOverflow()).toBe(held);
  });

  it("never holds a set wider than the row after a button grew in place", () => {
    widths.set("forge-stats", 208);
    render(<Row />);
    rowWidth = 281;
    act(() => resize(rightRow()));
    // Still the same buttons, now at the wider pill's width.
    widths.set("forge-stats", 236);
    act(() => resize(forgePill()));

    rowWidth = 261;
    act(() => resize(rightRow()));

    const hidden = new Set(rightOverflow().split(" "));
    const shown = IDS.filter((id) => !hidden.has(id));
    const footprint = shown.reduce((sum, id) => sum + (widths.get(id) ?? 0), 0);
    expect(footprint).toBeLessThanOrEqual(rowWidth);
  });
});

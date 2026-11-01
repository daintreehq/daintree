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

const ROW_WIDTH = 260;
const IDS: AnyToolbarButtonId[] = ["voice-recording", "forge-stats", "canopy", "settings"];
const widths = new Map<string, number>();
const observers = new Set<FakeResizeObserver>();

class FakeResizeObserver {
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
    this.callback(
      [{ target } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
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

const rightOverflow = () =>
  document.querySelector<HTMLElement>('[data-row="right"]')?.dataset.overflow ?? "";

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
    const width = this.dataset.row === "right" ? ROW_WIDTH : 0;
    return { width, height: 32, top: 0, left: 0, right: width, bottom: 32, x: 0, y: 0 } as DOMRect;
  });
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

    const pill = document.querySelector('[data-toolbar-button-id="forge-stats"]')!;
    widths.set("forge-stats", 70);
    act(() => resize(pill));

    expect(rightOverflow()).toBe("");
  });

  it("evicts when a button grows past the room the row has", () => {
    widths.set("forge-stats", 70);
    render(<Row />);
    expect(rightOverflow()).toBe("");

    const pill = document.querySelector('[data-toolbar-button-id="forge-stats"]')!;
    widths.set("forge-stats", 208);
    act(() => resize(pill));

    expect(rightOverflow()).not.toBe("");
  });
});

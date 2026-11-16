// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { PANEL_PARKING_ATTRIBUTE, useReadoutClearance, useWholeItemFit } from "../panelHeaderFit";

// jsdom has no layout, so the row's geometry is modelled: each item's width is
// its `data-w`, items sit 6px apart, and the row is `rowWidth` wide. Every read
// and every `hidden` write is logged in order so a test can see whether a read
// followed a write inside one measurement.
const layout = {
  rowWidth: 400,
  parked: false,
  visibilityChecks: 0,
  log: [] as string[],
  rects: new Map<string, { left: number; width: number }>(),
};

const GAP_PX = 6;

function visibleItems(row: Element): HTMLElement[] {
  return Array.from(row.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && !child.hasAttribute("hidden")
  );
}

function contentWidth(row: Element): number {
  const items = visibleItems(row);
  const widths = items.reduce((sum, item) => sum + Number(item.dataset.w ?? 0), 0);
  return widths + Math.max(0, items.length - 1) * GAP_PX;
}

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

function flushFrame() {
  const queued = [...frames.values()];
  frames = new Map();
  act(() => {
    for (const cb of queued) cb(performance.now());
  });
}

class StubResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>();
  constructor(private readonly cb: ResizeObserverCallback) {
    resizeObservers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  fire() {
    if (this.targets.size > 0) this.cb([], this);
  }
}

class StubIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  readonly targets = new Set<Element>();
  disconnected = false;
  constructor(private readonly cb: IntersectionObserverCallback) {
    intersectionObservers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  fire(isIntersecting: boolean) {
    if (this.disconnected) return;
    const entries = [...this.targets].map((target): IntersectionObserverEntry => ({
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect: new DOMRect(),
      intersectionRect: new DOMRect(),
      rootBounds: null,
      time: 0,
    }));
    this.cb(entries, this);
  }
}

const resizeObservers: StubResizeObserver[] = [];
const intersectionObservers: StubIntersectionObserver[] = [];

function fireResize() {
  act(() => {
    for (const ro of resizeObservers) ro.fire();
  });
}

function fireIntersection(isIntersecting: boolean) {
  act(() => {
    for (const io of intersectionObservers) io.fire(isIntersecting);
  });
}

async function flushMutations() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  layout.rowWidth = 400;
  layout.parked = false;
  layout.visibilityChecks = 0;
  layout.log = [];
  layout.rects = new Map();
  frames = new Map();
  nextFrame = 1;
  resizeObservers.length = 0;
  intersectionObservers.length = 0;

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);

  Object.defineProperty(Element.prototype, "checkVisibility", {
    configurable: true,
    value() {
      layout.visibilityChecks++;
      return !layout.parked;
    },
  });
  vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
    layout.log.push("read");
    return this.getAttribute("data-testid") === "row"
      ? Math.max(layout.rowWidth, contentWidth(this))
      : 0;
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.getAttribute("data-testid") === "row" ? layout.rowWidth : 0;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    layout.log.push("read");
    const rect = layout.rects.get(this.getAttribute("data-testid") ?? "") ?? {
      left: 0,
      width: 0,
    };
    return new DOMRect(rect.left, 0, rect.width, 20);
  });
  const setAttribute = Element.prototype.setAttribute;
  vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (
    this: Element,
    name: string,
    value: string
  ) {
    if (name === "hidden") layout.log.push("write");
    setAttribute.call(this, name, value);
  });
  const removeAttribute = Element.prototype.removeAttribute;
  vi.spyOn(Element.prototype, "removeAttribute").mockImplementation(function (
    this: Element,
    name: string
  ) {
    if (name === "hidden" && this.hasAttribute("hidden")) layout.log.push("write");
    removeAttribute.call(this, name);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
});

interface Item {
  id: string;
  w: number;
  priority?: number;
  text?: string;
}

function Row({ items, show = true }: { items: Item[]; show?: boolean }) {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  useWholeItemFit(row);
  return (
    <div data-testid="region">
      <div data-testid="identity" />
      <div data-testid="meta">
        {show && (
          <div data-testid="row" ref={setRow}>
            {items.map((item) => (
              <span
                key={item.id}
                data-testid={item.id}
                data-w={item.w}
                data-fit-priority={item.priority}
              >
                {item.text ?? item.id}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function hiddenIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-testid='row'] > [hidden]")).map(
    (el) => el.getAttribute("data-testid") ?? "?"
  );
}

function setText(container: HTMLElement, id: string, text: string) {
  const node = container.querySelector(`[data-testid='${id}']`)!.firstChild!;
  node.nodeValue = text;
}

describe("useWholeItemFit", () => {
  const items: Item[] = [
    { id: "decision", w: 60, priority: 2 },
    { id: "queue", w: 60, priority: 1 },
    { id: "cost", w: 60 },
    { id: "tokens", w: 60 },
  ];

  it("hides the lowest-priority, latest items first until the row fits", () => {
    layout.rowWidth = 140;
    const { container } = render(<Row items={items} />);
    // Ambient readings (priority 0) leave before the queue count, the later
    // one first; the waiting decision outlasts both.
    expect(hiddenIds(container)).toEqual(["cost", "tokens"]);
  });

  it("measures text ticks once per frame, not once per mutation", async () => {
    const { container } = render(<Row items={items} />);
    layout.log = [];

    // Each tick reaches the observers on its own, as live readings do.
    setText(container, "cost", "$1.10");
    await flushMutations();
    setText(container, "tokens", "12k");
    await flushMutations();
    fireResize();
    setText(container, "cost", "$1.20");
    await flushMutations();
    expect(layout.log).toEqual([]);
    expect(frames.size).toBe(1);

    flushFrame();
    expect(layout.log).toEqual(["read"]);

    // The next frame's ticks get a frame of their own.
    setText(container, "cost", "$1.30");
    await flushMutations();
    expect(frames.size).toBe(1);
    flushFrame();
    expect(layout.log).toEqual(["read", "read"]);
  });

  it("writes nothing when everything already fits", async () => {
    const { container } = render(<Row items={items} />);
    layout.log = [];

    setText(container, "cost", "$2.00");
    await flushMutations();
    flushFrame();
    expect(layout.log).toEqual(["read"]);
    expect(hiddenIds(container)).toEqual([]);
  });

  it("probes only the last item out on a tick that moves nothing", async () => {
    layout.rowWidth = 140;
    const { container } = render(<Row items={items} />);
    expect(hiddenIds(container)).toEqual(["cost", "tokens"]);
    layout.log = [];

    setText(container, "queue", "3 queued");
    await flushMutations();
    flushFrame();
    // Rather than revealing both and taking them out again, one read per side
    // of the boundary.
    expect(layout.log).toEqual(["read", "write", "read", "write"]);
    expect(hiddenIds(container)).toEqual(["cost", "tokens"]);
  });

  it("takes the next item out when the row narrows, without revealing any", () => {
    layout.rowWidth = 140;
    const { container } = render(<Row items={items} />);
    layout.log = [];

    layout.rowWidth = 70;
    fireResize();
    flushFrame();
    expect(hiddenIds(container)).toEqual(["queue", "cost", "tokens"]);
    expect(layout.log).toEqual(["read", "write", "read"]);
  });

  it("re-weighs from scratch when a priority changes the leaving order", async () => {
    layout.rowWidth = 140;
    const { container } = render(<Row items={items} />);
    expect(hiddenIds(container)).toEqual(["cost", "tokens"]);

    // The cost reading now outranks everything: the queue count leaves first.
    container.querySelector("[data-testid='cost']")!.setAttribute("data-fit-priority", "3");
    await flushMutations();
    flushFrame();
    expect(hiddenIds(container)).toEqual(["queue", "tokens"]);
  });

  it("gives back only what fits when the row widens part way", () => {
    layout.rowWidth = 140;
    const { container } = render(<Row items={items} />);

    layout.rowWidth = 200;
    fireResize();
    flushFrame();
    expect(hiddenIds(container)).toEqual(["tokens"]);
  });

  it("brings items back when the row widens", () => {
    layout.rowWidth = 140;
    const { container } = render(<Row items={items} />);
    expect(hiddenIds(container)).toEqual(["cost", "tokens"]);

    layout.rowWidth = 400;
    fireResize();
    flushFrame();
    expect(hiddenIds(container)).toEqual([]);
  });

  it("skips measurement while parked and measures again on reveal", async () => {
    const { container } = render(<Row items={items} />);
    layout.parked = true;
    layout.rowWidth = 140;
    layout.log = [];

    setText(container, "cost", "$3.00");
    await flushMutations();
    flushFrame();
    fireResize();
    flushFrame();
    expect(layout.log).toEqual([]);
    expect(hiddenIds(container)).toEqual([]);

    // Revealed with nothing else changing: the engine's visibility report alone
    // brings the fit back.
    layout.parked = false;
    fireIntersection(true);
    flushFrame();
    expect(hiddenIds(container)).toEqual(["cost", "tokens"]);
    expect(intersectionObservers.every((io) => io.disconnected)).toBe(true);
  });

  it("does no layout work at mount while parked", () => {
    layout.parked = true;
    layout.rowWidth = 140;
    const { container } = render(<Row items={items} />);
    expect(layout.log).toEqual([]);
    expect(hiddenIds(container)).toEqual([]);
  });

  it("knows a pane in the dock's parking container is parked without asking the engine", async () => {
    layout.rowWidth = 140;
    const { container } = render(
      <div data-testid="parking" {...{ [PANEL_PARKING_ATTRIBUTE]: "" }}>
        <Row items={items} />
      </div>
    );
    setText(container, "cost", "$5.00");
    await flushMutations();
    flushFrame();
    expect(layout.log).toEqual([]);
    expect(layout.visibilityChecks).toBe(0);

    container.querySelector("[data-testid='parking']")!.removeAttribute(PANEL_PARKING_ATTRIBUTE);
    fireIntersection(true);
    flushFrame();
    expect(hiddenIds(container)).toEqual(["cost", "tokens"]);
  });

  it("attaches to a row that mounts after the header", () => {
    layout.rowWidth = 140;
    const { container, rerender } = render(<Row items={items} show={false} />);
    rerender(<Row items={items} show />);
    expect(hiddenIds(container)).toEqual(["cost", "tokens"]);
  });

  it("cancels its pending frame and observers on unmount", async () => {
    const { container, unmount } = render(<Row items={items} />);
    setText(container, "cost", "$4.00");
    await flushMutations();
    expect(frames.size).toBe(1);
    const row = container.querySelector("[data-testid='row']")!;

    unmount();
    expect(frames.size).toBe(0);
    expect(resizeObservers.every((ro) => ro.targets.size === 0)).toBe(true);

    // Nothing left listening: a late tick on the detached row schedules nothing.
    row.firstChild!.firstChild!.nodeValue = "late";
    await flushMutations();
    expect(frames.size).toBe(0);
  });

  it("stops waiting for a reveal once unmounted", () => {
    layout.parked = true;
    const { unmount } = render(<Row items={items} />);
    expect(intersectionObservers.some((io) => !io.disconnected)).toBe(true);

    unmount();
    expect(intersectionObservers.every((io) => io.disconnected)).toBe(true);
  });
});

function Bar({ active }: { active: boolean }) {
  const [readout, setReadout] = useState<HTMLDivElement | null>(null);
  const clear = useReadoutClearance(readout, active);
  return (
    <div data-testid="bar">
      <div data-testid="title" data-readout-obstacle="" />
      {active && (
        <div data-testid="readout" ref={setReadout} data-clear={clear ? "true" : "false"} />
      )}
    </div>
  );
}

function readoutClear(container: HTMLElement): string | null {
  return container.querySelector("[data-testid='readout']")?.getAttribute("data-clear") ?? null;
}

describe("useReadoutClearance", () => {
  beforeEach(() => {
    layout.rects.set("readout", { left: 400, width: 200 });
  });

  it("stands the readout aside before first paint when it would meet an obstacle", () => {
    layout.rects.set("title", { left: 380, width: 100 });
    const { container } = render(<Bar active />);
    expect(readoutClear(container)).toBe("false");
  });

  it("re-measures a resize on the next frame, once", () => {
    layout.rects.set("title", { left: 0, width: 100 });
    const { container } = render(<Bar active />);
    expect(readoutClear(container)).toBe("true");

    layout.rects.set("title", { left: 0, width: 420 });
    layout.log = [];
    fireResize();
    fireResize();
    expect(layout.log).toEqual([]);
    flushFrame();
    // One measurement: the readout and its one obstacle.
    expect(layout.log).toEqual(["read", "read"]);
    expect(readoutClear(container)).toBe("false");
  });

  it("keeps an unmeasured readout out of sight until it renders and is measured", () => {
    layout.parked = true;
    layout.rects.set("title", { left: 0, width: 100 });
    const { container } = render(<Bar active />);
    expect(layout.log).toEqual([]);
    expect(readoutClear(container)).toBe("false");

    layout.parked = false;
    fireIntersection(true);
    flushFrame();
    expect(readoutClear(container)).toBe("true");
  });

  it("wakes on a resize too, when the readout first renders", () => {
    layout.parked = true;
    layout.rects.set("title", { left: 0, width: 100 });
    const { container } = render(<Bar active />);

    layout.parked = false;
    fireResize();
    flushFrame();
    expect(readoutClear(container)).toBe("true");
  });
});

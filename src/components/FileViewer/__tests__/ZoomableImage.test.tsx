// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fitScale, MAX_ZOOM, MIN_ZOOM, zoomViewAt, ZoomableImage } from "../ZoomableImage";

describe("fitScale", () => {
  it("never reports more than actual size — fitting only ever shrinks", () => {
    expect(fitScale({ width: 100, height: 100 }, { width: 800, height: 800 })).toBe(1);
  });

  it("is limited by whichever axis runs out first", () => {
    const natural = { width: 1200, height: 600 };
    const scale = fitScale(natural, { width: 600, height: 600 });
    expect(natural.width * scale).toBeLessThanOrEqual(600);
    expect(natural.height * scale).toBeLessThanOrEqual(600);
    expect(scale).toBeLessThan(1);
  });

  it("falls back to 1 when either size is unknown", () => {
    expect(fitScale(null, { width: 10, height: 10 })).toBe(1);
    expect(fitScale({ width: 10, height: 10 }, null)).toBe(1);
  });
});

describe("zoomViewAt", () => {
  // Where an image point (measured from the image's own centre, unscaled) lands
  // relative to the stage's centre.
  const screenPoint = (
    view: { zoom: number; offset: { x: number; y: number } },
    point: { x: number; y: number }
  ) => ({
    x: view.offset.x + view.zoom * point.x,
    y: view.offset.y + view.zoom * point.y,
  });

  it.each([
    { zoom: 1, offset: { x: 0, y: 0 }, next: 2.5, anchor: { x: 120, y: -80 } },
    { zoom: 3, offset: { x: -40, y: 25 }, next: 1.2, anchor: { x: -200, y: 60 } },
    { zoom: 0.5, offset: { x: 10, y: -10 }, next: 8, anchor: { x: 33, y: 44 } },
  ])("holds the point under the anchor still (zoom $zoom -> $next)", (case_) => {
    const view = { zoom: case_.zoom, offset: case_.offset };
    // The image point currently under the anchor.
    const point = {
      x: (case_.anchor.x - view.offset.x) / view.zoom,
      y: (case_.anchor.y - view.offset.y) / view.zoom,
    };
    const next = zoomViewAt(view, case_.next, case_.anchor);
    expect(next.zoom).toBe(case_.next);
    const after = screenPoint(next, point);
    expect(after.x).toBeCloseTo(case_.anchor.x, 9);
    expect(after.y).toBeCloseTo(case_.anchor.y, 9);
  });

  it.each([
    {
      zoom: 12,
      offset: { x: -30, y: 20 },
      next: MAX_ZOOM * 4,
      limit: MAX_ZOOM,
      anchor: { x: 150, y: -90 },
    },
    {
      zoom: 0.4,
      offset: { x: 15, y: -25 },
      next: MIN_ZOOM / 10,
      limit: MIN_ZOOM,
      anchor: { x: -70, y: 55 },
    },
  ])("holds the anchor still at the clamped zoom (zoom $zoom -> limit $limit)", (case_) => {
    const view = { zoom: case_.zoom, offset: case_.offset };
    const point = {
      x: (case_.anchor.x - view.offset.x) / view.zoom,
      y: (case_.anchor.y - view.offset.y) / view.zoom,
    };
    const next = zoomViewAt(view, case_.next, case_.anchor);
    expect(next.zoom).toBe(case_.limit);
    const after = screenPoint(next, point);
    expect(after.x).toBeCloseTo(case_.anchor.x, 9);
    expect(after.y).toBeCloseTo(case_.anchor.y, 9);
  });

  it("leaves a centred image centred when the anchor is the stage centre", () => {
    const next = zoomViewAt({ zoom: 1, offset: { x: 0, y: 0 } }, 4, { x: 0, y: 0 });
    expect(next.offset).toEqual({ x: 0, y: 0 });
  });

  it("returns the same view when the zoom is already pinned at a limit", () => {
    const view = { zoom: MAX_ZOOM, offset: { x: 17, y: -9 } };
    expect(zoomViewAt(view, MAX_ZOOM * 4, { x: 90, y: 90 })).toBe(view);
  });
});

describe("ZoomableImage wheel", () => {
  const STAGE = { left: 20, top: 10, width: 400, height: 300 };

  function renderStage() {
    render(
      <TooltipProvider>
        <ZoomableImage filePath="/repo/a.png" rootPath="/repo" alt="a.png" />
      </TooltipProvider>
    );
    const stage = screen.getByRole("group", { name: /^a\.png/ });
    // jsdom has no layout, so give the stage a box: centre at (220, 160).
    stage.getBoundingClientRect = () =>
      ({
        ...STAGE,
        right: STAGE.left + STAGE.width,
        bottom: STAGE.top + STAGE.height,
        x: STAGE.left,
        y: STAGE.top,
        toJSON: () => ({}),
      }) as DOMRect;
    const image = screen.getByRole("img", { name: "a.png" });
    const view = () => {
      const match = /translate\((\S+)px, (\S+)px\) scale\((\S+)\)/.exec(image.style.transform);
      if (!match) throw new Error(`unparsed transform: ${image.style.transform}`);
      return { offset: { x: Number(match[1]), y: Number(match[2]) }, zoom: Number(match[3]) };
    };
    return { stage, view };
  }

  it("keeps the point under the pointer where it is", () => {
    const { stage, view } = renderStage();
    // 100px right of and 50px below the stage centre, on an unzoomed image.
    fireEvent.wheel(stage, { deltaY: -400, clientX: 320, clientY: 210 });

    const after = view();
    expect(after.zoom).toBeGreaterThan(1);
    expect(after.offset.x + after.zoom * 100).toBeCloseTo(100, 6);
    expect(after.offset.y + after.zoom * 50).toBeCloseTo(50, 6);
  });

  it("composes successive wheel steps at different pointer positions", () => {
    const { stage, view } = renderStage();
    fireEvent.wheel(stage, { deltaY: -300, clientX: 320, clientY: 210 });
    const first = view();

    // Pointer moves to 60px left of and 40px above the stage centre.
    const anchor = { x: -60, y: -40 };
    const point = {
      x: (anchor.x - first.offset.x) / first.zoom,
      y: (anchor.y - first.offset.y) / first.zoom,
    };
    // The opposite step to the first, so the zoom has to come back to where it began.
    fireEvent.wheel(stage, { deltaY: 300, clientX: 160, clientY: 120 });

    const second = view();
    expect(second.zoom).toBeCloseTo(1, 9);
    expect(second.offset.x + second.zoom * point.x).toBeCloseTo(anchor.x, 6);
    expect(second.offset.y + second.zoom * point.y).toBeCloseTo(anchor.y, 6);
  });

  it("zooms about the image centre when the pointer is at the stage centre", () => {
    const { stage, view } = renderStage();
    fireEvent.wheel(stage, { deltaY: -400, clientX: 220, clientY: 160 });
    expect(view().zoom).toBeGreaterThan(1);
    expect(view().offset).toEqual({ x: 0, y: 0 });
  });

  it("keeps a wheel zoom's pan when the drag carries on", () => {
    const { stage, view } = renderStage();
    // jsdom has no pointer capture, which the press and release call.
    stage.setPointerCapture = () => {};
    stage.hasPointerCapture = () => false;
    stage.releasePointerCapture = () => {};
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 220, clientY: 160 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 230, clientY: 170 });
    expect(view().offset).toEqual({ x: 10, y: 10 });

    fireEvent.wheel(stage, { deltaY: -400, clientX: 320, clientY: 210 });
    const zoomed = view().offset;
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 235, clientY: 170 });
    expect(view().offset.x).toBeCloseTo(zoomed.x + 5, 9);
    expect(view().offset.y).toBeCloseTo(zoomed.y, 9);
  });

  it.each([
    {
      name: "+ key",
      grows: true,
      press: (stage: HTMLElement) => fireEvent.keyDown(stage, { key: "+" }),
    },
    {
      name: "- key",
      grows: false,
      press: (stage: HTMLElement) => fireEvent.keyDown(stage, { key: "-" }),
    },
    {
      name: "Zoom in button",
      grows: true,
      press: () => fireEvent.click(screen.getByRole("button", { name: "Zoom in" })),
    },
    {
      name: "Zoom out button",
      grows: false,
      press: () => fireEvent.click(screen.getByRole("button", { name: "Zoom out" })),
    },
  ])("steps zoom with the $name and leaves the pan alone", ({ grows, press }) => {
    const { stage, view } = renderStage();
    fireEvent.keyDown(stage, { key: "ArrowLeft" });
    fireEvent.keyDown(stage, { key: "ArrowUp" });
    const panned = view().offset;
    expect(panned.x).not.toBe(0);
    expect(panned.y).not.toBe(0);

    press(stage);
    if (grows) expect(view().zoom).toBeGreaterThan(1);
    else expect(view().zoom).toBeLessThan(1);
    expect(view().offset).toEqual(panned);
  });

  it("stops key steps at the zoom limits", () => {
    const { stage, view } = renderStage();
    for (let i = 0; i < 20; i++) fireEvent.keyDown(stage, { key: "+" });
    expect(view().zoom).toBe(MAX_ZOOM);
    for (let i = 0; i < 40; i++) fireEvent.keyDown(stage, { key: "-" });
    expect(view().zoom).toBe(MIN_ZOOM);
  });
});

describe("ZoomableImage keyboard", () => {
  function renderImage() {
    render(
      <TooltipProvider>
        <ZoomableImage filePath="/repo/a.png" rootPath="/repo" alt="a.png" />
      </TooltipProvider>
    );
    return screen.getByRole("group", { name: /^a\.png/ });
  }

  it("pans with the arrow keys and returns to fit on 0", () => {
    const stage = renderImage();
    const image = screen.getByRole("img", { name: "a.png" });

    const fit = screen.getByRole("button", { name: "Fit to screen" });
    // Unavailable at fit, but kept in the zoom toolbar's arrow-key order.
    expect(fit.getAttribute("aria-disabled")).toBe("true");
    expect(fit.hasAttribute("disabled")).toBe(false);

    fireEvent.keyDown(stage, { key: "ArrowLeft" });
    const panned = image.style.transform;
    expect(panned).not.toBe("translate(0px, 0px) scale(1)");
    expect(fit.hasAttribute("aria-disabled")).toBe(false);

    fireEvent.keyDown(stage, { key: "0" });
    expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("zooms with + and -", () => {
    const stage = renderImage();
    const image = screen.getByRole("img", { name: "a.png" });
    fireEvent.keyDown(stage, { key: "+" });
    expect(image.style.transform).not.toContain("scale(1)");
    fireEvent.keyDown(stage, { key: "-" });
    expect(image.style.transform).toContain("scale(1)");
  });

  it.each([{ metaKey: true }, { ctrlKey: true }, { altKey: true }])(
    "leaves a chord to the app (%o)",
    (modifier) => {
      const stage = renderImage();
      const image = screen.getByRole("img", { name: "a.png" });
      for (const key of ["+", "-", "0", "ArrowLeft"]) {
        const notCancelled = fireEvent.keyDown(stage, { key, ...modifier });
        // An uncancelled key is still the app's to act on.
        expect(notCancelled).toBe(true);
      }
      expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
    }
  );

  it("keeps the keys it handles from reaching an ancestor's own key handling", () => {
    // The content grid pans panel focus on bare arrows and doesn't look at
    // defaultPrevented, so a handled key has to stop here.
    const seen: string[] = [];
    render(
      <TooltipProvider>
        <div onKeyDown={(event) => seen.push(event.key)}>
          <ZoomableImage filePath="/repo/a.png" rootPath="/repo" alt="a.png" />
        </div>
      </TooltipProvider>
    );
    const stage = screen.getByRole("group", { name: /^a\.png/ });
    for (const key of ["ArrowLeft", "+", "-", "0"]) fireEvent.keyDown(stage, { key });
    fireEvent.keyDown(stage, { key: "Enter" });
    expect(seen).toEqual(["Enter"]);
  });
});

describe("ZoomableImage pointer", () => {
  function renderStage() {
    render(
      <TooltipProvider>
        <ZoomableImage filePath="/repo/a.png" rootPath="/repo" alt="a.png" />
      </TooltipProvider>
    );
    const stage = screen.getByRole("group", { name: /^a\.png/ });
    const captured: number[] = [];
    // jsdom has no pointer capture.
    stage.setPointerCapture = (id) => void captured.push(id);
    stage.hasPointerCapture = () => false;
    stage.releasePointerCapture = () => {};
    const image = screen.getByRole("img", { name: "a.png" });
    return { stage, image, captured };
  }

  it("pans on a primary-button drag", () => {
    const { stage, image, captured } = renderStage();
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 25, clientY: 30 });
    expect(captured).toEqual([1]);
    expect(image.style.transform).toBe("translate(15px, 20px) scale(1)");
  });

  it.each([
    { name: "a secondary press", init: { button: 2 } },
    {
      name: "a Control-click, which is the context menu on macOS",
      init: { button: 0, ctrlKey: true },
    },
  ])("leaves $name uncaptured and doesn't pan", ({ init }) => {
    const { stage, image, captured } = renderStage();
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 10, clientY: 10, ...init });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 25, clientY: 30 });
    expect(captured).toEqual([]);
    expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("stops panning once the browser takes the pointer capture back", () => {
    const { stage, image } = renderStage();
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 20, clientY: 10 });
    fireEvent.lostPointerCapture(stage, { pointerId: 1 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 90, clientY: 10 });
    expect(image.style.transform).toBe("translate(10px, 0px) scale(1)");
  });
});

describe("ZoomableImage footer", () => {
  it("is one named toolbar with a single tab stop", () => {
    render(
      <TooltipProvider>
        <ZoomableImage filePath="/repo/a.png" rootPath="/repo" alt="a.png" />
      </TooltipProvider>
    );
    const toolbar = screen.getByRole("toolbar", { name: "Zoom controls" });
    fireEvent.focus(toolbar);
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    // Disabled buttons take no focus at all, so they are no tab stop either way.
    const stops = Array.from(toolbar.querySelectorAll("button")).filter(
      (button) => !button.disabled && button.tabIndex === 0
    );
    expect(stops).toHaveLength(1);
  });
});

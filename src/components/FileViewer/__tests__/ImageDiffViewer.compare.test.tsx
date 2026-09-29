// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffMediaFileVersions } from "@shared/types";
import {
  ImageDiffViewer,
  describeImageFacts,
  nextSwipePosition,
  swipeValueText,
} from "../ImageDiffViewer";

const mockReadFileVersions = vi.fn();
vi.mock("@/clients/diffMediaClient", () => ({
  diffMediaClient: {
    readFileVersions: (...args: unknown[]) => mockReadFileVersions(...args),
  },
}));

const HEAD_URL = "data:image/png;base64,SEVBRA";
const WORKING_URL = "data:image/png;base64,V09SSw";

function versions(): DiffMediaFileVersions {
  return {
    head: { ok: true, dataUrl: HEAD_URL, byteSize: 1000 },
    working: { ok: true, dataUrl: WORKING_URL, byteSize: 1500 },
  };
}

function ok(byteSize: number) {
  return { ok: true as const, dataUrl: "data:x", byteSize };
}

describe("swipe divider keyboard contract", () => {
  it("steps with arrows, jumps further with page keys, and reaches both ends", () => {
    const arrow = nextSwipePosition("ArrowRight", 50)!;
    const page = nextSwipePosition("PageUp", 50)!;
    expect(arrow).toBeGreaterThan(50);
    expect(page).toBeGreaterThan(arrow);
    expect(nextSwipePosition("ArrowLeft", 50)).toBeLessThan(50);
    expect(nextSwipePosition("PageDown", 50)).toBeLessThan(nextSwipePosition("ArrowLeft", 50)!);
    // Vertical arrows move the same way as the horizontal ones (APG).
    expect(nextSwipePosition("ArrowUp", 50)).toBe(arrow);
    expect(nextSwipePosition("ArrowDown", 50)).toBe(nextSwipePosition("ArrowLeft", 50));
    expect(nextSwipePosition("Home", 37)).toBe(0);
    expect(nextSwipePosition("End", 37)).toBe(100);
    expect(nextSwipePosition("Tab", 50)).toBeNull();
  });

  it("never leaves the 0–100 range", () => {
    for (const key of ["ArrowLeft", "PageDown", "ArrowDown"]) {
      expect(nextSwipePosition(key, 1)).toBe(0);
    }
    for (const key of ["ArrowRight", "PageUp", "ArrowUp"]) {
      expect(nextSwipePosition(key, 99)).toBe(100);
    }
  });

  it("names which version each end shows, and both sides in between", () => {
    expect(swipeValueText(0)).not.toBe(swipeValueText(100));
    expect(swipeValueText(0)).toMatch(/working tree/i);
    expect(swipeValueText(100)).toMatch(/HEAD/);
    const middle = swipeValueText(30);
    expect(middle).toMatch(/HEAD/);
    expect(middle).toMatch(/working tree/i);
    expect(middle).toContain("30%");
    expect(middle).toContain("70%");
  });
});

describe("describeImageFacts", () => {
  const dims = { width: 640, height: 400 };

  it("calls out a dimension change only when the size changed", () => {
    const resized = describeImageFacts(
      ok(10),
      { width: 760, height: 360 },
      {
        side: ok(10),
        dims,
      }
    );
    expect(resized).toContain("640 × 400");
    expect(resized).toContain("760 × 360");
    const same = describeImageFacts(ok(10), dims, { side: ok(10), dims });
    expect(same.match(/×/g)).toHaveLength(1);
  });

  it("signs the byte change against the baseline, and says nothing when it's unchanged", () => {
    const grew = describeImageFacts(ok(2048), dims, { side: ok(1024), dims });
    const shrank = describeImageFacts(ok(1024), dims, { side: ok(2048), dims });
    expect(grew).toMatch(/\(\+/);
    expect(shrank).toMatch(/\(−/);
    expect(describeImageFacts(ok(1024), dims, { side: ok(1024), dims })).not.toMatch(/[(]/);
    // HEAD has no baseline, so it never carries a delta.
    expect(describeImageFacts(ok(2048), dims)).not.toMatch(/[(]/);
  });
});

describe("ImageDiffViewer comparison", () => {
  beforeEach(() => {
    mockReadFileVersions.mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  });

  it("clips HEAD and the working tree to complementary halves at every divider position", async () => {
    mockReadFileVersions.mockResolvedValue(versions());
    render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
    fireEvent.click(await screen.findByRole("radio", { name: "Swipe" }));
    const divider = screen.getByRole("slider", { name: "Swipe divider" });

    const insets = () => {
      const clip = (alt: string) => screen.getByAltText(alt).parentElement?.style.clipPath ?? "";
      const head = clip("HEAD version of logo.png").match(/inset\(0(?:px)? ([\d.]+)%/);
      const working = clip("Working tree version of logo.png").match(/([\d.]+)%\)$/);
      return { headRight: Number(head?.[1]), workingLeft: Number(working?.[1]) };
    };

    for (const key of [null, "PageUp", "End", "Home", "ArrowRight"]) {
      if (key) fireEvent.keyDown(divider, { key });
      const { headRight, workingLeft } = insets();
      // Whatever HEAD hides, the working tree shows, and nothing is shown twice.
      expect(headRight + workingLeft).toBe(100);
      expect(workingLeft).toBe(Number(divider.getAttribute("aria-valuenow")));
    }
  });

  it("describes the divider position for assistive tech as it moves", async () => {
    mockReadFileVersions.mockResolvedValue(versions());
    render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
    fireEvent.click(await screen.findByRole("radio", { name: "Swipe" }));
    const divider = screen.getByRole("slider", { name: "Swipe divider" });
    const before = divider.getAttribute("aria-valuetext");
    fireEvent.keyDown(divider, { key: "End" });
    expect(divider.getAttribute("aria-valuenow")).toBe("100");
    expect(divider.getAttribute("aria-valuetext")).toBe(swipeValueText(100));
    expect(divider.getAttribute("aria-valuetext")).not.toBe(before);
  });

  it("explains two limit failures per side instead of offering a Retry that can't help", async () => {
    mockReadFileVersions.mockResolvedValue({
      head: { ok: false, error: "TOO_LARGE" },
      working: { ok: false, error: "UNSUPPORTED" },
    } satisfies DiffMediaFileVersions);
    render(<ImageDiffViewer relPath="huge.png" worktreePath="/repo" status="modified" />);

    expect(await screen.findByText(/too large/i)).toBeDefined();
    expect(screen.getByText(/can't be previewed/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers Retry on a transiently failed side in two-up", async () => {
    mockReadFileVersions.mockResolvedValue({
      head: { ok: false, error: "ERROR" },
      working: { ok: true, dataUrl: WORKING_URL, byteSize: 7 },
    } satisfies DiffMediaFileVersions);
    render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(mockReadFileVersions).toHaveBeenCalledTimes(2);
  });

  describe("with measured frames and known natural sizes", () => {
    const NATURAL: Record<string, { w: number; h: number }> = {
      [HEAD_URL]: { w: 640, h: 400 },
      [WORKING_URL]: { w: 760, h: 360 },
    };

    // Assigned rather than `vi.stubGlobal`ed: unstubbing would also strip the
    // setup file's own ResizeObserver/rAF stubs, which later tests rely on.
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalRaf = globalThis.requestAnimationFrame;

    beforeEach(() => {
      HTMLImageElement.prototype.decode = () => Promise.resolve();
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockImplementation(function (
        this: HTMLImageElement
      ) {
        return NATURAL[this.src]?.w ?? 0;
      });
      vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockImplementation(function (
        this: HTMLImageElement
      ) {
        return NATURAL[this.src]?.h ?? 0;
      });
      // Every observed frame measures 300×200 — smaller than either image.
      globalThis.ResizeObserver = class {
        constructor(private cb: ResizeObserverCallback) {}
        observe(target: Element) {
          this.cb(
            [{ target, contentRect: { width: 300, height: 200 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver
          );
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
      globalThis.requestAnimationFrame = (fn: FrameRequestCallback) => {
        fn(0);
        return 1;
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
      globalThis.ResizeObserver = originalResizeObserver;
      globalThis.requestAnimationFrame = originalRaf;
    });

    const renderedWidth = (alt: string) => parseFloat(screen.getByAltText(alt).style.width);

    it.each(["Two-up", "Swipe", "Onion skin"])(
      "draws both versions at one shared scale in %s",
      async (mode) => {
        mockReadFileVersions.mockResolvedValue(versions());
        render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
        fireEvent.click(await screen.findByRole("radio", { name: mode }));

        const head = renderedWidth("HEAD version of logo.png");
        const working = renderedWidth("Working tree version of logo.png");
        expect(head).toBeGreaterThan(0);
        // Same scale ⇒ the rendered widths keep the natural widths' ratio,
        // so a wider working tree still looks wider.
        expect(working / head).toBeCloseTo(760 / 640, 1);
        expect(working).toBeLessThanOrEqual(300);
      }
    );

    it.each(["Two-up", "Swipe", "Onion skin"])(
      "draws both versions at their natural size at 100%% in %s",
      async (mode) => {
        mockReadFileVersions.mockResolvedValue(versions());
        render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
        fireEvent.click(await screen.findByRole("radio", { name: mode }));
        fireEvent.click(screen.getByRole("radio", { name: "Actual size" }));

        expect(renderedWidth("HEAD version of logo.png")).toBe(NATURAL[HEAD_URL]!.w);
        expect(renderedWidth("Working tree version of logo.png")).toBe(NATURAL[WORKING_URL]!.w);
        fireEvent.click(screen.getByRole("radio", { name: "Fit to screen" }));
        expect(renderedWidth("Working tree version of logo.png")).toBeLessThanOrEqual(300);
      }
    );

    it("gives both two-up panes the same canvas, so differently sized versions line up", async () => {
      mockReadFileVersions.mockResolvedValue(versions());
      render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
      await screen.findByRole("radio", { name: "Swipe" });

      const canvasOf = (alt: string) => screen.getByAltText(alt).parentElement!;
      for (const zoom of ["Fit to screen", "Actual size"]) {
        fireEvent.click(screen.getByRole("radio", { name: zoom }));
        const head = canvasOf("HEAD version of logo.png");
        const working = canvasOf("Working tree version of logo.png");
        expect(head.style.width).not.toBe("");
        expect(head.style.width).toBe(working.style.width);
        expect(head.style.height).toBe(working.style.height);
      }
    });

    it("keeps both two-up panes on the same region when one scrolls at 100%", async () => {
      mockReadFileVersions.mockResolvedValue(versions());
      render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
      fireEvent.click(await screen.findByRole("radio", { name: "Actual size" }));

      const frameOf = (alt: string) =>
        screen.getByAltText(alt).closest<HTMLElement>("[data-image-frame]")!;
      const head = frameOf("HEAD version of logo.png");
      const working = frameOf("Working tree version of logo.png");
      head.scrollLeft = 120;
      head.scrollTop = 45;
      fireEvent.scroll(head);
      expect(working.scrollLeft).toBe(head.scrollLeft);
      expect(working.scrollTop).toBe(head.scrollTop);
      working.scrollLeft = 7;
      fireEvent.scroll(working);
      expect(head.scrollLeft).toBe(working.scrollLeft);
    });

    it("never upscales an image smaller than its frame", async () => {
      NATURAL[HEAD_URL] = { w: 64, h: 40 };
      NATURAL[WORKING_URL] = { w: 64, h: 40 };
      try {
        mockReadFileVersions.mockResolvedValue(versions());
        render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
        await screen.findByRole("radio", { name: "Swipe" });
        expect(renderedWidth("HEAD version of logo.png")).toBe(64);
        // Everything already shows at actual size, so 100% would change nothing.
        expect(screen.getByRole("radio", { name: "Actual size" }).hasAttribute("disabled")).toBe(
          true
        );
      } finally {
        NATURAL[HEAD_URL] = { w: 640, h: 400 };
        NATURAL[WORKING_URL] = { w: 760, h: 360 };
      }
    });
  });
});

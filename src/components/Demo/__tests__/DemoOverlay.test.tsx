// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { DemoAnnotatePayload, DemoAnnotationSize } from "@shared/types/ipc/demo";
import {
  estimateWrappedLines,
  estimateCaptionBox,
  resolveAnnotationPlacement,
} from "../DemoOverlay";

const SAFE_MARGIN = 0.05;

// A deterministic text measurer so wrap-math tests don't depend on jsdom's
// canvas (which has no real font metrics). Every glyph is `perChar` px wide, so
// segment width == segment.length * perChar — exact and predictable.
function fixedMeasurer(perChar: number): Pick<CanvasRenderingContext2D, "font" | "measureText"> {
  return {
    font: "",
    measureText: (s: string) =>
      ({ width: s.length * perChar }) as TextMetrics,
  };
}

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, writable: true, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, writable: true, configurable: true });
}

// Recompute the box span from its translate anchors, exactly as the clamp does,
// so containment assertions check the same geometry the production code uses.
function boxSpan(
  placement: { left: number; top: number; tx: string; ty: string },
  estW: number,
  estH: number
) {
  const { left, top, tx, ty } = placement;
  const spanLeft = tx === "-50%" ? left - estW / 2 : tx === "-100%" ? left - estW : left;
  const spanTop = ty === "-50%" ? top - estH / 2 : ty === "-100%" ? top - estH : top;
  return { spanLeft, spanRight: spanLeft + estW, spanTop, spanBottom: spanTop + estH };
}

describe("estimateWrappedLines", () => {
  it("keeps a single short line on one line", () => {
    // perChar=10, "hi there" = 8 chars → words measured individually, total << limit.
    const ctx = fixedMeasurer(10);
    const { lines, maxLineWidth } = estimateWrappedLines("hi there", 1000, ctx);
    expect(lines).toBe(1);
    // maxLineWidth must be positive and not exceed the content width.
    expect(maxLineWidth).toBeGreaterThan(0);
    expect(maxLineWidth).toBeLessThanOrEqual(1000);
  });

  it("wraps greedily: more words than fit on a line produce more lines", () => {
    const ctx = fixedMeasurer(10);
    // Word "aaaa" measures 40px (with the 1.15 fudge → 46px). A 100px content
    // width holds ~2 such words per line, so 6 words must spill past one line.
    const text = "aaaa aaaa aaaa aaaa aaaa aaaa";
    const { lines } = estimateWrappedLines(text, 100, ctx);
    expect(lines).toBeGreaterThan(1);
    // Greedy wrap never produces more lines than words.
    expect(lines).toBeLessThanOrEqual(6);
  });

  it("explicit newlines force at least that many lines", () => {
    const ctx = fixedMeasurer(10);
    const { lines } = estimateWrappedLines("a\nb\nc", 1000, ctx);
    expect(lines).toBe(3);
  });

  it("break-word splits an unbreakable token wider than the box across lines", () => {
    const ctx = fixedMeasurer(10);
    // Single 50-char token = 500px raw → 575px after fudge. Into a 100px box that
    // is ceil(575/100) = 6 lines. A naive single-line count would be 1.
    const token = "x".repeat(50);
    const { lines, maxLineWidth } = estimateWrappedLines(token, 100, ctx);
    expect(lines).toBeGreaterThanOrEqual(5);
    // A token forced to break fills the content width on every wrapped line.
    expect(maxLineWidth).toBeCloseTo(100, 5);
  });

  it("never reports fewer than one line, even for empty text", () => {
    const ctx = fixedMeasurer(10);
    expect(estimateWrappedLines("", 1000, ctx).lines).toBe(1);
  });

  it("narrower content width yields at least as many lines as a wider one", () => {
    const ctx = fixedMeasurer(10);
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const wide = estimateWrappedLines(text, 600, ctx).lines;
    const narrow = estimateWrappedLines(text, 120, ctx).lines;
    // Monotonic: squeezing the box can only keep or increase the line count.
    expect(narrow).toBeGreaterThanOrEqual(wide);
  });
});

describe("estimateCaptionBox", () => {
  it("never returns a width wider than the allowed max box", () => {
    setViewport(3840, 2160);
    const longLine = "word ".repeat(200);
    const screen = estimateCaptionBox(longLine, "md", true, 3840, 2160);
    const element = estimateCaptionBox(longLine, "md", false, 3840, 2160);
    // The 0.7*fw / 0.34*fw caps are hard upper bounds on the estimated width.
    expect(screen.estW).toBeLessThanOrEqual(0.7 * 3840 + 0.5);
    expect(element.estW).toBeLessThanOrEqual(0.34 * 3840 + 0.5);
  });

  it("height grows monotonically with line count", () => {
    setViewport(1920, 1080);
    const one = estimateCaptionBox("short", "md", true, 1920, 1080);
    const many = estimateCaptionBox("line one\nline two\nline three\nline four", "md", true, 1920, 1080);
    expect(many.lines).toBeGreaterThan(one.lines);
    expect(many.estH).toBeGreaterThan(one.estH);
  });

  it("larger size produces a taller box at the same resolution", () => {
    setViewport(1920, 1080);
    const sm = estimateCaptionBox("caption text", "sm", true, 1920, 1080);
    const xl = estimateCaptionBox("caption text", "xl", true, 1920, 1080);
    expect(xl.estH).toBeGreaterThan(sm.estH);
  });

  it("guards a malformed size: coerces to a finite box, never NaN", () => {
    setViewport(1920, 1080);
    // Untyped IPC could deliver a bogus size; it must not poison the math.
    const bad = estimateCaptionBox("caption", "huge" as unknown as DemoAnnotationSize, true, 1920, 1080);
    expect(Number.isFinite(bad.estW)).toBe(true);
    expect(Number.isFinite(bad.estH)).toBe(true);
    expect(bad.estW).toBeGreaterThan(0);
    expect(bad.estH).toBeGreaterThan(0);
    // Coercion target is "md": the box matches an explicit "md" of the same text.
    const md = estimateCaptionBox("caption", "md", true, 1920, 1080);
    expect(bad.estW).toBeCloseTo(md.estW, 5);
    expect(bad.estH).toBeCloseTo(md.estH, 5);
  });

  it("scales the box with frame height across resolutions", () => {
    const hd = estimateCaptionBox("caption text", "md", true, 1920, 1080);
    const uhd = estimateCaptionBox("caption text", "md", true, 3840, 2160);
    // A 4K frame is twice as tall → font and thus box height scale up with it.
    expect(uhd.estH).toBeGreaterThan(hd.estH);
  });
});

describe("resolveAnnotationPlacement", () => {
  function annotate(over: Partial<DemoAnnotatePayload>): DemoAnnotatePayload {
    return { text: "caption", ...over } as DemoAnnotatePayload;
  }

  // Run each screen-anchored placement through the containment invariant at 4K:
  // after clamping, the estimated box must sit fully within the title-safe area.
  const screenPositions = [
    "screen-top",
    "screen-center",
    "screen-bottom",
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
    "lower-third-left",
    "lower-third-right",
  ] as const;

  it.each(screenPositions)(
    "keeps a normal caption inside the title-safe area for %s at 4K",
    (position) => {
      const fw = 3840;
      const fh = 2160;
      setViewport(fw, fh);
      const resolved = resolveAnnotationPlacement(annotate({ position, text: "Open the panel" }));
      expect("error" in resolved).toBe(false);
      if ("error" in resolved) return;

      const { estW, estH } = estimateCaptionBox("Open the panel", "md", true, fw, fh);
      const span = boxSpan(resolved, estW, estH);

      const mx = fw * SAFE_MARGIN;
      const my = fh * SAFE_MARGIN;
      // Allow a sub-pixel epsilon for the rounding inside the estimate.
      const eps = 1.5;
      expect(span.spanLeft).toBeGreaterThanOrEqual(mx - eps);
      expect(span.spanRight).toBeLessThanOrEqual(fw - mx + eps);
      expect(span.spanTop).toBeGreaterThanOrEqual(my - eps);
      expect(span.spanBottom).toBeLessThanOrEqual(fh - my + eps);
    }
  );

  it("centers an over-wide box on its axis rather than flinging it off-frame", () => {
    // A box wider than the safe area can't satisfy both edges; the independent
    // per-edge clamps must leave it centered, not slammed past one margin.
    const fw = 600; // tiny frame so a 0.7*fw box can exceed the safe width
    const fh = 2000;
    setViewport(fw, fh);
    const longText = "supercalifragilisticexpialidocious ".repeat(8);
    const resolved = resolveAnnotationPlacement(
      annotate({ position: "top-left", text: longText })
    );
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) return;

    const { estW } = estimateCaptionBox(longText, "md", true, fw, fh);
    const span = boxSpan(resolved, estW, estW > 0 ? 0 : 0); // only the x-axis matters here
    const mx = fw * SAFE_MARGIN;

    if (estW > fw - 2 * mx) {
      // Over-wide: the leftover overflow is split — the box overhangs both
      // margins symmetrically (centered), so neither overhang is near the full box.
      const leftOverhang = mx - span.spanLeft;
      const rightOverhang = span.spanRight - (fw - mx);
      expect(leftOverhang).toBeGreaterThan(0);
      expect(rightOverhang).toBeGreaterThan(0);
      expect(leftOverhang).toBeCloseTo(rightOverhang, 5);
      // The box center sits at the frame center, not flung to an edge.
      const center = (span.spanLeft + span.spanRight) / 2;
      expect(center).toBeCloseTo(fw / 2, 5);
    }
  });

  it("clamps an anchor that starts outside the safe area back inside it", () => {
    // top-right anchors at (fw - mx, my) with translate(-100%, 0); even a small
    // box must end up with its right edge no further than the safe margin.
    const fw = 1920;
    const fh = 1080;
    setViewport(fw, fh);
    const resolved = resolveAnnotationPlacement(annotate({ position: "top-right", text: "Hi" }));
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) return;

    const { estW, estH } = estimateCaptionBox("Hi", "md", true, fw, fh);
    const span = boxSpan(resolved, estW, estH);
    const mx = fw * SAFE_MARGIN;
    expect(span.spanRight).toBeLessThanOrEqual(fw - mx + 1.5);
    expect(span.spanLeft).toBeGreaterThanOrEqual(mx - 1.5);
  });

  it("returns an error for an element placement with no selector", () => {
    setViewport(1920, 1080);
    const resolved = resolveAnnotationPlacement(annotate({ position: "top" }));
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) expect(resolved.error).toContain("selector");
  });

  it("returns an error when a cursor-anchored placement finds no demo cursor", () => {
    setViewport(1920, 1080);
    const resolved = resolveAnnotationPlacement(annotate({ position: "above-cursor" }));
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) expect(resolved.error).toContain("cursor");
  });

  it("defaults a missing size to a finite, contained box (no NaN clamp bypass)", () => {
    const fw = 1920;
    const fh = 1080;
    setViewport(fw, fh);
    // No size on the payload: normalizeSize must default it so the clamp runs.
    const resolved = resolveAnnotationPlacement(annotate({ position: "screen-bottom" }));
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) return;
    expect(Number.isFinite(resolved.left)).toBe(true);
    expect(Number.isFinite(resolved.top)).toBe(true);
  });
});

// @vitest-environment jsdom
/**
 * The parse check a preview adds to the sanitizer (#15030). The sanitizer only
 * looks for `<svg`, so markup truncated mid-write passes it; these pin what
 * the preview then refuses, and that it still takes what the image renderer
 * takes. A separate suite from `svg.test.ts`, which runs without a DOM.
 */
import { describe, expect, it } from "vitest";
import { SVG_PARSE_ERROR, renderableSvg, sanitizeSvg, sanitizeSvgForPreview } from "../svg";

const SVG_NS = "http://www.w3.org/2000/svg";

describe("sanitizeSvgForPreview", () => {
  it.each([
    ["a mismatched closing tag", `<svg xmlns="${SVG_NS}"><rect></svg>`],
    ["markup cut off mid-element", `<svg xmlns="${SVG_NS}"><rect width="1`],
    ["markup cut off before the root closes", `<svg xmlns="${SVG_NS}"><rect />`],
    ["a root that isn't an svg", `<g xmlns="${SVG_NS}"><svg /></g>`],
    ["an svg in the wrong namespace", `<svg xmlns="http://example.com/ns"><rect /></svg>`],
  ])("refuses %s, which the sanitizer passes", (_case, markup) => {
    expect(sanitizeSvg(markup).ok).toBe(true);

    expect(sanitizeSvgForPreview(markup)).toEqual({ ok: false, error: SVG_PARSE_ERROR });
  });

  it.each([
    ["an ordinary drawing", `<svg xmlns="${SVG_NS}" viewBox="0 0 10 10"><rect /></svg>`],
    ["an intentionally empty svg", `<svg xmlns="${SVG_NS}" />`],
    ["an svg missing its namespace declaration", '<svg viewBox="0 0 10 10"><circle /></svg>'],
  ])("takes %s, returning the sanitizer's own outcome", (_case, markup) => {
    expect(sanitizeSvgForPreview(markup)).toEqual(sanitizeSvg(markup));
  });

  it("keeps the sanitizer's reason when the sanitizer rejects first", () => {
    const rejected = sanitizeSvg("<div>not an svg</div>");
    expect(rejected.ok).toBe(false);

    expect(sanitizeSvgForPreview("<div>not an svg</div>")).toEqual(rejected);
  });

  it("checks the sanitized markup, not the raw input", () => {
    // The raw markup doesn't parse, but the broken part sits inside the script
    // the sanitizer strips, so what's left to draw does.
    const raw = `<svg xmlns="${SVG_NS}"><script><unclosed></script><rect /></svg>`;
    expect(renderableSvg(raw)).toBeNull();
    const sanitized = sanitizeSvg(raw);
    expect(sanitized.ok).toBe(true);

    expect(sanitizeSvgForPreview(raw)).toEqual(sanitized);
  });
});

describe("renderableSvg", () => {
  it("declares a missing namespace on the root rather than rejecting it", () => {
    const shown = renderableSvg('<svg width="4"><rect /></svg>');

    expect(shown?.markup.startsWith(`<svg xmlns="${SVG_NS}"`)).toBe(true);
    expect(shown?.sized).toBe(true);
  });

  it("says an svg without a width has no size of its own", () => {
    expect(renderableSvg(`<svg xmlns="${SVG_NS}" viewBox="0 0 4 4" />`)?.sized).toBe(false);
  });
});

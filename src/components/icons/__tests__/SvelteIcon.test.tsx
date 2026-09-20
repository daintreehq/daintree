// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SvelteIcon } from "../brands/SvelteIcon";

/**
 * The official asset is a coloured blob under a white ribbon, and the reduction
 * that makes it theme-safe is fragile in one specific way: reintroduce the
 * ribbon as a second shape and the mark still "looks right" on white while
 * painting an untinted slab everywhere else.
 */
describe("SvelteIcon", () => {
  it("carries no colour of its own", () => {
    const { container } = render(<SvelteIcon />);
    const svg = container.querySelector("svg")!;
    const paint = [svg, ...svg.querySelectorAll<SVGElement>("*")].flatMap((el) =>
      ["fill", "stroke", "color"]
        .flatMap((prop) => [el.getAttribute(prop), el.style?.getPropertyValue(prop)])
        .filter((value): value is string => !!value)
    );
    // Both halves matter: a literal colour would ignore the theme, and no
    // declared paint at all would fall back to black rather than inheriting.
    expect(paint.filter((value) => value !== "currentColor" && value !== "none")).toEqual([]);
    expect(paint).toContain("currentColor");
  });

  it("keeps the ribbon as a hole in the blob", () => {
    const { container } = render(<SvelteIcon />);
    const paths = container.querySelectorAll("path");
    // One shape is the whole guarantee: a hole inherits the surface behind it,
    // so nothing is left that could need a second ink. The ribbon has to still
    // be in there as a subpath of it, under a rule that knocks it out —
    // dropping it would leave a legible-looking slab with no S in it.
    expect(paths).toHaveLength(1);
    expect(paths[0]!.getAttribute("d")?.match(/M/gi)?.length).toBeGreaterThan(1);
    expect(paths[0]!.getAttribute("fill-rule")).toBe("evenodd");
  });

  it("is decorative and takes its name from the control around it", () => {
    const { container } = render(<SvelteIcon />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.hasAttribute("aria-label")).toBe(false);
  });

  it("fills a square box so it sizes like its siblings", () => {
    const { container } = render(<SvelteIcon />);
    const [, , width, height] = container
      .querySelector("svg")!
      .getAttribute("viewBox")!
      .split(/\s+/)
      .map(Number);
    expect(width).toBe(height);
  });
});

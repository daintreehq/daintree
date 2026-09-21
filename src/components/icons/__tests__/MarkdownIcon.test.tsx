// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownIcon } from "../brands/MarkdownIcon";

describe("MarkdownIcon", () => {
  it("carries no colour of its own", () => {
    const { container } = render(<MarkdownIcon />);
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

  it("anchors the glyphs inside the enclosure", () => {
    const { container } = render(<MarkdownIcon />);
    const d = container.querySelector("path")!.getAttribute("d")!;
    // Upstream ships the glyphs as their own path, opened by a relative
    // moveto. Joined onto the enclosure that moveto has to be absolute: left
    // relative it resolves against the ring's last subpath and drops the M and
    // arrow 15 units, which still looks like a plausible path in review.
    expect(d).toMatch(/zM30 98v-68/);
    expect(d.match(/m/gi)).toHaveLength(4);
  });

  it("is decorative and takes its name from the control around it", () => {
    const { container } = render(<MarkdownIcon />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.hasAttribute("aria-label")).toBe(false);
  });

  it("centres the mark in a square box so it sizes like its siblings", () => {
    const { container } = render(<MarkdownIcon />);
    const [x = NaN, y = NaN, width = NaN, height = NaN] = container
      .querySelector("svg")!
      .getAttribute("viewBox")!
      .split(/\s+/)
      .map(Number);
    expect(width).toBe(height);
    // The native mark is 208x128, so the box has to hold it and share its
    // centre; a square box alone is satisfied by an off-centre or empty one.
    expect(width).toBeGreaterThanOrEqual(208);
    expect(x + width / 2).toBe(104);
    expect(y + height / 2).toBe(64);
  });
});

// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AGENT_ICON_MAP } from "@/config/agentIcons";
import { KiroIcon } from "../brands/KiroIcon";

/**
 * The render half of the brand-mark gate. The resolver suites prove a legible
 * ink is chosen for every colour; this proves the glyphs actually take it. An
 * SVG that kept a fill of its own would pass every resolver assertion and still
 * paint the wrong colour on screen.
 */
const icons = Object.entries(AGENT_ICON_MAP);

/**
 * Paint attributes on shapes that actually render. Anything inside a `<mask>` is
 * excluded: its black and white are geometry (show/hide), not colour.
 */
function renderedPaint(svg: Element): string[] {
  return [...svg.querySelectorAll("*")]
    .filter((el) => !el.closest("mask"))
    .flatMap((el) =>
      ["fill", "stroke"].map((a) => el.getAttribute(a)).filter((v): v is string => v !== null)
    );
}

describe("brand icons paint from the ink BrandMark chose", () => {
  it("covers the whole icon registry", () => {
    expect(icons.length).toBeGreaterThan(15);
  });

  it.each(icons)("%s hardcodes no colour of its own", (_id, Icon) => {
    const { container } = render(<Icon />);
    // `none` is legitimate (stroke-only marks); `url(#…)` is a mask reference.
    // A literal colour is not — it would ignore the theme entirely.
    const offending = renderedPaint(container.querySelector("svg")!).filter(
      (value) => value !== "currentColor" && value !== "none" && !value.startsWith("url(")
    );
    expect(offending).toEqual([]);
  });

  it("gives concurrent Kiro marks their own mask ids", () => {
    // Kiro is the one mark that masks; a fixed DOM id makes every `url(#…)`
    // resolve to whichever instance landed in the document first, so a second
    // mark on screen would wear the first one's geometry.
    const { container } = render(
      <>
        <KiroIcon />
        <KiroIcon />
      </>
    );

    const masks = [...container.querySelectorAll("mask")];
    const ids = masks.map((mask) => mask.getAttribute("id"));
    expect(ids.filter(Boolean)).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    const referenced = [...container.querySelectorAll("g[mask]")].map((g) =>
      g.getAttribute("mask")
    );
    expect(referenced).toEqual(ids.map((id) => `url(#${id})`));
  });
});

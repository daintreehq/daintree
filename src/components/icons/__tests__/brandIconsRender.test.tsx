// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AGENT_ICON_MAP } from "@/config/agentIcons";
import { BrandMark } from "../BrandMark";

/**
 * The render half of the #11895 gate. `brandBadgeRegistry.test.ts` proves the
 * resolver picks a legible ink for every registered color; this proves the
 * glyphs actually take that ink. A brand SVG that kept a hardcoded fill would
 * pass the resolver suite and still render the wrong color on screen.
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

describe("brand icons paint from the badge ink", () => {
  it("covers every brand icon in the registry", () => {
    expect(icons.length).toBeGreaterThan(15);
  });

  it.each(icons)("%s hardcodes no colour of its own", (_id, Icon) => {
    const { container } = render(<Icon />);
    // `none` is legitimate (stroke-only marks); `url(#…)` is a mask reference.
    // A literal colour is not — it would survive the knockout and ignore the
    // tile beneath it.
    const offending = renderedPaint(container.querySelector("svg")!).filter(
      (v) => v !== "currentColor" && v !== "none" && !v.startsWith("url(")
    );
    expect(offending).toEqual([]);
  });

  it.each(icons)("%s inherits the ink BrandMark chose", (_id, Icon) => {
    // #111111 forces white ink; the glyph must end up inheriting it rather than
    // carrying its own color.
    const { container } = render(
      <BrandMark brandColor="#111111">
        <Icon />
      </BrandMark>
    );
    const wrapper = container.querySelector<HTMLElement>("span")!;
    expect(wrapper.style.color).toBe("rgb(255, 255, 255)");
    expect(container.querySelector<SVGElement>("svg")!.style.color).toBe("inherit");
  });
});

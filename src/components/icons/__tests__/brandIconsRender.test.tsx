// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AGENT_ICON_MAP } from "@/config/agentIcons";
import { AGENT_REGISTRY } from "@/config/agents";
import { BrandMark } from "../BrandMark";
import { ClaudeIcon } from "../brands/ClaudeIcon";
import { KiroIcon } from "../brands/KiroIcon";

vi.mock("@/hooks/useActiveAppScheme", async () => {
  const { BUILT_IN_APP_SCHEMES: schemes } = await import("@shared/theme");
  return { useActiveAppScheme: () => schemes[0]! };
});

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
function renderedPaint(svg: SVGElement): string[] {
  // The root counts too: several marks carry their paint on the `<svg>` itself
  // (`fill="none"` plus `stroke="currentColor"`), so scanning descendants alone
  // would let a hardcoded root stroke straight through. `style` is scanned for
  // the same reason — an inline fill is a colour like any other.
  return [svg, ...svg.querySelectorAll("*")]
    .filter((el) => !el.closest("mask"))
    .flatMap((el) => [
      ...["fill", "stroke", "color", "stop-color"]
        .map((attr) => el.getAttribute(attr))
        .filter((value): value is string => value !== null),
      ...["fill", "stroke", "color"]
        .map((prop) => (el as SVGElement).style?.getPropertyValue(prop))
        .filter((value): value is string => !!value),
    ]);
}

describe("brand icons paint from the ink BrandMark chose", () => {
  it("covers every icon the agent registry actually asks for", () => {
    // A count would let icons quietly disappear; what matters is that every
    // registered agent's `iconId` resolves to a real module in this map.
    const wanted = [...new Set(Object.values(AGENT_REGISTRY).map((config) => config.iconId))];
    expect(wanted.length).toBeGreaterThan(0);
    expect(wanted.filter((id) => !Object.hasOwn(AGENT_ICON_MAP, id))).toEqual([]);
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

  it("wires the real resolver through to the real glyph", () => {
    // Every other BrandMark test mocks the resolver, which means all of them
    // would still pass if the component stopped passing the brand colour in, or
    // passed the same one for everybody. This one runs the real thing.
    const render1 = render(
      <BrandMark brandColor="#cc785c">
        <ClaudeIcon />
      </BrandMark>
    );
    const render2 = render(
      <BrandMark brandColor="#3ee6eb">
        <ClaudeIcon />
      </BrandMark>
    );

    const read = (result: ReturnType<typeof render>) => {
      const svg = result.container.querySelector("svg")!;
      return {
        rest: svg.style.getPropertyValue("--brand-mark-rest"),
        active: svg.style.getPropertyValue("--brand-mark-active"),
      };
    };
    const warm = read(render1);
    const cyan = read(render2);

    for (const ink of [warm, cyan]) {
      expect(ink.rest).toMatch(/^#[0-9a-f]{6}$/i);
      expect(ink.active).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // Different brand colours must produce different inks, or the colour is not
    // reaching the resolver at all.
    expect(warm.rest).not.toBe(cyan.rest);
    expect(warm.active).not.toBe(cyan.active);
    // And the resting ink must be a faded version of the brand rather than the
    // brand hex handed straight through.
    expect(warm.rest.toLowerCase()).not.toBe("#cc785c");
    expect(warm.rest.toLowerCase()).not.toBe(warm.active.toLowerCase());
  });
});

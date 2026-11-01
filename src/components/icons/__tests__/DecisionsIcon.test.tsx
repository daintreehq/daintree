// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DecisionsIcon } from "../brands/DecisionsIcon";
import { DecisionsIcon as FromBarrel } from "../index";
import { SETTINGS_REGISTRY, globalTabIcons } from "@/components/Settings/settingsTabRegistry";

describe("DecisionsIcon", () => {
  it("is exported through the icons barrel", () => {
    expect(FromBarrel).toBe(DecisionsIcon);
  });

  it("paints from the current text colour only, so every theme sets its ink", () => {
    const { container } = render(<DecisionsIcon />);
    const svg = container.querySelector("svg")!;
    const paints = [svg, ...svg.querySelectorAll("*")].flatMap((el) =>
      ["fill", "stroke", "color"].map((attr) => el.getAttribute(attr)).filter((v) => v !== null)
    );
    expect(paints.length).toBeGreaterThan(0);
    expect(paints.filter((v) => v !== "currentColor" && v !== "none")).toEqual([]);
  });

  it("keeps the question mark as holes cut from the diamond, not a second colour", () => {
    const { container } = render(<DecisionsIcon />);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    expect(paths[0]!.getAttribute("fill-rule")).toBe("evenodd");
    // Diamond outline, question-mark stem and dot: three closed subpaths. Losing the
    // stem and dot would leave a plain diamond, which is a different mark.
    expect(paths[0]!.getAttribute("d")!.match(/M/g)).toHaveLength(3);
  });

  it("sizes the artwork to the 20-unit live area of a 24-unit Lucide box", () => {
    const { container } = render(<DecisionsIcon />);
    const [x, y, w, h] = container
      .querySelector("svg")!
      .getAttribute("viewBox")!
      .split(" ")
      .map(Number);
    // The artwork's rounded tips span about 9..503 in its own 512 box.
    const ART = 494;
    expect(w).toBe(h);
    expect(x).toBe(y);
    expect(x! + w! / 2).toBeCloseTo(256, 5);
    expect((ART / w!) * 24).toBeCloseTo(20, 1);
  });

  it("defaults to 16px, takes a size, and is hidden from assistive tech", () => {
    const { container, rerender } = render(<DecisionsIcon />);
    const svg = () => container.querySelector("svg")!;
    expect(svg().getAttribute("width")).toBe("16");
    expect(svg().getAttribute("aria-hidden")).toBe("true");
    rerender(<DecisionsIcon size={20} />);
    expect(svg().getAttribute("height")).toBe("20");
  });

  it.each([
    ["the sidebar tab", () => SETTINGS_REGISTRY.find((e) => e.id === "decisions")!.icon],
    ["the page header", () => globalTabIcons.decisions],
  ])("is %s's icon", (_where, icon) => {
    const { container } = render(<>{icon()}</>);
    expect(container.querySelector("svg path")?.getAttribute("fill-rule")).toBe("evenodd");
  });
});

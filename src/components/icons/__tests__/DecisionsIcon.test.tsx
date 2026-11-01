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

  it("keeps the question mark as a hole, not a second colour", () => {
    const { container } = render(<DecisionsIcon />);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    expect(paths[0]!.getAttribute("fill-rule")).toBe("evenodd");
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

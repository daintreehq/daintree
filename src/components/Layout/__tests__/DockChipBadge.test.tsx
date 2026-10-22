// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DockChipBadge } from "../DockChipBadge";

describe("DockChipBadge", () => {
  it("renders nothing without a model", () => {
    const { container } = render(<DockChipBadge model={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("draws a decorative count pill carrying its colour", () => {
    const { container } = render(
      <DockChipBadge model={{ countGlyph: "9+", color: "warning", description: "12 new" }} />
    );
    const mark = container.querySelector("[data-dock-chip-badge]")!;
    expect(mark.getAttribute("data-dock-chip-badge")).toBe("count");
    expect(mark.getAttribute("data-badge-color")).toBe("warning");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.textContent).toBe("9+");
    expect(mark.getAttribute("role")).toBeNull();
  });

  it("draws a dot with no text", () => {
    const { container } = render(
      <DockChipBadge model={{ countGlyph: null, color: "default", description: "badge" }} />
    );
    const mark = container.querySelector("[data-dock-chip-badge]")!;
    expect(mark.getAttribute("data-dock-chip-badge")).toBe("dot");
    expect(mark.textContent).toBe("");
  });
});

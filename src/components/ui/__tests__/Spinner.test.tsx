// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Spinner } from "../Spinner";

describe("Spinner", () => {
  it("renders an SVG with animate-spin and motion-reduce classes", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg!.className.baseVal).toContain("animate-spin");
    expect(svg!.className.baseVal).toContain("motion-reduce:animate-none");
  });

  it("has aria-hidden by default", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  it("applies default md size classes", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg");
    expect(svg!.className.baseVal).toContain("w-4");
    expect(svg!.className.baseVal).toContain("h-4");
  });

  it("applies correct classes for each size", () => {
    const sizes = {
      xs: ["w-3", "h-3"],
      sm: ["w-3.5", "h-3.5"],
      md: ["w-4", "h-4"],
      lg: ["w-5", "h-5"],
      xl: ["w-6", "h-6"],
      "2xl": ["w-8", "h-8"],
    } as const;

    for (const [size, [w, h]] of Object.entries(sizes)) {
      const { container } = render(<Spinner size={size as keyof typeof sizes} />);
      const svg = container.querySelector("svg");
      expect(svg!.className.baseVal).toContain(w);
      expect(svg!.className.baseVal).toContain(h);
    }
  });

  it("merges custom className", () => {
    const { container } = render(<Spinner className="text-status-info mb-4" />);
    const svg = container.querySelector("svg");
    expect(svg!.className.baseVal).toContain("text-status-info");
    expect(svg!.className.baseVal).toContain("mb-4");
  });
});

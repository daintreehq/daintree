// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Spinner } from "../Spinner";

describe("Spinner", () => {
  it("renders an SVG", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("has aria-hidden by default", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  it("merges custom className", () => {
    const { container } = render(<Spinner className="text-status-info mb-4" />);
    const svg = container.querySelector("svg");
    expect(svg!.className.baseVal).toContain("text-status-info");
    expect(svg!.className.baseVal).toContain("mb-4");
  });
});

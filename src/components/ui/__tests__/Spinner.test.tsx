// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Spinner } from "../Spinner";

function wrapperOf(container: HTMLElement): HTMLElement {
  const wrapper = container.firstElementChild;
  if (!(wrapper instanceof HTMLElement)) throw new Error("no wrapper rendered");
  return wrapper;
}

describe("Spinner", () => {
  it("renders an SVG", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("is hidden from assistive technology", () => {
    const { container } = render(<Spinner />);
    expect(wrapperOf(container).getAttribute("aria-hidden")).toBe("true");
  });

  it("rotates an HTML wrapper, never the svg, which Chromium cannot composite", () => {
    const { container } = render(<Spinner />);
    const wrapper = wrapperOf(container);
    expect(wrapper.tagName).toBe("SPAN");
    expect(wrapper.classList.contains("animate-spin")).toBe(true);
    expect(container.querySelector("svg")!.classList.contains("animate-spin")).toBe(false);
  });

  it("puts custom classes on the rotating wrapper, outside the glyph", () => {
    const { container } = render(<Spinner className="text-status-info mb-4" />);
    const wrapper = wrapperOf(container);
    expect(wrapper.classList.contains("text-status-info")).toBe(true);
    expect(wrapper.classList.contains("mb-4")).toBe(true);
    expect(container.querySelector("svg")!.className.baseVal).not.toContain("mb-4");
  });

  it("lets a size override in className replace the preset", () => {
    const { container } = render(<Spinner className="h-3.5 w-3.5" />);
    const wrapper = wrapperOf(container);
    expect(wrapper.classList.contains("w-3.5")).toBe(true);
    expect(wrapper.classList.contains("w-4")).toBe(false);
  });
});

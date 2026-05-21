// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TerminalResourceSparkline } from "../TerminalResourceSparkline";

describe("TerminalResourceSparkline", () => {
  it("renders nothing with fewer than 2 data points", () => {
    const { container } = render(<TerminalResourceSparkline history={[50]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders an end-cap dot that inherits color via currentColor", () => {
    const { container } = render(<TerminalResourceSparkline history={[10, 40, 70]} />);
    const circle = container.querySelector("circle");
    expect(circle).not.toBeNull();
    // The dot must inherit the parent severity tint, never carry its own color.
    expect(circle!.getAttribute("fill")).toBe("currentColor");
    expect(circle!.getAttribute("stroke")).toBe("none");
  });

  it("anchors the dot to the last data point at the right edge", () => {
    const { container } = render(<TerminalResourceSparkline history={[0, 0, 50]} />);
    const circle = container.querySelector("circle")!;
    // width=48; last x is the right edge.
    expect(circle.getAttribute("cx")).toBe("48");
    // 50% CPU over a 14px height => y = 14 - 7 = 7.
    expect(circle.getAttribute("cy")).toBe("7");
  });

  it("lets the edge-anchored dot render fully via overflow visible", () => {
    // cx=48 sits on the viewBox right edge; without overflow:visible the dot
    // would clip to a half-disk.
    const { container } = render(<TerminalResourceSparkline history={[10, 20, 30]} />);
    expect(container.querySelector("svg")!.getAttribute("overflow")).toBe("visible");
  });

  it("clamps the dot cy so it stays inside the viewBox at extremes", () => {
    const radius = 2;
    const { container: hot } = render(<TerminalResourceSparkline history={[0, 100]} />);
    // 100% CPU => raw y = 0, clamped up to the radius.
    expect(hot.querySelector("circle")!.getAttribute("cy")).toBe(String(radius));

    const { container: cold } = render(<TerminalResourceSparkline history={[100, 0]} />);
    // 0% CPU => raw y = 14, clamped down to height - radius.
    expect(cold.querySelector("circle")!.getAttribute("cy")).toBe(String(14 - radius));
  });

  it("renders the dot after the polyline so it draws on top", () => {
    const { container } = render(<TerminalResourceSparkline history={[10, 20, 30]} />);
    const svg = container.querySelector("svg")!;
    const children = Array.from(svg.children);
    expect(children[children.length - 1]!.tagName.toLowerCase()).toBe("circle");
  });
});

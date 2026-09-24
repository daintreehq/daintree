// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TerminalResourceSparkline } from "../TerminalResourceSparkline";

function draw(history: number[], capacity?: number) {
  const { container } = render(<TerminalResourceSparkline history={history} capacity={capacity} />);
  const svg = container.querySelector("svg");
  if (!svg) return null;
  const [, , width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
  const points = svg
    .querySelector("polyline")!
    .getAttribute("points")!
    .split(" ")
    .map((pair): [number, number] => {
      const [x = NaN, y = NaN] = pair.split(",").map(Number);
      return [x, y];
    });
  const circle = svg.querySelector("circle")!;
  return {
    svg,
    width: width!,
    height: height!,
    points,
    dot: {
      x: Number(circle.getAttribute("cx")),
      y: Number(circle.getAttribute("cy")),
      r: Number(circle.getAttribute("r")),
    },
    oneCore: svg.querySelector('[data-role="one-core"]'),
  };
}

describe("TerminalResourceSparkline", () => {
  it("renders nothing with fewer than 2 data points", () => {
    expect(draw([50])).toBeNull();
  });

  it("inherits the badge's tone rather than carrying a colour of its own", () => {
    const { svg } = draw([10, 40, 70])!;
    for (const el of svg.querySelectorAll("polyline, circle")) {
      const paint = el.getAttribute("fill") === "none" ? "stroke" : "fill";
      expect(el.getAttribute(paint)).toBe("currentColor");
    }
  });

  it("puts the end dot exactly on the last vertex, drawn over the line", () => {
    for (const history of [
      [0, 0, 50],
      [0, 100],
      [100, 0],
      [3, 1, 2, 1],
      [40, 380, 360],
    ]) {
      const { svg, points, dot } = draw(history)!;
      const [lastX, lastY] = points[points.length - 1]!;
      expect(dot.x).toBeCloseTo(lastX, 1);
      expect(dot.y).toBeCloseTo(lastY, 1);
      expect(svg.lastElementChild!.tagName.toLowerCase()).toBe("circle");
    }
  });

  it("keeps the whole dot and line inside the box at both extremes", () => {
    for (const history of [
      [0, 0],
      [100, 100],
      [0, 100, 0],
      [380, 400, 395],
    ]) {
      const { width, height, points, dot } = draw(history)!;
      expect(dot.x + dot.r).toBeLessThanOrEqual(width);
      expect(dot.y - dot.r).toBeGreaterThanOrEqual(0);
      expect(dot.y + dot.r).toBeLessThanOrEqual(height);
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(height);
      }
    }
  });

  it("draws higher CPU higher", () => {
    const { points } = draw([10, 40, 70, 20])!;
    const ys = points.map(([, y]) => y);
    expect(ys[1]).toBeLessThan(ys[0]!);
    expect(ys[2]).toBeLessThan(ys[1]!);
    expect(ys[3]).toBeGreaterThan(ys[2]!);
  });

  it("spaces samples by a fixed interval and right-aligns a short history", () => {
    const short = draw([10, 20])!;
    const long = draw([10, 20, 30, 40, 50, 60])!;
    const gap = (p: [number, number][]) => p[1]![0] - p[0]![0];
    expect(gap(short.points)).toBeCloseTo(gap(long.points), 1);
    expect(short.points[1]![0]).toBeCloseTo(long.points[5]![0], 1);
    // Two samples are one poll apart, not the whole window.
    expect(short.points[1]![0] - short.points[0]![0]).toBeLessThan(short.width / 4);
  });

  it("fills the width once the history holds a full window", () => {
    const capacity = 8;
    const { points, width } = draw(
      Array.from({ length: capacity }, (_, i) => i * 10),
      capacity
    )!;
    const span = points[points.length - 1]![0] - points[0]![0];
    expect(span).toBeGreaterThan(width * 0.85);
  });

  it("keeps one core as the ceiling while every sample fits under it", () => {
    const quiet = draw([0, 50, 100])!;
    expect(quiet.oneCore).toBeNull();
    // 100% touches the top of the plot area; nothing is drawn above it.
    const top = Math.min(...quiet.points.map(([, y]) => y));
    expect(top).toBeCloseTo(quiet.dot.r, 1);
  });

  it("grows past one core instead of flattening multi-core load into a fake plateau", () => {
    const { points, oneCore } = draw([200, 300, 400])!;
    const ys = points.map(([, y]) => y);
    // Each step up is still visible.
    expect(ys[1]).toBeLessThan(ys[0]!);
    expect(ys[2]).toBeLessThan(ys[1]!);
    // And the one-core rule marks where the old ceiling was, below the line.
    expect(oneCore).not.toBeNull();
    expect(Number(oneCore!.getAttribute("y1"))).toBeGreaterThan(ys[0]!);
  });
});

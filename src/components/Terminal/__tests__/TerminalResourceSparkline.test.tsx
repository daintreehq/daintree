// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MIN_SPARKLINE_SAMPLES, TerminalResourceSparkline } from "../TerminalResourceSparkline";

type Point = [number, number];

function parsePoints(attr: string | null): Point[] {
  return (attr ?? "").split(" ").map((pair): Point => {
    const [x = NaN, y = NaN] = pair.split(",").map(Number);
    return [x, y];
  });
}

function draw(history: number[], capacity?: number) {
  const { container } = render(<TerminalResourceSparkline history={history} capacity={capacity} />);
  const svg = container.querySelector("svg")!;
  const [, , width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
  const runs = Array.from(svg.querySelectorAll("polyline")).map((el) => ({
    el,
    over: el.hasAttribute("data-over-range"),
    points: parsePoints(el.getAttribute("points")),
  }));
  // Consecutive runs share their joining vertex; drop the repeat.
  const points = runs.flatMap((run, i) => (i === 0 ? run.points : run.points.slice(1)));
  const circle = svg.querySelector("circle");
  return {
    svg,
    width: width!,
    height: height!,
    runs,
    points,
    dot: circle
      ? {
          x: Number(circle.getAttribute("cx")),
          y: Number(circle.getAttribute("cy")),
          r: Number(circle.getAttribute("r")),
        }
      : null,
  };
}

/** Enough samples to draw, ending in the given values. */
function history(...tail: number[]): number[] {
  const lead = Math.max(0, MIN_SPARKLINE_SAMPLES - tail.length);
  return [...Array.from({ length: lead }, () => 10), ...tail];
}

describe("TerminalResourceSparkline", () => {
  it("holds its box but draws nothing until the history reads as a line", () => {
    const short = draw(Array.from({ length: MIN_SPARKLINE_SAMPLES - 1 }, () => 40));
    const full = draw(history(40));
    expect(short.runs).toHaveLength(0);
    expect(short.dot).toBeNull();
    expect(short.svg.getAttribute("width")).toBe(full.svg.getAttribute("width"));
    expect(full.runs.length).toBeGreaterThan(0);
  });

  it("inherits the badge's tone rather than carrying a colour of its own", () => {
    const { svg } = draw(history(10, 40, 70, 300, 320));
    for (const el of svg.querySelectorAll("polyline, circle")) {
      const paint = el.getAttribute("fill") === "none" ? "stroke" : "fill";
      expect(el.getAttribute(paint)).toBe("currentColor");
    }
  });

  it("puts the end dot exactly on the last vertex, drawn over the line", () => {
    for (const h of [
      history(0, 0, 50),
      history(0, 100),
      history(100, 0),
      history(3, 1, 2, 1),
      history(40, 380, 360),
    ]) {
      const { svg, points, dot } = draw(h);
      const [lastX, lastY] = points[points.length - 1]!;
      expect(dot!.x).toBeCloseTo(lastX, 1);
      expect(dot!.y).toBeCloseTo(lastY, 1);
      expect(svg.lastElementChild!.tagName.toLowerCase()).toBe("circle");
    }
  });

  it("keeps the whole dot and line inside the box at both extremes", () => {
    for (const h of [history(0, 0), history(100, 100), history(0, 100, 0), history(380, 400)]) {
      const { width, height, points, dot } = draw(h);
      expect(dot!.x + dot!.r).toBeLessThanOrEqual(width);
      expect(dot!.y - dot!.r).toBeGreaterThanOrEqual(0);
      expect(dot!.y + dot!.r).toBeLessThanOrEqual(height);
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(height);
      }
    }
  });

  it("draws higher CPU higher", () => {
    const { points } = draw(history(10, 40, 70, 20));
    const ys = points.slice(-4).map(([, y]) => y);
    expect(ys[1]).toBeLessThan(ys[0]!);
    expect(ys[2]).toBeLessThan(ys[1]!);
    expect(ys[3]).toBeGreaterThan(ys[2]!);
  });

  it("spaces samples by a fixed interval and right-aligns a short history", () => {
    const short = draw(history(10, 20));
    const long = draw([...history(), 10, 20, 30, 40, 50, 60]);
    const gap = (p: Point[]) => p[1]![0] - p[0]![0];
    expect(gap(short.points)).toBeCloseTo(gap(long.points), 1);
    expect(short.points[short.points.length - 1]![0]).toBeCloseTo(
      long.points[long.points.length - 1]![0],
      1
    );
    // A few samples are a few polls apart, not the whole window.
    const span = short.points[short.points.length - 1]![0] - short.points[0]![0];
    expect(span).toBeLessThan(short.width / 4);
  });

  it("fills the width once the history holds a full window", () => {
    const capacity = 8;
    const { points, width } = draw(
      Array.from({ length: capacity }, (_, i) => i * 10),
      capacity
    );
    const span = points[points.length - 1]![0] - points[0]![0];
    expect(span).toBeGreaterThan(width * 0.85);
  });

  it("maps a reading to the same height in every pane, whatever else that pane has seen", () => {
    const lastY = (h: number[]) => draw(h).dot!.y;
    expect(lastY(history(0, 0, 50))).toBeCloseTo(lastY(history(400, 380, 50)), 1);
    expect(lastY(history(100, 100, 50))).toBeCloseTo(lastY(history(10, 20, 50)), 1);
  });

  it("dashes the stretches above one core and draws the rest solid", () => {
    const { runs } = draw(history(20, 60, 300, 380, 360, 40));
    const over = runs.filter((r) => r.over);
    expect(over).toHaveLength(1);
    // The dashed run is exactly the three over-range samples, riding the ceiling.
    expect(over[0]!.points).toHaveLength(3);
    const ceilingY = over[0]!.points[0]![1];
    for (const [, y] of over[0]!.points) expect(y).toBeCloseTo(ceilingY, 1);
    expect(over[0]!.el.getAttribute("stroke-dasharray")).toBeTruthy();
    for (const run of runs.filter((r) => !r.over)) {
      expect(run.el.getAttribute("stroke-dasharray")).toBeNull();
    }
  });

  it("draws no dashed run while every sample fits under one core", () => {
    const { runs } = draw(history(0, 50, 100, 100, 99));
    expect(runs.some((r) => r.over)).toBe(false);
  });
});

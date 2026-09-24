import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { buildPulseCalendar } from "../pulseCalendar";

const HEATMAP_PATH = resolve(__dirname, "../PulseHeatmap.tsx");

describe("PulseHeatmap — isBeforeProject filtering (issue #4078)", () => {
  it("never places a pre-project day in the calendar", () => {
    const calendar = buildPulseCalendar([
      { date: "2026-03-02", count: 0, level: 0, isBeforeProject: true },
      { date: "2026-03-03", count: 0, level: 0, isBeforeProject: true },
      { date: "2026-03-04", count: 2, level: 2 },
      { date: "2026-03-05", count: 0, level: 0 },
    ]);
    expect(calendar.positions.has("2026-03-02")).toBe(false);
    expect(calendar.positions.has("2026-03-03")).toBe(false);
    expect(calendar.days.map((c) => c.date)).toEqual(["2026-03-04", "2026-03-05"]);
    // The pre-project slots of the first week are empty space, not quiet days.
    expect(calendar.weeks[0]!.slice(0, 2)).toEqual([null, null]);
  });

  it("does not render isBeforeProject cells with a distinct style", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).not.toContain("var(--pulse-before-bg");
  });

  it("does not produce 'Before project started' tooltip text", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).not.toContain("Before project started");
  });
});

describe("PulseHeatmap — ARIA grid + roving tabindex (issue #7229)", () => {
  it("uses ARIA grid roles", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain('role="grid"');
    expect(content).toContain('role="row"');
    expect(content).toContain('role="gridcell"');
    expect(content).not.toContain('role="group"');
  });

  it("implements roving tabindex from render state", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain("activeCellKey");
    expect(content).toContain("setActiveCellKey");
    expect(content).toContain("isActive ? 0 : -1");
    expect(content).not.toMatch(/tabIndex=\{0\}\s*\/>/);
  });

  it("ignores Alt/Shift+Arrow combos in the grid keyboard handler", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain("event.altKey || event.shiftKey");
  });

  it("registers cell refs and handles keyboard navigation on the grid", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain("cellRefs");
    expect(content).toContain("onKeyDown={handleKeyDown}");
    expect(content).toContain("ArrowRight");
    expect(content).toContain("ArrowLeft");
    expect(content).toContain("ArrowUp");
    expect(content).toContain("ArrowDown");
  });
});

import { describe, it, expect } from "vitest";
import type { DockLaunchBandId, DockLaunchRow } from "../dockLaunchItems";
import { headingBand, layoutLauncherColumns } from "../launcherColumnLayout";

function rows(band: DockLaunchBandId, count: number, prefix = band): DockLaunchRow[] {
  return Array.from(
    { length: count },
    (_, i) =>
      ({ kind: "cue", cue: "manage-agents", rowKey: `${prefix}-${i}`, band }) as DockLaunchRow
  );
}

function inventory({
  agents = 0,
  dock = 0,
  grid = 0,
  recipes = 0,
}: {
  agents?: number;
  dock?: number;
  grid?: number;
  recipes?: number;
}): DockLaunchRow[] {
  return [
    ...rows("agents", agents),
    ...rows("dock-panels", dock),
    ...rows("grid-panels", grid),
    ...rows("recipes", recipes),
    ...rows("actions", 2),
  ];
}

/** Column heights in rows, a heading counting 0.7, as the layout measures them. */
function heights(layout: ReturnType<typeof layoutLauncherColumns>): [number, number] {
  const result: [number, number] = [0, 0];
  let previous: { column: number; heading: DockLaunchBandId } | null = null;
  for (const row of layout.rows) {
    const column = layout.columnOf.get(row.rowKey);
    if (column === undefined) continue;
    const heading = headingBand(row.band);
    if (!previous || previous.column !== column || previous.heading !== heading) {
      result[column] += 0.7;
    }
    result[column] += 1;
    previous = { column, heading };
  }
  return result;
}

const SCENARIOS = {
  "the usual machine": { agents: 9, grid: 6, recipes: 3 },
  "every agent installed": { agents: 17, grid: 6, recipes: 3 },
  "fifteen plugin panels": { agents: 9, grid: 21, recipes: 3 },
  "two agents": { agents: 2, grid: 6, recipes: 1 },
  "a long recipe list": { agents: 4, grid: 6, recipes: 16 },
  "the dock, both destinations": { agents: 9, dock: 5, grid: 1, recipes: 3 },
};

describe("layoutLauncherColumns", () => {
  for (const [name, shape] of Object.entries(SCENARIOS)) {
    describe(name, () => {
      const input = inventory(shape);
      const layout = layoutLauncherColumns(input, true);

      it("keeps every row exactly once, with the footer last", () => {
        expect([...layout.rows].sort((a, b) => a.rowKey.localeCompare(b.rowKey))).toEqual(
          [...input].sort((a, b) => a.rowKey.localeCompare(b.rowKey))
        );
        expect(layout.rows.slice(-2).every((row) => row.band === "actions")).toBe(true);
      });

      it("reads down the first column before the second", () => {
        const columns = layout.rows
          .map((row) => layout.columnOf.get(row.rowKey))
          .filter((column) => column !== undefined);
        expect(columns).toEqual([...columns].sort());
      });

      it("keeps each section's own order", () => {
        for (const band of ["agents", "dock-panels", "grid-panels", "recipes"] as const) {
          const keys = layout.rows.filter((row) => row.band === band).map((row) => row.rowKey);
          expect(keys).toEqual(input.filter((row) => row.band === band).map((row) => row.rowKey));
        }
      });

      it("keeps the dock panels ahead of the grid panels", () => {
        const bands = layout.rows.map((row) => row.band);
        const lastDock = bands.lastIndexOf("dock-panels");
        const firstGrid = bands.indexOf("grid-panels");
        if (lastDock >= 0 && firstGrid >= 0) expect(lastDock).toBeLessThan(firstGrid);
      });

      it("leads the first column with the agents", () => {
        expect(layout.rows[0]!.band).toBe("agents");
        expect(layout.columnOf.get(layout.rows[0]!.rowKey)).toBe(0);
      });

      it("ends the two columns within a couple of rows of each other", () => {
        const [first, second] = heights(layout);
        expect(Math.abs(first - second)).toBeLessThanOrEqual(2.5);
      });

      it("never strands a single row of a split section", () => {
        for (const key of layout.continuedKeys) {
          const band = layout.rows.find((row) => row.rowKey === key)!.band;
          const inFirst = layout.rows.filter(
            (row) => row.band === band && layout.columnOf.get(row.rowKey) === 0
          ).length;
          const inSecond = layout.rows.filter(
            (row) => row.band === band && layout.columnOf.get(row.rowKey) === 1
          ).length;
          expect(Math.min(inFirst, inSecond)).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }

  it("repeats the heading only where a section continues across the break", () => {
    const split = layoutLauncherColumns(inventory({ agents: 17, grid: 6, recipes: 3 }), true);
    expect(split.continuedKeys.size).toBe(1);
    const whole = layoutLauncherColumns(inventory({ agents: 9, grid: 6, recipes: 3 }), true);
    expect(whole.continuedKeys.size).toBe(0);
  });

  it("prefers whole sections when they balance nearly as well", () => {
    // Agents against panels + recipes is already close; splitting would add a
    // second heading to save less than a row.
    const layout = layoutLauncherColumns(inventory({ agents: 9, grid: 6, recipes: 3 }), true);
    expect(layout.continuedKeys.size).toBe(0);
    const firstColumnBands = new Set(
      layout.rows.filter((row) => layout.columnOf.get(row.rowKey) === 0).map((row) => row.band)
    );
    expect([...firstColumnBands]).toEqual(["agents"]);
  });

  it("keeps panels ahead of a long recipe list rather than reorder and split", () => {
    const layout = layoutLauncherColumns(inventory({ agents: 4, grid: 6, recipes: 16 }), true);
    const bands = layout.rows.map((row) => row.band);
    expect(bands.lastIndexOf("grid-panels")).toBeLessThan(bands.indexOf("recipes"));
  });

  it("still lets recipes join a short agent list when nothing has to split", () => {
    const layout = layoutLauncherColumns(inventory({ agents: 2, grid: 6, recipes: 1 }), true);
    const first = layout.rows.filter((row) => layout.columnOf.get(row.rowKey) === 0);
    expect(new Set(first.map((row) => row.band))).toEqual(new Set(["agents", "recipes"]));
    expect(layout.continuedKeys.size).toBe(0);
  });

  it("keeps the model's order in one column", () => {
    const input = inventory({ agents: 17, grid: 6, recipes: 3 });
    const layout = layoutLauncherColumns(input, false);
    expect(layout.rows).toEqual(input);
    expect(layout.continuedKeys.size).toBe(0);
    expect(new Set(layout.columnOf.values())).toEqual(new Set([0]));
  });

  it("is a pure function of the inventory", () => {
    const input = inventory({ agents: 9, grid: 21, recipes: 3 });
    expect(layoutLauncherColumns(input, true)).toEqual(layoutLauncherColumns(input, true));
  });
});

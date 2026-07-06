import { describe, expect, it } from "vitest";
import {
  distributeWebglBudget,
  PER_SURFACE_WEBGL_MAX,
  WEBGL_BUDGET_HYSTERESIS_GAP,
} from "../webglBudget";

describe("distributeWebglBudget", () => {
  it("returns empty for no surfaces", () => {
    expect(distributeWebglBudget([], 24)).toEqual([]);
  });

  it("grants full demand when the ceiling covers it", () => {
    const budgets = distributeWebglBudget(
      [
        { surfaceId: "a", wants: 5 },
        { surfaceId: "b", wants: 3 },
      ],
      24
    );
    expect(budgets.find((b) => b.surfaceId === "a")!.upperThreshold).toBe(5);
    expect(budgets.find((b) => b.surfaceId === "b")!.upperThreshold).toBe(3);
  });

  it("never exceeds the machine ceiling in total", () => {
    const budgets = distributeWebglBudget(
      [
        { surfaceId: "a", wants: 12 },
        { surfaceId: "b", wants: 12 },
        { surfaceId: "c", wants: 12 },
      ],
      20
    );
    const total = budgets.reduce((sum, b) => sum + b.upperThreshold, 0);
    expect(total).toBe(20);
    // Waterfill is fair: 20 across three equal demands → 7/7/6.
    expect(budgets.map((b) => b.upperThreshold).sort((x, y) => y - x)).toEqual([7, 7, 6]);
  });

  it("caps every surface at the single-view safe threshold", () => {
    const budgets = distributeWebglBudget([{ surfaceId: "a", wants: 40 }], 100);
    expect(budgets[0]!.upperThreshold).toBe(PER_SURFACE_WEBGL_MAX);
  });

  it("surfaces that want less donate the remainder to surfaces that want more", () => {
    const budgets = distributeWebglBudget(
      [
        { surfaceId: "hungry", wants: 12 },
        { surfaceId: "idle", wants: 1 },
      ],
      13
    );
    expect(budgets.find((b) => b.surfaceId === "hungry")!.upperThreshold).toBe(12);
    expect(budgets.find((b) => b.surfaceId === "idle")!.upperThreshold).toBe(1);
  });

  it("the ceiling is a hard total: a ceiling below the surface count zeroes the tail", () => {
    const budgets = distributeWebglBudget(
      [
        { surfaceId: "a", wants: 5 },
        { surfaceId: "b", wants: 5 },
        { surfaceId: "c", wants: 5 },
        { surfaceId: "d", wants: 5 },
      ],
      2
    );
    expect(budgets.map((b) => b.upperThreshold)).toEqual([1, 1, 0, 0]);
    expect(budgets.reduce((sum, b) => sum + b.upperThreshold, 0)).toBe(2);
  });

  it("every surface keeps a floor of one slot so its first hot terminal is not DOM-doomed", () => {
    const budgets = distributeWebglBudget(
      [
        { surfaceId: "a", wants: 12 },
        { surfaceId: "b", wants: 0 },
      ],
      12
    );
    expect(budgets.find((b) => b.surfaceId === "b")!.upperThreshold).toBe(1);
  });

  it("keeps the anti-flap hysteresis gap on every budget", () => {
    const budgets = distributeWebglBudget(
      [
        { surfaceId: "a", wants: 9 },
        { surfaceId: "b", wants: 1 },
      ],
      24
    );
    for (const budget of budgets) {
      expect(budget.lowerThreshold).toBe(
        Math.max(0, budget.upperThreshold - WEBGL_BUDGET_HYSTERESIS_GAP)
      );
      expect(budget.lowerThreshold).toBeLessThanOrEqual(budget.upperThreshold);
    }
  });

  it("is deterministic: ties resolve in input order", () => {
    const run = () =>
      distributeWebglBudget(
        [
          { surfaceId: "a", wants: 12 },
          { surfaceId: "b", wants: 12 },
        ],
        15
      );
    expect(run()).toEqual(run());
    const budgets = run();
    // Odd remainder goes to the first surface in input order.
    expect(budgets[0]!.upperThreshold).toBe(8);
    expect(budgets[1]!.upperThreshold).toBe(7);
  });
});

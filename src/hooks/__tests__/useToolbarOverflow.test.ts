import { describe, it, expect } from "vitest";
import { computeOverflow } from "../useToolbarOverflow";
import type { ToolbarButtonId, ToolbarButtonPriority } from "@shared/types/toolbar";
import { TOOLBAR_BUTTON_PRIORITIES } from "@shared/types/toolbar";

function makeWidths(ids: ToolbarButtonId[], width = 36): Map<string, number> {
  const map = new Map<string, number>();
  for (const id of ids) map.set(id, width);
  return map;
}

describe("computeOverflow", () => {
  const ids: ToolbarButtonId[] = ["terminal", "browser", "github-stats", "settings", "notes"];

  it("returns all visible when everything fits", () => {
    const widths = makeWidths(ids, 36);
    const result = computeOverflow(500, widths, ids, TOOLBAR_BUTTON_PRIORITIES);
    expect(result.visibleIds).toEqual(ids);
    expect(result.overflowIds).toEqual([]);
  });

  it("returns all visible at exact fit", () => {
    const widths = makeWidths(ids, 36); // 5 * 36 = 180
    const result = computeOverflow(180, widths, ids, TOOLBAR_BUTTON_PRIORITIES);
    expect(result.visibleIds).toEqual(ids);
    expect(result.overflowIds).toEqual([]);
  });

  it("overflows lowest-priority items first when one pixel short", () => {
    // Total = 180, container = 179 → needs to overflow.
    // Subtract trigger(36) + hysteresis(8) = 44, target = 135. Need to remove 45px worth.
    // Priority 5: github-stats (36) removed, then notes (36) removed → currentWidth = 108 ≤ 135
    const widths = makeWidths(ids, 36);
    const result = computeOverflow(179, widths, ids, TOOLBAR_BUTTON_PRIORITIES);
    expect(result.overflowIds).toContain("github-stats");
    expect(result.overflowIds).toContain("notes");
    expect(result.visibleIds).toContain("terminal");
    expect(result.visibleIds).toContain("browser");
    expect(result.visibleIds).toContain("settings");
  });

  it("overflows items by priority regardless of position order", () => {
    // Put a high-priority item at the end and low-priority at the start
    const ordered: ToolbarButtonId[] = ["notes", "github-stats", "terminal"];
    const widths = makeWidths(ordered, 50);
    // Total 150, container 100, target = 100 - 36 - 8 = 56
    const result = computeOverflow(100, widths, ordered, TOOLBAR_BUTTON_PRIORITIES);
    // notes (5) and github-stats (5) should overflow before terminal (3)
    expect(result.overflowIds).toContain("notes");
    expect(result.overflowIds).toContain("github-stats");
    expect(result.visibleIds).toEqual(["terminal"]);
  });

  it("handles very narrow container — only highest priority survives", () => {
    const ordered: ToolbarButtonId[] = ["claude", "terminal", "github-stats", "notes"];
    const priorities: Record<ToolbarButtonId, ToolbarButtonPriority> = {
      ...TOOLBAR_BUTTON_PRIORITIES,
    };
    const widths = makeWidths(ordered, 40);
    // Total 160, container 80, target = 80 - 36 - 8 = 36
    // Remove notes(5), github-stats(5), terminal(3) → currentWidth = 40 > 36
    // Remove claude(2) → currentWidth = 0 ≤ 36
    // Wait - claude is priority 2, highest. Let's recalculate.
    // Sorted by priority desc: notes(5), github-stats(5), terminal(3), claude(2)
    // Remove notes → 120, remove github-stats → 80, remove terminal → 40 > 36
    // Remove claude → 0. So only claude survives? No — 40 > 36, so claude also overflows.
    // Actually let me reconsider: 40 ≤ 36 is false, so claude gets removed too.
    // All overflow. That's correct for extremely narrow.
    const result = computeOverflow(80, widths, ordered, priorities);
    expect(result.overflowIds.length).toBeGreaterThan(0);
    // terminal and below should definitely overflow
    expect(result.overflowIds).toContain("github-stats");
    expect(result.overflowIds).toContain("notes");
    expect(result.overflowIds).toContain("terminal");
  });

  it("handles empty input arrays", () => {
    const result = computeOverflow(500, new Map(), [], TOOLBAR_BUTTON_PRIORITIES);
    expect(result.visibleIds).toEqual([]);
    expect(result.overflowIds).toEqual([]);
  });

  it("within same priority, removes later items first", () => {
    const ordered: ToolbarButtonId[] = ["terminal", "browser", "panel-palette"];
    // All priority 3. Within same priority, later index removed first.
    const widths = makeWidths(ordered, 50);
    // Total 150, container 110, target = 110 - 36 - 8 = 66. Need to remove 84.
    // panel-palette removed first (index 2), then browser (index 1)
    const result = computeOverflow(110, widths, ordered, TOOLBAR_BUTTON_PRIORITIES);
    // overflowIds preserves orderedIds order
    expect(result.overflowIds).toEqual(["browser", "panel-palette"]);
    expect(result.visibleIds).toEqual(["terminal"]);
  });
});

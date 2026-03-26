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
    // targetWidth = 179 - 0(trigger) - 8(hysteresis) = 171
    // Sorted for removal: notes(5,idx4), settings(5,idx3), browser(3), terminal(3), github-stats(1)
    // Remove notes(36) → 144 ≤ 171. Stop.
    const widths = makeWidths(ids, 36);
    const result = computeOverflow(179, widths, ids, TOOLBAR_BUTTON_PRIORITIES);
    expect(result.overflowIds).toEqual(["notes"]);
    expect(result.visibleIds).toContain("terminal");
    expect(result.visibleIds).toContain("browser");
    expect(result.visibleIds).toContain("github-stats");
    expect(result.visibleIds).toContain("settings");
  });

  it("overflows items by priority regardless of position order", () => {
    // Put a high-priority item at the end and low-priority at the start
    const ordered: ToolbarButtonId[] = ["notes", "settings", "terminal"];
    const widths = makeWidths(ordered, 50);
    // Total 150, container 100, target = 100 - 36 - 8 = 56
    const result = computeOverflow(100, widths, ordered, TOOLBAR_BUTTON_PRIORITIES);
    // notes (5) and settings (5) should overflow before terminal (3)
    expect(result.overflowIds).toContain("notes");
    expect(result.overflowIds).toContain("settings");
    expect(result.visibleIds).toEqual(["terminal"]);
  });

  it("handles very narrow container — only highest priority survives", () => {
    const ordered: ToolbarButtonId[] = ["claude", "terminal", "settings", "notes"];
    const widths = makeWidths(ordered, 40);
    // Total 160, container 80, target = 80 - 36 - 8 = 36
    // Sorted by priority desc: settings(5), notes(5), terminal(3), claude(2)
    // Remove settings → 120, remove notes → 80, remove terminal → 40 > 36
    // Remove claude → 0 ≤ 36. All overflow for extremely narrow container.
    const result = computeOverflow(80, widths, ordered, TOOLBAR_BUTTON_PRIORITIES);
    expect(result.overflowIds.length).toBeGreaterThan(0);
    expect(result.overflowIds).toContain("settings");
    expect(result.overflowIds).toContain("notes");
    expect(result.overflowIds).toContain("terminal");
  });

  it("handles empty input arrays", () => {
    const result = computeOverflow(500, new Map(), [], TOOLBAR_BUTTON_PRIORITIES);
    expect(result.visibleIds).toEqual([]);
    expect(result.overflowIds).toEqual([]);
  });

  it("within same priority, removes later items first", () => {
    const ordered: ToolbarButtonId[] = ["settings", "notes", "copy-tree"];
    // All priority 5. Within same priority, later index removed first.
    const widths = makeWidths(ordered, 50);
    // Total 150, container 110, targetWidth = 110 - 0 - 8 = 102
    // copy-tree removed first (index 2): 150-50=100 ≤ 102. Stop.
    const result = computeOverflow(110, widths, ordered, TOOLBAR_BUTTON_PRIORITIES);
    expect(result.overflowIds).toEqual(["copy-tree"]);
    expect(result.visibleIds).toEqual(["settings", "notes"]);
  });
});

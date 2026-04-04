/**
 * Regression test for issue where trashing a terminal left it visible in the grid.
 *
 * Root cause: the `tabGroups` useMemo in ContentGrid (and ContentDock) only depended on
 * `storeTerminalIds`, which does NOT change when a terminal is trashed — only `terminalsById`
 * and `trashedTerminals` change. This meant the memo stayed stale and the trashed terminal
 * remained rendered.
 *
 * Fix: add `trashedTerminals` to both the useShallow selector and the tabGroups memo deps.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const GRID_PATH = resolve(__dirname, "../ContentGrid.tsx");
const DOCK_PATH = resolve(__dirname, "../../Layout/ContentDock.tsx");

describe("ContentGrid tabGroups memo includes trashedTerminals dep (trash-visibility regression)", () => {
  it("selects trashedTerminals from the store", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toContain("trashedTerminals: state.trashedTerminals");
  });

  it("destructures trashedTerminals from the useShallow selector", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toMatch(/const\s*\{[^}]*trashedTerminals[^}]*\}\s*=\s*useTerminalStore/s);
  });

  it("includes trashedTerminals in the tabGroups memo dependency array", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    // Find the tabGroups memo block and verify trashedTerminals is in its dep array
    const tabGroupsBlock = content.slice(content.indexOf("const tabGroups = useMemo("));
    const depsArrayMatch = tabGroupsBlock.match(/\[([^\]]+)\]/s);
    expect(depsArrayMatch).not.toBeNull();
    expect(depsArrayMatch![1]).toContain("trashedTerminals");
  });
});

describe("ContentDock tabGroups memo includes trashedTerminals dep (trash-visibility regression)", () => {
  it("includes trashedTerminals in the tabGroups memo dependency array", async () => {
    const content = await readFile(DOCK_PATH, "utf-8");
    const tabGroupsBlock = content.slice(content.indexOf("const tabGroups = useMemo("));
    // Match the dependency array: }, [deps]) — the bracket after "}, "
    const depsArrayMatch = tabGroupsBlock.match(/\},\s*\[([^\]]+)\]/s);
    expect(depsArrayMatch).not.toBeNull();
    expect(depsArrayMatch![1]).toContain("trashedTerminals");
  });
});

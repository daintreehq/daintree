import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";

const DND_PROVIDER_PATH = path.resolve(__dirname, "../DndProvider.tsx");

// Static-source guard for #14943: handleDragEnd is not unit-drivable, and a
// direct trashPanelGroup call on a Trash drop skips the unsaved-work prompts.
describe("DndProvider Trash drop wiring (#14943)", () => {
  it("hands a Trash drop to trashDroppedPanel before the layout snapshot", async () => {
    const source = await fs.readFile(DND_PROVIDER_PATH, "utf-8");
    const branch = source.match(
      /if\s*\(\s*overId\s*===\s*TRASH_DROPPABLE_ID\s*\)\s*\{([\s\S]*?)\breturn;\s*\}/
    );

    expect(branch?.[1].replace(/\s+/g, "")).toBe("trashDroppedPanel(draggedId);");
    expect(source).not.toMatch(/trashPanelGroup\(\s*draggedId\s*\)/);
    expect(source.indexOf("overId === TRASH_DROPPABLE_ID")).toBeLessThan(
      source.indexOf("pushLayoutSnapshot()")
    );
  });
});

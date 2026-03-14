import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";

describe("Trash Toast Removal - Issue #3113", () => {
  it("should not have terminalTrashUndoToast file", async () => {
    const filePath = path.resolve(__dirname, "../../../lib/terminalTrashUndoToast.ts");
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("should not reference showUndoToast in terminalStore", async () => {
    const filePath = path.resolve(__dirname, "../../../store/terminalStore.ts");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).not.toContain("showUndoToast");
    expect(content).not.toContain("terminalTrashUndoToast");
  });

  it("should not export TRASH_UNDO_TOAST_DURATION_MS from trash config", async () => {
    const filePath = path.resolve(__dirname, "../../../../shared/config/trash.ts");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).not.toContain("TRASH_UNDO_TOAST_DURATION_MS");
  });

  it("should have trash-pulse animation in index.css", async () => {
    const filePath = path.resolve(__dirname, "../../../index.css");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("@keyframes trash-pulse");
    expect(content).toContain(".animate-trash-pulse");
  });

  it("should include animate-trash-pulse in prefers-reduced-motion override", async () => {
    const filePath = path.resolve(__dirname, "../../../index.css");
    const content = await fs.readFile(filePath, "utf-8");
    const reducedMotionMatch = content.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([^}]*\{[^}]*\})*[^}]*/
    );
    expect(reducedMotionMatch).not.toBeNull();
    expect(reducedMotionMatch![0]).toContain("animate-trash-pulse");
  });
});

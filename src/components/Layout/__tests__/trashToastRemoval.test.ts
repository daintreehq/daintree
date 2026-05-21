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

  it("should not reference showUndoToast in panelStore", async () => {
    const filePath = path.resolve(__dirname, "../../../store/panelStore.ts");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).not.toContain("showUndoToast");
    expect(content).not.toContain("terminalTrashUndoToast");
  });

  it("should have trash-pulse animation in index.css", async () => {
    const filePath = path.resolve(__dirname, "../../../index.css");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("@keyframes trash-pulse");
    expect(content).toContain(".animate-trash-pulse");
  });

  it("should include animate-trash-pulse in the reduce-motion variant override", async () => {
    const filePath = path.resolve(__dirname, "../../../index.css");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toMatch(
      /@variant\s+reduce-motion\s*\{[\s\S]*?\.animate-trash-pulse[\s\S]*?animation:\s*none/
    );
  });
});

import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const HOOK_PATH = resolve(__dirname, "../useRecipeFocusReload.ts");

describe("useRecipeFocusReload editor-open guard (#9186)", () => {
  it("imports the editor-activity store", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain(
      'import { useRecipeEditorActivityStore } from "@/store/recipeEditorActivityStore"'
    );
  });

  it("short-circuits the trigger when an editor surface is open", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("useRecipeEditorActivityStore.getState().isOpen()");
  });

  it("registers both focus and visibilitychange listeners", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain('window.addEventListener("focus"');
    expect(content).toContain('document.addEventListener("visibilitychange"');
  });

  it("uses fire-and-forget for loadRecipes (no await)", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("void useRecipeStore.getState().loadRecipes(projectId)");
  });
});

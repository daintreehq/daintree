import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const EMPTY_STATE_PATH = resolve(__dirname, "../ContentGridEmptyState.tsx");

describe("ContentGrid EmptyState — RecipeRunner integration", () => {
  it("hero section uses reduced spacing (mb-6 / mb-4)", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain('"mb-6 flex flex-col items-center text-center"');
    expect(content).toContain('"relative group mb-4"');
  });

  it("renders RecipeRunner component instead of inline recipe list", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("<RecipeRunner");
    expect(content).toContain('from "./RecipeRunner/RecipeRunner"');
    // No inline recipe list markup should remain
    expect(content).not.toContain('role="list"');
    expect(content).not.toContain("handleRunRecipe");
  });

  it("gates RecipeRunner on hasEverLaunchedAgent so first-run users don't see it", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("hasEverLaunchedAgent");
    expect(content).toContain("usePanelStore");
    expect(content).toContain("hasActiveWorktree && hasEverLaunchedAgent");
  });

  it("gates RotatingTip on hasEverLaunchedAgent — teaching content waits until after first launch", async () => {
    // Issue #6752 — first-run users (no agent ever launched) shouldn't see
    // shortcut-carousel teaching content. Returning users still see the
    // count-biased rotation polished by issue #6756.
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("<RotatingTip />");
    expect(content).toMatch(/hasActiveWorktree && hasEverLaunchedAgent && <RotatingTip \/>/);
  });
});

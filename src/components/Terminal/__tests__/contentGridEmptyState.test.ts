import { describe, it, expect } from "vitest";
import { readFile, access } from "fs/promises";
import { resolve } from "path";

const EMPTY_STATE_PATH = resolve(__dirname, "../ContentGridEmptyState.tsx");
const TIPS_PATH = resolve(__dirname, "../contentGridTips.tsx");

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

  it("does not render RotatingTip — teaching content waits until after first launch", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).not.toContain("RotatingTip");
  });

  it("contentGridTips.tsx is deleted — issue #6752 removed the only call site so the file cleanup follows", async () => {
    // Issue #6752 stripped RotatingTip out of the empty state. With no remaining
    // call site the tips module would knip-fail as an unused file — this guard
    // keeps the cleanup intent explicit so a future re-introduction has to also
    // restore a real consumer.
    await expect(access(TIPS_PATH)).rejects.toThrow();
  });
});

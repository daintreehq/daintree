import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const EMPTY_STATE_PATH = resolve(__dirname, "../ContentGridEmptyState.tsx");
const TIPS_PATH = resolve(__dirname, "../contentGridTips.tsx");

describe("ContentGrid EmptyState — RecipeRunner integration", () => {
  it("hero section uses reduced spacing (mb-6 / mb-4)", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain('"mb-6 flex flex-col items-center text-center"');
    expect(content).toContain('"relative group mb-4"');
  });

  it("tip text uses /70 opacity, not /60", async () => {
    const content = await readFile(TIPS_PATH, "utf-8");
    expect(content).toContain("text-daintree-text/70 text-center");
    expect(content).not.toContain("text-daintree-text/60 text-center");
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
});

describe("ContentGrid TIPS live shortcut migration — issue #6437", () => {
  it("imports useKeybindingDisplay so tip shortcuts react to remaps", async () => {
    const content = await readFile(TIPS_PATH, "utf-8");
    expect(content).toMatch(/import \{ useKeybindingDisplay \} from "@\/hooks\/useKeybinding"/);
  });

  it("declares a messageWithShortcut field on TipEntry", async () => {
    const content = await readFile(TIPS_PATH, "utf-8");
    expect(content).toMatch(/messageWithShortcut\?: \(shortcut: string\) => React\.ReactNode/);
  });

  it("defines a LiveTipMessage component that calls useKeybindingDisplay", async () => {
    const content = await readFile(TIPS_PATH, "utf-8");
    expect(content).toContain("function LiveTipMessage");
    const liveTipMatch = content.match(/function LiveTipMessage\([\s\S]*?\n\}/);
    expect(liveTipMatch).not.toBeNull();
    expect(liveTipMatch![0]).toContain("useKeybindingDisplay(lookupId)");
    expect(liveTipMatch![0]).toContain("tip.messageWithShortcut");
  });

  it("falls back to the static tip.message when no shortcut is bound", async () => {
    const content = await readFile(TIPS_PATH, "utf-8");
    const liveTipMatch = content.match(/function LiveTipMessage\([\s\S]*?\n\}/);
    expect(liveTipMatch).not.toBeNull();
    expect(liveTipMatch![0]).toMatch(/return <>\{tip\.message\}<\/>/);
  });

  it("RotatingTip renders <LiveTipMessage tip={tip} /> instead of {tip.message} directly", async () => {
    const content = await readFile(TIPS_PATH, "utf-8");
    expect(content).toContain("<LiveTipMessage tip={tip} />");
    expect(content).not.toMatch(/Tip: \{tip\.message\}/);
  });

  it("shortcut-driven tips supply messageWithShortcut so the live combo renders inline", async () => {
    const content = await readFile(TIPS_PATH, "utf-8");
    const tipIds = [
      "quick-switcher",
      "panel-palette",
      "action-palette",
      "worktree-overview",
      "new-worktree",
    ];
    for (const id of tipIds) {
      const tipBlock = content.match(new RegExp(`id: "${id}",[\\s\\S]*?(?=\\n {2}\\},)`));
      expect(tipBlock, `Expected tip block for ${id}`).not.toBeNull();
      expect(tipBlock![0]).toContain("messageWithShortcut:");
    }
  });

  it("worktree-overview tip uses worktree.overview (the toggle action) for shortcut display", async () => {
    const content = await readFile(TIPS_PATH, "utf-8");
    const tipBlock = content.match(/id: "worktree-overview",[\s\S]*?(?=\n {2}\},)/);
    expect(tipBlock).not.toBeNull();
    expect(tipBlock![0]).toContain('shortcutActionId: "worktree.overview"');
  });
});

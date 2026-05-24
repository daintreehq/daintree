import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const CONTEXT_MENU_PATH = path.resolve(__dirname, "../context-menu.tsx");

describe("ContextMenuActionItem aria-keyshortcuts — issue #8941", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(CONTEXT_MENU_PATH, "utf-8");
  });

  it("imports useAriaKeyshortcuts from @/hooks", () => {
    expect(source).toContain('import { useAriaKeyshortcuts } from "@/hooks"');
  });

  it("calls useAriaKeyshortcuts with actionId in ContextMenuActionItem", () => {
    expect(source).toContain("useAriaKeyshortcuts(actionId)");
  });

  it("renders aria-keyshortcuts on ContextMenuItem", () => {
    expect(source).toContain("aria-keyshortcuts={ariaKeyshortcuts}");
  });
});

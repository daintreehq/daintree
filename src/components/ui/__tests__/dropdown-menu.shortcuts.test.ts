import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const DROPDOWN_MENU_PATH = path.resolve(__dirname, "../dropdown-menu.tsx");

describe("DropdownMenuActionItem aria-keyshortcuts — issue #8941", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(DROPDOWN_MENU_PATH, "utf-8");
  });

  it("imports useAriaKeyshortcuts from @/hooks", () => {
    expect(source).toContain('import { useAriaKeyshortcuts } from "@/hooks"');
  });

  it("calls useAriaKeyshortcuts with actionId in DropdownMenuActionItem", () => {
    expect(source).toContain("useAriaKeyshortcuts(actionId)");
  });

  it("renders aria-keyshortcuts on DropdownMenuItem", () => {
    expect(source).toContain("aria-keyshortcuts={ariaKeyshortcuts}");
  });
});

// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const HYBRID_INPUT_BAR_PATH = resolve(__dirname, "../HybridInputBar.tsx");

describe("HybridInputBar shortcut tooltips — issue #6434", () => {
  const source = readFileSync(HYBRID_INPUT_BAR_PATH, "utf-8");

  describe("stash button", () => {
    it("uses useKeybindingDisplay for terminal.popStash", () => {
      expect(source).toContain('useKeybindingDisplay("terminal.popStash")');
    });

    it("uses createTooltipContent for restore stashed input", () => {
      expect(source).toContain('createTooltipContent("Restore stashed input", popStashShortcut)');
    });

    it("does not hardcode shortcut in title attribute", () => {
      expect(source).not.toContain('title="Restore stashed input (');
    });

    it("does not hardcode Unicode shortcut glyphs", () => {
      expect(source).not.toMatch(/⌘/);
      expect(source).not.toMatch(/⌃/);
      expect(source).not.toMatch(/⇧/);
    });

    it("keeps accessibility aria-label", () => {
      expect(source).toContain('aria-label="Restore stashed input"');
    });
  });
});

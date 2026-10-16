import { describe, expect, it } from "vitest";
import {
  isWorktreeCustomTitleTooLong,
  normalizeWorktreeCustomTitle,
  worktreeCustomTitleLength,
} from "../worktreeCustomTitle";

describe("normalizeWorktreeCustomTitle", () => {
  it("collapses whitespace runs, including newlines and tabs, and trims", () => {
    expect(normalizeWorktreeCustomTitle("  Release \t\n prep  ")).toBe("Release prep");
  });

  it("strips zero-width characters so an invisible title normalises to empty", () => {
    expect(normalizeWorktreeCustomTitle("\u200B\u200C\u200D\uFEFF")).toBe("");
    expect(normalizeWorktreeCustomTitle("Re\u200Blease")).toBe("Release");
    expect(normalizeWorktreeCustomTitle("\u200D Release \u200C")).toBe("Release");
  });

  it("keeps a joiner inside the title, where it carries meaning", () => {
    const technologist = "\u{1F469}\u200D\u{1F4BB}";
    expect(normalizeWorktreeCustomTitle(` ${technologist} prep `)).toBe(`${technologist} prep`);
  });
});

describe("worktree custom title length", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(worktreeCustomTitleLength("\u{1F680}\u{1F680}")).toBe(2);
  });

  it("allows 80 code points and flags 81", () => {
    expect(isWorktreeCustomTitleTooLong("\u{1F680}".repeat(80))).toBe(false);
    expect(isWorktreeCustomTitleTooLong("\u{1F680}".repeat(81))).toBe(true);
  });
});

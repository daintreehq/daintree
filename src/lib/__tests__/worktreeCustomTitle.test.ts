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
    expect(normalizeWorktreeCustomTitle("​‌‍﻿")).toBe("");
    expect(normalizeWorktreeCustomTitle("Re​lease")).toBe("Release");
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

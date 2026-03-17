import { describe, it, expect } from "vitest";
import { parseConventionalCommit } from "../commitListUtils";

describe("parseConventionalCommit", () => {
  it("parses a standard conventional commit", () => {
    const result = parseConventionalCommit("feat(auth): add login flow");
    expect(result).toEqual({
      type: "feat",
      scope: "auth",
      breaking: false,
      description: "add login flow",
    });
  });

  it("parses a commit without scope", () => {
    const result = parseConventionalCommit("fix: resolve crash on startup");
    expect(result).toEqual({
      type: "fix",
      scope: null,
      breaking: false,
      description: "resolve crash on startup",
    });
  });

  it("parses a breaking change with !", () => {
    const result = parseConventionalCommit("feat!: remove deprecated API");
    expect(result).toEqual({
      type: "feat",
      scope: null,
      breaking: true,
      description: "remove deprecated API",
    });
  });

  it("parses a breaking change with scope and !", () => {
    const result = parseConventionalCommit("refactor(core)!: restructure module system");
    expect(result).toEqual({
      type: "refactor",
      scope: "core",
      breaking: true,
      description: "restructure module system",
    });
  });

  it("handles multi-word scopes", () => {
    const result = parseConventionalCommit("feat(user auth): add OAuth support");
    expect(result).toEqual({
      type: "feat",
      scope: "user auth",
      breaking: false,
      description: "add OAuth support",
    });
  });

  it("returns null for merge commits", () => {
    expect(parseConventionalCommit("Merge pull request #123 from branch")).toBeNull();
  });

  it("returns null for non-conventional messages", () => {
    expect(parseConventionalCommit("Updated the readme")).toBeNull();
  });

  it("returns null when no space after colon", () => {
    expect(parseConventionalCommit("feat:no-space")).toBeNull();
  });

  it("returns null for empty description", () => {
    expect(parseConventionalCommit("feat: ")).toBeNull();
  });

  it("rejects empty scope parentheses", () => {
    const result = parseConventionalCommit("feat(): add something");
    expect(result).toBeNull();
  });

  it("only parses the first line of multiline messages", () => {
    const result = parseConventionalCommit("fix(ui): button alignment\n\nMore details here");
    expect(result).toEqual({
      type: "fix",
      scope: "ui",
      breaking: false,
      description: "button alignment",
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseConventionalCommit,
  getCommitTypeColor,
  getCommitDateGroupLabel,
  buildGroupedRows,
} from "../commitListUtils";
import type { GitCommit } from "@shared/types/github";

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

  it("treats empty scope as null", () => {
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

describe("getCommitTypeColor", () => {
  it("returns green for feat", () => {
    expect(getCommitTypeColor("feat")).toBe("text-category-green");
  });

  it("returns rose for fix", () => {
    expect(getCommitTypeColor("fix")).toBe("text-category-rose");
  });

  it("is case-insensitive", () => {
    expect(getCommitTypeColor("FEAT")).toBe("text-category-green");
    expect(getCommitTypeColor("Fix")).toBe("text-category-rose");
  });

  it("returns muted for unknown types", () => {
    expect(getCommitTypeColor("unknown")).toBe("text-muted-foreground");
  });

  it("returns muted for chore/build/ci", () => {
    expect(getCommitTypeColor("chore")).toBe("text-muted-foreground");
    expect(getCommitTypeColor("build")).toBe("text-muted-foreground");
    expect(getCommitTypeColor("ci")).toBe("text-muted-foreground");
  });
});

describe("getCommitDateGroupLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Today" for commits from today', () => {
    const now = new Date("2025-06-15T14:00:00Z");
    vi.setSystemTime(now);
    expect(getCommitDateGroupLabel("2025-06-15T10:00:00Z", now)).toBe("Today");
  });

  it('returns "Yesterday" for commits from yesterday', () => {
    const now = new Date("2025-06-15T14:00:00Z");
    vi.setSystemTime(now);
    expect(getCommitDateGroupLabel("2025-06-14T10:00:00Z", now)).toBe("Yesterday");
  });

  it('returns "This Week" for commits 2-6 days ago', () => {
    const now = new Date("2025-06-15T14:00:00Z");
    vi.setSystemTime(now);
    expect(getCommitDateGroupLabel("2025-06-12T10:00:00Z", now)).toBe("This Week");
    expect(getCommitDateGroupLabel("2025-06-10T10:00:00Z", now)).toBe("This Week");
  });

  it("returns formatted date for older commits in same year", () => {
    const now = new Date("2025-06-15T14:00:00Z");
    vi.setSystemTime(now);
    const label = getCommitDateGroupLabel("2025-01-15T10:00:00Z", now);
    expect(label).toBe("Jan 15");
  });

  it("returns formatted date with year for different year", () => {
    const now = new Date("2025-06-15T14:00:00Z");
    vi.setSystemTime(now);
    const label = getCommitDateGroupLabel("2024-03-10T10:00:00Z", now);
    expect(label).toBe("Mar 10, 2024");
  });
});

describe("buildGroupedRows", () => {
  const makeCommit = (hash: string, date: string): GitCommit => ({
    hash,
    shortHash: hash.slice(0, 7),
    message: `commit ${hash}`,
    date,
    author: { name: "Test", email: "test@test.com" },
  });

  it("inserts separators between different date groups", () => {
    const now = new Date("2025-06-15T14:00:00Z");
    const commits = [
      makeCommit("aaa", "2025-06-15T12:00:00Z"),
      makeCommit("bbb", "2025-06-15T10:00:00Z"),
      makeCommit("ccc", "2025-06-14T10:00:00Z"),
    ];

    const rows = buildGroupedRows(commits, now);

    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ kind: "separator", label: "Today" });
    expect(rows[1]).toEqual({ kind: "commit", commit: commits[0] });
    expect(rows[2]).toEqual({ kind: "commit", commit: commits[1] });
    expect(rows[3]).toEqual({ kind: "separator", label: "Yesterday" });
    expect(rows[4]).toEqual({ kind: "commit", commit: commits[2] });
  });

  it("returns empty array for no commits", () => {
    expect(buildGroupedRows([])).toEqual([]);
  });

  it("handles single commit", () => {
    const now = new Date("2025-06-15T14:00:00Z");
    const commits = [makeCommit("aaa", "2025-06-15T12:00:00Z")];
    const rows = buildGroupedRows(commits, now);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ kind: "separator", label: "Today" });
    expect(rows[1]).toEqual({ kind: "commit", commit: commits[0] });
  });
});

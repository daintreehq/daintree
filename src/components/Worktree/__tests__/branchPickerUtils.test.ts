import { describe, it, expect } from "vitest";
import {
  formatBranchLabel,
  toBranchOption,
  filterBranches,
  buildBranchRows,
  type BranchOption,
  type BranchPickerRow,
} from "../branchPickerUtils";
import type { BranchInfo } from "@/types/electron";
import type { WorktreeState } from "@shared/types";

function makeBranchOption(name: string, overrides?: Partial<BranchOption>): BranchOption {
  return {
    name,
    isCurrent: false,
    isRemote: false,
    remoteName: null,
    labelText: name,
    searchText: name.toLowerCase(),
    ...overrides,
  };
}

function makeWorktreeState(branch: string): WorktreeState {
  return {
    id: `wt-${branch}`,
    path: `/worktrees/${branch}`,
    name: branch,
    branch,
    isCurrent: false,
    worktreeId: `wt-${branch}`,
    worktreeChanges: null,
    lastActivityTimestamp: null,
  };
}

function getSelectableRows(rows: BranchPickerRow[]) {
  return rows.filter((r) => r.kind === "option");
}

describe("branchPickerUtils", () => {
  describe("formatBranchLabel", () => {
    it("formats a regular branch", () => {
      const branch: BranchInfo = { name: "feature/test", current: false, commit: "abc123" };
      expect(formatBranchLabel(branch)).toBe("feature/test");
    });

    it("formats a current branch", () => {
      const branch: BranchInfo = { name: "main", current: true, commit: "def456" };
      expect(formatBranchLabel(branch)).toBe("main (current)");
    });

    it("formats a remote branch", () => {
      const branch: BranchInfo = {
        name: "origin/feature",
        current: false,
        commit: "ghi789",
        remote: "origin",
      };
      expect(formatBranchLabel(branch)).toBe("origin/feature (remote)");
    });

    it("formats a current remote branch", () => {
      const branch: BranchInfo = {
        name: "origin/main",
        current: true,
        commit: "jkl012",
        remote: "origin",
      };
      expect(formatBranchLabel(branch)).toBe("origin/main (current) (remote)");
    });
  });

  describe("toBranchOption", () => {
    it("converts BranchInfo to BranchOption", () => {
      const branch: BranchInfo = { name: "feature/test", current: false, commit: "abc123" };
      const option = toBranchOption(branch);

      expect(option).toEqual({
        name: "feature/test",
        isCurrent: false,
        isRemote: false,
        remoteName: null,
        labelText: "feature/test",
        searchText: "feature/test",
      });
    });

    it("converts current remote branch", () => {
      const branch: BranchInfo = {
        name: "origin/main",
        current: true,
        commit: "def456",
        remote: "origin",
      };
      const option = toBranchOption(branch);

      expect(option).toEqual({
        name: "origin/main",
        isCurrent: true,
        isRemote: true,
        remoteName: "origin",
        labelText: "origin/main (current) (remote)",
        searchText: "origin/main (current) (remote)",
      });
    });
  });

  describe("toBranchOption edge cases", () => {
    it("handles branch names with mixed case", () => {
      const branch: BranchInfo = {
        name: "Feature/Test",
        current: false,
        commit: "abc123",
      };
      const option = toBranchOption(branch);

      expect(option.labelText).toBe("Feature/Test");
      expect(option.searchText).toBe("feature/test");
    });

    it("handles remote branch without remote prefix in name", () => {
      const branch: BranchInfo = {
        name: "main",
        current: false,
        commit: "abc123",
        remote: "origin",
      };
      const option = toBranchOption(branch);

      expect(option.labelText).toBe("main (remote)");
      expect(option.isRemote).toBe(true);
      expect(option.remoteName).toBe("origin");
    });
  });

  describe("filterBranches (deprecated, backward compat)", () => {
    const branches: BranchOption[] = [
      makeBranchOption("main", { isCurrent: true, labelText: "main (current)", searchText: "main (current)" }),
      makeBranchOption("feature/auth"),
      makeBranchOption("feature/ui-improvements"),
      makeBranchOption("origin/develop", { isRemote: true, remoteName: "origin", labelText: "origin/develop (remote)", searchText: "origin/develop (remote)" }),
    ];

    it("returns all branches when query is empty", () => {
      const result = filterBranches(branches, "", 200);
      expect(result).toEqual(branches);
    });

    it("filters branches by substring (case-insensitive)", () => {
      const result = filterBranches(branches, "feature", 200);
      expect(result).toHaveLength(2);
      expect(result.map((b) => b.name)).toEqual(["feature/auth", "feature/ui-improvements"]);
    });

    it("handles empty branch list", () => {
      expect(filterBranches([], "", 200)).toEqual([]);
      expect(filterBranches([], "anything", 200)).toEqual([]);
    });

    it("handles limit of 0", () => {
      expect(filterBranches(branches, "", 0)).toEqual([]);
    });
  });

  describe("buildBranchRows", () => {
    const branches: BranchOption[] = [
      makeBranchOption("main"),
      makeBranchOption("feature/auth"),
      makeBranchOption("feature/ui-improvements"),
      makeBranchOption("feature/issue-2841-improve-branch-picker-fuzzy"),
      makeBranchOption("bugfix/login-crash"),
    ];

    describe("empty query (MRU sorting)", () => {
      it("returns all branches without section header when no recent branches", () => {
        const rows = buildBranchRows(branches, {
          query: "",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        const selectable = getSelectableRows(rows);
        expect(selectable).toHaveLength(5);
        expect(rows.every((r) => r.kind === "option")).toBe(true);
      });

      it("shows recent branches first with section header", () => {
        const rows = buildBranchRows(branches, {
          query: "",
          recentBranchNames: ["feature/auth", "main"],
          worktreeByBranch: new Map(),
        });

        expect(rows[0]).toEqual({ kind: "section", label: "Recent" });
        const selectable = getSelectableRows(rows);
        expect(selectable[0].name).toBe("feature/auth");
        expect(selectable[0].isRecent).toBe(true);
        expect(selectable[1].name).toBe("main");
        expect(selectable[1].isRecent).toBe(true);
        expect(selectable[2].isRecent).toBe(false);
      });

      it("respects MRU order for recent branches", () => {
        const rows = buildBranchRows(branches, {
          query: "",
          recentBranchNames: ["bugfix/login-crash", "feature/auth"],
          worktreeByBranch: new Map(),
        });

        const selectable = getSelectableRows(rows);
        expect(selectable[0].name).toBe("bugfix/login-crash");
        expect(selectable[1].name).toBe("feature/auth");
      });

      it("ignores recent branch names that don't exist in the branch list", () => {
        const rows = buildBranchRows(branches, {
          query: "",
          recentBranchNames: ["nonexistent", "feature/auth"],
          worktreeByBranch: new Map(),
        });

        const selectable = getSelectableRows(rows);
        const recent = selectable.filter((r) => r.isRecent);
        expect(recent).toHaveLength(1);
        expect(recent[0].name).toBe("feature/auth");
      });

      it("soft caps at emptyQueryLimit", () => {
        const manyBranches = Array.from({ length: 600 }, (_, i) =>
          makeBranchOption(`branch-${i}`)
        );
        const rows = buildBranchRows(manyBranches, {
          query: "",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
          emptyQueryLimit: 500,
        });

        const selectable = getSelectableRows(rows);
        expect(selectable.length).toBeLessThanOrEqual(500);
      });
    });

    describe("fuzzy search", () => {
      it("matches substring queries", () => {
        const rows = buildBranchRows(branches, {
          query: "auth",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });

        const selectable = getSelectableRows(rows);
        expect(selectable.length).toBeGreaterThanOrEqual(1);
        expect(selectable[0].name).toBe("feature/auth");
      });

      it("matches fuzzy queries across slash separators", () => {
        const rows = buildBranchRows(branches, {
          query: "feature auth",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });

        const selectable = getSelectableRows(rows);
        expect(selectable.length).toBeGreaterThanOrEqual(1);
        const names = selectable.map((r) => r.name);
        expect(names).toContain("feature/auth");
      });

      it("matches deep in branch name (ignoreLocation: true)", () => {
        const rows = buildBranchRows(branches, {
          query: "2841",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });

        const selectable = getSelectableRows(rows);
        expect(selectable.length).toBeGreaterThanOrEqual(1);
        expect(selectable[0].name).toBe("feature/issue-2841-improve-branch-picker-fuzzy");
      });

      it("returns match ranges for highlighting", () => {
        const rows = buildBranchRows(branches, {
          query: "auth",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });

        const selectable = getSelectableRows(rows);
        expect(selectable[0].matchRanges.length).toBeGreaterThan(0);
        // Fuse may return multiple non-contiguous ranges for fuzzy matching
        // Verify the ranges cover the characters in the match
        const allHighlighted = selectable[0].matchRanges.map((r) =>
          selectable[0].name.substring(r.start, r.end + 1)
        );
        expect(allHighlighted.join("")).toContain("au");
      });

      it("returns empty for no matches", () => {
        const rows = buildBranchRows(branches, {
          query: "zzzznonexistent",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        expect(getSelectableRows(rows)).toHaveLength(0);
      });

      it("no section headers in fuzzy results", () => {
        const rows = buildBranchRows(branches, {
          query: "feature",
          recentBranchNames: ["feature/auth"],
          worktreeByBranch: new Map(),
        });
        expect(rows.every((r) => r.kind === "option")).toBe(true);
      });
    });

    describe("special characters in branch names", () => {
      const specialBranches = [
        makeBranchOption("feature/foo-bar"),
        makeBranchOption("feature/foo_bar"),
        makeBranchOption("feature/foo.bar"),
        makeBranchOption("!hotfix/urgent"),
        makeBranchOption("^caret/branch"),
        makeBranchOption("$dollar/branch"),
      ];

      it("does not crash on branch names with !, ^, $ prefixes", () => {
        const rows = buildBranchRows(specialBranches, {
          query: "hotfix",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        expect(getSelectableRows(rows).length).toBeGreaterThanOrEqual(1);
      });

      it("matches branches with dots and underscores", () => {
        const rows = buildBranchRows(specialBranches, {
          query: "foo.bar",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        const selectable = getSelectableRows(rows);
        expect(selectable.length).toBeGreaterThanOrEqual(1);
        expect(selectable[0].name).toBe("feature/foo.bar");
      });
    });

    describe("worktree-in-use detection", () => {
      it("attaches worktree state to in-use branches", () => {
        const wt = makeWorktreeState("feature/auth");
        const worktreeByBranch = new Map([["feature/auth", wt]]);

        const rows = buildBranchRows(branches, {
          query: "",
          recentBranchNames: [],
          worktreeByBranch,
        });

        const selectable = getSelectableRows(rows);
        const authRow = selectable.find((r) => r.name === "feature/auth");
        expect(authRow?.inUseWorktree).toBe(wt);
      });

      it("leaves inUseWorktree null for non-in-use branches", () => {
        const rows = buildBranchRows(branches, {
          query: "",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });

        const selectable = getSelectableRows(rows);
        expect(selectable.every((r) => r.inUseWorktree === null)).toBe(true);
      });

      it("attaches worktree state in fuzzy results", () => {
        const wt = makeWorktreeState("feature/auth");
        const worktreeByBranch = new Map([["feature/auth", wt]]);

        const rows = buildBranchRows(branches, {
          query: "auth",
          recentBranchNames: [],
          worktreeByBranch,
        });

        const selectable = getSelectableRows(rows);
        expect(selectable[0].inUseWorktree).toBe(wt);
      });
    });

    describe("edge cases", () => {
      it("handles empty branch list", () => {
        const rows = buildBranchRows([], {
          query: "",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        expect(rows).toHaveLength(0);
      });

      it("handles empty branch list with query", () => {
        const rows = buildBranchRows([], {
          query: "test",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        expect(rows).toHaveLength(0);
      });

      it("handles whitespace-only query as empty", () => {
        const rows = buildBranchRows(branches, {
          query: "   ",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        const selectable = getSelectableRows(rows);
        expect(selectable).toHaveLength(5);
      });
    });
  });
});

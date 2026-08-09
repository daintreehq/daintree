import { describe, it, expect } from "vitest";
import {
  formatBranchLabel,
  toBranchOption,
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
    // Spread last would leave this optional-typed; pinned so the fixture always
    // satisfies BranchOption's required `string | null`.
    committerDate: overrides?.committerDate ?? null,
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

function namesFor(query: string, branches: readonly BranchOption[]): string[] {
  const { rows } = buildBranchRows(branches, {
    query,
    recentBranchNames: [],
    worktreeByBranch: new Map(),
  });
  return getSelectableRows(rows).map((r) => r.name);
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
        committerDate: null,
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
        committerDate: null,
      });
    });

    it("carries the committer date through when git supplied one", () => {
      const withDate = toBranchOption({
        name: "main",
        current: false,
        commit: "abc123",
        committerDate: "2026-08-01T10:00:00+00:00",
      });
      const withoutDate = toBranchOption({ name: "dev", current: false, commit: "def456" });

      expect(withDate.committerDate).toBe("2026-08-01T10:00:00+00:00");
      // Normalized to null rather than left undefined so row rendering has one
      // absence to check.
      expect(withoutDate.committerDate).toBeNull();
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
        const { rows } = buildBranchRows(branches, {
          query: "",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        const selectable = getSelectableRows(rows);
        expect(selectable).toHaveLength(5);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.kind === "option")).toBe(true);
      });

      it("shows recent branches first with section header", () => {
        const { rows } = buildBranchRows(branches, {
          query: "",
          recentBranchNames: ["feature/auth", "main"],
          worktreeByBranch: new Map(),
        });

        expect(rows[0]).toEqual({ kind: "section", label: "Recent" });
        const selectable = getSelectableRows(rows);
        expect(selectable[0]!.name).toBe("feature/auth");
        expect(selectable[0]!.isRecent).toBe(true);
        expect(selectable[1]!.name).toBe("main");
        expect(selectable[1]!.isRecent).toBe(true);
        expect(selectable[2]!.isRecent).toBe(false);
      });

      it("respects MRU order for recent branches", () => {
        const { rows } = buildBranchRows(branches, {
          query: "",
          recentBranchNames: ["bugfix/login-crash", "feature/auth"],
          worktreeByBranch: new Map(),
        });

        const selectable = getSelectableRows(rows);
        expect(selectable[0]!.name).toBe("bugfix/login-crash");
        expect(selectable[1]!.name).toBe("feature/auth");
      });

      it("ignores recent branch names that don't exist in the branch list", () => {
        const { rows } = buildBranchRows(branches, {
          query: "",
          recentBranchNames: ["nonexistent", "feature/auth"],
          worktreeByBranch: new Map(),
        });

        const selectable = getSelectableRows(rows);
        const recent = selectable.filter((r) => r.isRecent);
        expect(recent).toHaveLength(1);
        expect(recent[0]!.name).toBe("feature/auth");
      });

      it("caps at emptyQueryLimit", () => {
        const manyBranches = Array.from({ length: 600 }, (_, i) => makeBranchOption(`branch-${i}`));
        const { rows } = buildBranchRows(manyBranches, {
          query: "",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
          emptyQueryLimit: 500,
        });

        expect(getSelectableRows(rows)).toHaveLength(500);
      });

      it("counts the Recent band against the cap instead of letting it overrun", () => {
        // Every branch is "recent", so an implementation that budgets only the
        // non-recent tail would render all 600 while the footnote claims fewer.
        const manyBranches = Array.from({ length: 600 }, (_, i) => makeBranchOption(`branch-${i}`));
        const { rows } = buildBranchRows(manyBranches, {
          query: "",
          recentBranchNames: manyBranches.map((b) => b.name),
          worktreeByBranch: new Map(),
          emptyQueryLimit: 500,
        });

        expect(getSelectableRows(rows)).toHaveLength(500);
      });
    });

    describe("search", () => {
      it("matches substring queries", () => {
        expect(namesFor("auth", branches)[0]).toBe("feature/auth");
      });

      it("finds branches from a single character instead of emptying the list", () => {
        // The reported regression: `minMatchCharLength: 2` made every 1-char
        // query return nothing, so typing replaced the list with "no matches".
        const fMatches = namesFor("f", branches);
        expect(fMatches).toContain("feature/auth");
        expect(fMatches).toContain("bugfix/login-crash");
        expect(fMatches).not.toContain("main");

        expect(namesFor("b", branches)).toContain("bugfix/login-crash");
      });

      it("requires every token of a multi-token query to match", () => {
        const matches = namesFor("feature 2841", branches);
        expect(matches).toEqual(["feature/issue-2841-improve-branch-picker-fuzzy"]);
      });

      it("matches multi-token queries against long slash-separated names", () => {
        const withTerrain = [...branches, makeBranchOption("feature/voxel-terrain")];
        expect(namesFor("feat terr", withTerrain)).toContain("feature/voxel-terrain");
      });

      it("matches fuzzy queries across slash separators", () => {
        expect(namesFor("feature auth", branches)).toContain("feature/auth");
      });

      it("rejects a query whose second token matches nothing", () => {
        expect(namesFor("feature zzzznonexistent", branches)).toHaveLength(0);
      });

      it("matches deep in branch name (ignoreLocation: true)", () => {
        expect(namesFor("2841", branches)[0]).toBe(
          "feature/issue-2841-improve-branch-picker-fuzzy"
        );
      });

      it("returns match ranges covering the matched characters", () => {
        const [row] = getSelectableRows(
          buildBranchRows(branches, {
            query: "auth",
            recentBranchNames: [],
            worktreeByBranch: new Map(),
          }).rows
        );

        expect(row!.matchRanges.length).toBeGreaterThan(0);
        const highlighted = row!.matchRanges
          .map(([start, end]) => row!.name.substring(start, end + 1))
          .join("");
        expect(highlighted).toContain("auth");
      });

      it("returns empty for no matches", () => {
        expect(namesFor("zzzznonexistent", branches)).toHaveLength(0);
      });

      it("no section headers in search results", () => {
        const { rows } = buildBranchRows(branches, {
          query: "feature",
          recentBranchNames: ["feature/auth"],
          worktreeByBranch: new Map(),
        });
        expect(rows.every((r) => r.kind === "option")).toBe(true);
      });

      it("ranks a name-prefix match above an interior one", () => {
        // The prefix match is deliberately LAST in source order, so a matcher with
        // no ranking at all would fail this.
        const candidates = [
          makeBranchOption("release/x"),
          makeBranchOption("hotfix/two"),
          makeBranchOption("fix/one"),
        ];
        // Single character takes the literal path, where prefix beats interior.
        expect(namesFor("f", candidates)[0]).toBe("fix/one");
      });

      it("keeps the best-ranked literal matches when the result cap bites", () => {
        // Single character, so this is the literal matcher, where prefix beats
        // interior. The one prefix match sits past the 200-row cap in source
        // order, so slicing before sorting would discard it entirely.
        const filler = Array.from({ length: 400 }, (_, i) => makeBranchOption(`zz-f-${i}`));
        const candidates = [...filler, makeBranchOption("f-wins")];

        const names = namesFor("f", candidates);

        expect(names).toHaveLength(200);
        expect(names[0]).toBe("f-wins");
      });
    });

    describe("label metadata is searchable", () => {
      const labelled: BranchOption[] = [
        makeBranchOption("main", {
          isCurrent: true,
          labelText: "main (current)",
          searchText: "main (current)",
        }),
        makeBranchOption("origin/develop", {
          isRemote: true,
          remoteName: "origin",
          labelText: "origin/develop (remote)",
          searchText: "origin/develop (remote)",
        }),
        makeBranchOption("feature/plain"),
      ];

      it("reaches the checked-out branch by typing its status word", () => {
        // `searchText` existed but nothing keyed it, so the "(current)" the row
        // displayed could not be typed.
        expect(namesFor("current", labelled)).toEqual(["main"]);
      });

      it("reaches remote branches by typing their status word", () => {
        expect(namesFor("remote", labelled)).toEqual(["origin/develop"]);
      });
    });

    describe("extended-search operator characters stay literal", () => {
      const specialBranches = [
        makeBranchOption("feature/foo-bar"),
        makeBranchOption("feature/foo_bar"),
        makeBranchOption("feature/foo.bar"),
        makeBranchOption("!hotfix/urgent"),
        makeBranchOption("$dollar/branch"),
      ];

      it("does not crash on branch names with ! and $ prefixes", () => {
        expect(namesFor("hotfix", specialBranches).length).toBeGreaterThanOrEqual(1);
      });

      it("treats a leading ! as text, never as fuse's inverse operator", () => {
        // Extended search reads `!foo` as "must NOT contain foo". A user typing a
        // branch name that starts with `!` must get that branch, not its complement.
        expect(namesFor("!hotfix", specialBranches)).toEqual(["!hotfix/urgent"]);
      });

      it("treats a leading $ as text, not fuse's suffix anchor", () => {
        expect(namesFor("$dollar", specialBranches)).toEqual(["$dollar/branch"]);
      });

      it("treats | as text, not fuse's OR operator", () => {
        expect(namesFor("foo|bar", specialBranches)).toHaveLength(0);
      });

      it.each([
        ["=", "=equals/branch"],
        ["'", "'quote/branch"],
        ['"', '"dquote/branch'],
        ["^", "^caret/branch"],
      ])("treats a leading %s as text rather than an operator", (_operator, branchName) => {
        // Each of these is an extended-search operator; dropping any one from the
        // routing regex would let fuse reinterpret the query instead of matching it.
        const candidates = [...specialBranches, makeBranchOption(branchName)];
        expect(namesFor(branchName, candidates)).toEqual([branchName]);
      });

      it("matches branches with dots and underscores", () => {
        expect(namesFor("foo.bar", specialBranches)[0]).toBe("feature/foo.bar");
      });
    });

    describe("worktree-in-use detection", () => {
      it("attaches worktree state to in-use branches", () => {
        const wt = makeWorktreeState("feature/auth");
        const worktreeByBranch = new Map([["feature/auth", wt]]);

        const { rows } = buildBranchRows(branches, {
          query: "",
          recentBranchNames: [],
          worktreeByBranch,
        });

        const authRow = getSelectableRows(rows).find((r) => r.name === "feature/auth");
        expect(authRow?.inUseWorktree).toBe(wt);
      });

      it("leaves inUseWorktree null for non-in-use branches", () => {
        const { rows } = buildBranchRows(branches, {
          query: "",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });

        const selectable = getSelectableRows(rows);
        expect(selectable.length).toBeGreaterThan(0);
        expect(selectable.every((r) => r.inUseWorktree === null)).toBe(true);
      });

      it("attaches worktree state in search results", () => {
        const wt = makeWorktreeState("feature/auth");
        const { rows } = buildBranchRows(branches, {
          query: "auth",
          recentBranchNames: [],
          worktreeByBranch: new Map([["feature/auth", wt]]),
        });

        expect(getSelectableRows(rows)[0]!.inUseWorktree).toBe(wt);
      });
    });

    describe("edge cases", () => {
      it("handles empty branch list", () => {
        const { rows } = buildBranchRows([], {
          query: "",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        expect(rows).toHaveLength(0);
      });

      it("handles empty branch list with query", () => {
        const { rows } = buildBranchRows([], {
          query: "test",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        expect(rows).toHaveLength(0);
      });

      it("handles whitespace-only query as empty", () => {
        const { rows } = buildBranchRows(branches, {
          query: "   ",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        expect(getSelectableRows(rows)).toHaveLength(5);
      });

      it("reports how many candidates qualified before the display cap", () => {
        // What tells the panel it truncated. Without it a capped search would drop
        // results with nothing on screen saying so.
        const many = Array.from({ length: 600 }, (_, i) => makeBranchOption(`branch-${i}`));

        const empty = buildBranchRows(many, {
          query: "",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
          emptyQueryLimit: 500,
        });
        expect(getSelectableRows(empty.rows)).toHaveLength(500);
        expect(empty.matchedTotal).toBe(600);

        // 600 branches all contain "branch", so the 200-result cap bites.
        const searched = buildBranchRows(many, {
          query: "branch",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });
        expect(getSelectableRows(searched.rows)).toHaveLength(200);
        expect(searched.matchedTotal).toBe(600);
      });

      it("reports the matched count, not the branch count, for a narrow search", () => {
        const result = buildBranchRows(branches, {
          query: "feature",
          recentBranchNames: [],
          worktreeByBranch: new Map(),
        });

        expect(result.matchedTotal).toBe(getSelectableRows(result.rows).length);
        expect(result.matchedTotal).toBeLessThan(branches.length);
      });

      it("carries the committer date onto rows", () => {
        const dated = [
          makeBranchOption("main", { committerDate: "2026-08-01T10:00:00+00:00" }),
          makeBranchOption("dev"),
        ];
        const rows = getSelectableRows(
          buildBranchRows(dated, {
            query: "",
            recentBranchNames: [],
            worktreeByBranch: new Map(),
          }).rows
        );

        expect(rows.find((r) => r.name === "main")!.committerDate).toBe(
          "2026-08-01T10:00:00+00:00"
        );
        expect(rows.find((r) => r.name === "dev")!.committerDate).toBeNull();
      });
    });
  });
});

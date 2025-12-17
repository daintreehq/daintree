import { describe, it, expect } from "vitest";
import {
  formatBranchLabel,
  toBranchOption,
  filterBranches,
  type BranchOption,
} from "../branchPickerUtils";
import type { BranchInfo } from "@/types/electron";

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

  describe("filterBranches", () => {
    const branches: BranchOption[] = [
      {
        name: "main",
        isCurrent: true,
        isRemote: false,
        remoteName: null,
        labelText: "main (current)",
        searchText: "main (current)",
      },
      {
        name: "feature/auth",
        isCurrent: false,
        isRemote: false,
        remoteName: null,
        labelText: "feature/auth",
        searchText: "feature/auth",
      },
      {
        name: "feature/ui-improvements",
        isCurrent: false,
        isRemote: false,
        remoteName: null,
        labelText: "feature/ui-improvements",
        searchText: "feature/ui-improvements",
      },
      {
        name: "origin/develop",
        isCurrent: false,
        isRemote: true,
        remoteName: "origin",
        labelText: "origin/develop (remote)",
        searchText: "origin/develop (remote)",
      },
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

    it("filters by case-insensitive match", () => {
      const result = filterBranches(branches, "FEATURE", 200);
      expect(result).toHaveLength(2);
    });

    it("matches partial strings", () => {
      const result = filterBranches(branches, "ui", 200);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("feature/ui-improvements");
    });

    it("matches labels including (current) and (remote)", () => {
      const result = filterBranches(branches, "current", 200);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("main");

      const result2 = filterBranches(branches, "remote", 200);
      expect(result2).toHaveLength(1);
      expect(result2[0].name).toBe("origin/develop");
    });

    it("limits results to specified limit", () => {
      const manyBranches = Array.from({ length: 300 }, (_, i) => ({
        name: `branch-${i}`,
        isCurrent: false,
        isRemote: false,
        remoteName: null,
        labelText: `branch-${i}`,
        searchText: `branch-${i}`,
      }));

      const result = filterBranches(manyBranches, "", 200);
      expect(result).toHaveLength(200);
    });

    it("limits filtered results", () => {
      const manyFeatures = Array.from({ length: 300 }, (_, i) => ({
        name: `feature/branch-${i}`,
        isCurrent: false,
        isRemote: false,
        remoteName: null,
        labelText: `feature/branch-${i}`,
        searchText: `feature/branch-${i}`,
      }));

      const result = filterBranches(manyFeatures, "feature", 150);
      expect(result).toHaveLength(150);
    });

    it("returns empty array when no matches", () => {
      const result = filterBranches(branches, "nonexistent", 200);
      expect(result).toEqual([]);
    });

    it("handles empty branch list", () => {
      const result = filterBranches([], "", 200);
      expect(result).toEqual([]);

      const result2 = filterBranches([], "anything", 200);
      expect(result2).toEqual([]);
    });

    it("handles whitespace-only query as empty", () => {
      const result = filterBranches(branches, "   ", 200);
      expect(result).toEqual(branches);
    });

    it("trims query before matching", () => {
      const result = filterBranches(branches, " feature ", 200);
      expect(result).toHaveLength(2);
      expect(result.map((b) => b.name)).toEqual(["feature/auth", "feature/ui-improvements"]);
    });

    it("uses default limit of 200 when not specified", () => {
      const manyBranches = Array.from({ length: 300 }, (_, i) => ({
        name: `branch-${i}`,
        isCurrent: false,
        isRemote: false,
        remoteName: null,
        labelText: `branch-${i}`,
        searchText: `branch-${i}`,
      }));

      const result = filterBranches(manyBranches, "");
      expect(result).toHaveLength(200);
    });

    it("handles limit of 0", () => {
      const result = filterBranches(branches, "", 0);
      expect(result).toEqual([]);

      const result2 = filterBranches(branches, "feature", 0);
      expect(result2).toEqual([]);
    });

    it("preserves order of branches", () => {
      const orderedBranches: BranchOption[] = [
        {
          name: "z-last",
          isCurrent: false,
          isRemote: false,
          remoteName: null,
          labelText: "z-last",
          searchText: "z-last",
        },
        {
          name: "a-first",
          isCurrent: false,
          isRemote: false,
          remoteName: null,
          labelText: "a-first",
          searchText: "a-first",
        },
        {
          name: "m-middle",
          isCurrent: false,
          isRemote: false,
          remoteName: null,
          labelText: "m-middle",
          searchText: "m-middle",
        },
      ];

      const result = filterBranches(orderedBranches, "", 10);
      expect(result.map((b) => b.name)).toEqual(["z-last", "a-first", "m-middle"]);
    });

    it("handles branches with special characters", () => {
      const specialBranches: BranchOption[] = [
        {
          name: "feature/foo-bar",
          isCurrent: false,
          isRemote: false,
          remoteName: null,
          labelText: "feature/foo-bar",
          searchText: "feature/foo-bar",
        },
        {
          name: "feature/foo_bar",
          isCurrent: false,
          isRemote: false,
          remoteName: null,
          labelText: "feature/foo_bar",
          searchText: "feature/foo_bar",
        },
        {
          name: "feature/foo.bar",
          isCurrent: false,
          isRemote: false,
          remoteName: null,
          labelText: "feature/foo.bar",
          searchText: "feature/foo.bar",
        },
      ];

      const result = filterBranches(specialBranches, "foo-bar", 10);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("feature/foo-bar");

      const result2 = filterBranches(specialBranches, "foo_bar", 10);
      expect(result2).toHaveLength(1);
      expect(result2[0].name).toBe("feature/foo_bar");

      const result3 = filterBranches(specialBranches, "foo.bar", 10);
      expect(result3).toHaveLength(1);
      expect(result3[0].name).toBe("feature/foo.bar");
    });

    it("stops filtering early when limit is reached", () => {
      const manyFeatures = Array.from({ length: 1000 }, (_, i) => ({
        name: `feature/branch-${i}`,
        isCurrent: false,
        isRemote: false,
        remoteName: null,
        labelText: `feature/branch-${i}`,
        searchText: `feature/branch-${i}`,
      }));

      const result = filterBranches(manyFeatures, "feature", 50);
      expect(result).toHaveLength(50);
      expect(result[0].name).toBe("feature/branch-0");
      expect(result[49].name).toBe("feature/branch-49");
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
});

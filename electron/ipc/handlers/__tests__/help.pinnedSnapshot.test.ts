import { describe, expect, it } from "vitest";
import { pinnedSnapshotFromContext } from "../help.js";

describe("pinnedSnapshotFromContext (#8772)", () => {
  it("projects the active worktree triple, never the focused worktree id", () => {
    // Regression guard: the id/name/branch must come from the same (active)
    // worktree so the chip never labels one worktree with another's name.
    const snapshot = pinnedSnapshotFromContext({
      focusedWorktreeId: "wt-focused",
      activeWorktreeId: "wt-active",
      activeWorktreeName: "main",
      activeWorktreeBranch: "develop",
      focusedTerminalId: "term-1",
    });
    expect(snapshot).toEqual({
      worktreeId: "wt-active",
      worktreeName: "main",
      worktreeBranch: "develop",
      terminalId: "term-1",
    });
  });

  it("returns null for a null context", () => {
    expect(pinnedSnapshotFromContext(null)).toBeNull();
  });

  it("suppresses the snapshot when neither worktree nor terminal is present", () => {
    expect(pinnedSnapshotFromContext({ dispatchSource: "user" })).toBeNull();
  });

  it("keeps a terminal-only context (worktreeId null) since the terminal is still actionable", () => {
    expect(pinnedSnapshotFromContext({ focusedTerminalId: "term-9" })).toEqual({
      worktreeId: null,
      worktreeName: null,
      worktreeBranch: null,
      terminalId: "term-9",
    });
  });
});

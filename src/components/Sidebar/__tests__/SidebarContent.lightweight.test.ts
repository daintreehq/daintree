import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

/**
 * The sidebar's branches are ordered early-returns, so what matters for a
 * workspace with no worktrees — a folder opened without git (#11405) or a
 * scratch (#11499) — is *where* its branch sits relative to the loading
 * skeleton and the "Open a Git repository" nudge, both of which would otherwise
 * claim the same zero-worktree state and mislead.
 */
describe("SidebarContent — workspace with no worktrees (#11405, #11499)", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("decides on the workspace's own kind, not on the absence of worktrees alone", () => {
    // Reading the emptiness alone would misreport a folder initialized
    // externally, whose host does load worktrees; those must win over a stale
    // flag. `isGitBacked` is false for both a non-git project and a scratch, so
    // one gate now covers both worktree-less kinds (#11499).
    expect(source).toMatch(
      /workspaceRoot !== null\s*&&\s*!workspaceRoot\.isGitBacked\s*&&\s*worktrees\.length === 0/
    );
  });

  it("answers before the loading skeleton, which would otherwise never resolve", () => {
    const gate = source.indexOf("!workspaceRoot.isGitBacked");
    const skeleton = source.indexOf("if (isLoading && worktrees.length === 0)");
    expect(gate).toBeGreaterThan(-1);
    expect(skeleton).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(skeleton);
  });

  it("answers before the zero-worktree branch that nudges toward opening a repository", () => {
    const gate = source.indexOf("!workspaceRoot.isGitBacked");
    const zeroWorktrees = source.indexOf("if (worktrees.length === 0)");
    expect(gate).toBeGreaterThan(-1);
    expect(zeroWorktrees).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(zeroWorktrees);
  });

  it("hands the branch to the workspace-root sidebar rather than an empty state", () => {
    // The sidebar lists the places agents run; a worktree-less workspace has
    // exactly one, so it gets a row like every other kind instead of a
    // Worktrees header over a zero-data nudge (#11499). What that sidebar then
    // renders is covered behaviourally in WorkspaceRootSidebar.test.tsx — this
    // only pins that the branch is wired to it at all.
    expect(source).toContain("<WorkspaceRootSidebar workspace={workspaceRoot}");
  });
});

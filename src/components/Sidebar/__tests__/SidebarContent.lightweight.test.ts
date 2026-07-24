import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

/**
 * The sidebar's branches are ordered early-returns, so what matters for a
 * workspace opened without git (#11405) is *where* its branch sits relative to
 * the loading skeleton and the "Open a Git repository" nudge — both of which
 * would otherwise claim the same zero-worktree state and mislead.
 */
describe("SidebarContent — workspace opened without git (#11405)", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("decides on the project's mode, not on the absence of worktrees alone", () => {
    // Reading the flag alone would misreport a folder initialized externally,
    // whose host does load worktrees; those must win over a stale flag.
    expect(source).toMatch(/!isGitBackedProject\(currentProject\)\s*&&\s*worktrees\.length === 0/);
  });

  it("answers before the loading skeleton, which would otherwise never resolve", () => {
    const gate = source.indexOf("!isGitBackedProject(currentProject)");
    const skeleton = source.indexOf("if (isLoading && worktrees.length === 0)");
    expect(gate).toBeGreaterThan(-1);
    expect(skeleton).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(skeleton);
  });

  it("answers before the zero-worktree branch that nudges toward opening a repository", () => {
    const gate = source.indexOf("!isGitBackedProject(currentProject)");
    const zeroWorktrees = source.indexOf("if (worktrees.length === 0)");
    expect(zeroWorktrees).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(zeroWorktrees);
  });

  it("offers the upgrade at the initialize step rather than re-asking the choice", () => {
    expect(source).toMatch(
      /openGitInitDialog\(\s*currentProject\.path,\s*\{\s*step:\s*"initialize"\s*\}\s*\)/
    );
  });
});

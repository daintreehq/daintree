import { describe, expect, it, vi } from "vitest";
import { readRunWorktrees } from "../canopyWorktrees.js";

describe("readRunWorktrees (#18151)", () => {
  it("answers only for runs the fleet holds in the incarnation named, from the fleet's own worktree and project", async () => {
    const readGit = vi.fn();
    const projectPathOf = vi.fn((workspaceId: string) => (workspaceId === "p1" ? "/repo" : null));
    const readings = await readRunWorktrees(
      [
        { runId: "a", spawnedAt: 1, workspaceId: "p1" },
        { runId: "b", spawnedAt: 2, workspaceId: "p2", worktreeId: "/elsewhere/b" },
        { runId: "c", spawnedAt: 3, workspaceId: "p1", worktreeId: "/repo-wt/c" },
      ],
      [
        { runId: "a", spawnedAt: 1 },
        { runId: "a", spawnedAt: 1 },
        { runId: "b", spawnedAt: 2 },
        { runId: "b", spawnedAt: 99 },
        { runId: "c", spawnedAt: 99 },
        { runId: "gone", spawnedAt: 1 },
      ],
      projectPathOf,
      { readGit }
    );

    expect(readings).toEqual([
      { runId: "a", work: { kind: "not-applicable" } },
      // No project path here for its workspace: nothing to check it against.
      { runId: "b", work: { kind: "unreadable" } },
    ]);
    expect(readGit).not.toHaveBeenCalled();
    expect(projectPathOf.mock.calls.map(([workspaceId]) => workspaceId)).toEqual(["p1", "p2"]);
  });
});

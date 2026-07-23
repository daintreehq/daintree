import { describe, it, expect } from "vitest";
import {
  buildWorktreeMoveContext,
  resolveMovedWorktreeId,
  resolveWorktreeMovePatch,
  type WorktreeMoveContext,
} from "../worktreeMoveRemap";

const OLD = "/repo/wt-feature";
const NEW = "/elsewhere/wt-feature";
const GITDIR = "/repo/.git/worktrees/wt-feature";

function ctxWith(
  worktrees: Array<{ id: string; gitDir?: string }>
): WorktreeMoveContext {
  const ctx = buildWorktreeMoveContext(worktrees);
  if (ctx === null) throw new Error("expected a non-null context");
  return ctx;
}

describe("buildWorktreeMoveContext", () => {
  it("returns null for an empty or absent list (treated as not-ready, #11234)", () => {
    expect(buildWorktreeMoveContext([])).toBeNull();
    expect(buildWorktreeMoveContext(null)).toBeNull();
    expect(buildWorktreeMoveContext(undefined)).toBeNull();
  });

  it("indexes ids and gitDir handles, skipping empty gitDir", () => {
    const ctx = ctxWith([
      { id: "/repo/main", gitDir: "/repo/.git" },
      { id: NEW, gitDir: GITDIR },
      { id: "/repo/no-handle", gitDir: "" },
      { id: "/repo/undef-handle" },
    ]);
    expect(ctx.knownIds).toEqual(
      new Set(["/repo/main", NEW, "/repo/no-handle", "/repo/undef-handle"])
    );
    expect(ctx.gitDirToId.get(GITDIR)).toBe(NEW);
    expect(ctx.gitDirToId.get("/repo/.git")).toBe("/repo/main");
    expect(ctx.gitDirToId.has("")).toBe(false);
  });
});

describe("resolveMovedWorktreeId", () => {
  it("returns undefined when the context is null (list not ready)", () => {
    expect(resolveMovedWorktreeId(OLD, GITDIR, null)).toBeUndefined();
  });

  it("returns undefined without a saved id or gitDir (legacy snapshot)", () => {
    const ctx = ctxWith([{ id: NEW, gitDir: GITDIR }]);
    expect(resolveMovedWorktreeId(undefined, GITDIR, ctx)).toBeUndefined();
    expect(resolveMovedWorktreeId(OLD, undefined, ctx)).toBeUndefined();
  });

  it("returns undefined when the saved id still exists (not moved)", () => {
    const ctx = ctxWith([{ id: OLD, gitDir: GITDIR }]);
    expect(resolveMovedWorktreeId(OLD, GITDIR, ctx)).toBeUndefined();
  });

  it("returns the new id when the saved id is gone but its gitDir matches a moved worktree", () => {
    const ctx = ctxWith([
      { id: "/repo/main", gitDir: "/repo/.git" },
      { id: NEW, gitDir: GITDIR },
    ]);
    expect(resolveMovedWorktreeId(OLD, GITDIR, ctx)).toBe(NEW);
  });

  it("returns undefined when the saved gitDir matches nothing (genuinely deleted)", () => {
    const ctx = ctxWith([{ id: "/repo/main", gitDir: "/repo/.git" }]);
    expect(resolveMovedWorktreeId(OLD, GITDIR, ctx)).toBeUndefined();
  });

  it("returns undefined when the matched worktree is the saved id itself", () => {
    // Defensive: an id absent from knownIds is the precondition, so this can only
    // happen with an inconsistent context — never remap onto the same id.
    const ctx: WorktreeMoveContext = {
      knownIds: new Set(["/repo/other"]),
      gitDirToId: new Map([[GITDIR, OLD]]),
    };
    expect(resolveMovedWorktreeId(OLD, GITDIR, ctx)).toBeUndefined();
  });
});

describe("resolveWorktreeMovePatch", () => {
  it("returns null when the worktree did not move", () => {
    const ctx = ctxWith([{ id: OLD, gitDir: GITDIR }]);
    expect(
      resolveWorktreeMovePatch({ worktreeId: OLD, worktreeGitDir: GITDIR }, ctx)
    ).toBeNull();
  });

  it("returns null for a legacy snapshot with no stored gitDir", () => {
    const ctx = ctxWith([{ id: NEW, gitDir: GITDIR }]);
    expect(resolveWorktreeMovePatch({ worktreeId: OLD }, ctx)).toBeNull();
  });

  it("remaps the worktree id and rebases cwd/filePath/markdownFilePath onto the new root", () => {
    const ctx = ctxWith([{ id: NEW, gitDir: GITDIR }]);
    const patch = resolveWorktreeMovePatch(
      {
        worktreeId: OLD,
        worktreeGitDir: GITDIR,
        cwd: `${OLD}/packages/app`,
        filePath: `${OLD}/src/index.ts`,
        markdownFilePath: `${OLD}/README.md`,
      },
      ctx
    );
    expect(patch).toEqual({
      worktreeId: NEW,
      cwd: `${NEW}/packages/app`,
      filePath: `${NEW}/src/index.ts`,
      markdownFilePath: `${NEW}/README.md`,
    });
  });

  it("remaps the id only when there are no path-bearing fields", () => {
    const ctx = ctxWith([{ id: NEW, gitDir: GITDIR }]);
    const patch = resolveWorktreeMovePatch(
      { worktreeId: OLD, worktreeGitDir: GITDIR },
      ctx
    );
    expect(patch).toEqual({ worktreeId: NEW });
  });

  it("leaves a path outside the moved worktree root untouched", () => {
    const ctx = ctxWith([{ id: NEW, gitDir: GITDIR }]);
    const patch = resolveWorktreeMovePatch(
      { worktreeId: OLD, worktreeGitDir: GITDIR, cwd: "/somewhere/else" },
      ctx
    );
    // Path prefix doesn't match the old worktree root, so it is preserved.
    expect(patch).toEqual({ worktreeId: NEW, cwd: "/somewhere/else" });
  });
});

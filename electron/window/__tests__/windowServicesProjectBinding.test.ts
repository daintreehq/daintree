import { describe, expect, it, vi } from "vitest";
import { resolveRestoreWorkspace, resolveWorktreeLoadPath } from "../restoreWorkspaceBinding.js";

const PROJECT = { id: "a".repeat(64), path: "/projects/a" };
const SCRATCH = { id: "11111111-1111-4111-8111-111111111111", path: "/scratches/one" };
const lookups = {
  getProjectById: (id: string) => (id === PROJECT.id ? PROJECT : undefined),
  getScratchById: (id: string) => (id === SCRATCH.id ? SCRATCH : undefined),
};

describe("windowServices restore workspace binding", () => {
  it("binds a restored project as both the workspace and the git-backed project", () => {
    const { project, workspace } = resolveRestoreWorkspace(PROJECT.id, lookups);
    expect(project).toEqual({ ...PROJECT, kind: "project" });
    expect(workspace).toEqual(project);
  });

  it("binds a scratch without presenting it as a git-backed project", () => {
    const { project, workspace } = resolveRestoreWorkspace(SCRATCH.id, lookups);
    expect(workspace).toEqual({ ...SCRATCH, kind: "scratch" });
    expect(project).toBeUndefined();
  });

  it.each(["f".repeat(64), "22222222-2222-4222-8222-222222222222"])(
    "leaves a deleted workspace unbound (%s)",
    (id) => {
      expect(resolveRestoreWorkspace(id, lookups)).toEqual({
        project: undefined,
        workspace: undefined,
      });
    }
  );

  it("does not consult global stores for an unbound new window", () => {
    const getProjectById = vi.fn(() => PROJECT);
    const getScratchById = vi.fn(() => SCRATCH);
    expect(resolveRestoreWorkspace(undefined, { getProjectById, getScratchById })).toEqual({
      project: undefined,
      workspace: undefined,
    });
    expect(getProjectById).not.toHaveBeenCalled();
    expect(getScratchById).not.toHaveBeenCalled();
  });

  it("prefers a project row when the same id resolves in both stores", () => {
    const getScratchById = vi.fn(() => SCRATCH);
    const { project, workspace } = resolveRestoreWorkspace(PROJECT.id, {
      getProjectById: () => PROJECT,
      getScratchById,
    });
    expect(project).toEqual({ ...PROJECT, kind: "project" });
    expect(workspace).toEqual(project);
    expect(getScratchById).not.toHaveBeenCalled();
  });
});

describe("windowServices worktree load path", () => {
  it.each([
    ["a restored project", PROJECT.id, undefined, PROJECT.path],
    ["a restored scratch", SCRATCH.id, undefined, undefined],
    ["an unbound window", undefined, undefined, undefined],
    ["an explicit path", undefined, "/cli/project", "/cli/project"],
    ["a path overriding a restored project", PROJECT.id, "/override/path", "/override/path"],
    ["a path overriding a restored scratch", SCRATCH.id, "/override/path", "/override/path"],
  ])("uses the git-backed path for %s", (_label, id, initialPath, expected) => {
    expect(resolveWorktreeLoadPath(initialPath, resolveRestoreWorkspace(id, lookups))).toBe(
      expected
    );
  });
});

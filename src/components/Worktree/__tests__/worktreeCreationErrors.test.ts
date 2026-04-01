import { describe, it, expect, vi, beforeEach } from "vitest";
import { mapCreationError } from "../worktreeCreationErrors";

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({
      worktrees: new Map([
        ["wt-1", { id: "wt-1", path: "/projects/repo-worktrees/feature-auth" }],
        ["wt-2", { id: "wt-2", path: "/projects/repo-worktrees/main" }],
      ]),
    }),
  }),
}));

const mockSelectWorktree = vi.fn();
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      selectWorktree: mockSelectWorktree,
    }),
  },
}));

beforeEach(() => {
  mockSelectWorktree.mockClear();
});

describe("mapCreationError", () => {
  it("maps 'already checked out' with path to friendly message and recovery", () => {
    const raw =
      "fatal: 'feature/auth' is already checked out at '/projects/repo-worktrees/feature-auth'";
    const result = mapCreationError(raw);

    expect(result.friendly).toBe("This branch is already open in another worktree.");
    expect(result.raw).toBe(raw);
    expect(result.recovery).toBeDefined();
    expect(result.recovery!.label).toBe("Open Worktree");
  });

  it("recovery action selects the matching worktree and calls onClose", () => {
    const raw =
      "fatal: 'feature/auth' is already checked out at '/projects/repo-worktrees/feature-auth'";
    const onClose = vi.fn();
    const result = mapCreationError(raw, onClose);

    result.recovery!.onAction();

    expect(mockSelectWorktree).toHaveBeenCalledWith("wt-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("recovery action does not call onClose if worktree path not found", () => {
    const raw =
      "fatal: 'feature/unknown' is already checked out at '/projects/repo-worktrees/unknown-path'";
    const onClose = vi.fn();
    const result = mapCreationError(raw, onClose);

    result.recovery!.onAction();

    expect(mockSelectWorktree).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("handles 'already checked out' without parseable path", () => {
    const raw = "fatal: branch is already checked out somewhere";
    const result = mapCreationError(raw);

    expect(result.friendly).toBe("This branch is already open in another worktree.");
    expect(result.recovery).toBeUndefined();
  });

  it("maps 'could not create work tree dir'", () => {
    const raw = "fatal: could not create work tree dir '/no-permission/path': Permission denied";
    const result = mapCreationError(raw);

    expect(result.friendly).toBe(
      "Cannot create directory — check permissions or available disk space."
    );
    expect(result.raw).toBe(raw);
    expect(result.recovery).toBeUndefined();
  });

  it("maps 'not a valid branch name'", () => {
    const raw = "fatal: 'my..branch' is not a valid branch name";
    const result = mapCreationError(raw);

    expect(result.friendly).toBe("The branch name contains invalid characters.");
    expect(result.recovery).toBeUndefined();
  });

  it("maps worktree path 'already exists' conflict", () => {
    const raw = "fatal: '/path/to/work tree' already exists";
    const result = mapCreationError(raw);

    expect(result.friendly).toBe("A worktree already exists at this path.");
  });

  it("does not misclassify 'branch already exists' as path conflict", () => {
    const raw = "fatal: a branch named 'feature/auth' already exists";
    const result = mapCreationError(raw);

    expect(result.friendly).not.toBe("A worktree already exists at this path.");
    expect(result.friendly).toBe(raw);
  });

  it("falls through to raw message for unknown errors", () => {
    const raw = "fatal: some completely unknown git error";
    const result = mapCreationError(raw);

    expect(result.friendly).toBe(raw);
    expect(result.raw).toBe(raw);
    expect(result.recovery).toBeUndefined();
  });
});

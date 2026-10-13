import { describe, it, expect, vi, beforeEach } from "vitest";
import { mapCreationError } from "../worktreeCreationErrors";

const POSIX_WORKTREES = new Map([
  ["wt-1", { id: "wt-1", path: "/projects/repo-worktrees/feature-auth" }],
  ["wt-2", { id: "wt-2", path: "/projects/repo-worktrees/main" }],
]);

const { viewWorktrees, isWindowsMock } = vi.hoisted(() => ({
  viewWorktrees: { current: new Map<string, { id: string; path: string }>() },
  isWindowsMock: vi.fn<() => boolean>(),
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ worktrees: viewWorktrees.current }),
  }),
}));

vi.mock("@/hooks/useHostPlatform", () => ({ isHostWindows: isWindowsMock }));

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
  viewWorktrees.current = POSIX_WORKTREES;
  isWindowsMock.mockReturnValue(false);
});

describe("mapCreationError", () => {
  it("maps 'already checked out' with path to friendly message and recovery", () => {
    const raw =
      "fatal: 'feature/auth' is already checked out at '/projects/repo-worktrees/feature-auth'";
    const result = mapCreationError(raw);

    expect(result.friendly).toBe("This branch is already open in another worktree.");
    expect(result.raw).toBe(raw);
    expect(result.recovery).toBeDefined();
    expect(result.recovery!.label).toBe("Open worktree");
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

  it("recognises git 2.42+'s 'already used by worktree' wording", () => {
    const raw =
      "fatal: 'feature/auth' is already used by worktree at '/projects/repo-worktrees/feature-auth'";
    const onClose = vi.fn();
    const result = mapCreationError(raw, onClose);

    expect(result.friendly).toBe("This branch is already open in another worktree.");
    result.recovery!.onAction();
    expect(mockSelectWorktree).toHaveBeenCalledWith("wt-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("on Windows, matches git's forward-slash path to the stored backslash path in any case", () => {
    isWindowsMock.mockReturnValue(true);
    viewWorktrees.current = new Map([
      ["wt-main", { id: "wt-main", path: "C:\\dev\\projects\\hello-app" }],
      [
        "wt-feature",
        { id: "wt-feature", path: "C:\\dev\\projects\\hello-app-worktrees\\feature-x" },
      ],
    ]);
    const raw =
      "fatal: 'feature-x' is already used by worktree at 'c:/dev/projects/hello-app-worktrees/Feature-X'";
    const onClose = vi.fn();

    mapCreationError(raw, onClose).recovery!.onAction();

    expect(mockSelectWorktree).toHaveBeenCalledWith("wt-feature");
    expect(onClose).toHaveBeenCalled();
  });

  it("on POSIX, does not treat a case-variant path as the same worktree", () => {
    const raw =
      "fatal: 'feature/auth' is already used by worktree at '/projects/repo-worktrees/Feature-Auth'";
    const onClose = vi.fn();

    mapCreationError(raw, onClose).recovery!.onAction();

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
    expect(result.gitReason).toBeUndefined();
  });

  it("tags existing worktree-specific overlays with a gitReason", () => {
    const ioRaw = "fatal: could not create work tree dir '/no-permission/path': Permission denied";
    expect(mapCreationError(ioRaw).gitReason).toBe("system-io-error");

    const invalidRaw = "fatal: 'my..branch' is not a valid branch name";
    expect(mapCreationError(invalidRaw).gitReason).toBe("pathspec-invalid");

    const existsRaw = "fatal: '/path/to/work tree' already exists";
    expect(mapCreationError(existsRaw).gitReason).toBe("system-io-error");
  });

  it("delegates to the shared classifier for generic git failures", () => {
    const raw = "remote: Authentication failed for 'https://github.com/foo/bar.git/'";
    const result = mapCreationError(raw);

    expect(result.gitReason).toBe("auth-failed");
    expect(result.friendly).toContain("credentials");
    expect(result.raw).toBe(raw);
  });

  it("uses the classifier hint as the friendly message for network failures", () => {
    const raw =
      "fatal: unable to access 'https://github.com/foo.git/': Could not resolve host: github.com";
    const result = mapCreationError(raw);

    expect(result.gitReason).toBe("network-unavailable");
    expect(result.friendly).toContain("internet connection");
  });
});

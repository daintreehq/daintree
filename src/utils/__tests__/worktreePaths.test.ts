import { beforeEach, describe, expect, it, vi } from "vitest";

const { isWindowsMock } = vi.hoisted(() => ({ isWindowsMock: vi.fn<() => boolean>() }));
vi.mock("@/hooks/useHostPlatform", () => ({ isHostWindows: isWindowsMock }));

import { inferWorktreeIdFromCwd } from "../worktreePaths";

beforeEach(() => {
  isWindowsMock.mockReset();
});

describe("inferWorktreeIdFromCwd on Windows", () => {
  beforeEach(() => isWindowsMock.mockReturnValue(true));

  const worktrees = [
    { id: "main", path: "C:\\dev\\projects\\hello-app" },
    { id: "feature", path: "C:\\dev\\projects\\hello-app-worktrees\\feature-x" },
  ];

  it("matches a cwd whose drive letter and folders differ only in case", () => {
    expect(inferWorktreeIdFromCwd("c:\\Dev\\Projects\\Hello-App\\src", worktrees)).toBe("main");
  });

  it("matches git's forward-slash spelling against a stored backslash path", () => {
    expect(inferWorktreeIdFromCwd("c:/dev/projects/hello-app-worktrees/Feature-X", worktrees)).toBe(
      "feature"
    );
  });

  it("still refuses a sibling that only shares a name prefix", () => {
    expect(
      inferWorktreeIdFromCwd("C:\\dev\\projects\\HELLO-APP-worktrees-old\\x", worktrees)
    ).toBeUndefined();
  });
});

describe("inferWorktreeIdFromCwd on POSIX", () => {
  beforeEach(() => isWindowsMock.mockReturnValue(false));

  it("stays case-sensitive", () => {
    const worktrees = [{ id: "wt", path: "/repo/wt" }];
    expect(inferWorktreeIdFromCwd("/repo/wt/src", worktrees)).toBe("wt");
    expect(inferWorktreeIdFromCwd("/repo/WT/src", worktrees)).toBeUndefined();
    expect(inferWorktreeIdFromCwd("/Repo/wt", worktrees)).toBeUndefined();
  });

  it("keeps differently normalized Unicode names apart", () => {
    // Two distinct directories on Linux; folding them would misfile a terminal.
    const worktrees = [{ id: "composed", path: "/repos/caf\u00e9" }];
    expect(inferWorktreeIdFromCwd("/repos/cafe\u0301/src", worktrees)).toBeUndefined();
  });
});

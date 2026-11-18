import { beforeEach, describe, expect, it, vi } from "vitest";

const { isWindowsMock, isRemoteMock } = vi.hoisted(() => ({
  isWindowsMock: vi.fn<() => boolean>(),
  isRemoteMock: vi.fn<() => boolean>(),
}));
vi.mock("@/hooks/useHostPlatform", () => ({
  isHostWindows: isWindowsMock,
  isRemoteWindow: isRemoteMock,
}));

import { inferWorktreeIdFromCwd, joinWorktreeFilePath } from "../worktreePaths";

beforeEach(() => {
  isWindowsMock.mockReset();
  isRemoteMock.mockReset().mockReturnValue(false);
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

describe("joinWorktreeFilePath on POSIX", () => {
  beforeEach(() => isWindowsMock.mockReturnValue(false));

  it("keeps a backslash in a file name instead of turning it into a folder", () => {
    expect(joinWorktreeFilePath("/repo", "a\\b.txt")).toBe("/repo/a\\b.txt");
    expect(joinWorktreeFilePath("/repo", "a\\b.txt")).not.toBe(
      joinWorktreeFilePath("/repo", "a/b.txt")
    );
  });

  it("keeps a backslash in the worktree path, even right before the join", () => {
    expect(joinWorktreeFilePath("/home/pro\\ject\\", "src/app.ts")).toBe(
      "/home/pro\\ject\\/src/app.ts"
    );
  });

  it("keeps a remote window's backslashes when this Windows machine answers for an unseeded host", () => {
    isWindowsMock.mockReturnValue(true);
    isRemoteMock.mockReturnValue(true);
    expect(joinWorktreeFilePath("/repo/", "a\\b.txt")).toBe("/repo/a\\b.txt");
  });

  it("joins with exactly one slash however the sides are padded", () => {
    expect(joinWorktreeFilePath("/repo//", "//src/app.ts")).toBe("/repo/src/app.ts");
    expect(joinWorktreeFilePath("/", "src/app.ts")).toBe("/src/app.ts");
  });
});

describe("joinWorktreeFilePath on Windows", () => {
  beforeEach(() => isWindowsMock.mockReturnValue(true));

  it("spells a backslash worktree with forward slashes", () => {
    expect(joinWorktreeFilePath("C:\\dev\\repo\\", "src/app.ts")).toBe("C:/dev/repo/src/app.ts");
  });

  it("joins under a drive root", () => {
    expect(joinWorktreeFilePath("C:\\", "src/app.ts")).toBe("C:/src/app.ts");
  });

  it("keeps a UNC share's leading pair and accepts either separator in the file path", () => {
    expect(joinWorktreeFilePath("\\\\server\\share\\repo", "src\\lib/app.ts")).toBe(
      "//server/share/repo/src/lib/app.ts"
    );
  });
});

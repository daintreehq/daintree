import { afterEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  execSync: execSyncMock,
}));

import { getGitBranch } from "../gitUtils.js";

describe("getGitBranch", () => {
  afterEach(() => {
    execSyncMock.mockReset();
  });

  it("returns the trimmed branch name", () => {
    execSyncMock.mockReturnValue("feature/foo\n");
    expect(getGitBranch("/repo")).toBe("feature/foo");
  });

  it("returns null for a detached HEAD", () => {
    execSyncMock.mockReturnValue("HEAD\n");
    expect(getGitBranch("/repo")).toBeNull();
  });

  it("returns null when git output is empty", () => {
    execSyncMock.mockReturnValue("\n");
    expect(getGitBranch("/repo")).toBeNull();
  });

  it("returns null when execSync throws (not a repo / timeout)", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not a git repository");
    });
    expect(getGitBranch("/not-a-repo")).toBeNull();
  });

  it("runs git in the given cwd with the requested timeout", () => {
    execSyncMock.mockReturnValue("main\n");
    getGitBranch("/repo/path", { timeout: 1234 });
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, opts] = execSyncMock.mock.calls[0];
    expect(cmd).toContain("rev-parse --abbrev-ref HEAD");
    expect(opts).toMatchObject({ cwd: "/repo/path", timeout: 1234 });
  });

  it("defaults to a short 500ms timeout", () => {
    execSyncMock.mockReturnValue("main\n");
    getGitBranch("/repo");
    expect(execSyncMock.mock.calls[0][1]).toMatchObject({ timeout: 500 });
  });
});

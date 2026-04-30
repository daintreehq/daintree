import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() =>
  vi.fn<
    (
      cmd: string,
      args: string[],
      opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
    ) => { kill: () => void; on: (event: string, handler: () => void) => void }
  >()
);

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

// WorkspaceService's module initialization pulls in a lot of modules that
// touch Electron. Stub the heavy dependencies before importing so the probe
// function can be exercised in isolation.
vi.mock("simple-git", () => ({ simpleGit: vi.fn() }));
vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(),
  createAuthenticatedGit: vi.fn(),
  validateCwd: vi.fn(),
  getGitLocaleEnv: vi.fn(() => ({ LC_CTYPE: "C.UTF-8" })),
}));
vi.mock("../../services/events.js", () => ({ events: { on: vi.fn(), off: vi.fn() } }));
vi.mock("../../services/PullRequestService.js", () => ({ pullRequestService: {} }));
vi.mock("../../services/github/GitHubAuth.js", () => ({ GitHubAuth: vi.fn() }));
vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumber: vi.fn(),
  extractIssueNumberSync: vi.fn(),
}));
vi.mock("../WorktreeLifecycleService.js", () => ({ WorktreeLifecycleService: vi.fn() }));
vi.mock("../WorktreeMonitor.js", () => ({ WorktreeMonitor: vi.fn() }));
vi.mock("../WorktreeListService.js", () => ({ WorktreeListService: vi.fn() }));
vi.mock("../PRIntegrationService.js", () => ({ PRIntegrationService: vi.fn() }));
vi.mock("../../utils/git.js", () => ({ invalidateGitStatusCache: vi.fn() }));
vi.mock("../../utils/gitUtils.js", () => ({ getGitDir: vi.fn(), clearGitDirCache: vi.fn() }));
vi.mock("../../utils/fs.js", () => ({ waitForPathExists: vi.fn() }));
vi.mock("../../services/projectStorePaths.js", () => ({
  generateProjectId: vi.fn(),
  settingsFilePath: vi.fn(),
}));

import { probeGitLfsAvailable } from "../WorkspaceService.js";

type ExecFileCallback = (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

function mockExecFile(
  handler: (cb: ExecFileCallback) => void,
  childOverrides?: { kill?: () => void }
) {
  execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    // Fire the callback on the next tick to better mimic real execFile semantics
    // (it never invokes its callback synchronously).
    setImmediate(() => handler(cb as ExecFileCallback));
    return {
      kill: childOverrides?.kill ?? (() => undefined),
      on: () => undefined,
    } as unknown as ReturnType<typeof execFileMock>;
  });
}

describe("probeGitLfsAvailable", () => {
  it("returns true when git-lfs is installed and reports its version", async () => {
    mockExecFile((cb) => cb(null, "git-lfs/3.4.0 (GitHub; darwin arm64; go 1.22.0)\n", ""));

    await expect(probeGitLfsAvailable()).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["lfs", "version"],
      expect.objectContaining({
        timeout: 3000,
        windowsHide: true,
        env: expect.objectContaining({ LC_CTYPE: expect.any(String) }),
      }),
      expect.any(Function)
    );
  });

  it("returns false when git-lfs is not on PATH (ENOENT)", async () => {
    mockExecFile((cb) => {
      const err = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      cb(err, "", "");
    });

    await expect(probeGitLfsAvailable()).resolves.toBe(false);
  });

  it("returns false when `git lfs` subcommand is not installed (non-zero exit)", async () => {
    mockExecFile((cb) => {
      const err = Object.assign(new Error("git: 'lfs' is not a git command"), {
        code: "1",
      }) as NodeJS.ErrnoException;
      cb(err, "", "git: 'lfs' is not a git command. See 'git --help'.");
    });

    await expect(probeGitLfsAvailable()).resolves.toBe(false);
  });

  it("returns false when stdout does not match the git-lfs banner", async () => {
    mockExecFile((cb) => cb(null, "git version 2.40.0\n", ""));

    await expect(probeGitLfsAvailable()).resolves.toBe(false);
  });
});

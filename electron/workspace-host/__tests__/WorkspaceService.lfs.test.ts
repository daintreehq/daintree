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

/** Where git resolves on a Windows host; the host's real PATH is never searched. */
const { WINDOWS_GIT } = vi.hoisted(() => ({ WINDOWS_GIT: "C:\\Program Files\\Git\\cmd\\git.exe" }));

vi.mock("../../utils/windowsExecutable.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/windowsExecutable.js")>()),
  resolveExecutableForSpawn: vi.fn(
    async (name: string, _env?: unknown, platform: NodeJS.Platform = process.platform) =>
      platform === "win32" ? WINDOWS_GIT : name
  ),
}));

// WorkspaceService's module initialization pulls in a lot of modules that
// touch Electron. Stub the heavy dependencies before importing so the probe
// function can be exercised in isolation.
vi.mock("simple-git", () => ({ simpleGit: vi.fn() }));
vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(),
  createAuthenticatedGit: vi.fn(),
  validateCwd: vi.fn(),
  validateBranchName: vi.fn(),
  getGitLocaleEnv: vi.fn(() => ({ LC_CTYPE: "C.UTF-8" })),
}));
vi.mock("../../services/events.js", () => ({ events: { on: vi.fn(), off: vi.fn() } }));
vi.mock("../../services/PullRequestService.js", () => ({ pullRequestService: {} }));
vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumber: vi.fn(),
  extractIssueNumberSync: vi.fn(),
  deriveIssueTitleFromBranch: vi.fn(),
}));
vi.mock("../WorktreeLifecycleService.js", () => ({ WorktreeLifecycleService: vi.fn() }));
vi.mock("../WorktreeMonitor.js", () => ({ WorktreeMonitor: vi.fn() }));
vi.mock("../WorktreeListService.js", () => ({ WorktreeListService: vi.fn() }));
vi.mock("../PRIntegrationService.js", () => ({ PRIntegrationService: vi.fn() }));
vi.mock("../../utils/git.js", () => ({ invalidateGitStatusCache: vi.fn() }));
vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn(),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));
vi.mock("../../utils/fs.js", () => ({ waitForPathExists: vi.fn() }));
vi.mock("../../services/projectStorePaths.js", () => ({
  settingsFilePath: vi.fn(),
}));

import { probeGitLfsAvailable } from "../WorkspaceService.js";
import {
  resolveExecutableForSpawn,
  windowsExecutableNotFound,
} from "../../utils/windowsExecutable.js";

/** What the probe starts: the PATH lookup's absolute path on Windows, bare git elsewhere. */
const GIT = process.platform === "win32" ? WINDOWS_GIT : "git";

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
      GIT,
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

  it("starts git on Windows by the absolute path its PATH lookup found", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      mockExecFile((cb) => cb(null, "git-lfs/3.4.0 (GitHub; windows amd64; go 1.22.0)\n", ""));
      await expect(probeGitLfsAvailable()).resolves.toBe(true);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
    expect(execFileMock.mock.calls.at(-1)?.slice(0, 2)).toEqual([WINDOWS_GIT, ["lfs", "version"]]);
  });

  it("returns false without running anything when the Windows PATH lookup finds no git", async () => {
    vi.mocked(resolveExecutableForSpawn).mockRejectedValueOnce(windowsExecutableNotFound("git"));
    execFileMock.mockClear();

    await expect(probeGitLfsAvailable()).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
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

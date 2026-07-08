import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

// On Windows, `path.resolve("/Users/foo/my repo")` prepends the current
// drive letter ("C:\Users\foo\my repo") and the handler normalizes
// backslashes to forward slashes. Deriving the expected value the same way
// keeps assertions correct on both POSIX and Windows runners.
const resolvedSlashed = (p: string): string => path.resolve(p).replace(/\\/g, "/");

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      cb(null, { stdout: "", stderr: "" });
    }
  )
);

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const realpathMock = vi.hoisted(() => vi.fn(async (p: string) => p));

vi.mock("node:fs/promises", () => ({
  realpath: realpathMock,
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn(() => ({})) },
}));

vi.mock("../../../services/SoundService.js", () => ({
  soundService: { play: vi.fn() },
}));

vi.mock("../../../utils/hardenedGit.js", () => ({
  validateCwd: vi.fn(),
  createHardenedGit: vi.fn(),
  createAuthenticatedGit: vi.fn(),
}));

import { registerGitWriteHandlers } from "../git-write.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`Handler for ${channel} not registered`);
  return call[1] as (_e: unknown, ...args: unknown[]) => unknown;
}

describe("git:mark-safe-directory handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Rate-limit state is module-scoped — reset between tests so multi-call
    // cases (validation + success paths) don't trip the 5/10s cap.
    _resetRateLimitQueuesForTest();
    realpathMock.mockImplementation(async (p: string) => p);
  });

  it("registers the mark-safe-directory channel", () => {
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "git:mark-safe-directory",
      expect.any(Function)
    );
  });

  it("rejects a non-string payload", async () => {
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await expect(handler(null, 123)).rejects.toThrow(/non-empty string/i);
    await expect(handler(null, "")).rejects.toThrow(/non-empty string/i);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects a relative path", async () => {
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await expect(handler(null, "relative/path")).rejects.toThrow(/absolute/i);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("invokes git config with the absolute path", async () => {
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await handler(null, "/Users/foo/my repo");
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["config", "--global", "--add", "safe.directory", resolvedSlashed("/Users/foo/my repo")],
      expect.objectContaining({ env: expect.objectContaining({ LC_ALL: "C" }) }),
      expect.any(Function)
    );
  });

  it("canonicalizes symlinked repo paths before writing", async () => {
    realpathMock.mockResolvedValueOnce("/Users/foo/real-repo");
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await handler(null, "/Users/foo/link-to-repo");
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["config", "--global", "--add", "safe.directory", "/Users/foo/real-repo"],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("falls back to the resolved path when realpath fails", async () => {
    realpathMock.mockRejectedValueOnce(new Error("ENOENT"));
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await handler(null, "/Users/foo/missing-repo");
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["config", "--global", "--add", "safe.directory", resolvedSlashed("/Users/foo/missing-repo")],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("normalizes Windows backslashes to forward slashes", async () => {
    realpathMock.mockResolvedValueOnce("C:\\Users\\foo\\repo");
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    // The path.isAbsolute check happens on the input, which on POSIX test
    // machines requires a leading "/". Feed a POSIX-absolute path; realpath
    // is mocked to return a Windows-style canonical path so we can assert
    // the backslash → forward-slash normalization runs.
    await handler(null, "/tmp/win-style");
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["config", "--global", "--add", "safe.directory", "C:/Users/foo/repo"],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("propagates git config failures", async () => {
    execFileMock.mockImplementationOnce(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        cb(new Error("git not found"), { stdout: "", stderr: "git not found" });
      }
    );
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await expect(handler(null, "/Users/foo/repo")).rejects.toThrow(/git not found/);
  });

  it("skips --add when the canonicalized path is already in safe.directory", async () => {
    const repoPath = "/Users/foo/my repo";
    const normalized = resolvedSlashed(repoPath);
    // First call: --get-all returns the same path (already configured).
    execFileMock.mockImplementationOnce(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        if (args.includes("--get-all")) {
          cb(null, { stdout: normalized + "\n", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      }
    );
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await handler(null, repoPath);

    const calls = execFileMock.mock.calls as [string, string[], unknown, unknown][];
    const addCall = calls.find(([, args]) => Array.isArray(args) && args.includes("--add"));
    expect(addCall).toBeUndefined();
  });

  it("writes --add when --get-all fails with exit code 1 (no entries)", async () => {
    const repoPath = "/Users/foo/my repo";
    const normalized = resolvedSlashed(repoPath);
    // First call: --get-all fails with exit code 1 (no safe.directory set).
    execFileMock.mockImplementationOnce(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        if (args.includes("--get-all")) {
          const err = new Error("Command failed") as Error & { code: number };
          err.code = 1;
          cb(err, { stdout: "", stderr: "error: invalid key: safe.directory\n" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      }
    );
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await handler(null, repoPath);

    const calls = execFileMock.mock.calls as [string, string[], unknown, unknown][];
    const addCall = calls.find(([, args]) => Array.isArray(args) && args.includes("--add"));
    expect(addCall).toBeDefined();
    expect(addCall![1]).toEqual(["config", "--global", "--add", "safe.directory", normalized]);
  });

  it("writes --add when the path is not in existing safe.directory entries", async () => {
    const repoPath = "/Users/foo/my repo";
    const normalized = resolvedSlashed(repoPath);
    // --get-all returns a different path.
    execFileMock.mockImplementationOnce(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        if (args.includes("--get-all")) {
          cb(null, { stdout: "/other/repo\n/another/repo\n", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      }
    );
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await handler(null, repoPath);

    const calls = execFileMock.mock.calls as [string, string[], unknown, unknown][];
    const addCall = calls.find(([, args]) => Array.isArray(args) && args.includes("--add"));
    expect(addCall).toBeDefined();
    expect(addCall![1]).toEqual(["config", "--global", "--add", "safe.directory", normalized]);
  });

  it("propagates non-exit-code-1 --get-all failures", async () => {
    execFileMock.mockImplementationOnce(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        if (args.includes("--get-all")) {
          const err = new Error("git not found") as Error & { code: number };
          err.code = 128;
          cb(err, { stdout: "", stderr: "fatal: unable to read config file\n" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      }
    );
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await expect(handler(null, "/Users/foo/repo")).rejects.toThrow(/git not found/);
  });

  it("matches a symlinked safe.directory entry against a symlinked path", async () => {
    // Both the candidate and the stored entry go through realpath to the
    // same canonical target, so the dedup fires even though the raw strings differ.
    const repoPath = "/Users/foo/link-to-repo";
    const realTarget = "/Users/foo/real-repo";
    realpathMock.mockImplementation(async (p: string) => {
      if (p.includes("link-to-repo") || p.includes("stored-link")) return realTarget;
      return p;
    });
    // --get-all returns a path that resolves to the same real target.
    execFileMock.mockImplementationOnce(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        if (args.includes("--get-all")) {
          cb(null, { stdout: "/Users/foo/stored-link\n", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      }
    );
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await handler(null, repoPath);

    const calls = execFileMock.mock.calls as [string, string[], unknown, unknown][];
    const addCall = calls.find(([, args]) => Array.isArray(args) && args.includes("--add"));
    expect(addCall).toBeUndefined();
  });
});

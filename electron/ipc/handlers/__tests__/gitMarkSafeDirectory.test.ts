import { describe, it, expect, vi, beforeEach } from "vitest";

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
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      cb(null, "", "");
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

vi.mock("../../../services/PreAgentSnapshotService.js", () => ({
  preAgentSnapshotService: {
    getSnapshot: vi.fn(),
    listSnapshots: vi.fn(),
    revertToSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
  },
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
      ["config", "--global", "--add", "safe.directory", "/Users/foo/my repo"],
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
      ["config", "--global", "--add", "safe.directory", "/Users/foo/missing-repo"],
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
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        cb(new Error("git not found"), "", "git not found");
      }
    );
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:mark-safe-directory");
    await expect(handler(null, "/Users/foo/repo")).rejects.toThrow(/git not found/);
  });
});

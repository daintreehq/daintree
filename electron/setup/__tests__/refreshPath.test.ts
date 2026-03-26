import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  default: { existsSync: vi.fn(() => false) },
  existsSync: vi.fn(() => false),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/tmp/test-appdata"),
    setPath: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    enableSandbox: vi.fn(),
    disableHardwareAcceleration: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("fix-path", () => ({ default: vi.fn() }));
vi.mock("node:v8", () => ({ default: { setFlagsFromString: vi.fn() } }));
vi.mock("node:vm", () => ({ default: { runInNewContext: vi.fn() } }));
vi.mock("os", () => ({
  default: { homedir: () => "/home/testuser" },
  homedir: () => "/home/testuser",
}));

const shellEnvMock = vi.fn<() => Promise<Record<string, string>>>();
vi.mock("shell-env", () => ({
  shellEnv: shellEnvMock,
}));

const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const originalPlatform = process.platform;
let savedPath: string | undefined;

describe("refreshPath", () => {
  beforeEach(() => {
    savedPath = process.env.PATH;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("updates PATH from shell environment on macOS/Linux", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.env.PATH = "/usr/bin";

    shellEnvMock.mockResolvedValue({
      PATH: "/usr/local/bin:/usr/bin:/home/user/.nvm/versions/node/v20/bin",
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/usr/local/bin:/usr/bin:/home/user/.nvm/versions/node/v20/bin");
  });

  it("deduplicates PATH entries", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });

    shellEnvMock.mockResolvedValue({
      PATH: "/usr/bin:/usr/local/bin:/usr/bin:/usr/local/bin",
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/usr/bin:/usr/local/bin");
  });

  it("falls back to current PATH when shellEnv times out", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.env.PATH = "/original/path";

    shellEnvMock.mockImplementation(() => new Promise(() => {})); // never resolves

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/original/path");
  }, 10_000);

  it("falls back to current PATH when shellEnv throws", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.env.PATH = "/original/path";

    shellEnvMock.mockRejectedValue(new Error("shell failed"));

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/original/path");
  });

  it("preserves current PATH when shellEnv returns no PATH", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.env.PATH = "/original/path";

    shellEnvMock.mockResolvedValue({});

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/original/path");
  });

  it("reads PATH from Windows registry on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    process.env.PATH = "C:\\Windows\\System32";

    execFileMock.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string) => void
      ) => {
        const key = args[1] as string;
        if (key.startsWith("HKLM")) {
          cb(null, "    Path    REG_EXPAND_SZ    C:\\Program Files\\nodejs");
        } else {
          cb(null, "    Path    REG_SZ    C:\\Users\\test\\.cargo\\bin");
        }
      }
    );

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    // Verify reg query was called for both HKLM and HKCU
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenCalledWith(
      "reg",
      expect.arrayContaining(["query"]),
      expect.any(Object),
      expect.any(Function)
    );
    // PATH should have been updated (not the original value)
    expect(process.env.PATH).not.toBe("C:\\Windows\\System32");
    // Both registry values should appear in the PATH string
    expect(process.env.PATH).toContain("Program Files\\nodejs");
  });

  it("falls back on Windows when reg query fails", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    process.env.PATH = "C:\\Windows\\System32";

    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string) => void
      ) => {
        cb(new Error("reg query failed"), "");
      }
    );

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("C:\\Windows\\System32");
  });

  it("is idempotent — repeated calls don't explode PATH", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });

    const shellPath = "/usr/local/bin:/usr/bin";
    shellEnvMock.mockResolvedValue({ PATH: shellPath });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();
    await refreshPath();
    await refreshPath();

    expect(process.env.PATH).toBe(shellPath);
  });
});

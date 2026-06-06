import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn, mockHardenedGitConfig, mockBuildHardenedGitEnv } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockHardenedGitConfig: [
    "core.fsmonitor=false",
    "protocol.ext.allow=never",
    "credential.helper=",
  ] as const,
  mockBuildHardenedGitEnv: vi.fn(() => ({
    LC_ALL: "",
    LC_CTYPE: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  })),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("../hardenedGit.js", () => ({
  HARDENED_GIT_CONFIG: mockHardenedGitConfig,
  buildHardenedGitEnv: mockBuildHardenedGitEnv,
}));

import { checkIgnoredPaths } from "../gitCheckIgnore.js";

interface FakeStdin {
  end: ReturnType<typeof vi.fn>;
}

function makeFakeProcess(
  opts: {
    exitCode?: number;
    errorEvent?: Error;
    stdoutData?: Buffer | Buffer[];
    stderrData?: Buffer | Buffer[];
  } = {}
) {
  const { exitCode = 0, errorEvent, stdoutData, stderrData } = opts;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin: FakeStdin = { end: vi.fn() };

  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: Readable;
    stderr: Readable;
    stdin: FakeStdin;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 12345;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = vi.fn();

  setImmediate(() => {
    if (stdoutData) {
      const chunks = Array.isArray(stdoutData) ? stdoutData : [stdoutData];
      for (const chunk of chunks) stdout.push(chunk);
    }
    if (stderrData) {
      const chunks = Array.isArray(stderrData) ? stderrData : [stderrData];
      for (const chunk of chunks) stderr.push(chunk);
    }
    stdout.push(null);
    stderr.push(null);
    if (errorEvent) {
      child.emit("error", errorEvent);
    } else {
      child.emit("close", exitCode);
    }
  });

  return child;
}

describe("checkIgnoredPaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildHardenedGitEnv.mockReturnValue({
      LC_ALL: "",
      LC_CTYPE: "C.UTF-8",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("EMPTY_INPUT_DOES_NOT_SPAWN", async () => {
    const result = await checkIgnoredPaths("/repo", []);
    expect(result).toEqual(new Set());
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("SPAWNS_GIT_WITH_STDIN_AND_DASH_Z", async () => {
    const child = makeFakeProcess({ exitCode: 0 });
    mockSpawn.mockReturnValue(child);

    await checkIgnoredPaths("/repo", ["src/a.txt"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "credential.helper=",
        "check-ignore",
        "--stdin",
        "-z",
      ],
      expect.objectContaining({
        cwd: "/repo",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        signal: undefined,
      })
    );
  });

  it("INCLUDES_HARDENED_GIT_CONFIG_AS_DASH_C_FLAGS", async () => {
    const child = makeFakeProcess({ exitCode: 0 });
    mockSpawn.mockReturnValue(child);

    await checkIgnoredPaths("/repo", ["src/a.txt"]);

    const args = mockSpawn.mock.calls[0][1] as string[];
    const configFlags: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-c") configFlags.push(args[i + 1] as string);
    }
    for (const entry of mockHardenedGitConfig) {
      expect(configFlags).toContain(entry);
    }
  });

  it("FORWARDS_HARDENED_ENV_TO_SPAWN", async () => {
    const child = makeFakeProcess({ exitCode: 0 });
    mockSpawn.mockReturnValue(child);

    await checkIgnoredPaths("/repo", ["src/a.txt"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      expect.anything(),
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          LC_ALL: "",
        }),
      })
    );
  });

  it("STDIN_RECEIVES_NUL_TERMINATED_BODY", async () => {
    const child = makeFakeProcess({ exitCode: 0 });
    mockSpawn.mockReturnValue(child);

    await checkIgnoredPaths("/repo", ["src/a.txt", "src/b.txt"]);

    expect(child.stdin.end).toHaveBeenCalledWith("src/a.txt\0src/b.txt\0");
  });

  it("EXIT_0_PARSES_NUL_SEPARATED_OUTPUT", async () => {
    const child = makeFakeProcess({
      exitCode: 0,
      stdoutData: Buffer.from("src/a.txt\0src/b.txt\0"),
    });
    mockSpawn.mockReturnValue(child);

    const result = await checkIgnoredPaths("/repo", ["src/a.txt", "src/b.txt"]);

    expect(result).toEqual(new Set(["src/a.txt", "src/b.txt"]));
  });

  it("EXIT_0_HANDLES_TRAILING_NUL_AND_EMPTY_TOKENS", async () => {
    const child = makeFakeProcess({
      exitCode: 0,
      stdoutData: Buffer.from("\0src/a.txt\0\0src/b.txt\0"),
    });
    mockSpawn.mockReturnValue(child);

    const result = await checkIgnoredPaths("/repo", ["src/a.txt", "src/b.txt"]);

    expect(result).toEqual(new Set(["src/a.txt", "src/b.txt"]));
  });

  it("EXIT_1_RESOLVES_TO_EMPTY_SET", async () => {
    const child = makeFakeProcess({ exitCode: 1 });
    mockSpawn.mockReturnValue(child);

    const result = await checkIgnoredPaths("/repo", ["src/a.txt", "src/b.txt"]);

    expect(result).toEqual(new Set());
  });

  it("EXIT_128_REJECTS_WITH_STDERR_MESSAGE", async () => {
    const child = makeFakeProcess({
      exitCode: 128,
      stderrData: Buffer.from("fatal: not a git repository"),
    });
    mockSpawn.mockReturnValue(child);

    await expect(checkIgnoredPaths("/not-a-repo", ["a.txt"])).rejects.toThrow(
      /exit 128.*fatal: not a git repository/
    );
  });

  it("NON_ZERO_NON_ONE_EXIT_REJECTS", async () => {
    const child = makeFakeProcess({
      exitCode: 2,
      stderrData: Buffer.from("usage: git check-ignore"),
    });
    mockSpawn.mockReturnValue(child);

    await expect(checkIgnoredPaths("/repo", ["a.txt"])).rejects.toThrow(/exit 2/);
  });

  it("SPAWN_ERROR_REJECTS", async () => {
    const child = makeFakeProcess({ errorEvent: new Error("ENOENT: git not found") });
    mockSpawn.mockReturnValue(child);

    await expect(checkIgnoredPaths("/repo", ["a.txt"])).rejects.toThrow("ENOENT");
  });

  it("FORWARDS_ABORT_SIGNAL_TO_SPAWN", async () => {
    const controller = new AbortController();
    const child = makeFakeProcess({ exitCode: 0 });
    mockSpawn.mockReturnValue(child);

    await checkIgnoredPaths("/repo", ["a.txt"], { signal: controller.signal });

    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      expect.anything(),
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("USES_BUILD_HARDENED_GIT_ENV_WITH_DEFAULT_PLATFORM", async () => {
    const child = makeFakeProcess({ exitCode: 0 });
    mockSpawn.mockReturnValue(child);

    await checkIgnoredPaths("/repo", ["a.txt"]);

    expect(mockBuildHardenedGitEnv).toHaveBeenCalledWith(process.platform);
  });

  it("USES_BUILD_HARDENED_GIT_ENV_WITH_PROVIDED_PLATFORM_OVERRIDE", async () => {
    const child = makeFakeProcess({ exitCode: 0 });
    mockSpawn.mockReturnValue(child);

    await checkIgnoredPaths("/repo", ["a.txt"], { platform: "win32" });

    expect(mockBuildHardenedGitEnv).toHaveBeenCalledWith("win32");
  });
});

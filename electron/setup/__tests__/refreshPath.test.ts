import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
  },
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

vi.mock("node:v8", () => ({ default: { setFlagsFromString: vi.fn() } }));
vi.mock("node:vm", () => ({ default: { runInNewContext: vi.fn() } }));
vi.mock("os", () => ({
  default: { homedir: () => "/home/testuser", totalmem: () => 16 * 1024 ** 3 },
  homedir: () => "/home/testuser",
  totalmem: () => 16 * 1024 ** 3,
}));

const shellEnvMock = vi.fn<() => Promise<Record<string, string>>>();
vi.mock("shell-env", () => ({
  shellEnv: shellEnvMock,
}));

const execFileMock = vi.fn();
const spawnMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

interface MockChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function extractMarker(probeCmd: string): string {
  const match = /printf '%s' "([0-9a-f]+)"/.exec(probeCmd);
  if (!match) throw new Error(`marker not found in probe command: ${probeCmd}`);
  return match[1];
}

const originalPlatform = process.platform;
let savedPath: string | undefined;

describe("refreshPath", () => {
  beforeEach(() => {
    vi.resetModules();
    savedPath = process.env.PATH;
    vi.clearAllMocks();
    delete process.env.DAINTREE_SHELL_PROBE;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    delete process.env.DAINTREE_SHELL_PROBE;
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
    const d = path.delimiter;

    shellEnvMock.mockResolvedValue({
      PATH: ["/usr/bin", "/usr/local/bin", "/usr/bin", "/usr/local/bin"].join(d),
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe(["/usr/bin", "/usr/local/bin"].join(d));
  });

  it("falls back to current PATH when shellEnv times out", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.env.PATH = "/original/path";

    shellEnvMock.mockImplementation(() => new Promise(() => {})); // never resolves

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/original/path");
  }, 12_000);

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

    // Verify reg query was called for both HKLM and HKCU, by absolute path
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/^[A-Za-z]:\\.*\\System32\\reg\.exe$/),
      expect.arrayContaining(["query"]),
      expect.any(Object),
      expect.any(Function)
    );
    // PATH should have been updated (not the original value)
    expect(process.env.PATH).not.toBe("C:\\Windows\\System32");
    // Both registry values should appear in the PATH string
    expect(process.env.PATH).toContain("Program Files\\nodejs");
  });

  it("expands %VAR% references from REG_EXPAND_SZ values", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    process.env.PATH = "C:\\old";
    process.env.SystemRoot = "C:\\Windows";
    process.env.USERPROFILE = "C:\\Users\\test";

    execFileMock.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string) => void
      ) => {
        const key = args[1] as string;
        if (key.startsWith("HKLM")) {
          cb(null, "    Path    REG_EXPAND_SZ    %SystemRoot%\\system32");
        } else {
          cb(null, "    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\bin");
        }
      }
    );

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    // Check expanded values appear (use fragments to avoid path.delimiter issues on macOS)
    expect(process.env.PATH).toContain("Windows\\system32");
    expect(process.env.PATH).toContain("Users\\test\\AppData\\Local\\bin");
    // Should NOT contain unexpanded %VAR% tokens
    expect(process.env.PATH).not.toContain("%SystemRoot%");
    expect(process.env.PATH).not.toContain("%USERPROFILE%");

    delete process.env.SystemRoot;
    delete process.env.USERPROFILE;
  });

  it("preserves unknown %VAR% tokens instead of replacing with empty string", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    process.env.PATH = "C:\\old";

    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string) => void
      ) => {
        cb(null, "    Path    REG_EXPAND_SZ    %UNKNOWN_VAR_12345%\\bin;C:\\real\\path");
      }
    );

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    // Unknown var should be preserved as-is, not replaced with empty string
    expect(process.env.PATH).toContain("%UNKNOWN_VAR_12345%\\bin");
    expect(process.env.PATH).toContain("C:\\real\\path");
  });

  it("is idempotent on Windows — repeated calls don't explode PATH", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    process.env.PATH = "C:\\Windows\\System32";
    process.env.SystemRoot = "C:\\Windows";

    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string) => void
      ) => {
        cb(null, "    Path    REG_EXPAND_SZ    %SystemRoot%\\system32");
      }
    );

    const { refreshPath } = await import("../environment.js");
    await refreshPath();
    const firstPath = process.env.PATH;
    await refreshPath();
    const secondPath = process.env.PATH;

    expect(firstPath).toBe(secondPath);

    delete process.env.SystemRoot;
  });

  it("keeps the PATH Daintree was launched with behind the registry's on Windows", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    // Colon-free entries so the assertion holds whatever `path.delimiter` the host has.
    const venv = "\\\\host\\share\\venv\\Scripts";
    const registry = "\\\\host\\share\\nodejs";
    process.env.PATH = [venv, registry].join(path.delimiter);

    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string) => void
      ) => {
        cb(null, `    Path    REG_SZ    ${registry}`);
      }
    );

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe([registry, venv].join(path.delimiter));
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

describe("refreshPath — shell probe (DAINTREE_SHELL_PROBE=1)", () => {
  beforeEach(() => {
    vi.resetModules();
    savedPath = process.env.PATH;
    vi.clearAllMocks();
    process.env.DAINTREE_SHELL_PROBE = "1";
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    delete process.env.DAINTREE_SHELL_PROBE;
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("does not invoke spawn when DAINTREE_SHELL_PROBE is unset", async () => {
    delete process.env.DAINTREE_SHELL_PROBE;
    process.env.PATH = "/usr/bin";
    shellEnvMock.mockResolvedValue({ PATH: "/from/shell-env" });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(shellEnvMock).toHaveBeenCalled();
    expect(process.env.PATH).toBe("/from/shell-env");
  });

  it("updates PATH from a markered probe response", async () => {
    process.env.PATH = "/usr/bin";

    spawnMock.mockImplementation((_shell: string, args: string[]) => {
      const child = createMockChild();
      const marker = extractMarker(args[args.length - 1]);
      setImmediate(() => {
        child.stdout.emit(
          "data",
          Buffer.from(`${marker}${JSON.stringify({ PATH: "/probed/bin:/usr/bin" })}${marker}`)
        );
        child.emit("close", 0);
      });
      return child;
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(shellEnvMock).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe("/probed/bin:/usr/bin");
  });

  it("passes -i -l -c flags and DAINTREE_RESOLVING_ENVIRONMENT to the shell", async () => {
    process.env.SHELL = "/bin/zsh";

    spawnMock.mockImplementation((_shell: string, args: string[]) => {
      const child = createMockChild();
      const marker = extractMarker(args[args.length - 1]);
      setImmediate(() => {
        child.stdout.emit(
          "data",
          Buffer.from(`${marker}${JSON.stringify({ PATH: "/x" })}${marker}`)
        );
        child.emit("close", 0);
      });
      return child;
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    const call = spawnMock.mock.calls[0];
    expect(call[0]).toBe("/bin/zsh");
    expect(call[1].slice(0, 3)).toEqual(["-i", "-l", "-c"]);
    expect(call[2].env.DAINTREE_RESOLVING_ENVIRONMENT).toBe("1");
    expect(call[2].env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(call[2].stdio).toEqual(["ignore", "pipe", "ignore"]);

    delete process.env.SHELL;
  });

  it("falls back to /bin/zsh on darwin when SHELL is unset", async () => {
    delete process.env.SHELL;

    spawnMock.mockImplementation((_shell: string, args: string[]) => {
      const child = createMockChild();
      const marker = extractMarker(args[args.length - 1]);
      setImmediate(() => {
        child.stdout.emit(
          "data",
          Buffer.from(`${marker}${JSON.stringify({ PATH: "/x" })}${marker}`)
        );
        child.emit("close", 0);
      });
      return child;
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(spawnMock.mock.calls[0][0]).toBe("/bin/zsh");
  });

  it("accepts a non-zero exit code as long as markers + JSON are valid", async () => {
    process.env.PATH = "/orig";

    spawnMock.mockImplementation((_shell: string, args: string[]) => {
      const child = createMockChild();
      const marker = extractMarker(args[args.length - 1]);
      setImmediate(() => {
        child.stdout.emit(
          "data",
          Buffer.from(`${marker}${JSON.stringify({ PATH: "/from/probe" })}${marker}`)
        );
        child.emit("close", 1);
      });
      return child;
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/from/probe");
  });

  it("ignores prompt-tool noise outside the markers", async () => {
    process.env.PATH = "/orig";

    spawnMock.mockImplementation((_shell: string, args: string[]) => {
      const child = createMockChild();
      const marker = extractMarker(args[args.length - 1]);
      setImmediate(() => {
        const noisy =
          "powerlevel10k instant prompt loading...\n" +
          `${marker}${JSON.stringify({ PATH: "/clean/bin" })}${marker}\n` +
          "trailing motd line\n";
        child.stdout.emit("data", Buffer.from(noisy));
        child.emit("close", 0);
      });
      return child;
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/clean/bin");
  });

  it("preserves PATH when the probe stdout has no markers", async () => {
    process.env.PATH = "/orig";

    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("no markers here, just garbage"));
        child.emit("close", 0);
      });
      return child;
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/orig");
  });

  it("preserves PATH when the JSON between markers is malformed", async () => {
    process.env.PATH = "/orig";

    spawnMock.mockImplementation((_shell: string, args: string[]) => {
      const child = createMockChild();
      const marker = extractMarker(args[args.length - 1]);
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(`${marker}{not json${marker}`));
        child.emit("close", 0);
      });
      return child;
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/orig");
  });

  it("preserves PATH when the probed PATH is empty or missing", async () => {
    process.env.PATH = "/orig";

    spawnMock.mockImplementation((_shell: string, args: string[]) => {
      const child = createMockChild();
      const marker = extractMarker(args[args.length - 1]);
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(`${marker}${JSON.stringify({ PATH: "" })}${marker}`));
        child.emit("close", 0);
      });
      return child;
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/orig");
  });

  it("preserves PATH when the spawn emits an error event", async () => {
    process.env.PATH = "/orig";

    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      setImmediate(() => {
        child.emit("error", new Error("ENOENT"));
        child.emit("close", 127);
      });
      return child;
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/orig");
  });

  it("preserves PATH when spawn() throws synchronously", async () => {
    process.env.PATH = "/orig";

    spawnMock.mockImplementation(() => {
      throw new Error("EACCES");
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/orig");
  });

  it("deduplicates the probed PATH entries", async () => {
    process.env.PATH = "/usr/bin";
    const d = path.delimiter;

    spawnMock.mockImplementation((_shell: string, args: string[]) => {
      const child = createMockChild();
      const marker = extractMarker(args[args.length - 1]);
      setImmediate(() => {
        const probedPath = ["/a", "/b", "/a", "/b"].join(d);
        child.stdout.emit(
          "data",
          Buffer.from(`${marker}${JSON.stringify({ PATH: probedPath })}${marker}`)
        );
        child.emit("close", 0);
      });
      return child;
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe(["/a", "/b"].join(d));
  });

  it("spawns once for concurrent refreshPath() calls (singleton cache)", async () => {
    let resolveChild: (() => void) | undefined;

    spawnMock.mockImplementation((_shell: string, args: string[]) => {
      const child = createMockChild();
      const marker = extractMarker(args[args.length - 1]);
      resolveChild = () => {
        child.stdout.emit(
          "data",
          Buffer.from(`${marker}${JSON.stringify({ PATH: "/probed" })}${marker}`)
        );
        child.emit("close", 0);
      };
      return child;
    });

    const { refreshPath } = await import("../environment.js");
    const p1 = refreshPath();
    const p2 = refreshPath();
    const p3 = refreshPath();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    resolveChild!();
    await Promise.all([p1, p2, p3]);

    expect(process.env.PATH).toBe("/probed");
  });

  it("re-spawns on a subsequent refreshPath() if the previous probe returned null", async () => {
    process.env.PATH = "/orig";

    spawnMock
      .mockImplementationOnce(() => {
        const child = createMockChild();
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from("no markers"));
          child.emit("close", 0);
        });
        return child;
      })
      .mockImplementationOnce((_shell: string, args: string[]) => {
        const child = createMockChild();
        const marker = extractMarker(args[args.length - 1]);
        setImmediate(() => {
          child.stdout.emit(
            "data",
            Buffer.from(`${marker}${JSON.stringify({ PATH: "/recovered" })}${marker}`)
          );
          child.emit("close", 0);
        });
        return child;
      });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();
    expect(process.env.PATH).toBe("/orig");

    await refreshPath();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(process.env.PATH).toBe("/recovered");
  });

  it("kills the child with SIGTERM then SIGKILL on probe timeout", async () => {
    vi.useFakeTimers();
    process.env.PATH = "/orig";

    let mockChild: MockChild | undefined;
    spawnMock.mockImplementation(() => {
      mockChild = createMockChild();
      // never emits close — exercises both kill timers
      return mockChild;
    });

    try {
      const { refreshPath } = await import("../environment.js");
      const refreshPromise = refreshPath();

      // Advance to SIGTERM (REFRESH_TIMEOUT_MS = 10s).
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockChild!.kill).toHaveBeenCalledWith("SIGTERM");

      // Advance the additional 500ms grace period to SIGKILL.
      await vi.advanceTimersByTimeAsync(500);
      expect(mockChild!.kill).toHaveBeenCalledWith("SIGKILL");

      await refreshPromise;
      expect(process.env.PATH).toBe("/orig");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clobber PATH if the probe closes during the SIGTERM grace window", async () => {
    vi.useFakeTimers();
    process.env.PATH = "/orig";

    let mockChild: MockChild | undefined;
    let mockMarker = "";
    spawnMock.mockImplementation((_shell: string, args: string[]) => {
      mockChild = createMockChild();
      mockMarker = extractMarker(args[args.length - 1]);
      return mockChild;
    });

    try {
      const { refreshPath } = await import("../environment.js");
      const refreshPromise = refreshPath();

      // Trip the outer race timeout — refreshPath returns and applies its
      // post-race fallback augmentation.
      await vi.advanceTimersByTimeAsync(10_000);
      await refreshPromise;
      const pathAfterTimeout = process.env.PATH;

      // Now simulate the shell finally responding to SIGTERM (within the
      // 500ms grace window) with valid markers — this MUST NOT clobber the
      // post-race PATH.
      mockChild!.stdout.emit(
        "data",
        Buffer.from(`${mockMarker}${JSON.stringify({ PATH: "/late/clobber" })}${mockMarker}`)
      );
      mockChild!.emit("close", 0);
      // Drain microtasks so any (incorrectly) pending PATH assignment runs.
      await vi.advanceTimersByTimeAsync(0);

      expect(process.env.PATH).toBe(pathAfterTimeout);
      expect(process.env.PATH).not.toBe("/late/clobber");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("refreshPath shell observation (#12371)", () => {
  const savedShell = process.env.SHELL;

  beforeEach(() => {
    vi.resetModules();
    savedPath = process.env.PATH;
    vi.clearAllMocks();
    delete process.env.DAINTREE_SHELL_PROBE;
    process.env.SHELL = "/bin/zsh";
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("keeps what the named login shell exports for Claude's store, and nothing else", async () => {
    shellEnvMock.mockResolvedValue({
      PATH: "/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: "/custom/claude",
      UNRELATED_SECRET: "never kept",
    });
    const { refreshPath } = await import("../environment.js");
    const { getShellEnvironmentObservation } = await import("../shellEnvironmentObservation.js");
    expect(getShellEnvironmentObservation()).toBeUndefined();

    await refreshPath();

    expect(shellEnvMock).toHaveBeenCalledWith("/bin/zsh");
    expect(getShellEnvironmentObservation()).toEqual({
      shell: "/bin/zsh",
      env: { CLAUDE_CONFIG_DIR: "/custom/claude" },
    });
  });

  it("records a probed shell that leaves the store unset", async () => {
    shellEnvMock.mockResolvedValue({ PATH: "/usr/bin:/bin" });
    const { refreshPath } = await import("../environment.js");
    const { getShellEnvironmentObservation } = await import("../shellEnvironmentObservation.js");

    await refreshPath();

    expect(getShellEnvironmentObservation()).toEqual({ shell: "/bin/zsh", env: {} });
  });

  it("observes nothing when the named shell fails, though PATH still comes from the fallback", async () => {
    shellEnvMock
      .mockRejectedValueOnce(new Error("broken .zshrc"))
      .mockResolvedValueOnce({ PATH: "/from/fallback", CLAUDE_CONFIG_DIR: "/other/claude" });
    const { refreshPath } = await import("../environment.js");
    const { getShellEnvironmentObservation } = await import("../shellEnvironmentObservation.js");

    await refreshPath();

    expect(shellEnvMock).toHaveBeenLastCalledWith();
    expect(process.env.PATH).toBe("/from/fallback");
    expect(getShellEnvironmentObservation()).toBeUndefined();
  });

  it("observes nothing without a named shell to probe", async () => {
    delete process.env.SHELL;
    shellEnvMock.mockResolvedValue({ PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: "/custom/claude" });
    const { refreshPath } = await import("../environment.js");
    const { getShellEnvironmentObservation } = await import("../shellEnvironmentObservation.js");

    await refreshPath();

    expect(getShellEnvironmentObservation()).toBeUndefined();
  });
});

describe("refreshPath — Linux fallback bin dirs", () => {
  const d = path.delimiter;
  const ENV_KEYS = [
    "NPM_CONFIG_PREFIX",
    "npm_config_prefix",
    "CARGO_HOME",
    "BUN_INSTALL",
    "DENO_INSTALL_ROOT",
    "HOMEBREW_PREFIX",
    "HOME",
  ] as const;
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    savedPath = process.env.PATH;
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    delete process.env.DAINTREE_SHELL_PROBE;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  // vi.resetModules re-runs the fs mock factory, so the instances environment.js
  // will see are the ones imported after the reset.
  async function stubFs(existing: readonly string[], npmrc?: string): Promise<void> {
    const fsModule = await import("fs");
    vi.mocked(fsModule.existsSync).mockImplementation((p) => existing.includes(String(p)));
    if (npmrc !== undefined) {
      vi.mocked(fsModule.default.readFileSync).mockImplementation((p) => {
        if (String(p) === "/home/testuser/.npmrc") return npmrc;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
    }
  }

  async function refreshOn(platform: NodeJS.Platform, shellPath: string): Promise<string> {
    Object.defineProperty(process, "platform", { value: platform, writable: true });
    shellEnvMock.mockResolvedValue({ PATH: shellPath });
    const { refreshPath } = await import("../environment.js");
    await refreshPath();
    return process.env.PATH ?? "";
  }

  it("appends the standard Linux dirs that exist, after the shell's PATH", async () => {
    await stubFs([
      "/home/testuser/.npm-global/bin",
      "/home/testuser/.cargo/bin",
      "/home/testuser/.bun/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/snap/bin",
    ]);

    const result = await refreshOn("linux", ["/usr/bin", "/bin"].join(d));

    expect(result).toBe(
      [
        "/usr/bin",
        "/bin",
        "/home/testuser/.npm-global/bin",
        "/home/testuser/.cargo/bin",
        "/home/testuser/.bun/bin",
        "/home/linuxbrew/.linuxbrew/bin",
        "/snap/bin",
      ].join(d)
    );
  });

  it("still prepends the version-manager shims and ~/.local/bin", async () => {
    await stubFs(["/home/testuser/.local/bin", "/home/testuser/.npm-global/bin"]);

    const result = await refreshOn("linux", "/usr/bin");

    expect(result).toBe(
      ["/home/testuser/.local/bin", "/usr/bin", "/home/testuser/.npm-global/bin"].join(d)
    );
  });

  it("finds the CLI dirs when the login-shell read fails", async () => {
    await stubFs(["/home/testuser/.npm-global/bin", "/snap/bin"]);
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    process.env.PATH = "/usr/bin";
    shellEnvMock.mockRejectedValue(new Error("broken .bashrc"));

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe(
      ["/usr/bin", "/home/testuser/.npm-global/bin", "/snap/bin"].join(d)
    );
  });

  it("leaves a dir the shell already put on PATH where the shell put it", async () => {
    await stubFs(["/home/testuser/.npm-global/bin", "/snap/bin"]);

    const shellPath = ["/home/testuser/.npm-global/bin", "/usr/bin", "/snap/bin"].join(d);
    expect(await refreshOn("linux", shellPath)).toBe(shellPath);
  });

  it("follows the npm prefix ~/.npmrc names, with ${VAR} expanded", async () => {
    process.env.HOME = "/home/testuser";
    await stubFs(
      ["/home/testuser/.npm-packages/bin"],
      "registry=https://registry.npmjs.org/\nprefix=${HOME}/.npm-packages\n"
    );

    expect(await refreshOn("linux", "/usr/bin")).toBe(
      ["/usr/bin", "/home/testuser/.npm-packages/bin"].join(d)
    );
  });

  it("expands a leading ~ in the npmrc prefix and takes the last one", async () => {
    await stubFs(["/home/testuser/.node/bin"], "prefix=/opt/old\nprefix = '~/.node'\n");

    expect(await refreshOn("linux", "/usr/bin")).toBe(
      ["/usr/bin", "/home/testuser/.node/bin"].join(d)
    );
  });

  it("prefers NPM_CONFIG_PREFIX over ~/.npmrc", async () => {
    process.env.NPM_CONFIG_PREFIX = "/home/testuser/.env-prefix";
    await stubFs(
      ["/home/testuser/.env-prefix/bin", "/home/testuser/.npmrc-prefix/bin"],
      "prefix=/home/testuser/.npmrc-prefix\n"
    );

    expect(await refreshOn("linux", "/usr/bin")).toBe(
      ["/usr/bin", "/home/testuser/.env-prefix/bin"].join(d)
    );
  });

  it("ignores a relative npm prefix rather than resolving it against the cwd", async () => {
    await stubFs(["relative/bin"], "prefix=relative\n");

    expect(await refreshOn("linux", "/usr/bin")).toBe("/usr/bin");
  });

  it("honours CARGO_HOME, BUN_INSTALL and HOMEBREW_PREFIX", async () => {
    process.env.CARGO_HOME = "/opt/cargo";
    process.env.BUN_INSTALL = "/opt/bun";
    process.env.HOMEBREW_PREFIX = "/opt/brew";
    await stubFs(["/opt/cargo/bin", "/opt/bun/bin", "/opt/brew/bin", "/home/testuser/.cargo/bin"]);

    expect(await refreshOn("linux", "/usr/bin")).toBe(
      ["/usr/bin", "/opt/cargo/bin", "/opt/bun/bin", "/opt/brew/bin"].join(d)
    );
  });

  it("adds none of them on macOS", async () => {
    await stubFs([
      "/home/testuser/.npm-global/bin",
      "/home/testuser/.cargo/bin",
      "/home/testuser/bin",
      "/snap/bin",
    ]);

    expect(await refreshOn("darwin", "/usr/bin")).toBe("/usr/bin");
  });
});

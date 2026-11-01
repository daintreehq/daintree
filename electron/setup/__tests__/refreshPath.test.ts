import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { stubProcessKillForFile } from "../../__tests__/helpers/processKillGuard.js";

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
const userInfoMock = vi.fn(() => ({ shell: "/bin/zsh" as string | null }));
vi.mock("os", () => ({
  default: {
    homedir: () => "/home/testuser",
    totalmem: () => 16 * 1024 ** 3,
    userInfo: () => userInfoMock(),
  },
  homedir: () => "/home/testuser",
  totalmem: () => 16 * 1024 ** 3,
}));

const execFileMock = vi.fn();
const spawnMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

interface MockStream extends EventEmitter {
  setEncoding: ReturnType<typeof vi.fn>;
}

interface MockChild extends EventEmitter {
  pid: number;
  stdin: EventEmitter;
  stdout: MockStream;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

let nextPid = 40_000;

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.pid = nextPid++;
  child.stdin = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function extractMarker(probeCmd: string): string {
  const match = /printf '%s' "([0-9a-f]+)"/.exec(probeCmd);
  if (!match) throw new Error(`marker not found in probe command: ${probeCmd}`);
  return match[1];
}

const SHELL_ENV_DELIMITER = "_SHELL_ENV_DELIMITER_";

// Each login shell the default path spawns asks this how to answer: resolve
// with the environment it prints, reject for a shell that exits non-zero, or
// never settle for one whose profile hangs.
const loginShellMock = vi.fn<(shell: string) => Promise<Record<string, string>>>();

// Mock shells that have been spawned and not yet exited, by PID.
const liveShells = new Map<number, MockChild>();
let maxLiveShells = 0;
// How the mock shells take signals sent to their process group.
let shellsIgnoreSigterm = false;
let shellsIgnoreSigkill = false;

function endShell(child: MockChild, code: number | null, signal: NodeJS.Signals | null = null) {
  if (!liveShells.delete(child.pid)) return;
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
}

function printEnv(child: MockChild, env: Record<string, string>): void {
  const lines = Object.entries(env)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  child.stdout.emit("data", `${SHELL_ENV_DELIMITER}${lines}${SHELL_ENV_DELIMITER}`);
}

function spawnLoginShell(shell: string): MockChild {
  const child = createMockChild();
  liveShells.set(child.pid, child);
  maxLiveShells = Math.max(maxLiveShells, liveShells.size);
  void loginShellMock(shell).then(
    (env) => {
      if (!liveShells.has(child.pid)) return;
      printEnv(child, env);
      endShell(child, 0);
    },
    () => endShell(child, 1)
  );
  return child;
}

function spawnedShells(): string[] {
  return spawnMock.mock.calls
    .filter((call) => (call[1] as string[] | undefined)?.[0] === "-ilc")
    .map((call) => call[0] as string);
}

const killSpy = stubProcessKillForFile();

beforeEach(() => {
  liveShells.clear();
  maxLiveShells = 0;
  shellsIgnoreSigterm = false;
  shellsIgnoreSigkill = false;
  loginShellMock.mockReset();
  userInfoMock.mockReset();
  userInfoMock.mockReturnValue({ shell: "/bin/zsh" });
  spawnMock.mockImplementation((shell: string) => spawnLoginShell(shell));
  killSpy().mockImplementation((pid: number, signal?: string | number) => {
    const child = liveShells.get(-pid);
    if (child) {
      if (signal === "SIGKILL" && !shellsIgnoreSigkill) endShell(child, null, "SIGKILL");
      if (signal === "SIGTERM" && !shellsIgnoreSigterm) endShell(child, null, "SIGTERM");
    }
    return true;
  });
});

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

    loginShellMock.mockResolvedValue({
      PATH: "/usr/local/bin:/usr/bin:/home/user/.nvm/versions/node/v20/bin",
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/usr/local/bin:/usr/bin:/home/user/.nvm/versions/node/v20/bin");
  });

  it("deduplicates PATH entries", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const d = path.delimiter;

    loginShellMock.mockResolvedValue({
      PATH: ["/usr/bin", "/usr/local/bin", "/usr/bin", "/usr/local/bin"].join(d),
    });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe(["/usr/bin", "/usr/local/bin"].join(d));
  });

  it("falls back to current PATH when the login shell times out", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.env.PATH = "/original/path";

    loginShellMock.mockImplementation(() => new Promise(() => {})); // never resolves

    try {
      const { refreshPath } = await import("../environment.js");
      const refreshPromise = refreshPath();
      await vi.advanceTimersByTimeAsync(10_000);
      await refreshPromise;

      expect(process.env.PATH).toBe("/original/path");
      // Let the kill grace run so the read is released inside this test.
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to current PATH when every login shell fails", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.env.PATH = "/original/path";

    loginShellMock.mockRejectedValue(new Error("shell failed"));

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(process.env.PATH).toBe("/original/path");
  });

  it("preserves current PATH when the login shell exports no PATH", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.env.PATH = "/original/path";

    loginShellMock.mockResolvedValue({});

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

  it("runs the default login-shell read, not the markered probe, when DAINTREE_SHELL_PROBE is unset", async () => {
    delete process.env.DAINTREE_SHELL_PROBE;
    process.env.PATH = "/usr/bin";
    loginShellMock.mockResolvedValue({ PATH: "/from/login-shell" });

    const { refreshPath } = await import("../environment.js");
    await refreshPath();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1]).not.toContain("-i");
    expect(spawnedShells()).toHaveLength(1);
    expect(process.env.PATH).toBe("/from/login-shell");
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
    expect(spawnedShells()).toEqual([]);
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
    loginShellMock.mockResolvedValue({
      PATH: "/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: "/custom/claude",
      UNRELATED_SECRET: "never kept",
    });
    const { refreshPath } = await import("../environment.js");
    const { getShellEnvironmentObservation } = await import("../shellEnvironmentObservation.js");
    expect(getShellEnvironmentObservation()).toBeUndefined();

    await refreshPath();

    expect(loginShellMock).toHaveBeenCalledWith("/bin/zsh");
    expect(getShellEnvironmentObservation()).toEqual({
      shell: "/bin/zsh",
      env: { CLAUDE_CONFIG_DIR: "/custom/claude" },
    });
  });

  it("records a probed shell that leaves the store unset", async () => {
    loginShellMock.mockResolvedValue({ PATH: "/usr/bin:/bin" });
    const { refreshPath } = await import("../environment.js");
    const { getShellEnvironmentObservation } = await import("../shellEnvironmentObservation.js");

    await refreshPath();

    expect(getShellEnvironmentObservation()).toEqual({ shell: "/bin/zsh", env: {} });
  });

  it("observes nothing when the named shell fails, though PATH still comes from the fallback", async () => {
    loginShellMock
      .mockRejectedValueOnce(new Error("broken .zshrc"))
      .mockResolvedValueOnce({ PATH: "/from/fallback", CLAUDE_CONFIG_DIR: "/other/claude" });
    const { refreshPath } = await import("../environment.js");
    const { getShellEnvironmentObservation } = await import("../shellEnvironmentObservation.js");

    await refreshPath();

    // Named first, then the unnamed default, which is the same shell here.
    expect(spawnedShells()).toEqual(["/bin/zsh", "/bin/zsh"]);
    expect(process.env.PATH).toBe("/from/fallback");
    expect(getShellEnvironmentObservation()).toBeUndefined();
  });

  it("observes nothing without a named shell to probe", async () => {
    delete process.env.SHELL;
    loginShellMock.mockResolvedValue({
      PATH: "/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: "/custom/claude",
    });
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
    loginShellMock.mockResolvedValue({ PATH: shellPath });
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
    loginShellMock.mockRejectedValue(new Error("broken .bashrc"));

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

describe("refreshPath — login shell lifecycle (#15565)", () => {
  const savedShell = process.env.SHELL;
  // Captured before fake timers replace them: they let the leaf's dynamic
  // import land without moving the fake clock.
  const realSetTimeout = setTimeout;
  const realNow = Date.now;
  let exitListenersBefore = 0;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const fsModule = await import("fs");
    vi.mocked(fsModule.existsSync).mockReturnValue(false);
    savedPath = process.env.PATH;
    delete process.env.DAINTREE_SHELL_PROBE;
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/orig";
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    exitListenersBefore = process.listenerCount("exit");
    vi.useFakeTimers();
  });

  afterEach(async () => {
    // Every read releases once its shells are gone and their grace has run.
    shellsIgnoreSigterm = false;
    shellsIgnoreSigkill = false;
    for (const child of [...liveShells.values()]) endShell(child, null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(11_000);
    vi.useRealTimers();
    expect(process.listenerCount("exit")).toBe(exitListenersBefore);
    process.env.PATH = savedPath;
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  async function loadRefreshPath() {
    const { refreshPath } = await import("../environment.js");
    await import("../loginShellEnvironment.js");
    const { getShellEnvironmentObservation } = await import("../shellEnvironmentObservation.js");
    return { refreshPath, getShellEnvironmentObservation };
  }

  async function untilReal(predicate: () => boolean): Promise<void> {
    const end = realNow() + 5_000;
    while (!predicate() && realNow() < end) {
      await new Promise((resolve) => realSetTimeout(resolve, 2));
    }
  }

  async function untilSpawned(count: number): Promise<void> {
    await untilReal(() => spawnedShells().length >= count);
    expect(spawnedShells()).toHaveLength(count);
  }

  // A refresh that spawns nothing still crosses the leaf's dynamic import.
  async function settleWithoutTimers(promise: Promise<unknown>): Promise<void> {
    let done = false;
    void promise.then(() => (done = true));
    await untilReal(() => done);
    expect(done).toBe(true);
  }

  function groupSignals(): Array<[number, string | number | undefined]> {
    return killSpy()
      .mock.calls.filter(([pid]) => pid < 0)
      .map(([pid, signal]) => [pid, signal]);
  }

  // A shell that exits at once while something it started keeps its output
  // pipe open, ignoring SIGTERM: only the group's SIGKILL closes it.
  function spawnShellThatLeavesAChild(): MockChild[] {
    const spawned: MockChild[] = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      spawned.push(child);
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    killSpy().mockImplementation((pid: number, signal?: string | number) => {
      const child = spawned.find((c) => c.pid === -pid);
      if (child && signal === "SIGKILL") child.emit("close", null, "SIGKILL");
      return true;
    });
    return spawned;
  }

  it("terminates a login shell that never exits at the deadline, then SIGKILLs its group", async () => {
    shellsIgnoreSigterm = true;
    loginShellMock.mockReturnValue(new Promise(() => {}));
    const { refreshPath } = await loadRefreshPath();

    const refresh = refreshPath();
    await untilSpawned(1);
    const [pid] = [...liveShells.keys()];
    await vi.advanceTimersByTimeAsync(9_999);
    expect(groupSignals()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await refresh;
    expect(groupSignals()).toEqual([[-pid!, "SIGTERM"]]);
    expect(process.env.PATH).toBe("/orig");

    await vi.advanceTimersByTimeAsync(500);
    expect(groupSignals()).toEqual([
      [-pid!, "SIGTERM"],
      [-pid!, "SIGKILL"],
    ]);
    expect(liveShells.size).toBe(0);
  });

  it("starts no more shells for back-to-back refreshes while a timed-out one is alive", async () => {
    shellsIgnoreSigterm = true;
    loginShellMock.mockReturnValue(new Promise(() => {}));
    const { refreshPath } = await loadRefreshPath();

    const first = refreshPath();
    await untilSpawned(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await first;

    // Focus, wake, launcher and wizard-poll refreshes inside the kill grace.
    await settleWithoutTimers(refreshPath());
    await settleWithoutTimers(Promise.all([refreshPath(), refreshPath()]));
    await settleWithoutTimers(refreshPath());
    expect(spawnedShells()).toHaveLength(1);
    expect(process.env.PATH).toBe("/orig");

    // Once SIGKILL has reaped it, the next refresh may read again.
    await vi.advanceTimersByTimeAsync(500);
    expect(liveShells.size).toBe(0);
    const next = refreshPath();
    await untilSpawned(2);
    await vi.advanceTimersByTimeAsync(10_500);
    await next;

    expect(maxLiveShells).toBe(1);
  });

  it("keeps a shell SIGKILL has not reaped yet as the only one", async () => {
    shellsIgnoreSigterm = true;
    shellsIgnoreSigkill = true;
    loginShellMock.mockReturnValue(new Promise(() => {}));
    const { refreshPath } = await loadRefreshPath();

    const first = refreshPath();
    await untilSpawned(1);
    await vi.advanceTimersByTimeAsync(10_500);
    await first;

    for (let i = 0; i < 3; i++) {
      const refresh = refreshPath();
      await vi.advanceTimersByTimeAsync(10_000);
      await refresh;
    }

    expect(spawnedShells()).toHaveLength(1);
    expect(liveShells.size).toBe(1);
    expect(process.env.PATH).toBe("/orig");
  });

  it("holds the read through the grace when the shell exited but its group still holds the output", async () => {
    const spawned = spawnShellThatLeavesAChild();
    const { refreshPath } = await loadRefreshPath();

    const first = refreshPath();
    await untilSpawned(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    expect(groupSignals()).toEqual([[-spawned[0]!.pid, "SIGTERM"]]);
    expect(process.env.PATH).toBe("/orig");

    await settleWithoutTimers(refreshPath());
    expect(spawnedShells()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(groupSignals()).toEqual([
      [-spawned[0]!.pid, "SIGTERM"],
      [-spawned[0]!.pid, "SIGKILL"],
    ]);
    const next = refreshPath();
    await untilSpawned(2);
    await vi.advanceTimersByTimeAsync(10_500);
    await next;
  });

  it("kills a read's process group when Daintree exits mid-read", async () => {
    const spawned = spawnShellThatLeavesAChild();
    const before = process.listeners("exit");
    const { refreshPath } = await loadRefreshPath();

    const refresh = refreshPath();
    await untilSpawned(1);
    const added = process.listeners("exit").filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);

    (added[0] as () => void)();
    expect(groupSignals()).toEqual([[-spawned[0]!.pid, "SIGKILL"]]);

    await vi.advanceTimersByTimeAsync(10_000);
    await refresh;
  });

  it("ignores an answer the shell gives after the deadline", async () => {
    const fsModule = await import("fs");
    vi.mocked(fsModule.existsSync).mockImplementation(
      (p) => String(p) === "/home/testuser/.volta/bin"
    );
    shellsIgnoreSigterm = true;
    let answer!: (env: Record<string, string>) => void;
    loginShellMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { refreshPath, getShellEnvironmentObservation } = await loadRefreshPath();

    const first = refreshPath();
    await untilSpawned(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    expect(process.env.PATH).toBe(["/home/testuser/.volta/bin", "/orig"].join(path.delimiter));

    // A refresh that has already begun when the late answer lands.
    const second = refreshPath();
    answer({ PATH: "/late/clobber", CLAUDE_CONFIG_DIR: "/late/claude" });
    await settleWithoutTimers(second);
    await vi.advanceTimersByTimeAsync(500);

    expect(process.env.PATH).toBe(["/home/testuser/.volta/bin", "/orig"].join(path.delimiter));
    expect(getShellEnvironmentObservation()).toBeUndefined();
    expect(spawnedShells()).toHaveLength(1);
  });

  it("still takes PATH and the shell observation from a slow profile that finishes in time", async () => {
    loginShellMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                PATH: ["/slow/bin", "/usr/bin", "/slow/bin"].join(path.delimiter),
                CLAUDE_CONFIG_DIR: "/slow/claude",
              }),
            9_500
          )
        )
    );
    const { refreshPath, getShellEnvironmentObservation } = await loadRefreshPath();

    const refresh = refreshPath();
    await untilSpawned(1);
    await vi.advanceTimersByTimeAsync(9_500);
    await refresh;

    expect(process.env.PATH).toBe(["/slow/bin", "/usr/bin"].join(path.delimiter));
    expect(getShellEnvironmentObservation()).toEqual({
      shell: "/bin/zsh",
      env: { CLAUDE_CONFIG_DIR: "/slow/claude" },
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(groupSignals()).toEqual([]);
  });

  it("gives the named shell and every fallback one budget between them", async () => {
    userInfoMock.mockReturnValue({ shell: "/opt/homebrew/bin/fish" });
    loginShellMock.mockImplementation((shell) =>
      shell === "/opt/homebrew/bin/fish"
        ? new Promise(() => {})
        : new Promise((_resolve, reject) => setTimeout(() => reject(new Error("exit 1")), 6_000))
    );
    const { refreshPath, getShellEnvironmentObservation } = await loadRefreshPath();

    const refresh = refreshPath();
    await untilSpawned(1);
    await vi.advanceTimersByTimeAsync(6_000);
    await untilSpawned(2);
    expect(spawnedShells()).toEqual(["/bin/zsh", "/opt/homebrew/bin/fish"]);
    const fishPid = [...liveShells.keys()][0];

    await vi.advanceTimersByTimeAsync(3_999);
    expect(groupSignals()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(groupSignals()).toEqual([[-fishPid!, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(500);
    await refresh;

    // The zsh/bash fallbacks never start after the deadline.
    expect(spawnedShells()).toEqual(["/bin/zsh", "/opt/homebrew/bin/fish"]);
    expect(getShellEnvironmentObservation()).toBeUndefined();
  });

  it("tries the unnamed default, then zsh and bash without it, then keeps this process's PATH", async () => {
    delete process.env.SHELL;
    userInfoMock.mockReturnValue({ shell: "/bin/bash" });
    loginShellMock.mockRejectedValue(new Error("exit 1"));
    const { refreshPath } = await loadRefreshPath();

    const refresh = refreshPath();
    await untilSpawned(2);
    await refresh;

    expect(spawnedShells()).toEqual(["/bin/bash", "/bin/zsh"]);
    expect(process.env.PATH).toBe("/orig");
  });

  it("settles the unnamed shells once, as shell-env did on import", async () => {
    delete process.env.SHELL;
    userInfoMock.mockReturnValue({ shell: "/bin/bash" });
    loginShellMock.mockRejectedValue(new Error("exit 1"));
    const { refreshPath } = await loadRefreshPath();

    const first = refreshPath();
    await untilSpawned(2);
    await first;
    userInfoMock.mockReturnValue({ shell: "/opt/homebrew/bin/fish" });
    const second = refreshPath();
    await untilSpawned(4);
    await second;

    expect(spawnedShells()).toEqual(["/bin/bash", "/bin/zsh", "/bin/bash", "/bin/zsh"]);
  });

  it("reads a section with no closing delimiter, less its final CRLF", async () => {
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => {
        child.stdout.emit("data", `${SHELL_ENV_DELIMITER}PATH=/crlf/bin\r\n`);
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    });
    const { refreshPath } = await loadRefreshPath();

    const refresh = refreshPath();
    await untilSpawned(1);
    await refresh;

    expect(process.env.PATH).toBe("/crlf/bin");
  });

  it("spawns -ilc in its own process group, with shell-env's overrides winning over inherited values", async () => {
    const names = ["DISABLE_AUTO_UPDATE", "ZSH_TMUX_AUTOSTARTED", "ZSH_TMUX_AUTOSTART"];
    const saved = Object.fromEntries(
      [...names, "DAINTREE_LOGIN_SHELL_TEST"].map((name) => [name, process.env[name]])
    );
    for (const name of names) process.env[name] = "inherited";
    process.env.DAINTREE_LOGIN_SHELL_TEST = "kept";
    loginShellMock.mockResolvedValue({ PATH: "/usr/bin" });

    try {
      const { refreshPath } = await loadRefreshPath();
      const refresh = refreshPath();
      await untilSpawned(1);
      await refresh;

      const [shell, args, options] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { detached: boolean; env: NodeJS.ProcessEnv },
      ];
      expect(shell).toBe("/bin/zsh");
      expect(args[1]).toContain("command env");
      expect(options.detached).toBe(true);
      expect(options.env.DAINTREE_LOGIN_SHELL_TEST).toBe("kept");
      for (const name of names) {
        expect(options.env[name]).toBeDefined();
        expect(options.env[name]).not.toBe("inherited");
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("moves on to the next shell when one cannot be spawned", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("EAGAIN");
    });
    loginShellMock.mockResolvedValue({ PATH: "/from/fallback" });
    const { refreshPath, getShellEnvironmentObservation } = await loadRefreshPath();

    const refresh = refreshPath();
    await untilSpawned(2);
    await refresh;

    expect(spawnedShells()).toEqual(["/bin/zsh", "/bin/zsh"]);
    expect(process.env.PATH).toBe("/from/fallback");
    expect(getShellEnvironmentObservation()).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";

/** Normalize a path to forward slashes for cross-platform mock matching */
const n = (p: string) => (p as string).replace(/\\/g, "/");

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  access: vi.fn(),
  cp: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("../../utils/fs.js", () => ({
  resilientAtomicWriteFile: vi.fn().mockResolvedValue(undefined),
}));

describe("WorktreeLifecycleService", () => {
  let service: import("../WorktreeLifecycleService.js").WorktreeLifecycleService;
  let mockAccess: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockCp: ReturnType<typeof vi.fn>;
  let mockSpawn: ReturnType<typeof vi.fn>;
  let mockSpawnSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const fsModule = await import("fs/promises");
    mockAccess = vi.mocked(fsModule.access);
    mockReadFile = vi.mocked(fsModule.readFile);
    mockCp = vi.mocked(fsModule.cp);

    const childProcessModule = await import("child_process");
    mockSpawn = vi.mocked(childProcessModule.spawn);
    mockSpawnSync = vi.mocked(
      (childProcessModule as unknown as { spawnSync: ReturnType<typeof vi.fn> }).spawnSync
    );

    const { WorktreeLifecycleService } = await import("../WorktreeLifecycleService.js");
    service = new WorktreeLifecycleService("/home/testuser");
  });

  describe("loadConfig", () => {
    it("returns null when no config files exist", async () => {
      mockAccess.mockRejectedValue(new Error("ENOENT"));
      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).toBeNull();
    });

    it("returns main repo config when only it exists", async () => {
      const projectConfig = { setup: ["npm install"], teardown: ["docker compose down"] };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.daintree/config.json")) throw new Error("ENOENT");
        return undefined; // main repo config exists
      });

      mockReadFile.mockResolvedValue(JSON.stringify(projectConfig));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).toEqual(projectConfig);
    });

    it("uses worktree-level config over main repo config (priority chain)", async () => {
      const mainConfig = { setup: ["npm install"] };
      const worktreeConfig = { setup: ["yarn install"] };

      mockAccess.mockImplementation(async (p: string) => {
        // user config does not exist
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        // worktree config exists (second check)
        return undefined;
      });

      mockReadFile.mockImplementation(async (p: string) => {
        if (n(p).endsWith("/worktree/.daintree/config.json")) {
          return JSON.stringify(worktreeConfig);
        }
        return JSON.stringify(mainConfig);
      });

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result?.setup).toEqual(["yarn install"]);
    });

    it("uses user-level config as highest priority", async () => {
      const userConfig = { setup: ["bun install"] };

      mockAccess.mockResolvedValue(undefined); // all files exist
      mockReadFile.mockResolvedValue(JSON.stringify(userConfig));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      // First existing valid config wins — user-level is first
      expect(result?.setup).toEqual(["bun install"]);
    });

    it("skips invalid JSON and tries next config", async () => {
      const validConfig = { setup: ["npm install"] };

      let readCount = 0;
      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockImplementation(async () => {
        readCount++;
        if (readCount === 1) return "not valid json{{{";
        return JSON.stringify(validConfig);
      });

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).toEqual(validConfig);
    });

    it("skips config with invalid schema and tries next", async () => {
      const invalidConfig = { setup: [123, true] }; // not strings
      const validConfig = { setup: ["npm install"] };

      let readCount = 0;
      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockImplementation(async () => {
        readCount++;
        if (readCount === 1) return JSON.stringify(invalidConfig);
        return JSON.stringify(validConfig);
      });

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).toEqual(validConfig);
    });

    it("returns config with only setup or only teardown", async () => {
      const config = { teardown: ["docker compose down"] };

      mockAccess.mockImplementation(async (p: string) => {
        if (!n(p).endsWith("/project/.daintree/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result?.setup).toBeUndefined();
      expect(result?.teardown).toEqual(["docker compose down"]);
    });
  });

  describe("copyDaintreeDir", () => {
    it("does nothing if source .daintree does not exist", async () => {
      mockAccess.mockRejectedValue(new Error("ENOENT"));
      await service.copyDaintreeDir("/main/repo", "/new/worktree");
      expect(mockCp).not.toHaveBeenCalled();
    });

    it("copies .daintree from src to dest even if dest already exists (force:false preserves existing)", async () => {
      mockAccess.mockResolvedValue(undefined); // src exists
      await service.copyDaintreeDir("/main/repo", "/new/worktree");
      expect(mockCp).toHaveBeenCalledWith(
        path.join("/main/repo", ".daintree"),
        path.join("/new/worktree", ".daintree"),
        {
          recursive: true,
          force: false,
          errorOnExist: false,
        }
      );
    });

    it("copies .daintree from src to dest when src exists", async () => {
      mockAccess.mockImplementation(async (p: string) => {
        if ((p as string).includes(path.join("/main/repo", ".daintree"))) return undefined; // src exists
        throw new Error("ENOENT"); // dest does not
      });

      await service.copyDaintreeDir("/main/repo", "/new/worktree");
      expect(mockCp).toHaveBeenCalledWith(
        path.join("/main/repo", ".daintree"),
        path.join("/new/worktree", ".daintree"),
        {
          recursive: true,
          force: false,
          errorOnExist: false,
        }
      );
    });

    it("propagates the error if cp fails so the caller can surface it", async () => {
      // Per #8401, copyDaintreeDir no longer swallows its error — the caller
      // (WorkspaceService createWorktree async tail) has `worktreeId` in scope
      // and routes the failure through `notify-error` so the worktree card can
      // show it instead of disappearing into `console.warn`.
      mockAccess.mockImplementation(async (p: string) => {
        if ((p as string).includes(path.join("/main/repo", ".daintree"))) return undefined;
        throw new Error("ENOENT");
      });
      mockCp.mockRejectedValue(new Error("Permission denied"));

      await expect(service.copyDaintreeDir("/main/repo", "/new/worktree")).rejects.toThrow(
        "Permission denied"
      );
    });
  });

  describe("buildEnv", () => {
    it("returns DAINTREE_* and non-interactive environment variables", () => {
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/my-branch");
      expect(env).toEqual({
        CI: "true",
        NONINTERACTIVE: "1",
        GIT_TERMINAL_PROMPT: "0",
        DEBIAN_FRONTEND: "noninteractive",
        DAINTREE_WORKTREE_PATH: "/worktrees/feat",
        DAINTREE_PROJECT_ROOT: "/project",
        DAINTREE_WORKTREE_NAME: "feature/my-branch",
      });
    });
  });

  describe("runCommands", () => {
    function makeFakeProcess(exitCode: number = 0, errorEvent?: Error) {
      const stdout = { on: vi.fn() };
      const stderr = { on: vi.fn() };
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

      const child = {
        pid: 12345,
        stdout,
        stderr,
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          listeners[event] ??= [];
          listeners[event].push(cb);
        }),
        kill: vi.fn(),
        emit: (event: string, ...args: unknown[]) => {
          listeners[event]?.forEach((cb) => cb(...args));
        },
      };

      // Simulate async process completion
      setTimeout(() => {
        if (errorEvent) {
          child.emit("error", errorEvent);
        } else {
          child.emit("close", exitCode);
        }
      }, 0);

      return child;
    }

    function makeFakeProcessWithOutput(
      stdoutData: string | string[],
      exitCode: number = 0,
      stderrData?: string
    ) {
      const stdoutListeners: ((chunk: Buffer) => void)[] = [];
      const stderrListeners: ((chunk: Buffer) => void)[] = [];
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

      const stdout = {
        on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
          if (event === "data") stdoutListeners.push(cb);
        }),
      };
      const stderr = {
        on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
          if (event === "data") stderrListeners.push(cb);
        }),
      };

      const child = {
        pid: 12345,
        stdout,
        stderr,
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          listeners[event] ??= [];
          listeners[event].push(cb);
        }),
        kill: vi.fn(),
        emit: (event: string, ...args: unknown[]) => {
          listeners[event]?.forEach((cb) => cb(...args));
        },
      };

      const stdoutChunks = Array.isArray(stdoutData) ? stdoutData : [stdoutData];

      setTimeout(() => {
        for (const chunk of stdoutChunks) {
          stdoutListeners.forEach((cb) => cb(Buffer.from(chunk)));
        }
        if (stderrData !== undefined) {
          stderrListeners.forEach((cb) => cb(Buffer.from(stderrData)));
        }
        child.emit("close", exitCode);
      }, 0);

      return child;
    }

    it("returns success when command exits with code 0", async () => {
      mockSpawn.mockReturnValue(makeFakeProcess(0));

      const onProgress = vi.fn();
      const result = await service.runCommands(["echo hello"], {
        cwd: "/test",
        env: {},
        onProgress,
      });

      expect(result.success).toBe(true);
      expect(onProgress).toHaveBeenCalledWith(0, 1, "echo hello");
    });

    it("returns failure when command exits with non-zero code", async () => {
      mockSpawn.mockReturnValue(makeFakeProcess(1));

      const result = await service.runCommands(["npm install"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("exit");
    });

    it("stops at first failing command", async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        return makeFakeProcess(callCount === 1 ? 1 : 0);
      });

      const result = await service.runCommands(["failing-cmd", "second-cmd"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(callCount).toBe(1);
    });

    it("returns success for empty commands array", async () => {
      const result = await service.runCommands([], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(true);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("returns failure on spawn error event", async () => {
      mockSpawn.mockReturnValue(makeFakeProcess(0, new Error("ENOENT: not found")));

      const result = await service.runCommands(["nonexistent-cmd"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("ENOENT");
    });

    it.skipIf(process.platform === "win32")("injects PATH and HOME on Unix", async () => {
      const child = makeFakeProcess(0);
      mockSpawn.mockReturnValue(child);

      await service.runCommands(["echo test"], {
        cwd: "/test",
        env: { DAINTREE_WORKTREE_PATH: "/wt" },
        onProgress: vi.fn(),
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        "echo test",
        expect.objectContaining({
          env: expect.objectContaining({
            DAINTREE_WORKTREE_PATH: "/wt",
            PATH: expect.any(String),
            HOME: expect.any(String),
          }),
        })
      );
    });

    it.runIf(process.platform === "win32")("injects PATH and USERPROFILE on Windows", async () => {
      const child = makeFakeProcess(0);
      mockSpawn.mockReturnValue(child);

      await service.runCommands(["echo test"], {
        cwd: "/test",
        env: { DAINTREE_WORKTREE_PATH: "/wt" },
        onProgress: vi.fn(),
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        "echo test",
        expect.objectContaining({
          env: expect.objectContaining({
            DAINTREE_WORKTREE_PATH: "/wt",
            PATH: expect.any(String),
            USERPROFILE: expect.any(String),
          }),
        })
      );
    });

    it("scrubs secrets from captured stdout before returning", async () => {
      const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
      const stdoutText = `Setup complete. token=${token} remaining work to do.`;
      mockSpawn.mockReturnValue(makeFakeProcessWithOutput(stdoutText, 0));

      const result = await service.runCommands(["./setup.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(true);
      expect(result.output).not.toContain(token);
      expect(result.output).toContain("[REDACTED]");
      expect(result.output).toContain("Setup complete.");
      expect(result.output).toContain("remaining work to do.");
    });

    it("scrubs secrets emitted to stderr on command failure", async () => {
      const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
      const stderrText = `error: authentication failed using ${token}`;
      mockSpawn.mockReturnValue(makeFakeProcessWithOutput("", 1, stderrText));

      const result = await service.runCommands(["./setup.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.output).not.toContain(token);
      expect(result.output).toContain("[REDACTED]");
      expect(result.output).toContain("authentication failed");
    });

    it("scrubs secrets when split across multiple stdout chunks (post-join scrubbing)", async () => {
      const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
      const halfA = `before token=ghp_abcdefghijklmnop`;
      const halfB = `qrstuvwxyz0123456789ABCD after`;
      mockSpawn.mockReturnValue(makeFakeProcessWithOutput([halfA, halfB], 0));

      const result = await service.runCommands(["./setup.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(true);
      expect(result.output).not.toContain(token);
      expect(result.output).toContain("[REDACTED]");
      expect(result.output).toContain("before");
      expect(result.output).toContain("after");
    });

    it("preserves valid JSON structure when scrubbing a secret inside a string value", async () => {
      const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
      const json = JSON.stringify({ status: "ok", endpoint: "https://api.example.com", token });
      mockSpawn.mockReturnValue(makeFakeProcessWithOutput(json, 0));

      const result = await service.runCommands(["./status.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(true);
      expect(result.output).not.toContain(token);
      const parsed = JSON.parse(result.output) as Record<string, string>;
      expect(parsed.status).toBe("ok");
      expect(parsed.endpoint).toBe("https://api.example.com");
      expect(parsed.token).toBe("[REDACTED]");
    });

    it("uses detached conditionally based on platform", async () => {
      mockSpawn.mockReturnValue(makeFakeProcess(0));

      await service.runCommands(["echo test"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
      });

      const expectedDetached = process.platform !== "win32";
      expect(mockSpawn).toHaveBeenCalledWith(
        "echo test",
        expect.objectContaining({ detached: expectedDetached, shell: true })
      );
    });

    describe("platform-specific process killing", () => {
      const originalPlatform = process.platform;
      let processKillSpy: ReturnType<typeof vi.spyOn> | undefined;

      afterEach(() => {
        processKillSpy?.mockRestore();
        processKillSpy = undefined;
        Object.defineProperty(process, "platform", { value: originalPlatform });
        vi.useRealTimers();
      });

      it("uses taskkill on Windows for timeout kill", async () => {
        Object.defineProperty(process, "platform", { value: "win32" });
        vi.useFakeTimers();

        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const child = {
          pid: 12345,
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            listeners[event] ??= [];
            listeners[event].push(cb);
          }),
          kill: vi.fn(),
        };
        mockSpawn.mockReturnValue(child);

        const resultPromise = service.runCommands(["slow-cmd"], {
          cwd: "/test",
          env: {},
          timeoutMs: 1000,
          onProgress: vi.fn(),
        });

        // Advance past the timeout
        vi.advanceTimersByTime(1001);

        expect(mockSpawnSync).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "12345"], {
          windowsHide: true,
        });

        // Emit close to resolve the promise
        listeners["close"]?.forEach((cb) => cb(1));
        const result = await resultPromise;
        expect(result.timedOut).toBe(true);
      });

      it("uses process group kill on Unix for timeout kill", async () => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        vi.useFakeTimers();

        processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const child = {
          pid: 12345,
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            listeners[event] ??= [];
            listeners[event].push(cb);
          }),
          kill: vi.fn(),
        };
        mockSpawn.mockReturnValue(child);

        const resultPromise = service.runCommands(["slow-cmd"], {
          cwd: "/test",
          env: {},
          timeoutMs: 1000,
          onProgress: vi.fn(),
        });

        // Advance past the timeout
        vi.advanceTimersByTime(1001);

        expect(processKillSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
        expect(mockSpawnSync).not.toHaveBeenCalled();

        // Advance 5s for SIGKILL escalation
        vi.advanceTimersByTime(5000);
        expect(processKillSpy).toHaveBeenCalledWith(-12345, "SIGKILL");

        // Emit close to resolve the promise
        listeners["close"]?.forEach((cb) => cb(null));
        await resultPromise;
      });

      it("injects USERPROFILE and PATHEXT on Windows", async () => {
        Object.defineProperty(process, "platform", { value: "win32" });

        const child = makeFakeProcess(0);
        mockSpawn.mockReturnValue(child);

        await service.runCommands(["echo test"], {
          cwd: "/test",
          env: { DAINTREE_WORKTREE_PATH: "/wt" },
          onProgress: vi.fn(),
        });

        const spawnEnv = mockSpawn.mock.calls[0][1].env;
        // Windows env-var names are case-insensitive; on a Windows host the
        // copied keys can be any case (e.g. `SYSTEMROOT` or `Systemroot`),
        // so check the upper-cased key set rather than literal property names.
        const upperKeys = new Set(Object.keys(spawnEnv).map((k) => k.toUpperCase()));
        expect(upperKeys.has("USERPROFILE")).toBe(true);
        expect(upperKeys.has("PATHEXT")).toBe(true);
        expect(upperKeys.has("SYSTEMROOT")).toBe(true);
        expect(upperKeys.has("HOME")).toBe(false);
      });

      it("falls back to child.kill() on Windows when pid is undefined", async () => {
        Object.defineProperty(process, "platform", { value: "win32" });
        vi.useFakeTimers();

        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const child = {
          pid: undefined,
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            listeners[event] ??= [];
            listeners[event].push(cb);
          }),
          kill: vi.fn(),
        };
        mockSpawn.mockReturnValue(child);

        const resultPromise = service.runCommands(["slow-cmd"], {
          cwd: "/test",
          env: {},
          timeoutMs: 1000,
          onProgress: vi.fn(),
        });

        vi.advanceTimersByTime(1001);

        expect(mockSpawnSync).not.toHaveBeenCalled();
        expect(child.kill).toHaveBeenCalled();

        listeners["close"]?.forEach((cb) => cb(1));
        await resultPromise;
      });
    });
  });

  describe("teardown log persistence", () => {
    let mockMkdir: ReturnType<typeof vi.fn>;
    let mockReaddir: ReturnType<typeof vi.fn>;
    let mockUnlink: ReturnType<typeof vi.fn>;
    let mockAtomicWrite: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const fsModule = await import("fs/promises");
      mockMkdir = vi.mocked(fsModule.mkdir as unknown as () => Promise<undefined>);
      mockReaddir = vi.mocked(fsModule.readdir as unknown as () => Promise<string[]>);
      mockUnlink = vi.mocked(fsModule.unlink as unknown as () => Promise<void>);

      const fsUtilsModule = await import("../../utils/fs.js");
      mockAtomicWrite = vi.mocked(fsUtilsModule.resilientAtomicWriteFile);
      mockAtomicWrite.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([]);
      mockUnlink.mockResolvedValue(undefined);
    });

    function makeOutputProcess(stdout: string, exitCode = 0) {
      const stdoutListeners: ((chunk: Buffer) => void)[] = [];
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const child = {
        pid: 12345,
        stdout: {
          on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
            if (event === "data") stdoutListeners.push(cb);
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          listeners[event] ??= [];
          listeners[event].push(cb);
        }),
        kill: vi.fn(),
        emit: (event: string, ...args: unknown[]) => {
          listeners[event]?.forEach((cb) => cb(...args));
        },
      };
      setTimeout(() => {
        stdoutListeners.forEach((cb) => cb(Buffer.from(stdout)));
        child.emit("close", exitCode);
      }, 0);
      return child;
    }

    it("does not create or write a log file when logDir is omitted", async () => {
      mockSpawn.mockReturnValue(makeOutputProcess("setup output", 0));

      const result = await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(true);
      expect(result.logPath).toBeUndefined();
      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockAtomicWrite).not.toHaveBeenCalled();
    });

    it("writes a scrubbed full-output log when logDir is provided", async () => {
      const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
      const stdout = `starting... token=${token} ...done`;
      mockSpawn.mockReturnValue(makeOutputProcess(stdout, 0));

      const result = await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
        logDir: "/home/testuser/.daintree/projects/_path_root/teardown-logs/wt-1",
      });

      expect(result.success).toBe(true);
      expect(result.logPath).toBeDefined();
      expect(n(result.logPath ?? "")).toMatch(
        /\/home\/testuser\/\.daintree\/projects\/_path_root\/teardown-logs\/wt-1\/\d+\.log$/
      );
      expect(mockMkdir).toHaveBeenCalledWith(
        "/home/testuser/.daintree/projects/_path_root/teardown-logs/wt-1",
        { recursive: true }
      );
      const writtenContent = mockAtomicWrite.mock.calls[0][1];
      expect(writtenContent).not.toContain(token);
      expect(writtenContent).toContain("[REDACTED]");
      expect(writtenContent).toContain("starting...");
      expect(writtenContent).toContain("...done");
    });

    it("returns undefined logPath when the log write fails (run still succeeds)", async () => {
      mockSpawn.mockReturnValue(makeOutputProcess("output", 0));
      mockAtomicWrite.mockRejectedValueOnce(new Error("ENOSPC: no space left"));

      const result = await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
        logDir: "/some/log/dir",
      });

      expect(result.success).toBe(true);
      expect(result.logPath).toBeUndefined();
    });

    it("returns undefined logPath when mkdir fails (run still succeeds)", async () => {
      mockSpawn.mockReturnValue(makeOutputProcess("output", 0));
      mockMkdir.mockRejectedValueOnce(new Error("EACCES: permission denied"));

      const result = await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
        logDir: "/some/log/dir",
      });

      expect(result.success).toBe(true);
      expect(result.logPath).toBeUndefined();
      expect(mockAtomicWrite).not.toHaveBeenCalled();
    });

    it("prunes oldest log files beyond MAX_TEARDOWN_LOGS_PER_WORKTREE", async () => {
      mockSpawn.mockReturnValue(makeOutputProcess("output", 0));
      // Simulate 12 existing log files (counting the freshly-written one); the
      // two oldest should be deleted to bring the count back to the cap of 10.
      const existing = Array.from({ length: 12 }, (_, i) => `${1000 + i}.log`);
      mockReaddir.mockResolvedValueOnce(existing);

      await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
        logDir: "/some/log/dir",
      });

      expect(mockUnlink).toHaveBeenCalledTimes(2);
      expect(mockUnlink).toHaveBeenNthCalledWith(1, expect.stringMatching(/1000\.log$/));
      expect(mockUnlink).toHaveBeenNthCalledWith(2, expect.stringMatching(/1001\.log$/));
    });

    it("ignores non-.log entries when computing retention", async () => {
      mockSpawn.mockReturnValue(makeOutputProcess("output", 0));
      mockReaddir.mockResolvedValueOnce([
        "README.md",
        "1000.log",
        "1001.log",
        "1002.log",
        "spurious.txt",
      ]);

      await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
        logDir: "/some/log/dir",
      });

      // Only 3 .log files: under the cap of 10, so nothing is unlinked.
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it("does not fail the run when readdir-based prune throws", async () => {
      mockSpawn.mockReturnValue(makeOutputProcess("output", 0));
      mockReaddir.mockRejectedValueOnce(new Error("EACCES"));

      const result = await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
        logDir: "/some/log/dir",
      });

      expect(result.success).toBe(true);
      expect(result.logPath).toBeDefined();
    });

    it("does not fail the run when an individual unlink throws during prune", async () => {
      mockSpawn.mockReturnValue(makeOutputProcess("output", 0));
      const existing = Array.from({ length: 12 }, (_, i) => `${1000 + i}.log`);
      mockReaddir.mockResolvedValueOnce(existing);
      mockUnlink.mockRejectedValueOnce(new Error("EBUSY"));

      const result = await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
        logDir: "/some/log/dir",
      });

      // Both candidates still attempted even though the first throws.
      expect(mockUnlink).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.logPath).toBeDefined();
    });

    it("includes byte count and log path in the truncation marker when output exceeds the tail cap", async () => {
      const huge = "a".repeat(10_000); // > OUTPUT_TAIL_BYTES (8192)
      mockSpawn.mockReturnValue(makeOutputProcess(huge, 0));

      const result = await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
        logDir: "/home/testuser/.daintree/projects/_root/teardown-logs/wt-1",
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("...(truncated — omitted ");
      expect(result.output).toContain("bytes");
      expect(result.output).toContain(`full log: ${result.logPath}`);
    });

    it("says 'full log unavailable' in the truncation marker when log persistence fails", async () => {
      const huge = "x".repeat(10_000);
      mockSpawn.mockReturnValue(makeOutputProcess(huge, 0));
      mockAtomicWrite.mockRejectedValueOnce(new Error("disk full"));

      const result = await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
        logDir: "/some/log/dir",
      });

      expect(result.success).toBe(true);
      expect(result.logPath).toBeUndefined();
      expect(result.output).toContain("...(truncated — omitted ");
      expect(result.output).toContain("full log unavailable");
    });

    it("writes a log on failure paths (non-zero exit) and surfaces logPath", async () => {
      mockSpawn.mockReturnValue(makeOutputProcess("failed output", 1));

      const result = await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
        logDir: "/some/log/dir",
      });

      expect(result.success).toBe(false);
      expect(result.logPath).toBeDefined();
      expect(mockAtomicWrite).toHaveBeenCalledTimes(1);
    });

    it("truncates byte-accurately for multibyte UTF-8 content", async () => {
      // 3000 CJK chars × 3 bytes = 9000 bytes, well over OUTPUT_TAIL_BYTES (8192).
      // The char count (3000) is under the threshold; if the guard were
      // char-based the output would not truncate — verifies the byte-correct fix.
      const multibyte = "界".repeat(3000);
      mockSpawn.mockReturnValue(makeOutputProcess(multibyte, 0));

      const result = await service.runCommands(["./run.sh"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
        logDir: "/some/log/dir",
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("...(truncated — omitted ");
      // Total 9000 bytes − 8192-byte tail = 808 bytes dropped.
      expect(result.output).toContain("omitted 808 bytes");
    });
  });

  describe("runLifecycleSetup — return value contract", () => {
    function makeFakeMonitor(opts: { worktreeMode?: string } = {}) {
      const status = {
        lifecycleStatus: undefined as unknown,
        hasResourceConfig: false,
      };
      return {
        name: "wt-1",
        branch: "feature/x",
        path: "/wt",
        worktreeMode: opts.worktreeMode ?? "local",
        get hasResourceConfig() {
          return status.hasResourceConfig;
        },
        get lifecycleStatus() {
          return status.lifecycleStatus;
        },
        resourceStatus: undefined,
        setLifecycleStatus(s: unknown) {
          status.lifecycleStatus = s;
        },
        setHasResourceConfig(b: boolean) {
          status.hasResourceConfig = b;
        },
        setHasStatusCommand: vi.fn(),
        setHasPauseCommand: vi.fn(),
        setHasResumeCommand: vi.fn(),
        setHasTeardownCommand: vi.fn(),
        setHasProvisionCommand: vi.fn(),
        setResourceProvider: vi.fn(),
        setResourceConnectCommand: vi.fn(),
        setResourcePollInterval: vi.fn(),
      };
    }

    function makeCtx(monitor: ReturnType<typeof makeFakeMonitor> | null) {
      return {
        projectRootPath: "/root",
        projectEnvVars: {},
        getMonitor: () => (monitor as unknown) ?? undefined,
        emitUpdate: vi.fn(),
      } as unknown as import("../WorktreeLifecycleService.js").WorkspaceHostContext;
    }

    function makeSpawnChild(exitCode: number) {
      return () => {
        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const child = {
          pid: 1234,
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            listeners[event] ??= [];
            listeners[event].push(cb);
            if (event === "close") setTimeout(() => cb(exitCode), 0);
          }),
          kill: vi.fn(),
        };
        return child as never;
      };
    }

    it("returns shouldProvision=true when provisionResource is requested and setup succeeds with provision commands", async () => {
      const config = {
        setup: ["npm install"],
        resource: { provision: ["terraform apply"], connect: "ssh host" },
      };

      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/root/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);
      mockSpawn.mockImplementation(makeSpawnChild(0));

      const monitor = makeFakeMonitor();
      const ctx = makeCtx(monitor);
      const result = await service.runLifecycleSetup("wt-1", "/wt", ctx, true);

      expect(result).toEqual({ shouldProvision: true });
    });

    it("returns shouldProvision=false when provisionResource is not requested", async () => {
      const config = {
        setup: ["npm install"],
        resource: { provision: ["terraform apply"] },
      };

      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/root/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);
      mockSpawn.mockImplementation(makeSpawnChild(0));

      const monitor = makeFakeMonitor();
      const result = await service.runLifecycleSetup("wt-1", "/wt", makeCtx(monitor), false);

      expect(result).toEqual({ shouldProvision: false });
    });

    it("returns shouldProvision=false when there are no provision commands in the resolved resource", async () => {
      const config = {
        setup: ["npm install"],
        resource: { connect: "ssh host" },
      };

      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/root/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);
      mockSpawn.mockImplementation(makeSpawnChild(0));

      const monitor = makeFakeMonitor();
      const result = await service.runLifecycleSetup("wt-1", "/wt", makeCtx(monitor), true);

      expect(result).toEqual({ shouldProvision: false });
    });

    it("returns shouldProvision=false when setup commands fail", async () => {
      const config = {
        setup: ["npm install"],
        resource: { provision: ["terraform apply"] },
      };

      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/root/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);
      mockSpawn.mockImplementation(makeSpawnChild(1));

      const monitor = makeFakeMonitor();
      const result = await service.runLifecycleSetup("wt-1", "/wt", makeCtx(monitor), true);

      expect(result).toEqual({ shouldProvision: false });
    });

    it("returns shouldProvision=false when no config exists", async () => {
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const monitor = makeFakeMonitor();
      const result = await service.runLifecycleSetup("wt-1", "/wt", makeCtx(monitor), true);

      expect(result).toEqual({ shouldProvision: false });
    });

    it("returns shouldProvision=false when the monitor disappears mid-run (early-exit guard)", async () => {
      const config = {
        setup: ["npm install"],
        resource: { provision: ["terraform apply"] },
      };

      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/root/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);
      mockSpawn.mockImplementation(makeSpawnChild(0));

      const result = await service.runLifecycleSetup("wt-1", "/wt", makeCtx(null), true);

      expect(result).toEqual({ shouldProvision: false });
    });

    it("caches resource config on the monitor when there are no setup commands", async () => {
      const config = {
        resource: { provision: ["terraform apply"], connect: "ssh host" },
      };

      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/root/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);

      const monitor = makeFakeMonitor();
      const result = await service.runLifecycleSetup("wt-1", "/wt", makeCtx(monitor), false);

      expect(result).toEqual({ shouldProvision: false });
      // Resource config IS cached even when setup is empty (no-setup early-return path)
      expect(monitor.hasResourceConfig).toBe(true);
      expect(monitor.setResourceConnectCommand).toHaveBeenCalled();
      // spawn must NOT have been called (no setup commands)
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("returns shouldProvision=true when provisionResource=true and provision commands exist even without setup commands", async () => {
      // Config has no `setup` array but has `resource.provision` — the early-return
      // path must still flag for auto-provision so the host can kick off the
      // provision action immediately after creation.
      const config = {
        resource: { provision: ["terraform apply"], connect: "ssh host" },
      };

      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/root/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);

      const monitor = makeFakeMonitor();
      const result = await service.runLifecycleSetup("wt-1", "/wt", makeCtx(monitor), true);

      expect(result).toEqual({ shouldProvision: true });
      // No spawn should fire — no setup commands to run before provisioning
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe("runLifecycleTeardown — log persistence wiring", () => {
    function makeTeardownMonitor(opts: { hasResourceConfig?: boolean } = {}) {
      const statuses: unknown[] = [];
      const phaseResults: import("../../../shared/types/worktree.js").WorktreeLifecyclePhaseResult[] =
        [];
      return {
        name: "wt-1",
        branch: "feature/x",
        path: "/wt",
        worktreeMode: "local",
        hasResourceConfig: opts.hasResourceConfig ?? false,
        get lifecycleStatus() {
          return statuses[statuses.length - 1];
        },
        recordedStatuses: statuses,
        resourceStatus: undefined,
        setLifecycleStatus(s: unknown) {
          statuses.push(s);
        },
        get lifecyclePhaseResults() {
          return phaseResults;
        },
        clearLifecyclePhaseResults() {
          phaseResults.length = 0;
        },
        recordLifecyclePhaseResult(
          r: import("../../../shared/types/worktree.js").WorktreeLifecyclePhaseResult
        ) {
          const idx = phaseResults.findIndex((x) => x.phase === r.phase);
          if (idx >= 0) phaseResults[idx] = r;
          else phaseResults.push(r);
        },
      };
    }

    function makeCtx(monitor: ReturnType<typeof makeTeardownMonitor>) {
      return {
        projectRootPath: "/projects/my-app",
        projectEnvVars: {},
        getMonitor: () => monitor as never,
        emitUpdate: vi.fn(),
      } as unknown as import("../WorktreeLifecycleService.js").WorkspaceHostContext;
    }

    function makeSpawnChild(exitCode: number) {
      return () => {
        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const child = {
          pid: 1234,
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            listeners[event] ??= [];
            listeners[event].push(cb);
            if (event === "close") setTimeout(() => cb(exitCode), 0);
          }),
          kill: vi.fn(),
        };
        return child as never;
      };
    }

    it("propagates logPath into the final teardown lifecycle status", async () => {
      const config = { teardown: ["docker compose down"] };
      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/projects/my-app/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);
      mockSpawn.mockImplementation(makeSpawnChild(0));

      const monitor = makeTeardownMonitor();
      await service.runLifecycleTeardown("wt-1", monitor as never, false, makeCtx(monitor));

      const finalStatus = monitor.recordedStatuses.at(-1) as {
        phase: string;
        state: string;
        logPath?: string;
      };
      expect(finalStatus.phase).toBe("teardown");
      expect(finalStatus.state).toBe("success");
      expect(finalStatus.logPath).toBeDefined();
      expect(n(finalStatus.logPath ?? "")).toContain(
        "/home/testuser/.daintree/projects/_projects_my-app/teardown-logs/wt-1/"
      );
      expect(finalStatus.logPath).toMatch(/\d+\.log$/);
    });

    it("propagates logPath into the resource-teardown lifecycle status", async () => {
      const config = {
        resource: { teardown: ["terraform destroy"] },
      };
      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/projects/my-app/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);
      mockSpawn.mockImplementation(makeSpawnChild(0));

      const monitor = makeTeardownMonitor({ hasResourceConfig: true });
      await service.runLifecycleTeardown("wt-1", monitor as never, false, makeCtx(monitor));

      const resourceFinal = monitor.recordedStatuses
        .filter(
          (s): s is { phase: string; state: string; logPath?: string } =>
            typeof s === "object" && s !== null && "phase" in s
        )
        .find((s) => s.phase === "resource-teardown" && s.state !== "running");
      expect(resourceFinal).toBeDefined();
      expect(resourceFinal?.logPath).toBeDefined();
      expect(n(resourceFinal?.logPath ?? "")).toContain(
        "/home/testuser/.daintree/projects/_projects_my-app/teardown-logs/wt-1/"
      );
    });

    it("sanitizes path-unsafe characters in the project root segment", async () => {
      const config = { teardown: ["true"] };
      mockAccess.mockImplementation(async (p: unknown) => {
        // Match the unsanitized path read; the config-lookup helper itself
        // already sanitizes the segment to `_projects_my_app_with_colon` so
        // the access predicate uses that form.
        if (n(p as string).endsWith("/projects/my:app/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);
      mockSpawn.mockImplementation(makeSpawnChild(0));

      const monitor = makeTeardownMonitor();
      const ctx = {
        projectRootPath: "/projects/my:app",
        projectEnvVars: {},
        getMonitor: () => monitor as never,
        emitUpdate: vi.fn(),
      } as unknown as import("../WorktreeLifecycleService.js").WorkspaceHostContext;

      await service.runLifecycleTeardown("wt-1", monitor as never, false, ctx);

      const finalStatus = monitor.recordedStatuses.at(-1) as { logPath?: string };
      expect(finalStatus.logPath).toBeDefined();
      // Colon in the path must not appear in the persisted directory.
      expect(finalStatus.logPath).not.toContain("my:app");
      expect(n(finalStatus.logPath ?? "")).toContain("/_projects_my_app/teardown-logs/wt-1/");
    });
  });

  describe("signal capture and abort/timeout markers", () => {
    function makeManualChild(pid: number | undefined = 12345) {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const child = {
        pid,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          (listeners[event] ??= []).push(cb);
        }),
        kill: vi.fn(),
      };
      const fireClose = (code: number | null, signal?: string) =>
        listeners["close"]?.forEach((cb) => cb(code, signal));
      return { child, fireClose };
    }

    it("captures the OS signal name from the close event (not flattened into exit code)", async () => {
      const { child, fireClose } = makeManualChild();
      mockSpawn.mockReturnValue(child as never);

      const p = service.runCommands(["slow-cmd"], { cwd: "/t", env: {}, onProgress: vi.fn() });
      await Promise.resolve();
      fireClose(null, "SIGTERM");
      const result = await p;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBeNull();
      expect(result.signalName).toBe("SIGTERM");
      expect(result.error).toContain("killed by SIGTERM");
    });

    it("captures exit code with a null signal on a normal non-zero exit", async () => {
      const { child, fireClose } = makeManualChild();
      mockSpawn.mockReturnValue(child as never);

      const p = service.runCommands(["bad-cmd"], { cwd: "/t", env: {}, onProgress: vi.fn() });
      await Promise.resolve();
      fireClose(3);
      const result = await p;

      expect(result.exitCode).toBe(3);
      expect(result.signalName).toBeNull();
      expect(result.error).not.toContain("killed by");
    });

    it("appends a timeout marker to the captured output before killing", async () => {
      vi.useFakeTimers();
      try {
        const { child, fireClose } = makeManualChild();
        mockSpawn.mockReturnValue(child as never);

        const p = service.runCommands(["slow-cmd"], {
          cwd: "/t",
          env: {},
          timeoutMs: 1000,
          onProgress: vi.fn(),
        });
        vi.advanceTimersByTime(1001);
        fireClose(null, "SIGKILL");
        const result = await p;

        expect(result.timedOut).toBe(true);
        expect(result.signalName).toBe("SIGKILL");
        expect(result.output).toContain("[Process timed out after 1000ms");
      } finally {
        vi.useRealTimers();
      }
    });

    it("appends an abort marker to the captured output", async () => {
      const ac = new AbortController();
      const { child, fireClose } = makeManualChild();
      mockSpawn.mockReturnValue(child as never);

      const p = service.runCommands(["slow-cmd"], {
        cwd: "/t",
        env: {},
        signal: ac.signal,
        onProgress: vi.fn(),
      });
      await Promise.resolve();
      ac.abort();
      fireClose(null, "SIGTERM");
      const result = await p;

      expect(result.aborted).toBe(true);
      expect(result.output).toContain("[Process aborted:");
    });
  });

  describe("runLifecycleTeardown — phase result accumulation", () => {
    function makeTeardownMonitor() {
      const phaseResults: import("../../../shared/types/worktree.js").WorktreeLifecyclePhaseResult[] =
        [];
      let lifecycleStatus: unknown;
      return {
        name: "wt-1",
        branch: "feature/x",
        path: "/wt",
        worktreeMode: "local",
        hasResourceConfig: true,
        resourceStatus: undefined,
        get lifecycleStatus() {
          return lifecycleStatus;
        },
        setLifecycleStatus(s: unknown) {
          lifecycleStatus = s;
        },
        get lifecyclePhaseResults() {
          return phaseResults;
        },
        clearLifecyclePhaseResults() {
          phaseResults.length = 0;
        },
        recordLifecyclePhaseResult(
          r: import("../../../shared/types/worktree.js").WorktreeLifecyclePhaseResult
        ) {
          const idx = phaseResults.findIndex((x) => x.phase === r.phase);
          if (idx >= 0) phaseResults[idx] = r;
          else phaseResults.push(r);
        },
      };
    }

    function makeCtx(monitor: ReturnType<typeof makeTeardownMonitor>) {
      return {
        projectRootPath: "/root",
        projectEnvVars: {},
        getMonitor: () => monitor as unknown,
        emitUpdate: vi.fn(),
      } as unknown as import("../WorktreeLifecycleService.js").WorkspaceHostContext;
    }

    it("accumulates both phases without the later phase overwriting the earlier failure", async () => {
      const config = {
        teardown: ["cleanup.sh"],
        resource: { teardown: ["terraform destroy"], provider: "akash" },
      };
      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/root/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);

      // First spawn (resource-teardown) fails; second (local teardown) succeeds.
      let call = 0;
      mockSpawn.mockImplementation(() => {
        call++;
        const exit = call === 1 ? 1 : 0;
        const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
        const child = {
          pid: 1234,
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
            (listeners[event] ??= []).push(cb);
            if (event === "close") setTimeout(() => cb(exit), 0);
          }),
          kill: vi.fn(),
        };
        return child as never;
      });

      const monitor = makeTeardownMonitor();
      await service.runLifecycleTeardown("wt-1", monitor as never, false, makeCtx(monitor));

      const results = monitor.lifecyclePhaseResults;
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        phase: "resource-teardown",
        state: "failed",
        category: "billing-critical",
        exitCode: 1,
      });
      expect(results[1]).toMatchObject({
        phase: "teardown",
        state: "success",
        category: "cosmetic",
        exitCode: 0,
      });
    });

    it("records only the billing-critical phase for a resource-only teardown", async () => {
      const config = { resource: { teardown: ["terraform destroy"], provider: "akash" } };
      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/root/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);
      mockSpawn.mockImplementation(() => {
        const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
        const child = {
          pid: 1234,
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
            (listeners[event] ??= []).push(cb);
            if (event === "close") setTimeout(() => cb(0), 0);
          }),
          kill: vi.fn(),
        };
        return child as never;
      });

      const monitor = makeTeardownMonitor();
      await service.runLifecycleTeardown("wt-1", monitor as never, false, makeCtx(monitor));

      const results = monitor.lifecyclePhaseResults;
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        phase: "resource-teardown",
        category: "billing-critical",
      });
    });

    it("clears stale results when a re-invocation has no teardown configured", async () => {
      const monitor = makeTeardownMonitor();
      monitor.recordLifecyclePhaseResult({
        phase: "resource-teardown",
        state: "failed",
        category: "billing-critical",
        exitCode: 1,
        signalName: null,
        startedAt: 1,
        completedAt: 2,
      });

      // No config file exists this time → early-return path.
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      await service.runLifecycleTeardown("wt-1", monitor as never, false, makeCtx(monitor));

      expect(monitor.lifecyclePhaseResults).toHaveLength(0);
    });
  });
});

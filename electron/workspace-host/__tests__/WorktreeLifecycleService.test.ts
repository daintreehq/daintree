import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";

/** Normalize a path to forward slashes for cross-platform mock matching */
const n = (p: string) => (p as string).replace(/\\/g, "/");

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  access: vi.fn(),
  cp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
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

    it("does not throw if cp fails", async () => {
      mockAccess.mockImplementation(async (p: string) => {
        if ((p as string).includes(path.join("/main/repo", ".daintree"))) return undefined;
        throw new Error("ENOENT");
      });
      mockCp.mockRejectedValue(new Error("Permission denied"));

      await expect(service.copyDaintreeDir("/main/repo", "/new/worktree")).resolves.toBeUndefined();
    });
  });

  describe("buildEnv", () => {
    it("returns CANOPY_* and non-interactive environment variables", () => {
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
        expect(spawnEnv).toHaveProperty("USERPROFILE");
        expect(spawnEnv).toHaveProperty("PATHEXT");
        expect(spawnEnv).toHaveProperty("SystemRoot");
        expect(spawnEnv).not.toHaveProperty("HOME");
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
});

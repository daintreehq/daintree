import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  access: vi.fn(),
  cp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

describe("WorktreeLifecycleService", () => {
  let service: import("../WorktreeLifecycleService.js").WorktreeLifecycleService;
  let mockAccess: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockCp: ReturnType<typeof vi.fn>;
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const fsModule = await import("fs/promises");
    mockAccess = vi.mocked(fsModule.access);
    mockReadFile = vi.mocked(fsModule.readFile);
    mockCp = vi.mocked(fsModule.cp);

    const childProcessModule = await import("child_process");
    mockSpawn = vi.mocked(childProcessModule.spawn);

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
        if ((p as string).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if ((p as string).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
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
        if ((p as string).includes("/.canopy/projects/")) throw new Error("ENOENT");
        // worktree config exists (second check)
        return undefined;
      });

      mockReadFile.mockImplementation(async (p: string) => {
        if ((p as string).endsWith("/worktree/.canopy/config.json")) {
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
        if ((p as string).includes("/.canopy/projects/")) throw new Error("ENOENT");
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
        if ((p as string).includes("/.canopy/projects/")) throw new Error("ENOENT");
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
        if (!(p as string).endsWith("/project/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result?.setup).toBeUndefined();
      expect(result?.teardown).toEqual(["docker compose down"]);
    });
  });

  describe("copyCanopyDir", () => {
    it("does nothing if source .canopy does not exist", async () => {
      mockAccess.mockRejectedValue(new Error("ENOENT"));
      await service.copyCanopyDir("/main/repo", "/new/worktree");
      expect(mockCp).not.toHaveBeenCalled();
    });

    it("copies .canopy from src to dest even if dest already exists (force:false preserves existing)", async () => {
      mockAccess.mockResolvedValue(undefined); // src exists
      await service.copyCanopyDir("/main/repo", "/new/worktree");
      expect(mockCp).toHaveBeenCalledWith(
        path.join("/main/repo", ".canopy"),
        path.join("/new/worktree", ".canopy"),
        {
          recursive: true,
          force: false,
          errorOnExist: false,
        }
      );
    });

    it("copies .canopy from src to dest when src exists", async () => {
      mockAccess.mockImplementation(async (p: string) => {
        if ((p as string).includes(path.join("/main/repo", ".canopy"))) return undefined; // src exists
        throw new Error("ENOENT"); // dest does not
      });

      await service.copyCanopyDir("/main/repo", "/new/worktree");
      expect(mockCp).toHaveBeenCalledWith(
        path.join("/main/repo", ".canopy"),
        path.join("/new/worktree", ".canopy"),
        {
          recursive: true,
          force: false,
          errorOnExist: false,
        }
      );
    });

    it("does not throw if cp fails", async () => {
      mockAccess.mockImplementation(async (p: string) => {
        if ((p as string).includes(path.join("/main/repo", ".canopy"))) return undefined;
        throw new Error("ENOENT");
      });
      mockCp.mockRejectedValue(new Error("Permission denied"));

      await expect(service.copyCanopyDir("/main/repo", "/new/worktree")).resolves.toBeUndefined();
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
        CANOPY_WORKTREE_PATH: "/worktrees/feat",
        CANOPY_PROJECT_ROOT: "/project",
        CANOPY_WORKTREE_NAME: "feature/my-branch",
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

    it("injects PATH and HOME along with CANOPY_* env vars", async () => {
      const child = makeFakeProcess(0);
      mockSpawn.mockReturnValue(child);

      await service.runCommands(["echo test"], {
        cwd: "/test",
        env: { CANOPY_WORKTREE_PATH: "/wt" },
        onProgress: vi.fn(),
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        "echo test",
        expect.objectContaining({
          env: expect.objectContaining({
            CANOPY_WORKTREE_PATH: "/wt",
            PATH: expect.any(String),
            HOME: expect.any(String),
          }),
        })
      );
    });

    it("uses detached: true for process group management", async () => {
      mockSpawn.mockReturnValue(makeFakeProcess(0));

      await service.runCommands(["echo test"], {
        cwd: "/test",
        env: {},
        onProgress: vi.fn(),
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        "echo test",
        expect.objectContaining({ detached: true, shell: true })
      );
    });
  });
});

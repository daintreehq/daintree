import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { Worktree } from "../../../shared/types/worktree.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";
import type { SimpleGit } from "simple-git";

const n = (p: string) => (p as string).replace(/\\/g, "/");

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockSimpleGit),
}));

vi.mock("../../utils/fs.js", () => ({
  waitForPathExists: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockSimpleGit),
  validateCwd: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
  getWorktreeChangesWithStats: vi.fn().mockResolvedValue({
    head: "abc123",
    isDirty: false,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    changedFileCount: 0,
    changes: [],
  }),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/worktree/.git"),
  clearGitDirCache: vi.fn(),
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: vi.fn().mockReturnValue("stable"),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../services/worktree/index.js", () => ({
  AdaptivePollingStrategy: vi.fn(function () {
    return {
      getCurrentInterval: vi.fn().mockReturnValue(2000),
      updateInterval: vi.fn(),
      reportActivity: vi.fn(),
      updateConfig: vi.fn(),
      isCircuitBreakerTripped: vi.fn().mockReturnValue(false),
      reset: vi.fn(),
      setBaseInterval: vi.fn(),
      calculateNextInterval: vi.fn().mockReturnValue(2000),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
  }),
  NoteFileReader: vi.fn(function () {
    return { read: vi.fn().mockResolvedValue({}) };
  }),
}));

vi.mock("../../services/github/GitHubAuth.js", () => ({
  GitHubAuth: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../services/PullRequestService.js", () => ({
  pullRequestService: {
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    refresh: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      state: "idle",
      isPolling: false,
      candidateCount: 0,
      resolvedCount: 0,
      isEnabled: true,
    }),
  },
}));

vi.mock("../../services/events.js", () => ({
  events: new EventEmitter(),
}));

vi.mock("../../utils/gitFileWatcher.js", () => {
  return {
    GitFileWatcher: class {
      start() {
        return false;
      }
      dispose() {}
    },
  };
});

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }),
}));

function createTestWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: "/test/worktree",
    path: "/test/worktree",
    name: "feature/test",
    branch: "feature/test",
    isCurrent: false,
    isMainWorktree: false,
    gitDir: "/test/worktree/.git",
    ...overrides,
  };
}

function makeSpawnChild(exitCode: number, stdoutData: string = "") {
  return () => {
    const child = {
      pid: 99,
      stdout: {
        on: vi.fn((event: string, cb: (data: Buffer) => void) => {
          if (event === "data" && stdoutData) {
            setTimeout(() => cb(Buffer.from(stdoutData)), 0);
          }
        }),
      },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "close") setTimeout(() => cb(exitCode), 5);
      }),
      kill: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return child as any;
  };
}

describe("WorkspaceService.runResourceAction", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(
      mockSendEvent as unknown as (event: WorkspaceHostEvent) => void
    );

    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;

    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as unknown as SimpleGit;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createAndRegisterMonitor(overrides: Partial<Worktree> = {}): WorktreeMonitor {
    const wt = createTestWorktree(overrides);
    const monitor = new WorktreeMonitorClass(
      wt,
      {
        basePollingInterval: 10000,
        adaptiveBackoff: false,
        pollIntervalMax: 30000,
        circuitBreakerThreshold: 3,
        gitWatchEnabled: false,
      },
      { onUpdate: vi.fn() },
      "main"
    );
    service["monitors"].set(wt.id, monitor);
    return monitor;
  }

  async function setupConfig(config: Record<string, unknown>) {
    const fsModule = await import("fs/promises");
    const mockAccess = vi.mocked(fsModule.access);
    const mockReadFile = vi.mocked(fsModule.readFile);

    mockAccess.mockImplementation(async (p: unknown) => {
      if (n(p as string).endsWith("/test/root/.canopy/config.json")) return undefined;
      throw new Error("ENOENT");
    });
    mockReadFile.mockResolvedValue(JSON.stringify(config) as never);
  }

  async function setupSpawn(exitCode: number, stdoutData: string = "") {
    const childProcessModule = await import("child_process");
    vi.mocked(childProcessModule.spawn).mockImplementation(makeSpawnChild(exitCode, stdoutData));
  }

  // --- runResourceAction when no monitor found ---

  it("sends error when worktree not found", async () => {
    await service.runResourceAction("req-1", "/nonexistent", "status");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "resource-action-result",
        requestId: "req-1",
        success: false,
        error: "Worktree not found",
      })
    );
  });

  // --- runResourceAction when no project root ---

  it("sends error when no project root path", async () => {
    createAndRegisterMonitor();
    service["projectRootPath"] = null;

    await service.runResourceAction("req-2", "/test/worktree", "provision");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "resource-action-result",
        success: false,
        error: "No project root path",
      })
    );
  });

  // --- runResourceAction when no resource config ---

  it("sends error when no resource config found", async () => {
    createAndRegisterMonitor();
    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockRejectedValue(new Error("ENOENT"));

    await service.runResourceAction("req-3", "/test/worktree", "provision");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "resource-action-result",
        success: false,
        error: "No resource config found",
      })
    );
  });

  // --- status action: JSON parsing ---

  describe("status action — JSON parsing", () => {
    it("parses valid JSON with status field", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { status: "check-status", provision: ["provision-cmd"] },
      });
      await setupSpawn(0, JSON.stringify({ status: "running", uptime: 42 }));

      await service.runResourceAction("req-s1", "/test/worktree", "status");

      expect(monitor.resourceStatus).toEqual(
        expect.objectContaining({
          lastStatus: "running",
          lastOutput: expect.stringContaining('"status":"running"'),
        })
      );
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "resource-action-result",
          success: true,
        })
      );
    });

    it("sets lastStatus=unhealthy for valid JSON without status field", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { status: "check-status", provision: ["provision-cmd"] },
      });
      await setupSpawn(0, JSON.stringify({ uptime: 42, healthy: true }));

      await service.runResourceAction("req-s2", "/test/worktree", "status");

      expect(monitor.resourceStatus).toEqual(
        expect.objectContaining({
          lastStatus: "unhealthy",
          lastOutput: expect.stringContaining('"uptime":42'),
        })
      );
    });

    it("sets lastStatus=unhealthy for non-JSON output", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { status: "check-status", provision: ["provision-cmd"] },
      });
      await setupSpawn(0, "not valid json at all");

      await service.runResourceAction("req-s3", "/test/worktree", "status");

      expect(monitor.resourceStatus).toEqual(
        expect.objectContaining({
          lastStatus: "unhealthy",
          lastOutput: "not valid json at all",
        })
      );
    });

    it("sets error state on command failure", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { status: "check-status", provision: ["provision-cmd"] },
      });
      await setupSpawn(1, "some error output");

      await service.runResourceAction("req-s4", "/test/worktree", "status");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "resource-action-result",
          success: false,
        })
      );
      expect(monitor.lifecycleStatus?.state).toBe("failed");
    });

    it("sends error when no status command configured", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: { provision: ["provision-cmd"] },
      });

      await service.runResourceAction("req-s5", "/test/worktree", "status");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "resource-action-result",
          success: false,
          error: "No status command configured",
        })
      );
    });

    it("extracts endpoint and meta from status JSON", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { status: "check-status", provision: ["provision-cmd"] },
      });
      await setupSpawn(
        0,
        JSON.stringify({
          status: "running",
          endpoint: "https://example.com:8080",
          meta: { region: "us-east-1", instanceId: "i-abc123" },
        })
      );

      await service.runResourceAction("req-ep1", "/test/worktree", "status");

      expect(monitor.resourceStatus).toEqual(
        expect.objectContaining({
          lastStatus: "running",
          endpoint: "https://example.com:8080",
          meta: { region: "us-east-1", instanceId: "i-abc123" },
        })
      );
    });
  });

  // --- canopy-remote wrapper generation ---

  describe("canopy-remote wrapper generation on status ready", () => {
    it("generates canopy-remote wrapper when status is ready with endpoint and connect command", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: {
          status: "check-status",
          connect: "ssh -i key.pem root@${CANOPY_RESOURCE_ENDPOINT}",
          provision: ["provision-cmd"],
        },
      });
      await setupSpawn(
        0,
        JSON.stringify({
          status: "ready",
          endpoint: "ec2-1-2-3-4.compute.amazonaws.com",
        })
      );

      const fsModule = await import("fs/promises");
      const mockWriteFile = vi.mocked(fsModule.writeFile);
      const mockMkdir = vi.mocked(fsModule.mkdir);

      await service.runResourceAction("req-wrap1", "/test/worktree", "status");

      expect(mockMkdir).toHaveBeenCalledWith("/test/worktree/.canopy", { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/test/worktree/.canopy/canopy-remote",
        expect.stringContaining("#!/usr/bin/env bash"),
        expect.objectContaining({ mode: 0o755 })
      );
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/test/worktree/.canopy/canopy-remote",
        expect.stringContaining("Endpoint: ec2-1-2-3-4.compute.amazonaws.com"),
        expect.anything()
      );
    });

    it("does not generate wrapper when status is not ready", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: {
          status: "check-status",
          connect: "ssh root@${CANOPY_RESOURCE_ENDPOINT}",
          provision: ["provision-cmd"],
        },
      });
      await setupSpawn(
        0,
        JSON.stringify({
          status: "provisioning",
          endpoint: "ec2-1-2-3-4.compute.amazonaws.com",
        })
      );

      const fsModule = await import("fs/promises");
      const mockWriteFile = vi.mocked(fsModule.writeFile);

      await service.runResourceAction("req-wrap2", "/test/worktree", "status");

      expect(mockWriteFile).not.toHaveBeenCalledWith(
        "/test/worktree/.canopy/canopy-remote",
        expect.anything(),
        expect.anything()
      );
    });

    it("does not generate wrapper when endpoint is missing even if status is ready", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: {
          status: "check-status",
          connect: "ssh root@${CANOPY_RESOURCE_ENDPOINT}",
          provision: ["provision-cmd"],
        },
      });
      await setupSpawn(
        0,
        JSON.stringify({
          status: "ready",
        })
      );

      const fsModule = await import("fs/promises");
      const mockWriteFile = vi.mocked(fsModule.writeFile);

      await service.runResourceAction("req-wrap3", "/test/worktree", "status");

      expect(mockWriteFile).not.toHaveBeenCalledWith(
        "/test/worktree/.canopy/canopy-remote",
        expect.anything(),
        expect.anything()
      );
    });

    it("does not generate wrapper when connect command is missing", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: {
          status: "check-status",
          provision: ["provision-cmd"],
        },
      });
      await setupSpawn(
        0,
        JSON.stringify({
          status: "ready",
          endpoint: "ec2-1-2-3-4.compute.amazonaws.com",
        })
      );

      const fsModule = await import("fs/promises");
      const mockWriteFile = vi.mocked(fsModule.writeFile);

      await service.runResourceAction("req-wrap4", "/test/worktree", "status");

      expect(mockWriteFile).not.toHaveBeenCalledWith(
        "/test/worktree/.canopy/canopy-remote",
        expect.anything(),
        expect.anything()
      );
    });
  });

  // --- configurable timeouts ---

  describe("configurable timeouts via resource.timeouts", () => {
    it("uses default timeout when no overrides configured", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: { provision: ["deploy"], status: "check" },
      });
      const spy = vi.spyOn(service["lifecycleService"], "runCommands");
      await setupSpawn(0);

      await service.runResourceAction("req-t1", "/test/worktree", "provision");

      expect(spy).toHaveBeenCalledWith(["deploy"], expect.objectContaining({ timeoutMs: 300_000 }));
    });

    it("uses config timeout override for provision (seconds → ms)", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: {
          provision: ["deploy"],
          status: "check",
          timeouts: { provision: 600 },
        },
      });
      const spy = vi.spyOn(service["lifecycleService"], "runCommands");
      await setupSpawn(0);

      await service.runResourceAction("req-t2", "/test/worktree", "provision");

      expect(spy).toHaveBeenCalledWith(["deploy"], expect.objectContaining({ timeoutMs: 600_000 }));
    });

    it("uses config timeout override for status", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: {
          provision: ["deploy"],
          status: "check",
          timeouts: { status: 30 },
        },
      });
      const spy = vi.spyOn(service["lifecycleService"], "runCommands");
      await setupSpawn(0, '{"status":"ready"}');

      await service.runResourceAction("req-t3", "/test/worktree", "status");

      expect(spy).toHaveBeenCalledWith(["check"], expect.objectContaining({ timeoutMs: 30_000 }));
    });

    it("falls back to default when specific action not in timeouts", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: {
          provision: ["deploy"],
          resume: ["start-cmd"],
          status: "check",
          timeouts: { provision: 600 },
        },
      });
      const spy = vi.spyOn(service["lifecycleService"], "runCommands");
      await setupSpawn(0);

      await service.runResourceAction("req-t4", "/test/worktree", "resume");

      // resume default = 120_000ms (provision override doesn't affect resume)
      expect(spy).toHaveBeenCalledWith(
        ["start-cmd"],
        expect.objectContaining({ timeoutMs: 120_000 })
      );
    });
  });

  // --- provision action: lifecycle phase ---

  describe("provision action — lifecycle phase", () => {
    it("sets lifecycle phase to resource-provision while running", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { provision: ["terraform apply"] },
      });
      await setupSpawn(0);

      const phases: string[] = [];
      const origSetLifecycleStatus = monitor.setLifecycleStatus.bind(monitor);
      vi.spyOn(monitor, "setLifecycleStatus").mockImplementation((status) => {
        if (status) phases.push(status.phase);
        origSetLifecycleStatus(status);
      });

      await service.runResourceAction("req-p1", "/test/worktree", "provision");

      expect(phases).toContain("resource-provision");
    });

    it("updates to success when commands complete", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { provision: ["terraform apply"] },
      });
      await setupSpawn(0);

      await service.runResourceAction("req-p2", "/test/worktree", "provision");

      expect(monitor.lifecycleStatus).toEqual(
        expect.objectContaining({
          phase: "resource-provision",
          state: "success",
        })
      );
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "resource-action-result",
          success: true,
        })
      );
    });

    it("updates to failed when commands fail", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { provision: ["terraform apply"] },
      });
      await setupSpawn(1);

      await service.runResourceAction("req-p3", "/test/worktree", "provision");

      expect(monitor.lifecycleStatus).toEqual(
        expect.objectContaining({
          phase: "resource-provision",
          state: "failed",
        })
      );
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "resource-action-result",
          success: false,
        })
      );
    });

    it("caches hasResourceConfig and resourceConnectCommand on monitor", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: {
          provision: ["terraform apply"],
          connect: "ssh user@host",
        },
      });
      await setupSpawn(0);

      await service.runResourceAction("req-p4", "/test/worktree", "provision");

      expect(monitor.hasResourceConfig).toBe(true);
      expect(monitor.resourceConnectCommand).toBe("ssh user@host");
    });

    it("stores provider from resource config", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { provider: "akash", status: "check-status", provision: ["provision-cmd"] },
      });
      await setupSpawn(0, JSON.stringify({ status: "running" }));

      await service.runResourceAction("req-p1", "/test/worktree", "status");

      expect(monitor.resourceProvider).toBe("akash");
    });

    it("sends error when no provision commands configured", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: { status: "check-status" },
      });

      await service.runResourceAction("req-p5", "/test/worktree", "provision");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "resource-action-result",
          success: false,
          error: "No provision commands configured",
        })
      );
    });

    it("substitutes {{worktree_name}} in connect command", async () => {
      const monitor = createAndRegisterMonitor({ name: "feat-deploy" });
      await setupConfig({
        resource: {
          provision: ["echo ok"],
          connect: "ssh {{worktree_name}}@host.example.com",
        },
      });
      await setupSpawn(0);

      await service.runResourceAction("req-sub1", "/test/worktree", "provision");

      expect(monitor.resourceConnectCommand).toBe("ssh feat-deploy@host.example.com");
    });

    it("substitutes {{branch}} in connect command", async () => {
      const monitor = createAndRegisterMonitor({ branch: "feature/remote" });
      await setupConfig({
        resource: {
          provision: ["echo ok"],
          connect: "ssh root@{{branch}}.dev.example.com",
        },
      });
      await setupSpawn(0);

      await service.runResourceAction("req-sub2", "/test/worktree", "provision");

      expect(monitor.resourceConnectCommand).toBe("ssh root@feature/remote.dev.example.com");
    });

    it("leaves unresolved {{endpoint}} placeholder intact", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: {
          provision: ["echo ok"],
          connect: "ssh root@{{endpoint}} -i ~/.ssh/key",
        },
      });
      await setupSpawn(0);

      await service.runResourceAction("req-sub3", "/test/worktree", "provision");

      expect(monitor.resourceConnectCommand).toBe("ssh root@{{endpoint}} -i ~/.ssh/key");
    });

    it("substitutes variables in provision commands before execution", async () => {
      createAndRegisterMonitor({ name: "my-wt", branch: "feat/x" });
      await setupConfig({
        resource: {
          provision: ["deploy --name={{worktree_name}} --branch={{branch}}"],
        },
      });
      await setupSpawn(0);

      const runCommandsSpy = vi.spyOn(service["lifecycleService"], "runCommands");

      await service.runResourceAction("req-sub4", "/test/worktree", "provision");

      expect(runCommandsSpy).toHaveBeenCalledWith(
        ["deploy --name=my-wt --branch=feat/x"],
        expect.any(Object)
      );
    });
  });

  // --- pause/resume actions ---

  describe("pause/resume actions", () => {
    it("runs resume commands and updates lifecycle status", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { resume: ["docker compose up -d"] },
      });
      await setupSpawn(0);

      await service.runResourceAction("req-st1", "/test/worktree", "resume");

      expect(monitor.lifecycleStatus).toEqual(
        expect.objectContaining({
          phase: "resource-resume",
          state: "success",
        })
      );
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "resource-action-result",
          success: true,
        })
      );
    });

    it("runs pause commands and updates lifecycle status", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { pause: ["docker compose down"] },
      });
      await setupSpawn(0);

      await service.runResourceAction("req-st2", "/test/worktree", "pause");

      expect(monitor.lifecycleStatus).toEqual(
        expect.objectContaining({
          phase: "resource-pause",
          state: "success",
        })
      );
    });

    it("reports failure for pause when command fails", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { pause: ["docker compose down"] },
      });
      await setupSpawn(1);

      await service.runResourceAction("req-st3", "/test/worktree", "pause");

      expect(monitor.lifecycleStatus?.state).toBe("failed");
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "resource-action-result",
          success: false,
        })
      );
    });

    it("sends error when no resume commands configured", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: { pause: ["docker compose down"] },
      });

      await service.runResourceAction("req-st4", "/test/worktree", "resume");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "resource-action-result",
          success: false,
          error: "No resume commands configured",
        })
      );
    });

    it("records resumedAt timestamp on successful resume", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { resume: ["start-cmd"], provision: ["provision-cmd"] },
      });
      await setupSpawn(0, "started");

      const before = Date.now();
      await service.runResourceAction("req-t1", "/test/worktree", "resume");
      const after = Date.now();

      expect(monitor.resourceStatus?.resumedAt).toBeGreaterThanOrEqual(before);
      expect(monitor.resourceStatus?.resumedAt).toBeLessThanOrEqual(after);
    });

    it("records pausedAt timestamp on successful pause", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { pause: ["stop-cmd"], provision: ["provision-cmd"] },
      });
      await setupSpawn(0, "paused");

      const before = Date.now();
      await service.runResourceAction("req-t2", "/test/worktree", "pause");
      const after = Date.now();

      expect(monitor.resourceStatus?.pausedAt).toBeGreaterThanOrEqual(before);
      expect(monitor.resourceStatus?.pausedAt).toBeLessThanOrEqual(after);
    });
  });

  // --- Timeout differences: provision/teardown=300s, resume/pause=120s ---

  describe("timeout values", () => {
    it("uses 300s timeout for provision", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: { provision: ["long-running-cmd"] },
      });
      await setupSpawn(0);

      // We verify the timeout indirectly: the runCommands call is made with timeoutMs.
      // Spy on lifecycleService.runCommands to capture the timeoutMs argument.
      const runCommandsSpy = vi.spyOn(service["lifecycleService"], "runCommands");

      await service.runResourceAction("req-t1", "/test/worktree", "provision");

      expect(runCommandsSpy).toHaveBeenCalledWith(
        ["long-running-cmd"],
        expect.objectContaining({ timeoutMs: 300_000 })
      );
    });

    it("uses 300s timeout for teardown", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: { teardown: ["cleanup-cmd"] },
      });
      await setupSpawn(0);

      const runCommandsSpy = vi.spyOn(service["lifecycleService"], "runCommands");

      await service.runResourceAction("req-t2", "/test/worktree", "teardown");

      expect(runCommandsSpy).toHaveBeenCalledWith(
        ["cleanup-cmd"],
        expect.objectContaining({ timeoutMs: 300_000 })
      );
    });

    it("uses 120s timeout for resume", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: { resume: ["start-cmd"] },
      });
      await setupSpawn(0);

      const runCommandsSpy = vi.spyOn(service["lifecycleService"], "runCommands");

      await service.runResourceAction("req-t3", "/test/worktree", "resume");

      expect(runCommandsSpy).toHaveBeenCalledWith(
        ["start-cmd"],
        expect.objectContaining({ timeoutMs: 120_000 })
      );
    });

    it("uses 120s timeout for pause", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: { pause: ["stop-cmd"] },
      });
      await setupSpawn(0);

      const runCommandsSpy = vi.spyOn(service["lifecycleService"], "runCommands");

      await service.runResourceAction("req-t4", "/test/worktree", "pause");

      expect(runCommandsSpy).toHaveBeenCalledWith(
        ["stop-cmd"],
        expect.objectContaining({ timeoutMs: 120_000 })
      );
    });

    it("falls back to default when specific action not in timeouts", async () => {
      createAndRegisterMonitor();
      await setupConfig({
        resource: { resume: ["start-cmd"] },
      });
      await setupSpawn(0);

      const runCommandsSpy = vi.spyOn(service["lifecycleService"], "runCommands");

      await service.runResourceAction("req-t5", "/test/worktree", "resume");

      expect(runCommandsSpy).toHaveBeenCalledWith(
        ["start-cmd"],
        expect.objectContaining({ timeoutMs: 120_000 })
      );
    });
  });

  // --- Idempotent provision logic ---

  describe("provision idempotency", () => {
    it("provision is a no-op when resource status is `ready`", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { provision: ["terraform apply"] },
      });
      monitor.setResourceStatus({ lastStatus: "ready", lastCheckedAt: Date.now() });

      const runCommandsSpy = vi.spyOn(service["lifecycleService"], "runCommands");

      await service.runResourceAction("req-prov-1", "/test/worktree", "provision");

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "resource-action-result",
          success: true,
        })
      );
      expect(runCommandsSpy).toHaveBeenCalledTimes(0);
    });

    it("provision routes to resume when status is `paused`", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { provision: ["terraform apply"], resume: ["resume-cmd"] },
      });
      monitor.setResourceStatus({ lastStatus: "paused", lastCheckedAt: Date.now() });
      await setupSpawn(0);

      const runCommandsSpy = vi.spyOn(service["lifecycleService"], "runCommands");

      await service.runResourceAction("req-prov-2", "/test/worktree", "provision");

      expect(runCommandsSpy).toHaveBeenCalledWith(["resume-cmd"], expect.anything());
      expect(monitor.lifecycleStatus?.phase).toBe("resource-resume");
    });

    it("provision runs provision commands when status is `unknown`", async () => {
      const monitor = createAndRegisterMonitor();
      await setupConfig({
        resource: { provision: ["terraform apply"] },
      });
      monitor.setResourceStatus({ lastStatus: "unknown", lastCheckedAt: Date.now() });
      await setupSpawn(0);

      const runCommandsSpy = vi.spyOn(service["lifecycleService"], "runCommands");

      await service.runResourceAction("req-prov-3", "/test/worktree", "provision");

      expect(runCommandsSpy).toHaveBeenCalledWith(["terraform apply"], expect.anything());
      expect(monitor.lifecycleStatus?.phase).toBe("resource-provision");
    });
  });
});

describe("WorkspaceService.runLifecycleTeardown — resource teardown integration", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(
      mockSendEvent as unknown as (event: WorkspaceHostEvent) => void
    );

    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;

    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as unknown as SimpleGit;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createAndRegisterMonitor(overrides: Partial<Worktree> = {}): WorktreeMonitor {
    const wt = createTestWorktree(overrides);
    const monitor = new WorktreeMonitorClass(
      wt,
      {
        basePollingInterval: 10000,
        adaptiveBackoff: false,
        pollIntervalMax: 30000,
        circuitBreakerThreshold: 3,
        gitWatchEnabled: false,
      },
      { onUpdate: vi.fn() },
      "main"
    );
    service["monitors"].set(wt.id, monitor);
    return monitor;
  }

  it("runs resource teardown BEFORE regular teardown when hasResourceConfig=true", async () => {
    const monitor = createAndRegisterMonitor();
    monitor.setHasResourceConfig(true);

    const config = {
      teardown: ["npm run cleanup"],
      resource: { teardown: ["terraform destroy"] },
    };

    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
      if (n(p as string).endsWith("/test/root/.canopy/config.json")) return undefined;
      throw new Error("ENOENT");
    });
    vi.mocked(fsModule.readFile).mockResolvedValue(JSON.stringify(config) as never);

    const phases: string[] = [];
    const origSetLifecycleStatus = monitor.setLifecycleStatus.bind(monitor);
    vi.spyOn(monitor, "setLifecycleStatus").mockImplementation((status) => {
      if (status) phases.push(status.phase);
      origSetLifecycleStatus(status);
    });

    const childProcessModule = await import("child_process");
    vi.mocked(childProcessModule.spawn).mockImplementation(makeSpawnChild(0));

    await service["runLifecycleTeardown"]("/test/worktree", monitor, false);

    const resourceTeardownIdx = phases.indexOf("resource-teardown");
    const teardownIdx = phases.indexOf("teardown");
    expect(resourceTeardownIdx).toBeGreaterThanOrEqual(0);
    expect(teardownIdx).toBeGreaterThanOrEqual(0);
    expect(resourceTeardownIdx).toBeLessThan(teardownIdx);
  });

  it("runs only regular teardown when no resource config", async () => {
    const monitor = createAndRegisterMonitor();

    const config = { teardown: ["npm run cleanup"] };

    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
      if (n(p as string).endsWith("/test/root/.canopy/config.json")) return undefined;
      throw new Error("ENOENT");
    });
    vi.mocked(fsModule.readFile).mockResolvedValue(JSON.stringify(config) as never);

    const phases: string[] = [];
    const origSetLifecycleStatus = monitor.setLifecycleStatus.bind(monitor);
    vi.spyOn(monitor, "setLifecycleStatus").mockImplementation((status) => {
      if (status) phases.push(status.phase);
      origSetLifecycleStatus(status);
    });

    const childProcessModule = await import("child_process");
    vi.mocked(childProcessModule.spawn).mockImplementation(makeSpawnChild(0));

    await service["runLifecycleTeardown"]("/test/worktree", monitor, false);

    expect(phases).not.toContain("resource-teardown");
    expect(phases).toContain("teardown");
  });

  it("continues regular teardown even when resource teardown fails", async () => {
    const monitor = createAndRegisterMonitor();
    monitor.setHasResourceConfig(true);

    const config = {
      teardown: ["npm run cleanup"],
      resource: { teardown: ["terraform destroy"] },
    };

    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
      if (n(p as string).endsWith("/test/root/.canopy/config.json")) return undefined;
      throw new Error("ENOENT");
    });
    vi.mocked(fsModule.readFile).mockResolvedValue(JSON.stringify(config) as never);

    const childProcessModule = await import("child_process");
    let callCount = 0;
    vi.mocked(childProcessModule.spawn).mockImplementation(() => {
      callCount++;
      // First call (resource teardown) fails, second (regular teardown) succeeds
      const exitCode = callCount === 1 ? 1 : 0;
      return makeSpawnChild(exitCode)();
    });

    const phases: string[] = [];
    const origSetLifecycleStatus = monitor.setLifecycleStatus.bind(monitor);
    vi.spyOn(monitor, "setLifecycleStatus").mockImplementation((status) => {
      if (status) phases.push(status.phase);
      origSetLifecycleStatus(status);
    });

    await service["runLifecycleTeardown"]("/test/worktree", monitor, false);

    expect(phases).toContain("resource-teardown");
    expect(phases).toContain("teardown");
  });
});

describe("WorkspaceService.runLifecycleSetup — resource config caching", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(
      mockSendEvent as unknown as (event: WorkspaceHostEvent) => void
    );

    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;

    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as unknown as SimpleGit;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createAndRegisterMonitor(overrides: Partial<Worktree> = {}): WorktreeMonitor {
    const wt = createTestWorktree(overrides);
    const monitor = new WorktreeMonitorClass(
      wt,
      {
        basePollingInterval: 10000,
        adaptiveBackoff: false,
        pollIntervalMax: 30000,
        circuitBreakerThreshold: 3,
        gitWatchEnabled: false,
      },
      { onUpdate: vi.fn() },
      "main"
    );
    service["monitors"].set(wt.id, monitor);
    return monitor;
  }

  it("sets hasResourceConfig and resourceConnectCommand after setup when config has resource block", async () => {
    const monitor = createAndRegisterMonitor();

    const config = {
      setup: ["npm install"],
      resource: {
        provision: ["terraform apply"],
        connect: "ssh user@host",
      },
    };

    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
      if (n(p as string).endsWith("/test/root/.canopy/config.json")) return undefined;
      throw new Error("ENOENT");
    });
    vi.mocked(fsModule.readFile).mockResolvedValue(JSON.stringify(config) as never);

    const childProcessModule = await import("child_process");
    vi.mocked(childProcessModule.spawn).mockImplementation(makeSpawnChild(0));

    await service["runLifecycleSetup"]("/test/worktree", "/test/worktree", "/test/root");

    expect(monitor.hasResourceConfig).toBe(true);
    expect(monitor.resourceConnectCommand).toBe("ssh user@host");
  });

  it("does not set hasResourceConfig when config has no resource block", async () => {
    const monitor = createAndRegisterMonitor();

    const config = { setup: ["npm install"] };

    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
      if (n(p as string).endsWith("/test/root/.canopy/config.json")) return undefined;
      throw new Error("ENOENT");
    });
    vi.mocked(fsModule.readFile).mockResolvedValue(JSON.stringify(config) as never);

    const childProcessModule = await import("child_process");
    vi.mocked(childProcessModule.spawn).mockImplementation(makeSpawnChild(0));

    await service["runLifecycleSetup"]("/test/worktree", "/test/worktree", "/test/root");

    expect(monitor.hasResourceConfig).toBe(false);
    expect(monitor.resourceConnectCommand).toBeUndefined();
  });

  it("does not run when config has no setup commands", async () => {
    const monitor = createAndRegisterMonitor();

    const config = {
      resource: { provision: ["terraform apply"], connect: "ssh user@host" },
    };

    const fsModule = await import("fs/promises");
    vi.mocked(fsModule.access).mockImplementation(async (p: unknown) => {
      if (n(p as string).endsWith("/test/root/.canopy/config.json")) return undefined;
      throw new Error("ENOENT");
    });
    vi.mocked(fsModule.readFile).mockResolvedValue(JSON.stringify(config) as never);

    const childProcessModule = await import("child_process");
    const mockSpawn = vi.mocked(childProcessModule.spawn);

    await service["runLifecycleSetup"]("/test/worktree", "/test/worktree", "/test/root");

    expect(mockSpawn).not.toHaveBeenCalled();
    // Resource config IS cached even without setup commands (early-return path)
    expect(monitor.hasResourceConfig).toBe(true);
    expect(monitor.resourceConnectCommand).toBe("ssh user@host");
  });
});

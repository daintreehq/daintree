import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { randomBytes } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { SimpleGit } from "simple-git";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

// Settings are saved and read back through the real filesystem; only git, the
// forge, and the commands themselves are stubbed.

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
};

vi.mock("simple-git", () => ({ simpleGit: vi.fn(() => mockSimpleGit) }));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockSimpleGit),
  validateCwd: vi.fn(),
  validateBranchName: vi.fn(),
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

vi.mock("../../services/events.js", () => ({ events: new EventEmitter() }));

vi.mock("../../utils/gitFileWatcher.js", () => ({
  GitFileWatcher: class {
    start() {
      return Promise.resolve(false);
    }
    setUpstreamRef() {}
    dispose() {}
  },
}));

vi.mock("../../services/ProjectEnvSecureStorage.js", () => ({
  projectEnvSecureStorage: {
    getForProject: vi.fn(() => new Map()),
    replaceForProject: vi.fn(),
    deleteAllForProject: vi.fn(),
    migrateAllForProject: vi.fn(),
  },
}));

vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: vi.fn() }));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }),
}));

const ENVIRONMENT = {
  provision: ["cloud-provision"],
  teardown: ["cloud-teardown"],
  pause: ["cloud-pause"],
  resume: ["cloud-resume"],
  status: "cloud-status",
  connect: "ssh cloud.example",
};

describe("WorkspaceService — resource environments saved in Project settings (#17354)", () => {
  let root: string;
  let projectRoot: string;
  let worktreePath: string;
  let userData: string;
  let previousUserData: string | undefined;
  let projectId: string;
  let spawned: string[];
  let service: WorkspaceService | undefined;
  let monitor: WorktreeMonitor;

  function host(): WorkspaceService {
    if (!service) throw new Error("WorkspaceService was not constructed");
    return service;
  }

  /** The per-root settings file in the home folder, which every host read before #17354. */
  function writeHomeSettings(settings: Record<string, unknown>) {
    const dir = path.join(
      root,
      "home",
      ".daintree",
      "projects",
      projectRoot.replace(/[/\\:*?"<>|]/g, "_")
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    service = undefined;
    root = mkdtempSync(path.join(os.tmpdir(), "saved-environments-"));
    projectRoot = path.join(root, "repo");
    worktreePath = path.join(root, "repo-feature");
    userData = path.join(root, "userData");
    for (const dir of [projectRoot, worktreePath, path.join(root, "home")]) {
      mkdirSync(dir, { recursive: true });
    }
    // Teardown logs and the per-root files live under the home folder.
    vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
    previousUserData = process.env.DAINTREE_USER_DATA;
    process.env.DAINTREE_USER_DATA = userData;
    // Not derived from the path, as for a project that has moved since it was added.
    projectId = randomBytes(32).toString("hex");

    const { ProjectSettingsManager } = await import("../../services/ProjectSettingsManager.js");
    const settings = new ProjectSettingsManager(path.join(userData, "projects"), {
      get: vi.fn(),
    } as never);
    await settings.saveProjectSettings(projectId, {
      runCommands: [],
      resourceEnvironments: { cloud: ENVIRONMENT },
    });

    spawned = [];
    const childProcess = await import("child_process");
    vi.mocked(childProcess.spawn).mockImplementation(((command: string) => {
      spawned.push(command);
      const child = {
        pid: 99,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (code: number) => void) => {
          if (event === "close") setTimeout(() => cb(0), 0);
        }),
        kill: vi.fn(),
      };
      return child as never;
    }) as never);

    const { WorkspaceService: Service } = await import("../WorkspaceService.js");
    service = new Service(vi.fn() as unknown as (event: WorkspaceHostEvent) => void);
    service["projectRootPath"] = projectRoot;
    service["projectId"] = projectId;
    service["git"] = mockSimpleGit as unknown as SimpleGit;

    const { WorktreeMonitor: Monitor } = await import("../WorktreeMonitor.js");
    monitor = new Monitor(
      {
        id: worktreePath,
        path: worktreePath,
        name: "feature/x",
        branch: "feature/x",
        isCurrent: false,
        isMainWorktree: false,
        gitDir: path.join(worktreePath, ".git"),
      },
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
    monitor.setWorktreeMode("cloud");
    service["monitors"].set(worktreePath, monitor);
  });

  afterEach(() => {
    try {
      service?.dispose();
    } finally {
      if (previousUserData === undefined) delete process.env.DAINTREE_USER_DATA;
      else process.env.DAINTREE_USER_DATA = previousUserData;
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("provisions the environment when a worktree is created on it", async () => {
    const outcome = await host()["setupCoordinator"].runLifecycleSetup(
      worktreePath,
      worktreePath,
      projectRoot,
      true
    );

    expect(outcome).toEqual({ ok: true });
    expect(spawned).toEqual(["cloud-provision"]);
    expect(monitor.lifecycleCommandsNeedApproval ?? false).toBe(false);
    expect(monitor.resourceConnectCommand).toBe("ssh cloud.example");
  });

  it.each([
    ["pause", "cloud-pause"],
    ["resume", "cloud-resume"],
    ["status", "cloud-status"],
  ] as const)("answers %s", async (action, command) => {
    await host().runResourceAction(`req-${action}`, worktreePath, action);

    expect(spawned).toEqual([command]);
  });

  it("offers connect as soon as the worktree's monitor starts", async () => {
    await host()["initResourceConfigAsync"](monitor, worktreePath);

    expect(monitor.hasResourceConfig).toBe(true);
    expect(monitor.resourceConnectCommand).toBe("ssh cloud.example");
  });

  it.each(["local", "staging"])(
    "offers a %s worktree the switch but none of another environment's commands",
    async (mode) => {
      monitor.setWorktreeMode(mode);

      await host()["initResourceConfigAsync"](monitor, worktreePath);

      expect(monitor.hasResourceConfig).toBe(true);
      expect(monitor.resourceConnectCommand).toBeUndefined();
      expect(monitor.hasStatusCommand).toBe(false);
      expect(monitor.hasTeardownCommand).toBe(false);
    }
  );

  it("drops the commands of an environment renamed away on the next refresh", async () => {
    await host()["initResourceConfigAsync"](monitor, worktreePath);
    expect(monitor.resourceConnectCommand).toBe("ssh cloud.example");

    const { ProjectSettingsManager } = await import("../../services/ProjectSettingsManager.js");
    await new ProjectSettingsManager(path.join(userData, "projects"), {
      get: vi.fn(),
    } as never).saveProjectSettings(projectId, {
      runCommands: [],
      resourceEnvironments: { staging: ENVIRONMENT },
    });
    await host()["initResourceConfigAsync"](monitor, worktreePath);

    expect(monitor.hasResourceConfig).toBe(true);
    expect(monitor.resourceConnectCommand).toBeUndefined();
    expect(monitor.hasStatusCommand).toBe(false);
    expect(monitor.hasPauseCommand).toBe(false);
    expect(monitor.hasTeardownCommand).toBe(false);
  });

  it("tears the environment down when the worktree is deleted", async () => {
    await host()["initResourceConfigAsync"](monitor, worktreePath);
    await host()["runLifecycleTeardown"](worktreePath, monitor);

    expect(spawned).toEqual(["cloud-teardown"]);
  });

  it("never reads the loaded project's saved settings for another root", async () => {
    expect(
      await host()["lifecycleService"].resolveProjectResourceEnvironments(path.join(root, "other"))
    ).toBeNull();
  });

  describe("when the host finds no saved settings", () => {
    beforeEach(() => {
      writeHomeSettings({ resourceEnvironments: { cloud: { provision: ["home-provision"] } } });
    });

    it("still provisions an environment from the home settings file", async () => {
      host()["projectId"] = randomBytes(32).toString("hex");

      await host()["setupCoordinator"].runLifecycleSetup(
        worktreePath,
        worktreePath,
        projectRoot,
        true
      );

      expect(spawned).toEqual(["home-provision"]);
    });

    it("offers the home settings file's environments to the New Worktree dialog (#17358)", async () => {
      writeHomeSettings({
        resourceEnvironments: { cloud: { provision: ["home-provision"] }, gpu: { status: "x" } },
      });
      host()["projectId"] = randomBytes(32).toString("hex");

      expect(await host().resourceEnvironmentKeys()).toEqual(["cloud", "gpu"]);
    });

    it("reads the home settings file when the host has no userData folder", async () => {
      delete process.env.DAINTREE_USER_DATA;

      await host()["setupCoordinator"].runLifecycleSetup(
        worktreePath,
        worktreePath,
        projectRoot,
        true
      );

      expect(host()["projectSettingsFilePath"](projectId)).toBeNull();
      expect(spawned).toEqual(["home-provision"]);
    });
  });

  it("offers the saved environments, not a home file's, while Project settings has some (#17358)", async () => {
    writeHomeSettings({ resourceEnvironments: { home: { provision: ["home-provision"] } } });

    expect(await host().resourceEnvironmentKeys()).toEqual(["cloud"]);
  });

  it("is reported as configured by the resource probe", async () => {
    const { probeResourceConfig } = await import("../../utils/resourceConfigProbe.js");
    const { settingsFilePath } = await import("../../services/projectStorePaths.js");

    const probe = await probeResourceConfig(projectRoot, [worktreePath], {
      homeDir: path.join(root, "home"),
      projectSettingsPath: settingsFilePath(path.join(userData, "projects"), projectId),
    });

    expect(probe).toBe("configured");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import path from "path";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeSetupStepDescriptor } from "../../../shared/types/workspace-host.js";

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  checkIsRepo: vi.fn().mockResolvedValue(true),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
  branchLocal: vi.fn().mockResolvedValue({ all: [], current: "", branches: {}, detached: false }),
  // The tracking decision needs the real remote names to know where
  // `origin/main` splits; a repo with one remote is the ordinary case.
  getRemotes: vi.fn().mockResolvedValue([{ name: "origin", refs: { fetch: "url", push: "url" } }]),
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
  validateBranchName: vi.fn(),
  getGitLocaleEnv: vi.fn().mockReturnValue({}),
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
  getGitCommonDir: vi.fn().mockReturnValue(null),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: vi.fn().mockReturnValue("stable"),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
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
    return {
      read: vi.fn().mockResolvedValue({}),
    };
  }),
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
        return Promise.resolve(false);
      }
      setUpstreamRef() {}
      dispose() {}
    },
  };
});

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
  // Identity by default: no symlinks in unit tests. The containment check
  // (assertWorktreePathContained) realpaths the repo parent and the target's
  // nearest existing ancestor; identity keeps resolved paths unchanged.
  realpath: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
}));

vi.mock("../worktreeInclude.js", () => ({
  copyWorktreeIncludeFiles: vi.fn(),
}));

// Default to "exists" so pre-existing tests don't exercise the parent mkdir
// path unless they opt in by toggling the mock.
vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

const bridge = vi.hoisted(() => ({
  listSteps: vi.fn(),
  runStep: vi.fn(),
}));

vi.mock("../worktreeSetupBridge.js", () => ({
  getWorktreeSetupBridge: () => bridge,
}));

function step(
  pluginId: string,
  stepId: string,
  label: string,
  pluginName = pluginId
): WorktreeSetupStepDescriptor {
  return { pluginId, pluginName, pluginVersion: "1.0.0", stepId, label, timeoutMs: 60_000 };
}

const ACME_DB = step("acme", "provision-db", "Provision DB", "Acme");
const ACME_SEED = step("acme", "seed", "Seed fixtures", "Acme");
const ZED_REGISTER = step("zed", "register", "Register branch", "Zed");

describe("WorkspaceService plugin worktree setup steps (#13807)", () => {
  let service: WorkspaceService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSimpleGit.raw.mockResolvedValue(undefined);
    mockSimpleGit.checkIsRepo.mockResolvedValue(true);
    mockSimpleGit.branch.mockResolvedValue({ current: "main" });
    mockSimpleGit.branchLocal.mockResolvedValue({
      all: [],
      current: "",
      branches: {},
      detached: false,
    });
    const worktreeIncludeModule = await import("../worktreeInclude.js");
    vi.mocked(worktreeIncludeModule.copyWorktreeIncludeFiles).mockResolvedValue({
      copied: 0,
      skippedExisting: 0,
      skippedUnsafe: 0,
      skippedOversized: 0,
      skippedOverLimit: 0,
    });

    bridge.listSteps.mockResolvedValue([]);
    bridge.runStep.mockResolvedValue({ state: "succeeded" });

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(vi.fn());
    (service as unknown as { projectRootPath: string }).projectRootPath = "/test/root";
    vi.spyOn(
      service as unknown as { initWorktreeSubmodules: (...args: unknown[]) => Promise<unknown> },
      "initWorktreeSubmodules"
    ).mockResolvedValue({ ok: true });
    vi.spyOn(service["lifecycleService"], "runLifecycleSetup").mockResolvedValue({
      shouldProvision: false,
      needsApproval: false,
    });
    vi.spyOn(service["lifecycleService"], "pendingPluginSteps").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function create(name: string): Promise<string> {
    await service.createWorktree(`req-${name}`, "/test/root", {
      baseBranch: "main",
      newBranch: `feature/${name}`,
      path: `/test/${name}`,
    });
    const worktreeId = path.resolve(`/test/${name}`);
    await vi.waitFor(() => {
      const state = service["monitors"].get(worktreeId)?.setupStatus?.state;
      expect(state === "pending" || state === "running").toBe(false);
    });
    return worktreeId;
  }

  const statusOf = (worktreeId: string) => service["monitors"].get(worktreeId)?.setupStatus;

  it("runs every step after the setup script, in order, holding setup running until the last", async () => {
    bridge.listSteps.mockResolvedValue([ACME_DB, ACME_SEED, ZED_REGISTER]);
    const seen: Array<{ label: string; state?: string; stage?: string; card?: string }> = [];
    bridge.runStep.mockImplementation(async (s: WorktreeSetupStepDescriptor, target) => {
      const monitor = service["monitors"].get(target.worktreeId);
      seen.push({
        label: s.label,
        state: monitor?.setupStatus?.state,
        stage: monitor?.setupStatus?.stage,
        card: monitor?.lifecycleStatus?.currentCommand,
      });
      return { state: "succeeded" };
    });
    const setupOrder = vi.mocked(service["lifecycleService"].runLifecycleSetup);

    const worktreeId = await create("steps-in-order");

    expect(setupOrder).toHaveBeenCalledTimes(1);
    expect(setupOrder.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.runStep.mock.invocationCallOrder[0]
    );
    expect(seen).toEqual([
      {
        label: "Provision DB",
        state: "running",
        stage: "plugin-steps",
        card: "Provision DB (Acme)",
      },
      {
        label: "Seed fixtures",
        state: "running",
        stage: "plugin-steps",
        card: "Seed fixtures (Acme)",
      },
      {
        label: "Register branch",
        state: "running",
        stage: "plugin-steps",
        card: "Register branch (Zed)",
      },
    ]);
    const status = statusOf(worktreeId);
    expect(status?.state).toBe("ready");
    expect(status?.pluginSteps?.map((s) => s.state)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(service["monitors"].get(worktreeId)?.lifecycleStatus?.state).toBe("success");
  });

  it("keeps going past a failed step, and attributes the failure to its plugin", async () => {
    bridge.listSteps.mockResolvedValue([ACME_DB, ZED_REGISTER]);
    bridge.runStep.mockImplementation(async (s: WorktreeSetupStepDescriptor) =>
      s.stepId === "provision-db"
        ? { state: "failed", error: "quota exceeded" }
        : { state: "succeeded" }
    );

    const worktreeId = await create("step-fails");

    expect(bridge.runStep).toHaveBeenCalledTimes(2);
    const status = statusOf(worktreeId);
    expect(status?.state).toBe("failed");
    expect(status?.stage).toBe("plugin-steps");
    expect(status?.error).toBe('Acme "Provision DB" failed: quota exceeded');
    expect(status?.pluginSteps?.map((s) => s.state)).toEqual(["failed", "succeeded"]);
    const lifecycle = service["monitors"].get(worktreeId)?.lifecycleStatus;
    expect(lifecycle).toMatchObject({ phase: "setup", state: "failed" });
    expect(lifecycle?.error).toContain("Acme");
  });

  it("records a step its plugin could not run as skipped, and never calls setup ready", async () => {
    bridge.listSteps.mockResolvedValue([ACME_DB]);
    bridge.runStep.mockResolvedValue({
      state: "skipped",
      error: "the plugin isn't loaded for this project",
    });

    const worktreeId = await create("step-skipped");

    const status = statusOf(worktreeId);
    expect(status?.state).toBe("failed");
    expect(status?.pluginSteps?.[0]).toMatchObject({ state: "skipped" });
    expect(status?.error).toContain("was skipped");
  });

  it("reports timed-out when the first unfinished step timed out", async () => {
    bridge.listSteps.mockResolvedValue([ACME_DB]);
    bridge.runStep.mockResolvedValue({ state: "timed-out", error: "timed out after 60s" });

    const worktreeId = await create("step-timed-out");

    expect(statusOf(worktreeId)).toMatchObject({ state: "timed-out", stage: "plugin-steps" });
  });

  it("skips an unallowed step, runs the allowed ones, and asks for approval", async () => {
    bridge.listSteps.mockResolvedValue([ACME_DB, ZED_REGISTER]);
    vi.mocked(service["lifecycleService"].pendingPluginSteps).mockResolvedValue([ACME_DB]);

    const worktreeId = await create("step-unapproved");

    expect(bridge.runStep).toHaveBeenCalledTimes(1);
    expect(bridge.runStep.mock.calls[0][0]).toBe(ZED_REGISTER);
    const status = statusOf(worktreeId);
    expect(status?.state).toBe("needs-approval");
    expect(status?.stage).toBe("plugin-steps");
    expect(status?.pluginSteps?.map((s) => s.state)).toEqual(["needs-approval", "succeeded"]);
  });

  it("does not run plugin steps when the setup script failed", async () => {
    bridge.listSteps.mockResolvedValue([ACME_DB]);
    vi.mocked(service["lifecycleService"].runLifecycleSetup).mockImplementation(
      async (worktreeId: string) => {
        service["monitors"].get(worktreeId)?.setLifecycleStatus({
          phase: "setup",
          state: "failed",
          startedAt: Date.now(),
          completedAt: Date.now(),
          error: "npm ci exited 1",
        });
        return { shouldProvision: false, needsApproval: false };
      }
    );

    const worktreeId = await create("script-failed");

    expect(bridge.listSteps).not.toHaveBeenCalled();
    expect(bridge.runStep).not.toHaveBeenCalled();
    expect(statusOf(worktreeId)).toMatchObject({ state: "failed", stage: "setup-script" });
  });

  it("fails the plugin stage rather than calling it empty when main does not answer the list", async () => {
    bridge.listSteps.mockRejectedValue(new Error("No answer from the app after 30s"));

    const worktreeId = await create("list-failed");

    const status = statusOf(worktreeId);
    expect(status?.state).toBe("failed");
    expect(status?.stage).toBe("plugin-steps");
    expect(status?.error).toContain("Couldn't read the plugin setup steps");
  });

  it("is ready with no plugin record when no plugin declares a step", async () => {
    const worktreeId = await create("no-steps");

    expect(statusOf(worktreeId)?.state).toBe("ready");
    expect(statusOf(worktreeId)?.pluginSteps).toBeUndefined();
  });

  it("retries only the steps that did not succeed, without re-running the setup script", async () => {
    bridge.listSteps.mockResolvedValue([ACME_DB, ZED_REGISTER]);
    bridge.runStep.mockImplementation(async (s: WorktreeSetupStepDescriptor) =>
      s.stepId === "provision-db"
        ? { state: "failed", error: "quota exceeded" }
        : { state: "succeeded" }
    );
    const worktreeId = await create("retry-resume");
    const setupRuns = vi.mocked(service["lifecycleService"].runLifecycleSetup).mock.calls.length;
    bridge.runStep.mockClear();
    bridge.runStep.mockResolvedValue({ state: "succeeded" });

    await service.retryLifecycleSetup(worktreeId);

    expect(vi.mocked(service["lifecycleService"].runLifecycleSetup).mock.calls.length).toBe(
      setupRuns
    );
    expect(bridge.runStep).toHaveBeenCalledTimes(1);
    expect(bridge.runStep.mock.calls[0][0]).toBe(ACME_DB);
    const status = statusOf(worktreeId);
    expect(status?.state).toBe("ready");
    expect(status?.pluginSteps?.map((s) => s.state)).toEqual(["succeeded", "succeeded"]);
  });

  it("resumes an approved step through the retry an approval triggers", async () => {
    bridge.listSteps.mockResolvedValue([ACME_DB]);
    vi.mocked(service["lifecycleService"].pendingPluginSteps).mockResolvedValue([ACME_DB]);
    const worktreeId = await create("approve-resume");
    expect(statusOf(worktreeId)?.state).toBe("needs-approval");
    expect(service["setupAwaitingApproval"].has(service["monitors"].get(worktreeId)!)).toBe(true);

    vi.mocked(service["lifecycleService"].pendingPluginSteps).mockResolvedValue([]);
    await service.retryLifecycleSetup(worktreeId);

    expect(bridge.runStep).toHaveBeenCalledTimes(1);
    expect(statusOf(worktreeId)?.state).toBe("ready");
    expect(service["setupAwaitingApproval"].has(service["monitors"].get(worktreeId)!)).toBe(false);
  });

  it("refuses a retry while plugin steps are still running", async () => {
    bridge.listSteps.mockResolvedValue([ACME_DB]);
    let release!: () => void;
    bridge.runStep.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ state: "succeeded" })))
    );
    await service.createWorktree("req-busy", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/busy",
      path: "/test/busy",
    });
    const worktreeId = path.resolve("/test/busy");
    await vi.waitFor(() => expect(bridge.runStep).toHaveBeenCalled());

    await expect(service.retryLifecycleSetup(worktreeId)).rejects.toThrow(
      "Setup is already running"
    );
    release();
    await vi.waitFor(() => expect(statusOf(worktreeId)?.state).toBe("ready"));
  });

  it("cancels the running step when its worktree is removed", async () => {
    bridge.listSteps.mockResolvedValue([ACME_DB, ZED_REGISTER]);
    let signal: AbortSignal | undefined;
    bridge.runStep.mockImplementation(
      (_s: WorktreeSetupStepDescriptor, _t: unknown, s: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal = s;
          s.addEventListener("abort", () => reject(new Error("Cancelled")));
        })
    );
    await service.createWorktree("req-removed", "/test/root", {
      baseBranch: "main",
      newBranch: "feature/removed",
      path: "/test/removed",
    });
    const worktreeId = path.resolve("/test/removed");
    await vi.waitFor(() => expect(signal).toBeDefined());

    service["removeMonitor"](worktreeId);

    expect(signal?.aborted).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    // The second step never starts for a worktree that is gone.
    expect(bridge.runStep).toHaveBeenCalledTimes(1);
  });
});

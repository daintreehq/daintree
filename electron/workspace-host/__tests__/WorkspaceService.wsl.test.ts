import { EventEmitter } from "events";
import os from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";
import type { Worktree } from "../../../shared/types/worktree.js";

const mockSimpleGit = {
  raw: vi.fn(),
  checkIsRepo: vi.fn().mockResolvedValue(true),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockSimpleGit),
}));

// These tests override process.platform to "win32" before importing
// WorkspaceService. Mock the watcher boundary so the suite does not arm a real
// recursive fs.watch subscription over its synthetic paths.
vi.mock("../../utils/parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
}));

vi.mock("../../utils/fs.js", () => ({
  waitForPathExists: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockSimpleGit),
  createAuthenticatedGit: vi.fn(() => mockSimpleGit),
  validateBranchName: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/worktree/.git"),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
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

const { detectWslPathMock, getDefaultWslDistroMock } = vi.hoisted(() => ({
  detectWslPathMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn(),
}));
vi.mock("../../utils/wsl.js", () => ({
  detectWslPath: detectWslPathMock,
  getDefaultWslDistro: getDefaultWslDistroMock,
}));

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
  realpath: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

interface StubMonitor {
  isWslPath: boolean;
  wslDistro: string | undefined;
  setWslEligible: ReturnType<typeof vi.fn>;
  setWslOptIn: ReturnType<typeof vi.fn>;
  // dispose() iterates monitors and calls stop(); provide a no-op so teardown
  // doesn't blow up on these lightweight stubs.
  stop: ReturnType<typeof vi.fn>;
}

function stubMonitor(isWslPath: boolean, wslDistro: string | undefined): StubMonitor {
  return { isWslPath, wslDistro, setWslEligible: vi.fn(), setWslOptIn: vi.fn(), stop: vi.fn() };
}

const WSL_WORKTREE: Worktree = {
  id: "\\\\wsl$\\Ubuntu\\repo",
  path: "\\\\wsl$\\Ubuntu\\repo",
  name: "repo",
  isCurrent: false,
};

// The eligibility matrix lives in WslGitEligibilityTracker.test.ts; these
// cover only how WorkspaceService wires the tracker to its monitors and its
// background, unload and project-switch lifecycle.
describe("WorkspaceService WSL eligibility wiring (#9924)", () => {
  let service: WorkspaceService;
  let clearedOptIns: string[];
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    detectWslPathMock.mockReset().mockReturnValue({ distro: "Ubuntu", posixPath: "/repo" });
    getDefaultWslDistroMock.mockReset().mockResolvedValue("Ubuntu");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.spyOn(os, "setPriority").mockImplementation(() => {});
    clearedOptIns = [];
    const workspaceModule = await import("../WorkspaceService.js");
    service = new workspaceModule.WorkspaceService((event: WorkspaceHostEvent) => {
      if (event.type === "clear-wsl-git-opt-in") clearedOptIns.push(event.worktreeId);
    });
  });

  afterEach(() => {
    service.dispose();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function seedMonitors(): { ubuntu: StubMonitor; debian: StubMonitor } {
    const ubuntu = stubMonitor(true, "Ubuntu");
    const debian = stubMonitor(true, "Debian");
    const monitors = service["monitors"] as unknown as Map<string, StubMonitor>;
    monitors.set("ubuntu-wt", ubuntu);
    monitors.set("debian-wt", debian);
    monitors.set("local-wt", stubMonitor(false, undefined));
    return { ubuntu, debian };
  }

  /** Arms the distro poll the way a first WSL monitor install does. */
  function enrichWslWorktree(wt: Worktree = WSL_WORKTREE): Promise<Worktree> {
    return service["wslGit"].enrichWorktree(wt);
  }

  it("reprobe refreshes the service's own WSL monitors", async () => {
    const { ubuntu, debian } = seedMonitors();
    getDefaultWslDistroMock.mockResolvedValue("Debian");

    await service.reprobeWslForWorktree("ubuntu-wt");

    expect(ubuntu.setWslEligible).toHaveBeenCalledWith("unprobed");
    expect(ubuntu.setWslEligible).toHaveBeenLastCalledWith("ineligible");
    expect(debian.setWslEligible).toHaveBeenLastCalledWith("eligible");
  });

  it("setWslOptIn reaches the matching monitor and later enrichments", async () => {
    const monitor = stubMonitor(true, "Ubuntu");
    (service["monitors"] as unknown as Map<string, StubMonitor>).set(WSL_WORKTREE.id, monitor);

    service.setWslOptIn(WSL_WORKTREE.id, true, false);
    expect(monitor.setWslOptIn).toHaveBeenLastCalledWith(true, false);
    service.setWslOptIn(WSL_WORKTREE.id, false, true);
    expect(monitor.setWslOptIn).toHaveBeenLastCalledWith(false, true);

    const enriched = await enrichWslWorktree();
    expect(enriched.wslGitOptIn).toBe(false);
    expect(enriched.wslGitDismissed).toBe(true);
  });

  it("load merges main's opt-ins under in-memory toggles, then prunes stale in-project keys", async () => {
    const root = "/projects/repo";
    const live: Worktree = {
      id: `${root}/.worktrees/live`,
      path: `${root}/.worktrees/live`,
      name: "live",
      isCurrent: false,
    };
    const listService = service["listService"] as unknown as {
      list: unknown;
      mapToWorktrees: unknown;
    };
    listService.list = vi.fn().mockResolvedValue([]);
    listService.mapToWorktrees = vi.fn().mockResolvedValue([live]);
    vi.spyOn(service, "syncMonitors").mockResolvedValue(undefined);
    vi.spyOn(
      service["topologyWatcher"] as unknown as { startWatcher: () => Promise<void> },
      "startWatcher"
    ).mockResolvedValue(undefined);
    const internals = service as unknown as {
      sweepPrunableWorktreeEntries: () => Promise<void>;
      initializePRService: () => Promise<void>;
      refreshAll: (force?: boolean) => Promise<void>;
    };
    vi.spyOn(internals, "sweepPrunableWorktreeEntries").mockResolvedValue(undefined);
    // The post-load PR and status work is fire-and-forget and outside this wiring.
    vi.spyOn(internals, "initializePRService").mockResolvedValue(undefined);
    vi.spyOn(internals, "refreshAll").mockResolvedValue(undefined);

    // A toggle that landed before main's persisted map must survive the merge.
    service.setWslOptIn(live.id, false, true);
    await service.loadProject("req-load", root, "project-id", undefined, {
      [live.id]: { enabled: true, dismissed: false },
      [`${root}/.worktrees/stale`]: { enabled: true, dismissed: false },
      "/elsewhere/repo/wt": { enabled: true, dismissed: false },
    });

    expect(clearedOptIns).toEqual([`${root}/.worktrees/stale`]);
    const enriched = await enrichWslWorktree(live);
    expect(enriched.wslGitOptIn).toBe(false);
    expect(enriched.wslGitDismissed).toBe(true);
  });

  it("stops the distro poll while backgrounded and restarts it on resume (#12519)", async () => {
    vi.useFakeTimers();
    await enrichWslWorktree();

    service.pause();
    getDefaultWslDistroMock.mockClear();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(getDefaultWslDistroMock).not.toHaveBeenCalled();

    service.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getDefaultWslDistroMock).toHaveBeenCalled();
  });

  it("a first WSL enrichment landing while backgrounded arms the poll on resume", async () => {
    vi.useFakeTimers();
    service.pause();

    await enrichWslWorktree();
    getDefaultWslDistroMock.mockClear();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(getDefaultWslDistroMock).not.toHaveBeenCalled();

    service.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getDefaultWslDistroMock).toHaveBeenCalled();
  });

  it("a project switch while backgrounded does not revive the poll on resume", async () => {
    vi.useFakeTimers();
    await enrichWslWorktree();
    service.pause();
    await service.onProjectSwitch("switch-1");

    service.resume();
    getDefaultWslDistroMock.mockClear();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
  });

  it("a project switch discards an in-flight reprobe and drops the cached distro", async () => {
    await enrichWslWorktree();
    const { ubuntu, debian } = seedMonitors();
    let resolveProbe!: (v: string | null) => void;
    getDefaultWslDistroMock.mockReturnValueOnce(
      new Promise<string | null>((r) => {
        resolveProbe = r;
      })
    );
    const pending = service.reprobeWslForWorktree("ubuntu-wt");
    ubuntu.setWslEligible.mockClear();

    await service.onProjectSwitch("switch-1");
    resolveProbe("Debian");
    await pending;

    expect(ubuntu.setWslEligible).not.toHaveBeenCalled();
    expect(debian.setWslEligible).not.toHaveBeenCalled();
    getDefaultWslDistroMock.mockClear();
    await enrichWslWorktree();
    expect(getDefaultWslDistroMock).toHaveBeenCalledTimes(1);
  });

  it("dispose stops the distro poll", async () => {
    vi.useFakeTimers();
    await enrichWslWorktree();

    service.dispose();
    getDefaultWslDistroMock.mockClear();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
  });
});

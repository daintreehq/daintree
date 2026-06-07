import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

const mockSimpleGit = {
  raw: vi.fn(),
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
  createAuthenticatedGit: vi.fn(() => mockSimpleGit),
  validateBranchName: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/worktree/.git"),
  clearGitDirCache: vi.fn(),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
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

const getDefaultWslDistroMock = vi.hoisted(() => vi.fn());
vi.mock("../../utils/wsl.js", () => ({
  detectWslPath: vi.fn().mockReturnValue(null),
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
  // dispose() iterates monitors and calls stop(); provide a no-op so teardown
  // doesn't blow up on these lightweight stubs.
  stop: ReturnType<typeof vi.fn>;
}

function stubMonitor(isWslPath: boolean, wslDistro: string | undefined): StubMonitor {
  return { isWslPath, wslDistro, setWslEligible: vi.fn(), stop: vi.fn() };
}

describe("WorkspaceService WSL eligibility refresh (#9924)", () => {
  let service: WorkspaceService;
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const workspaceModule = await import("../WorkspaceService.js");
    service = new workspaceModule.WorkspaceService((_event: WorkspaceHostEvent) => {});
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    service.dispose();
    vi.restoreAllMocks();
  });

  function seedMonitors(): { ubuntu: StubMonitor; debian: StubMonitor; nonWsl: StubMonitor } {
    const ubuntu = stubMonitor(true, "Ubuntu");
    const debian = stubMonitor(true, "Debian");
    const nonWsl = stubMonitor(false, undefined);
    const monitors = service["monitors"] as unknown as Map<string, StubMonitor>;
    monitors.set("ubuntu-wt", ubuntu);
    monitors.set("debian-wt", debian);
    monitors.set("local-wt", nonWsl);
    return { ubuntu, debian, nonWsl };
  }

  it("reprobe refreshes every WSL monitor against the fresh default distro", async () => {
    const { ubuntu, debian, nonWsl } = seedMonitors();
    // Default distro changed to Debian mid-session.
    getDefaultWslDistroMock.mockResolvedValue("Debian");

    await service.reprobeWslForWorktree("ubuntu-wt");

    // Target monitor first shows the pending state, then its final verdict.
    expect(ubuntu.setWslEligible).toHaveBeenCalledWith("unprobed");
    expect(ubuntu.setWslEligible).toHaveBeenLastCalledWith("ineligible");
    // The shared probe also refreshes the now-default Debian worktree.
    expect(debian.setWslEligible).toHaveBeenLastCalledWith("eligible");
    // Non-WSL monitors are never touched.
    expect(nonWsl.setWslEligible).not.toHaveBeenCalled();
  });

  it("reprobe maps a failed probe (null default) to 'unprobed', not 'ineligible'", async () => {
    const { ubuntu, debian } = seedMonitors();
    getDefaultWslDistroMock.mockResolvedValue(null);

    await service.reprobeWslForWorktree("ubuntu-wt");

    expect(ubuntu.setWslEligible).toHaveBeenLastCalledWith("unprobed");
    expect(debian.setWslEligible).toHaveBeenLastCalledWith("unprobed");
  });

  it("reprobe is a no-op for an unknown or non-WSL worktree", async () => {
    const { nonWsl } = seedMonitors();
    getDefaultWslDistroMock.mockResolvedValue("Ubuntu");

    await service.reprobeWslForWorktree("local-wt");
    await service.reprobeWslForWorktree("does-not-exist");

    expect(nonWsl.setWslEligible).not.toHaveBeenCalled();
    expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
  });

  it("the background poll refreshes monitors only when the default distro changes", async () => {
    const { ubuntu, debian } = seedMonitors();
    service["wslLastKnownDefaultDistro"] = "Ubuntu";

    // Same distro → no refresh.
    getDefaultWslDistroMock.mockResolvedValueOnce("Ubuntu");
    await (service as unknown as { pollWslDefaultDistro(): Promise<void> }).pollWslDefaultDistro();
    expect(ubuntu.setWslEligible).not.toHaveBeenCalled();
    expect(debian.setWslEligible).not.toHaveBeenCalled();

    // Distro flips to Debian → both WSL monitors recompute.
    getDefaultWslDistroMock.mockResolvedValueOnce("Debian");
    await (service as unknown as { pollWslDefaultDistro(): Promise<void> }).pollWslDefaultDistro();
    expect(ubuntu.setWslEligible).toHaveBeenLastCalledWith("ineligible");
    expect(debian.setWslEligible).toHaveBeenLastCalledWith("eligible");
    expect(service["wslLastKnownDefaultDistro"]).toBe("Debian");
  });
});

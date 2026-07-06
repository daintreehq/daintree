import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { WorkspaceService } from "../WorkspaceService.js";

// Real fs.watch drives the sentinel; only the parcel watcher (native FSEvents
// subscription for the steady-state topology watcher) is stubbed.
const parcelSubscriptions: Array<{ dir: string; unsubscribed: boolean }> = [];

vi.mock("@parcel/watcher", () => ({
  default: {
    subscribe: vi.fn((dir: string) => {
      const entry = { dir, unsubscribed: false };
      parcelSubscriptions.push(entry);
      return Promise.resolve({
        unsubscribe: () => {
          entry.unsubscribed = true;
          return Promise.resolve();
        },
      });
    }),
  },
}));

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockSimpleGit),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockSimpleGit),
  createWslHardenedGit: vi.fn(() => mockSimpleGit),
  validateCwd: vi.fn(),
  validateBranchName: vi.fn(),
}));

// getGitCommonDir points the metadata-dir resolution at the temp repo.
let commonDir: string;
vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue(null),
  getGitCommonDir: vi.fn(() => Promise.resolve(commonDir)),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
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

const mockEvents = new EventEmitter();
vi.mock("../../services/events.js", () => ({
  events: mockEvents,
}));

describe("WorkspaceService topology metadata sentinel", () => {
  let service: WorkspaceService;
  let tempRoot: string;
  let metadataDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    parcelSubscriptions.length = 0;
    tempRoot = mkdtempSync(join(tmpdir(), "daintree-topo-sentinel-"));
    commonDir = join(tempRoot, ".git");
    mkdirSync(commonDir, { recursive: true });
    metadataDir = join(commonDir, "worktrees");

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(vi.fn() as any);
    service["projectRootPath"] = tempRoot;
    service["git"] = mockSimpleGit as any;
  });

  afterEach(() => {
    service["stopTopologyWatcher"]();
    rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("arms the sentinel instead of subscribing when .git/worktrees is absent", async () => {
    await service["startTopologyWatcher"]();

    expect(service["topologyMetadataSentinel"]).not.toBeNull();
    expect(service["topologyWatcherSubscription"].value).toBeUndefined();
    expect(parcelSubscriptions).toHaveLength(0);
  });

  it("hands off to the real watcher and schedules a reconcile when the dir appears", async () => {
    const reconcileSpy = vi
      .spyOn(service, "scheduleTopologyReconcile")
      .mockImplementation(() => {});
    await service["startTopologyWatcher"]();
    expect(service["topologyMetadataSentinel"]).not.toBeNull();

    // The first external `git worktree add` creates the metadata dir.
    mkdirSync(metadataDir);

    await vi.waitFor(
      () => {
        expect(reconcileSpy).toHaveBeenCalled();
        expect(parcelSubscriptions).toHaveLength(1);
      },
      { timeout: 5000, interval: 25 }
    );
    expect(parcelSubscriptions[0]!.dir).toBe(metadataDir);
    expect(service["topologyMetadataSentinel"]).toBeNull();
  });

  it("subscribes directly (no sentinel) when the dir already exists", async () => {
    mkdirSync(metadataDir);

    await service["startTopologyWatcher"]();
    await vi.waitFor(() => {
      expect(service["topologyWatcherSubscription"].value).toBeDefined();
    });

    expect(service["topologyMetadataSentinel"]).toBeNull();
    expect(parcelSubscriptions).toHaveLength(1);
  });

  it("stopTopologyWatcher disarms a live sentinel", async () => {
    await service["startTopologyWatcher"]();
    expect(service["topologyMetadataSentinel"]).not.toBeNull();

    service["stopTopologyWatcher"]();

    expect(service["topologyMetadataSentinel"]).toBeNull();
  });

  it("ensureTopologyWatcherAlive drops a dead subscription once the dir vanished and re-arms the sentinel", async () => {
    mkdirSync(metadataDir);
    await service["startTopologyWatcher"]();
    await vi.waitFor(() => {
      expect(service["topologyWatcherSubscription"].value).toBeDefined();
    });

    // Last linked worktree removed → watch root gone; the parcel
    // subscription goes silent without erroring.
    rmSync(metadataDir, { recursive: true });

    await service["ensureTopologyWatcherAlive"]();

    expect(service["topologyWatcherSubscription"].value).toBeUndefined();
    expect(service["topologyMetadataSentinel"]).not.toBeNull();
  });

  it("ensureTopologyWatcherAlive keeps a healthy subscription untouched", async () => {
    mkdirSync(metadataDir);
    await service["startTopologyWatcher"]();
    await vi.waitFor(() => {
      expect(service["topologyWatcherSubscription"].value).toBeDefined();
    });
    const before = service["topologyWatcherSubscription"].value;

    await service["ensureTopologyWatcherAlive"]();

    expect(service["topologyWatcherSubscription"].value).toBe(before);
    expect(parcelSubscriptions).toHaveLength(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, normalize } from "path";

const { metadataWatchCallbacks } = vi.hoisted(() => ({
  metadataWatchCallbacks: [] as Array<
    (eventType: string, filename: string | Buffer | null) => void
  >,
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    watch: vi.fn(
      (
        _filename: unknown,
        _options: unknown,
        listener: (eventType: string, filename: string | Buffer | null) => void
      ) => {
        metadataWatchCallbacks.push(listener);
        return { close: vi.fn(), on: vi.fn() };
      }
    ),
  };
});

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

// getGitCommonDir points the metadata-dir resolution at the temp repo.
let commonDir: string;
vi.mock("../../utils/gitUtils.js", () => ({
  getGitCommonDir: vi.fn(() => Promise.resolve(commonDir)),
}));

import { TopologyWatcher, type TopologyWatcherHost } from "../TopologyWatcher.js";

interface MutableHost {
  pollingEnabled: boolean;
  projectRootPath: string | null;
  activeWorktreeId: string | null;
  monitors: Map<string, unknown>;
  discoverAndSyncWorktrees: ReturnType<typeof vi.fn>;
  setActiveWorktree: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
}

function makeHost(overrides: Partial<MutableHost> = {}): MutableHost {
  return {
    pollingEnabled: true,
    projectRootPath: null,
    activeWorktreeId: null,
    monitors: new Map(),
    discoverAndSyncWorktrees: vi.fn().mockResolvedValue(undefined),
    setActiveWorktree: vi.fn(),
    sendEvent: vi.fn(),
    ...overrides,
  };
}

describe("TopologyWatcher metadata sentinel", () => {
  let host: MutableHost;
  let watcher: TopologyWatcher;
  let tempRoot: string;
  let metadataDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    metadataWatchCallbacks.length = 0;
    parcelSubscriptions.length = 0;
    tempRoot = mkdtempSync(join(tmpdir(), "daintree-topo-sentinel-"));
    commonDir = join(tempRoot, ".git");
    mkdirSync(commonDir, { recursive: true });
    metadataDir = join(commonDir, "worktrees");

    host = makeHost({ projectRootPath: tempRoot });
    watcher = new TopologyWatcher(host as unknown as TopologyWatcherHost);
  });

  afterEach(() => {
    watcher.stop();
    rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("arms the sentinel instead of subscribing when .git/worktrees is absent", async () => {
    await watcher.startWatcher();

    expect((watcher as any).metadataSentinel).not.toBeNull();
    expect((watcher as any).subscription.value).toBeUndefined();
    expect(parcelSubscriptions).toHaveLength(0);
  });

  it("hands off to the real watcher and schedules a reconcile when the dir appears", async () => {
    const reconcileSpy = vi.spyOn(watcher, "scheduleReconcile").mockImplementation(() => {});
    await watcher.startWatcher();
    expect((watcher as any).metadataSentinel).not.toBeNull();

    // The first external `git worktree add` creates the metadata dir.
    mkdirSync(metadataDir);
    metadataWatchCallbacks[0]!("rename", "worktrees");

    await vi.waitFor(() => {
      expect(reconcileSpy).toHaveBeenCalled();
      expect(parcelSubscriptions).toHaveLength(1);
    });
    expect(normalize(parcelSubscriptions[0]!.dir)).toBe(normalize(metadataDir));
    expect((watcher as any).metadataSentinel).toBeNull();
  });

  it("subscribes directly (no sentinel) when the dir already exists", async () => {
    mkdirSync(metadataDir);

    await watcher.startWatcher();
    await vi.waitFor(() => {
      expect((watcher as any).subscription.value).toBeDefined();
    });

    expect((watcher as any).metadataSentinel).toBeNull();
    expect(parcelSubscriptions).toHaveLength(1);
  });

  it("stop disarms a live sentinel", async () => {
    await watcher.startWatcher();
    expect((watcher as any).metadataSentinel).not.toBeNull();

    watcher.stop();

    expect((watcher as any).metadataSentinel).toBeNull();
  });

  it("ensureAlive drops a dead subscription once the dir vanished and re-arms the sentinel", async () => {
    mkdirSync(metadataDir);
    await watcher.startWatcher();
    await vi.waitFor(() => {
      expect((watcher as any).subscription.value).toBeDefined();
    });

    // Last linked worktree removed → watch root gone; the parcel
    // subscription goes silent without erroring.
    rmSync(metadataDir, { recursive: true });

    await (watcher as any).ensureAlive();

    expect((watcher as any).subscription.value).toBeUndefined();
    expect((watcher as any).metadataSentinel).not.toBeNull();
  });

  it("arms nothing while polling is paused (backgrounded app)", async () => {
    mkdirSync(metadataDir);
    host.pollingEnabled = false;

    await watcher.startWatcher();
    expect((watcher as any).subscription.value).toBeUndefined();
    expect((watcher as any).metadataSentinel).toBeNull();
    expect(parcelSubscriptions).toHaveLength(0);

    // The sentinel path is equally gated: absent dir + paused → no sentinel.
    rmSync(metadataDir, { recursive: true });
    await watcher.startWatcher();
    expect((watcher as any).metadataSentinel).toBeNull();

    await (watcher as any).ensureAlive();
    expect((watcher as any).subscription.value).toBeUndefined();
    expect((watcher as any).metadataSentinel).toBeNull();
  });

  it("ensureAlive keeps a healthy subscription untouched", async () => {
    mkdirSync(metadataDir);
    await watcher.startWatcher();
    await vi.waitFor(() => {
      expect((watcher as any).subscription.value).toBeDefined();
    });
    const before = (watcher as any).subscription.value;

    await (watcher as any).ensureAlive();

    expect((watcher as any).subscription.value).toBe(before);
    expect(parcelSubscriptions).toHaveLength(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fstatSync, mkdtempSync, mkdirSync, rmSync, statSync } from "fs";
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

vi.mock("../../utils/parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: vi.fn((dir: string) => {
    const entry = { dir, unsubscribed: false };
    parcelSubscriptions.push(entry);
    return Promise.resolve({
      unsubscribe: () => {
        entry.unsubscribed = true;
        return Promise.resolve();
      },
    });
  }),
}));

// getGitCommonDir points the metadata-dir resolution at the temp repo.
let commonDir: string;
vi.mock("../../utils/gitUtils.js", () => ({
  getGitCommonDir: vi.fn(() => Promise.resolve(commonDir)),
}));

import { subscribeParcelWatcher } from "../../utils/parcelWatcherBackend.js";
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

  it("starts the real watcher and keeps the parent sentinel when the dir appears", async () => {
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
    expect((watcher as any).metadataSentinel).not.toBeNull();
  });

  it("subscribes and keeps the parent sentinel when the dir already exists", async () => {
    mkdirSync(metadataDir);

    await watcher.startWatcher();
    await vi.waitFor(() => {
      expect((watcher as any).subscription.value).toBeDefined();
    });

    expect((watcher as any).metadataSentinel).not.toBeNull();
    expect(parcelSubscriptions).toHaveLength(1);
  });

  it("replaces a subscription when the metadata root is recreated", async () => {
    mkdirSync(metadataDir);
    await watcher.startWatcher();
    await vi.waitFor(() => expect(parcelSubscriptions).toHaveLength(1));

    rmSync(metadataDir, { recursive: true });
    mkdirSync(metadataDir);
    metadataWatchCallbacks[0]!("rename", "worktrees");

    await vi.waitFor(() => expect(parcelSubscriptions).toHaveLength(2));
    expect(parcelSubscriptions[0]!.unsubscribed).toBe(true);
    expect((watcher as any).metadataSentinel).not.toBeNull();
  });

  describe("on Linux", () => {
    const platform = process.platform;
    const pinnedFd = () => (watcher as any).metadataRootFd as number | null;
    const identityOf = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`;

    // A subscribe that stays pending until the test settles it.
    function deferSubscribe() {
      const settle = {} as { resolve: () => void; reject: (err: Error) => void };
      vi.mocked(subscribeParcelWatcher).mockImplementationOnce((dir: string) => {
        const entry = { dir, unsubscribed: false };
        parcelSubscriptions.push(entry);
        return new Promise((resolve, reject) => {
          settle.resolve = () =>
            resolve({
              unsubscribe: () => {
                entry.unsubscribed = true;
                return Promise.resolve();
              },
            } as never);
          settle.reject = reject;
        });
      });
      return settle;
    }

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    });

    it("holds the subscribed root open so a recreated root can't reuse its inode", async () => {
      mkdirSync(metadataDir);
      await watcher.startWatcher();
      await vi.waitFor(() => expect((watcher as any).subscription.value).toBeDefined());
      const first = fstatSync(pinnedFd()!);

      rmSync(metadataDir, { recursive: true });
      mkdirSync(metadataDir);
      const recreated = statSync(metadataDir);
      expect(identityOf(recreated)).not.toBe(identityOf(first));
      metadataWatchCallbacks[0]!("rename", "worktrees");

      await vi.waitFor(() => expect(parcelSubscriptions).toHaveLength(2));
      await vi.waitFor(() => expect((watcher as any).subscription.value).toBeDefined());
      expect(identityOf(fstatSync(pinnedFd()!))).toBe(identityOf(recreated));

      const finalFd = pinnedFd()!;
      watcher.stop();
      expect(pinnedFd()).toBeNull();
      await vi.waitFor(() =>
        expect(() => fstatSync(finalFd)).toThrow(expect.objectContaining({ code: "EBADF" }))
      );
    });

    it("holds the pin until the subscription's teardown settles", async () => {
      let finishTeardown!: () => void;
      vi.mocked(subscribeParcelWatcher).mockImplementationOnce((dir: string) => {
        const entry = { dir, unsubscribed: false };
        parcelSubscriptions.push(entry);
        return Promise.resolve({
          unsubscribe: () => {
            entry.unsubscribed = true;
            return new Promise<void>((resolve) => {
              finishTeardown = resolve;
            });
          },
        } as never);
      });
      mkdirSync(metadataDir);
      await watcher.startWatcher();
      await vi.waitFor(() => expect((watcher as any).subscription.value).toBeDefined());
      const heldFd = pinnedFd()!;

      rmSync(metadataDir, { recursive: true });
      metadataWatchCallbacks[0]!("rename", "worktrees");
      expect(parcelSubscriptions[0]!.unsubscribed).toBe(true);
      expect(pinnedFd()).toBeNull();

      // Parcel removes its inotify watch inside that teardown; freeing the inode
      // first would make the kernel drop the watch and parcel's removal fail.
      await new Promise((resolve) => setImmediate(resolve));
      expect(() => fstatSync(heldFd)).not.toThrow();

      finishTeardown();
      await vi.waitFor(() =>
        expect(() => fstatSync(heldFd)).toThrow(expect.objectContaining({ code: "EBADF" }))
      );
    });

    it("holds a pending subscribe's pin until it lands and is torn down", async () => {
      let landSubscribe!: () => void;
      let finishTeardown!: () => void;
      vi.mocked(subscribeParcelWatcher).mockImplementationOnce((dir: string) => {
        const entry = { dir, unsubscribed: false };
        parcelSubscriptions.push(entry);
        return new Promise((resolve) => {
          landSubscribe = () =>
            resolve({
              unsubscribe: () => {
                entry.unsubscribed = true;
                return new Promise<void>((done) => {
                  finishTeardown = done;
                });
              },
            } as never);
        });
      });
      mkdirSync(metadataDir);
      await watcher.startWatcher();
      const heldFd = pinnedFd()!;
      const flush = () => new Promise((resolve) => setImmediate(resolve));

      try {
        rmSync(metadataDir, { recursive: true });
        metadataWatchCallbacks[0]!("rename", "worktrees");
        expect(pinnedFd()).toBeNull();
        await flush();
        expect(() => fstatSync(heldFd)).not.toThrow();

        landSubscribe();
        await vi.waitFor(() => expect(parcelSubscriptions[0]!.unsubscribed).toBe(true));
        await flush();
        expect(() => fstatSync(heldFd)).not.toThrow();
      } finally {
        finishTeardown?.();
      }

      await vi.waitFor(() =>
        expect(() => fstatSync(heldFd)).toThrow(expect.objectContaining({ code: "EBADF" }))
      );
    });

    it("keeps the pin when an unchanged-root notice lands while the subscribe is pending", async () => {
      mkdirSync(metadataDir);
      const pending = deferSubscribe();
      await watcher.startWatcher();
      expect(parcelSubscriptions).toHaveLength(1);

      metadataWatchCallbacks[0]!("rename", "worktrees");
      pending.resolve();

      await vi.waitFor(() => expect((watcher as any).subscription.value).toBeDefined());
      await vi.waitFor(() =>
        expect(parcelSubscriptions.filter((s) => !s.unsubscribed)).toHaveLength(1)
      );
      expect(identityOf(fstatSync(pinnedFd()!))).toBe(identityOf(statSync(metadataDir)));
    });

    it("discards a pending subscribe when its root is removed", async () => {
      mkdirSync(metadataDir);
      const pending = deferSubscribe();
      await watcher.startWatcher();
      const heldFd = pinnedFd()!;

      rmSync(metadataDir, { recursive: true });
      metadataWatchCallbacks[0]!("rename", "worktrees");
      pending.resolve();

      await vi.waitFor(() => expect(parcelSubscriptions[0]!.unsubscribed).toBe(true));
      expect((watcher as any).subscription.value).toBeUndefined();
      expect(pinnedFd()).toBeNull();
      await vi.waitFor(() =>
        expect(() => fstatSync(heldFd)).toThrow(expect.objectContaining({ code: "EBADF" }))
      );
    });

    it("releases the pin when the subscribe is rejected", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mkdirSync(metadataDir);
      const pending = deferSubscribe();
      await watcher.startWatcher();
      const heldFd = pinnedFd()!;
      expect(heldFd).toEqual(expect.any(Number));

      pending.reject(new Error("inotify watch limit reached"));

      await vi.waitFor(() => expect(pinnedFd()).toBeNull());
      await vi.waitFor(() =>
        expect(() => fstatSync(heldFd)).toThrow(expect.objectContaining({ code: "EBADF" }))
      );
    });
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

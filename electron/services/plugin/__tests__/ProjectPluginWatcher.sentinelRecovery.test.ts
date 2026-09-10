import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp, watch } from "fs";
import os from "os";
import path from "path";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    // No notifications: recovery must observe the filesystem itself.
    watch: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })),
  };
});

vi.mock("../../../utils/parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: vi.fn(async () => ({ unsubscribe: vi.fn(async () => {}) })),
}));

import { subscribeParcelWatcher } from "../../../utils/parcelWatcherBackend.js";
import { ProjectPluginWatcher } from "../ProjectPluginWatcher.js";
import { discoverProjectPlugins } from "../projectPluginDiscovery.js";

describe("ProjectPluginWatcher sentinel recovery", () => {
  let root: string;
  let watcher: ProjectPluginWatcher;
  let reload: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "dt-ppw-recovery-"));
    reload = vi.fn(async () => {});
    watcher = new ProjectPluginWatcher({
      discover: discoverProjectPlugins,
      loadedManifestIds: () => [],
      reload,
      viewGenerationsAllocated: () => 0,
      resolveGitDir: async () => null,
      timings: { debounceMs: 1 },
    });
  });

  afterEach(async () => {
    watcher.dispose();
    vi.useRealTimers();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("follows ancestors and reconciles an appearing folder without native events", async () => {
    await watcher.ensure("project", root);
    const daintreeDir = path.join(root, ".daintree");
    await fsp.mkdir(daintreeDir);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(watch).mock.calls.some(([dir]) => dir === daintreeDir)).toBe(true);

    const pluginsRoot = path.join(daintreeDir, "plugins");
    await fsp.mkdir(pluginsRoot);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(watcher.isWatching("project")).toBe(true));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith("project", root, []));
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers when the native sentinel cannot be opened", async () => {
    vi.mocked(watch).mockImplementationOnce(() => {
      throw new Error("watch unavailable");
    });
    await watcher.ensure("project", root);
    await fsp.mkdir(path.join(root, ".daintree", "plugins"), { recursive: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(watcher.isWatching("project")).toBe(true));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stop", "dispose"] as const)(
    "%s cancels recovery before the folder appears",
    async (method) => {
      await watcher.ensure("project", root);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      if (method === "stop") watcher.stop("project");
      else watcher.dispose();
      await fsp.mkdir(path.join(root, ".daintree", "plugins"), { recursive: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(subscribeParcelWatcher).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});

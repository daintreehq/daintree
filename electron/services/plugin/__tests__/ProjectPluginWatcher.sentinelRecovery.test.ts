import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsModule from "fs";
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
    // A live native sentinel leaves only the slow backstop poll running.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(watch).mock.calls.some(([dir]) => dir === daintreeDir)).toBe(true);

    const pluginsRoot = path.join(daintreeDir, "plugins");
    await fsp.mkdir(pluginsRoot);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(watcher.isWatching("project")).toBe(true));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith("project", root, []));
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls on the fast cadence only when the native sentinel is unavailable", async () => {
    const statSpy = vi.spyOn(fsModule, "existsSync");
    try {
      await watcher.ensure("project", root);
      statSpy.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      const watched = statSpy.mock.calls.length;
      watcher.stop("project");

      const available = vi.mocked(watch).getMockImplementation()!;
      vi.mocked(watch).mockImplementation(() => {
        throw new Error("watch unavailable");
      });
      try {
        await watcher.ensure("project", root);
        statSpy.mockClear();
        await vi.advanceTimersByTimeAsync(60_000);
      } finally {
        vi.mocked(watch).mockImplementation(available);
      }
      const unwatched = statSpy.mock.calls.length;

      expect(watched).toBeGreaterThan(0);
      expect(watched * 3).toBeLessThan(unwatched);
    } finally {
      statSpy.mockRestore();
    }
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

  describe("native sentinel events", () => {
    type SentinelListener = (event: string, filename: unknown) => void;

    function sentinelListener(dir: string): SentinelListener {
      const calls = vi.mocked(watch).mock.calls.filter(([watched]) => watched === dir);
      const call = calls[calls.length - 1];
      if (!call) throw new Error(`no sentinel was opened on ${dir}`);
      return call[2] as unknown as SentinelListener;
    }

    function watchCount(dir: string): number {
      return vi.mocked(watch).mock.calls.filter(([watched]) => watched === dir).length;
    }

    it("skips the existence checks for root entries that cannot become .daintree", async () => {
      await watcher.ensure("project", root);
      const onRootEvent = sentinelListener(root);
      const statSpy = vi.spyOn(fsModule, "existsSync");
      try {
        for (const name of ["package-lock.json", ".DS_Store", "dist", ".daintree.tmp", "plugins"]) {
          onRootEvent("change", name);
          onRootEvent("rename", name);
        }
        expect(statSpy).not.toHaveBeenCalled();
      } finally {
        statSpy.mockRestore();
      }
    });

    it.each([".daintree", ".DAINTREE", null, undefined, "", Buffer.from("README.md")])(
      "moves inward when a %j root event lands after .daintree appears",
      async (filename) => {
        await watcher.ensure("project", root);
        const onRootEvent = sentinelListener(root);
        const daintreeDir = path.join(root, ".daintree");
        await fsp.mkdir(daintreeDir);

        onRootEvent("rename", filename);
        expect(watchCount(daintreeDir)).toBe(1);
      }
    );

    it("skips .daintree entries other than plugins and arms on plugins", async () => {
      const daintreeDir = path.join(root, ".daintree");
      await fsp.mkdir(daintreeDir);
      await watcher.ensure("project", root);
      const onDaintreeEvent = sentinelListener(daintreeDir);
      const statSpy = vi.spyOn(fsModule, "existsSync");
      try {
        for (const name of ["recipes", "settings.json", "plugins.bak"]) {
          onDaintreeEvent("rename", name);
        }
        expect(statSpy).not.toHaveBeenCalled();
      } finally {
        statSpy.mockRestore();
      }

      await fsp.mkdir(path.join(daintreeDir, "plugins"));
      onDaintreeEvent("rename", "plugins");
      await vi.waitFor(() => expect(watcher.isWatching("project")).toBe(true));
      await vi.waitFor(() => expect(reload).toHaveBeenCalledWith("project", root, []));
    });

    // A watched directory's own deletion is named after the directory itself,
    // not after any entry inside it: its basename on inotify, its full path on
    // Windows.
    it.each(["basename", "full path"] as const)(
      "moves back out to the project root when .daintree reports its own removal by %s",
      async (form) => {
        const daintreeDir = path.join(root, ".daintree");
        await fsp.mkdir(daintreeDir);
        await watcher.ensure("project", root);
        const onDaintreeEvent = sentinelListener(daintreeDir);
        expect(watchCount(root)).toBe(0);

        await fsp.rm(daintreeDir, { recursive: true });
        onDaintreeEvent("rename", form === "basename" ? ".daintree" : daintreeDir);
        expect(watchCount(root)).toBe(1);
      }
    );
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

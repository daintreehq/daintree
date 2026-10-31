import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Only `kill()` and `catch()` are exercised, so the fake stops there. It's
// declared through `vi.hoisted` and referenced directly rather than through
// `vi.mocked()` on the real export, so its type stays the fake's own shape:
// routing it via the export's `ResultPromise` signature would force an unsafe
// assertion on every `mockImplementationOnce`.
const { spawnViteWatchMock } = vi.hoisted(() => ({
  // Synchronous like the real helper: returns a live child handle, not a Promise.
  spawnViteWatchMock: vi.fn((_dir: string, _args?: string[]) => ({
    kill: vi.fn(),
    catch: vi.fn(),
  })),
}));

vi.mock("../lib/viteBuild.js", async (importOriginal) => {
  // `resolveVitePlan` stays real: it's pure filesystem inspection, and it's
  // what decides how many watchers spawn, so stubbing it would hide the
  // behavior these tests exist to pin. `runVitePlanBuild` must be mocked
  // rather than spread through from the original — it calls `runViteBuild`
  // via its own module-local binding, which no mock of the export can
  // intercept, so a real one would shell out to a Vite that isn't installed
  // in the fixture. What the plan *contains* is covered in viteBuild.test.ts;
  // here we assert dev.ts hands the resolved plan to the builder.
  const actual = await importOriginal<typeof import("../lib/viteBuild.js")>();
  return {
    ...actual,
    runVitePlanBuild: vi.fn(async () => {}),
    spawnViteWatch: spawnViteWatchMock,
  };
});
vi.mock("../ipc/client.js", () => ({
  sendCliRequest: vi.fn(async () => ({ status: "ok" })),
  DaintreeUnavailableError: class extends Error {},
}));
vi.mock("../commands/validate.js", () => ({
  runValidate: vi.fn(async () => ({ ok: true, errors: [], warnings: [] })),
}));

import { linkDevPlugin, cleanupDevLink, runDev, type DevLink } from "../commands/dev.js";
import { runVitePlanBuild } from "../lib/viteBuild.js";
import { sendCliRequest } from "../ipc/client.js";

let tmpDir: string;
let pluginDir: string;
let pluginsRoot: string;

beforeEach(async () => {
  // resetAllMocks, not clearAllMocks: clearing wipes recorded calls but leaves
  // queued `mockImplementationOnce` entries behind, so a test that ends without
  // consuming its queue poisons the next one. Every mock here is a
  // `vi.fn(impl)`, which reset restores to that original implementation.
  vi.resetAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-dev-test-"));
  pluginDir = path.join(tmpDir, "my-plugin");
  pluginsRoot = path.join(tmpDir, "plugins-root");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "acme.demo", main: "dist/index.js" })
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function lstatSafe(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

describe("linkDevPlugin", () => {
  it("creates a symlink to the plugin dir and writes the marker through it", async () => {
    const link = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    expect(link.createdSymlink).toBe(true);

    const stat = await fs.lstat(link.linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(link.linkPath), await fs.readlink(link.linkPath))).toBe(
      path.resolve(pluginDir)
    );
    // Marker is visible through the symlink, i.e. inside the real plugin dir.
    await expect(fs.access(path.join(pluginDir, ".dev-marker"))).resolves.toBeUndefined();
  });

  it("reuses an existing symlink that already points at the plugin dir", async () => {
    await fs.mkdir(pluginsRoot, { recursive: true });
    await fs.symlink(pluginDir, path.join(pluginsRoot, "acme.demo"));
    const link = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    expect(link.createdSymlink).toBe(false);
  });

  it("reuses a link that reaches the plugin dir under another spelling", async () => {
    const alias = path.join(tmpDir, "alias");
    await fs.symlink(pluginDir, alias);
    await fs.mkdir(pluginsRoot, { recursive: true });
    await fs.symlink(alias, path.join(pluginsRoot, "acme.demo"));

    const link = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });

    expect(link.createdSymlink).toBe(false);
    expect(await fs.readlink(link.linkPath)).toBe(alias);
  });

  it("creates no link when it can't write the marker", async () => {
    // A directory where the marker belongs makes the write fail.
    await fs.mkdir(path.join(pluginDir, ".dev-marker"));
    await expect(
      linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" })
    ).rejects.toThrow();
    expect(await lstatSafe(path.join(pluginsRoot, "acme.demo"))).toBeNull();
  });

  it("stamps the marker with this session, distinct per session", async () => {
    const first = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    await cleanupDevLink(first);
    const second = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });

    expect(second.sessionId).not.toBe(first.sessionId);
    const marker = JSON.parse(await fs.readFile(path.join(pluginDir, ".dev-marker"), "utf8"));
    expect(marker).toEqual({ sessionId: second.sessionId, pid: process.pid });
  });

  it("refuses a second session in the same directory while the first is alive", async () => {
    const first = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });

    await expect(linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" })).rejects.toThrow(
      /already running/
    );

    const marker = JSON.parse(await fs.readFile(first.markerPath, "utf8"));
    expect(marker.sessionId).toBe(first.sessionId);
  });

  it("replaces a marker left by a session whose process has exited", async () => {
    await fs.writeFile(
      path.join(pluginDir, ".dev-marker"),
      JSON.stringify({ sessionId: "crashed", pid: 4242 })
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    try {
      const link = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
      expect(kill).toHaveBeenCalledWith(4242, 0);
      const marker = JSON.parse(await fs.readFile(link.markerPath, "utf8"));
      expect(marker.sessionId).toBe(link.sessionId);
    } finally {
      kill.mockRestore();
    }
  });

  it("treats a process it may not signal as a live session", async () => {
    await fs.writeFile(
      path.join(pluginDir, ".dev-marker"),
      JSON.stringify({ sessionId: "other-user", pid: 4242 })
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    try {
      await expect(
        linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" })
      ).rejects.toThrow(/already running/);
    } finally {
      kill.mockRestore();
    }
  });

  it("replaces the empty marker an older CLI leaves behind", async () => {
    await fs.writeFile(path.join(pluginDir, ".dev-marker"), "");
    const link = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    const marker = JSON.parse(await fs.readFile(link.markerPath, "utf8"));
    expect(marker.sessionId).toBe(link.sessionId);
  });

  it("writes the marker into the plugin dir even when the link is retargeted", async () => {
    const otherDir = path.join(tmpDir, "other-worktree");
    await fs.mkdir(otherDir, { recursive: true });
    const older = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    const newer = await linkDevPlugin({ pluginDir: otherDir, pluginsRoot, pluginId: "acme.demo" });

    expect(older.markerPath).toBe(path.join(pluginDir, ".dev-marker"));
    expect(newer.markerPath).toBe(path.join(otherDir, ".dev-marker"));
    // Each directory keeps its own session's marker; the takeover rewrote neither.
    const olderMarker = JSON.parse(await fs.readFile(older.markerPath, "utf8"));
    const newerMarker = JSON.parse(await fs.readFile(newer.markerPath, "utf8"));
    expect(olderMarker.sessionId).toBe(older.sessionId);
    expect(newerMarker.sessionId).toBe(newer.sessionId);
  });

  it("replaces a symlink pointing somewhere else", async () => {
    const other = path.join(tmpDir, "other");
    await fs.mkdir(other, { recursive: true });
    await fs.mkdir(pluginsRoot, { recursive: true });
    await fs.symlink(other, path.join(pluginsRoot, "acme.demo"));

    const link = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    expect(link.createdSymlink).toBe(true);
    expect(path.resolve(path.dirname(link.linkPath), await fs.readlink(link.linkPath))).toBe(
      path.resolve(pluginDir)
    );
  });

  it("refuses to clobber a real directory at the link path", async () => {
    await fs.mkdir(path.join(pluginsRoot, "acme.demo"), { recursive: true });
    await expect(linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" })).rejects.toThrow(
      /isn't a symlink/
    );
    // The marker it stamped first comes back off, so nothing reroutes a later load.
    expect(await lstatSafe(path.join(pluginDir, ".dev-marker"))).toBeNull();
  });
});

describe("cleanupDevLink", () => {
  it("removes the marker and the symlink it created, leaving the source intact", async () => {
    const link = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    await cleanupDevLink(link);

    expect(await lstatSafe(link.linkPath)).toBeNull();
    expect(await lstatSafe(path.join(pluginDir, ".dev-marker"))).toBeNull();
    // The source dir and its manifest survive — unlink removes the link, not the target.
    await expect(fs.access(path.join(pluginDir, "plugin.json"))).resolves.toBeUndefined();
  });

  it("is idempotent — a second cleanup does not throw", async () => {
    const link = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    await cleanupDevLink(link);
    await expect(cleanupDevLink(link)).resolves.toBeUndefined();
  });

  it("leaves a link retargeted by a newer session, and its marker, alone", async () => {
    const otherDir = path.join(tmpDir, "other-worktree");
    await fs.mkdir(otherDir, { recursive: true });
    const older = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    const newer = await linkDevPlugin({ pluginDir: otherDir, pluginsRoot, pluginId: "acme.demo" });

    await cleanupDevLink(older);

    expect(path.resolve(pluginsRoot, await fs.readlink(newer.linkPath))).toBe(otherDir);
    await expect(fs.access(path.join(otherDir, ".dev-marker"))).resolves.toBeUndefined();
    // The older session cleans up the marker in its own directory instead.
    expect(await lstatSafe(path.join(pluginDir, ".dev-marker"))).toBeNull();
  });

  it("leaves a reused (not created) symlink in place", async () => {
    await fs.mkdir(pluginsRoot, { recursive: true });
    await fs.symlink(pluginDir, path.join(pluginsRoot, "acme.demo"));
    const reused = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    await cleanupDevLink(reused);
    // Symlink stays (we didn't create it this round); marker is removed.
    expect(await lstatSafe(reused.linkPath)).not.toBeNull();
    expect(await lstatSafe(reused.markerPath)).toBeNull();
  });

  it("releases the marker only after the link is gone", async () => {
    const link = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    const unlink = vi.spyOn(fs, "unlink");
    try {
      await cleanupDevLink(link);
      // The marker reserves the directory: dropped first, a session starting
      // here could reuse the link and then have it removed under it.
      expect(unlink.mock.calls.map((c) => c[0])).toEqual([link.linkPath, link.markerPath]);
    } finally {
      unlink.mockRestore();
    }
  });

  it("never removes a real directory that replaced its link", async () => {
    const link = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    await fs.unlink(link.linkPath);
    await fs.mkdir(link.linkPath);
    const unlink = vi.spyOn(fs, "unlink");
    try {
      await cleanupDevLink(link);
      expect(unlink).not.toHaveBeenCalledWith(link.linkPath);
    } finally {
      unlink.mockRestore();
    }
    expect((await fs.lstat(link.linkPath)).isDirectory()).toBe(true);
  });

  it("leaves a marker another session stamped since", async () => {
    const link: DevLink = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    const foreign = JSON.stringify({ sessionId: "someone-else", pid: process.pid });
    await fs.writeFile(link.markerPath, foreign);
    await cleanupDevLink(link);
    expect(await fs.readFile(link.markerPath, "utf8")).toBe(foreign);
  });
});

describe("runDev", () => {
  it("builds, links, starts, watches, then tears down on stop", async () => {
    const controller = new AbortController();
    controller.abort(); // resolve the keep-alive immediately

    await runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal });

    expect(runVitePlanBuild).toHaveBeenCalledWith(
      pluginDir,
      expect.objectContaining({ dualConfig: false })
    );
    expect(spawnViteWatchMock).toHaveBeenCalledWith(pluginDir, ["build", "--watch"]);
    const calls = vi.mocked(sendCliRequest).mock.calls.map((c) => c[0]);
    expect(calls).toContain("plugin.dev.start");
    expect(calls).toContain("plugin.dev.stop");

    // dist/<main> must exist before Daintree loads the plugin, or the marker is
    // in place with no bundle for the dev worker to import.
    expect(vi.mocked(runVitePlanBuild).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendCliRequest).mock.invocationCallOrder[0]
    );

    const watch = await spawnViteWatchMock.mock.results[0].value;
    expect(watch.kill).toHaveBeenCalled();
    // The dev artifacts are gone after teardown.
    expect(await lstatSafe(path.join(pluginsRoot, "acme.demo"))).toBeNull();
  });

  it("sends plugin.dev.start before plugin.dev.stop, both for this session", async () => {
    const atStart: { marker: { sessionId?: string } | null } = { marker: null };
    vi.mocked(sendCliRequest).mockImplementation(async (method) => {
      if (method === "plugin.dev.start") {
        atStart.marker = JSON.parse(await fs.readFile(path.join(pluginDir, ".dev-marker"), "utf8"));
      }
      return { status: "ok" };
    });
    const controller = new AbortController();
    controller.abort();
    await runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal });

    // The session Daintree is told about is the one the marker it loads names.
    const sessionId = atStart.marker?.sessionId;
    expect(sessionId).toEqual(expect.any(String));
    const calls = vi.mocked(sendCliRequest).mock.calls;
    expect(calls[0]).toEqual(["plugin.dev.start", { pluginId: "acme.demo", sessionId }]);
    expect(calls[calls.length - 1]).toEqual([
      "plugin.dev.stop",
      { pluginId: "acme.demo", sessionId },
    ]);
  });

  it("still unloads and unlinks when the plugin dir moved away mid-session", async () => {
    const controller = new AbortController();
    const done = runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal });
    await vi.waitFor(() => expect(spawnViteWatchMock).toHaveBeenCalled());

    await fs.rename(pluginDir, path.join(tmpDir, "moved"));
    controller.abort();
    await done;

    expect(vi.mocked(sendCliRequest).mock.calls.map((c) => c[0])).toContain("plugin.dev.stop");
    expect(await lstatSafe(path.join(pluginsRoot, "acme.demo"))).toBeNull();
  });

  it("never asks for metrics with metrics disabled, and stops polling before unloading", async () => {
    for (const metrics of [false, undefined]) {
      vi.mocked(sendCliRequest).mockClear();
      const controller = new AbortController();
      controller.abort();
      await runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal, metrics });
      const methods = vi.mocked(sendCliRequest).mock.calls.map((c) => c[0]);
      expect(methods).not.toContain("plugin.dev.metrics");
      expect(methods[methods.length - 1]).toBe("plugin.dev.stop");
    }
  });

  it("unloads and cleans up when the build watcher fails to start", async () => {
    spawnViteWatchMock.mockImplementationOnce(() => {
      throw new Error("Couldn't find Vite");
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal })
    ).rejects.toThrow(/Vite/);

    // The plugin was already started in Daintree, so it must be stopped, and the
    // symlink/marker removed — no dangling dev state.
    expect(vi.mocked(sendCliRequest).mock.calls.map((c) => c[0])).toContain("plugin.dev.stop");
    expect(await lstatSafe(path.join(pluginsRoot, "acme.demo"))).toBeNull();
  });

  it("skips the initial build with skipBuild but still links and starts", async () => {
    const controller = new AbortController();
    controller.abort();
    await runDev({
      dir: pluginDir,
      pluginsRoot,
      skipBuild: true,
      keepAliveSignal: controller.signal,
    });
    expect(runVitePlanBuild).not.toHaveBeenCalled();
    expect(vi.mocked(sendCliRequest).mock.calls.map((c) => c[0])).toContain("plugin.dev.start");
  });

  it("cleans up the link and does not start the watcher when Daintree is unreachable", async () => {
    vi.mocked(sendCliRequest).mockRejectedValueOnce(new Error("Daintree isn't running"));
    const controller = new AbortController();
    controller.abort();

    await expect(
      runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal })
    ).rejects.toThrow(/isn't running/);

    expect(spawnViteWatchMock).not.toHaveBeenCalled();
    expect(await lstatSafe(path.join(pluginsRoot, "acme.demo"))).toBeNull();
  });

  describe("with a server config (dual-target plugin)", () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(pluginDir, "vite.config.server.ts"), "export default {};");
    });

    it("builds both targets before handing the plugin to Daintree", async () => {
      const controller = new AbortController();
      controller.abort();
      await runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal });

      // The server bundle has to exist before plugin.dev.start, or the marker
      // is in place with no worker entry for the host to import.
      const plan = vi.mocked(runVitePlanBuild).mock.calls[0][1];
      expect(plan.dualConfig).toBe(true);
      expect(plan.oneShot).toHaveLength(2);
    });

    it("watches both targets with output-clearing disabled", async () => {
      const controller = new AbortController();
      controller.abort();
      await runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal });

      // Without --no-emptyOutDir each watcher re-empties the shared dist/ on
      // every incremental rebuild, so a browser save deletes the worker bundle.
      const watchArgs = spawnViteWatchMock.mock.calls.map((c) => c[1]);
      expect(watchArgs).toEqual([
        ["build", "--watch", "--no-emptyOutDir"],
        ["build", "--watch", "--config", "vite.config.server.ts", "--no-emptyOutDir"],
      ]);
    });

    it("kills every watcher on teardown", async () => {
      const controller = new AbortController();
      controller.abort();
      await runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal });

      const spawned = spawnViteWatchMock.mock.results.map((r) => r.value);
      expect(spawned).toHaveLength(2);
      for (const watch of spawned) {
        expect(watch.kill).toHaveBeenCalled();
      }
    });

    it("kills the first watcher when the second fails to spawn", async () => {
      const first = { kill: vi.fn(), catch: vi.fn() };
      spawnViteWatchMock
        .mockImplementationOnce(() => first)
        .mockImplementationOnce(() => {
          throw new Error("Couldn't find Vite");
        });
      const controller = new AbortController();
      controller.abort();

      await expect(
        runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal })
      ).rejects.toThrow(/Vite/);

      // A half-started session must not leak a live Vite process.
      expect(first.kill).toHaveBeenCalled();
      expect(vi.mocked(sendCliRequest).mock.calls.map((c) => c[0])).toContain("plugin.dev.stop");
      expect(await lstatSafe(path.join(pluginsRoot, "acme.demo"))).toBeNull();
    });
  });

  describe("overlapping sessions for one plugin id", () => {
    let otherDir: string;

    beforeEach(async () => {
      otherDir = path.join(tmpDir, "other-worktree");
      await fs.mkdir(otherDir, { recursive: true });
      await fs.copyFile(path.join(pluginDir, "plugin.json"), path.join(otherDir, "plugin.json"));
    });

    /** Run a session up to its keep-alive wait; `stop()` ends it and awaits teardown. */
    async function startSession(dir: string): Promise<{ stop: () => Promise<void> }> {
      const controller = new AbortController();
      const spawnedBefore = spawnViteWatchMock.mock.calls.length;
      const done = runDev({ dir, pluginsRoot, keepAliveSignal: controller.signal, metrics: false });
      done.catch(() => {});
      await vi.waitFor(() => expect(spawnViteWatchMock.mock.calls.length).toBe(spawnedBefore + 1));
      return {
        stop: async () => {
          controller.abort();
          await done;
        },
      };
    }

    function methodsSince(index: number): string[] {
      return vi
        .mocked(sendCliRequest)
        .mock.calls.slice(index)
        .map((c) => c[0]);
    }

    it("an older session's exit leaves a newer session from another directory running", async () => {
      const older = await startSession(pluginDir);
      const newer = await startSession(otherDir);
      const callsBeforeOlderStop = vi.mocked(sendCliRequest).mock.calls.length;

      await older.stop();

      const linkPath = path.join(pluginsRoot, "acme.demo");
      expect(path.resolve(pluginsRoot, await fs.readlink(linkPath))).toBe(otherDir);
      await expect(fs.access(path.join(otherDir, ".dev-marker"))).resolves.toBeUndefined();
      expect(await lstatSafe(path.join(pluginDir, ".dev-marker"))).toBeNull();
      // The host session now belongs to the newer directory; nothing may unload it.
      expect(methodsSince(callsBeforeOlderStop)).not.toContain("plugin.dev.stop");

      const callsBeforeNewerStop = vi.mocked(sendCliRequest).mock.calls.length;
      await newer.stop();
      expect(methodsSince(callsBeforeNewerStop)).toContain("plugin.dev.stop");
      expect(await lstatSafe(linkPath)).toBeNull();
      expect(await lstatSafe(path.join(otherDir, ".dev-marker"))).toBeNull();
    });

    it("keeps a link a newer session takes over while the older one waits on Daintree", async () => {
      const older = await startSession(pluginDir);
      let newerLink: DevLink | null = null;
      vi.mocked(sendCliRequest).mockImplementation(async (method) => {
        if (method === "plugin.dev.stop") {
          newerLink = await linkDevPlugin({
            pluginDir: otherDir,
            pluginsRoot,
            pluginId: "acme.demo",
          });
        }
        return { status: "ok" };
      });

      await older.stop();

      expect(newerLink).not.toBeNull();
      const linkPath = path.join(pluginsRoot, "acme.demo");
      expect(path.resolve(pluginsRoot, await fs.readlink(linkPath))).toBe(otherDir);
      await expect(fs.access(path.join(otherDir, ".dev-marker"))).resolves.toBeUndefined();
    });

    it("refuses a second session in the same directory and leaves the first running", async () => {
      const first = await startSession(pluginDir);
      const callsBeforeSecond = vi.mocked(sendCliRequest).mock.calls.length;
      vi.mocked(runVitePlanBuild).mockClear();
      const controller = new AbortController();
      controller.abort();

      await expect(
        runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal, metrics: false })
      ).rejects.toThrow(/already running/);

      // Refused before building, which would rewrite dist/ under the first.
      expect(runVitePlanBuild).not.toHaveBeenCalled();
      expect(methodsSince(callsBeforeSecond)).toEqual([]);
      const linkPath = path.join(pluginsRoot, "acme.demo");
      expect(path.resolve(pluginsRoot, await fs.readlink(linkPath))).toBe(pluginDir);
      await expect(fs.access(path.join(pluginDir, ".dev-marker"))).resolves.toBeUndefined();

      await first.stop();
      expect(methodsSince(callsBeforeSecond)).toContain("plugin.dev.stop");
      expect(await lstatSafe(linkPath)).toBeNull();
      expect(await lstatSafe(path.join(pluginDir, ".dev-marker"))).toBeNull();
    });
  });

  it("rejects a plugin with no main entry", async () => {
    await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({ name: "acme.demo" }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal })
    ).rejects.toThrow(/main/);
  });
});

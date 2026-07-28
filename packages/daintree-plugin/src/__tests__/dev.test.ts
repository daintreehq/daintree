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
    await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    const second = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    expect(second.createdSymlink).toBe(false);
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

  it("leaves a reused (not created) symlink in place", async () => {
    await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    const reused = await linkDevPlugin({ pluginDir, pluginsRoot, pluginId: "acme.demo" });
    const link: DevLink = { ...reused };
    await cleanupDevLink(link);
    // Symlink stays (we didn't create it this round); marker is removed.
    expect(await lstatSafe(reused.linkPath)).not.toBeNull();
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

  it("sends plugin.dev.start before plugin.dev.stop with the plugin id", async () => {
    const controller = new AbortController();
    controller.abort();
    await runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal });
    const calls = vi.mocked(sendCliRequest).mock.calls;
    expect(calls[0]).toEqual(["plugin.dev.start", { pluginId: "acme.demo" }]);
    expect(calls[calls.length - 1]).toEqual(["plugin.dev.stop", { pluginId: "acme.demo" }]);
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

  it("rejects a plugin with no main entry", async () => {
    await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({ name: "acme.demo" }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal })
    ).rejects.toThrow(/main/);
  });
});

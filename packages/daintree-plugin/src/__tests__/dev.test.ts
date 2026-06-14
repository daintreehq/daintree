import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../lib/viteBuild.js", () => ({
  runViteBuild: vi.fn(async () => {}),
  // Synchronous like the real helper: returns a live child handle, not a Promise.
  spawnViteWatch: vi.fn(() => ({ kill: vi.fn(), catch: vi.fn() })),
}));
vi.mock("../ipc/client.js", () => ({
  sendCliRequest: vi.fn(async () => ({ status: "ok" })),
  DaintreeUnavailableError: class extends Error {},
}));
vi.mock("../commands/validate.js", () => ({
  runValidate: vi.fn(async () => ({ ok: true, errors: [], warnings: [] })),
}));

import { linkDevPlugin, cleanupDevLink, runDev, type DevLink } from "../commands/dev.js";
import { runViteBuild, spawnViteWatch } from "../lib/viteBuild.js";
import { sendCliRequest } from "../ipc/client.js";

let tmpDir: string;
let pluginDir: string;
let pluginsRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
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

    expect(runViteBuild).toHaveBeenCalledWith(pluginDir);
    expect(spawnViteWatch).toHaveBeenCalledWith(pluginDir);
    const calls = vi.mocked(sendCliRequest).mock.calls.map((c) => c[0]);
    expect(calls).toContain("plugin.dev.start");
    expect(calls).toContain("plugin.dev.stop");

    const watch = await vi.mocked(spawnViteWatch).mock.results[0].value;
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
    vi.mocked(spawnViteWatch).mockImplementationOnce(() => {
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
    expect(runViteBuild).not.toHaveBeenCalled();
    expect(vi.mocked(sendCliRequest).mock.calls.map((c) => c[0])).toContain("plugin.dev.start");
  });

  it("cleans up the link and does not start the watcher when Daintree is unreachable", async () => {
    vi.mocked(sendCliRequest).mockRejectedValueOnce(new Error("Daintree isn't running"));
    const controller = new AbortController();
    controller.abort();

    await expect(
      runDev({ dir: pluginDir, pluginsRoot, keepAliveSignal: controller.signal })
    ).rejects.toThrow(/isn't running/);

    expect(spawnViteWatch).not.toHaveBeenCalled();
    expect(await lstatSafe(path.join(pluginsRoot, "acme.demo"))).toBeNull();
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

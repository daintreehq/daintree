import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

import { ProjectPluginController } from "../ProjectPluginController.js";
import type { ProjectPluginControllerDeps } from "../ProjectPluginController.js";
import { ProjectPluginWatcher } from "../ProjectPluginWatcher.js";
import { discoverProjectPlugins } from "../projectPluginDiscovery.js";
import type { ProjectPluginTrustRecord } from "../../../../shared/types/plugin.js";
import { makeProjectPluginInstanceKey } from "../../../../shared/types/plugin.js";

/**
 * End-to-end hot reload, driven by real filesystem writes.
 *
 * A temp copy of `plugins/fixtures/project-local` gets a real
 * platform watcher subscription, a real `discoverProjectPlugins`, and a real
 * `ProjectPluginController`. Only the very last hop — the load itself — is
 * substituted, because the real one is `PluginService.loadPlugin` and needs
 * Electron; the stand-in reads the plugin's `dist/index.js` off disk, so the
 * assertion is that the host is running the NEW bytes, not that a timer fired.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const FIXTURE = path.join(REPO_ROOT, "plugins", "fixtures", "project-local");
const PLUGIN_ID = "acme.project-hello";
const PLUGIN_DIR_NAME = "acme.project-hello";
const PROJECT_ID = "f".repeat(64);

const tempRoots: string[] = [];
const watchers: ProjectPluginWatcher[] = [];
const controllers: ProjectPluginController[] = [];

const FAST = {
  debounceMs: 40,
  gitLockPollMs: 30,
  gitLockMaxDeferMs: 2_000,
  invalidManifestRetryMs: 40,
  invalidManifestMaxRetries: 20,
};

async function copyFixture(): Promise<{ root: string; pluginDir: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `dt-pphr-${randomUUID()}-`));
  tempRoots.push(root);
  await fsp.cp(FIXTURE, root, { recursive: true });
  return { root, pluginDir: path.join(root, ".daintree", "plugins", PLUGIN_DIR_NAME) };
}

interface Harness {
  controller: ProjectPluginController;
  watcher: ProjectPluginWatcher;
  /** instance key → the `dist/index.js` bytes the host loaded. */
  running: Map<string, string>;
  loads: string[];
  unloads: string[];
  open: () => Promise<void>;
}

function makeHarness(root: string): Harness {
  const trust = new Map<string, ProjectPluginTrustRecord>([
    [
      PROJECT_ID,
      {
        decision: "enabled",
        decidedAt: Date.now(),
        // Already known, so the reconcile loads it rather than staging it.
        knownPluginIds: [PLUGIN_ID],
        stagedPluginIds: [],
        mutedPluginIds: [],
      },
    ],
  ]);
  const running = new Map<string, string>();
  const loads: string[] = [];
  const unloads: string[] = [];

  const deps: ProjectPluginControllerDeps = {
    discover: (projectRoot) => discoverProjectPlugins(projectRoot),
    loadProjectPlugin: async ({ projectId, dir, manifest }) => {
      // The one substitution: read what the real loader would have imported.
      const source = await fsp.readFile(path.join(dir, "dist", "index.js"), "utf-8");
      const instanceKey = makeProjectPluginInstanceKey(projectId, manifest.name);
      running.set(instanceKey, source);
      loads.push(instanceKey);
      return true;
    },
    unloadProjectPlugin: (instanceKey) => {
      running.delete(instanceKey);
      unloads.push(instanceKey);
    },
    purgeConsentForInstance: vi.fn(),
    listGlobalPluginIds: () => new Set<string>(),
    readTrust: (projectId) => trust.get(projectId),
    writeTrust: (projectId, record) => {
      if (record) trust.set(projectId, record);
      else trust.delete(projectId);
    },
    emitToProject: vi.fn(),
    isProjectClosed: () => false,
  };

  const controller = new ProjectPluginController(deps);
  controllers.push(controller);

  const watcher = new ProjectPluginWatcher({
    discover: (projectRoot) => discoverProjectPlugins(projectRoot),
    loadedManifestIds: (projectId) => controller.loadedManifestIds(projectId),
    reload: (projectId, projectRoot, manifestIds) =>
      controller.reloadChanged(projectId, projectRoot, manifestIds),
    viewGenerationsAllocated: () => loads.length,
    resolveGitDir: async () => null,
    timings: FAST,
  });
  watchers.push(watcher);

  return {
    controller,
    watcher,
    running,
    loads,
    unloads,
    open: async () => {
      await controller.onProjectOpened(PROJECT_ID, root);
      await watcher.ensure(PROJECT_ID, root);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.dispose();
  for (const controller of controllers.splice(0)) controller.dispose();
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const root of tempRoots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("project-local plugin hot reload (end to end)", () => {
  const instanceKey = makeProjectPluginInstanceKey(PROJECT_ID, PLUGIN_ID);

  it("re-runs the plugin with the new bytes when dist/ is rebuilt", async () => {
    const { root, pluginDir } = await copyFixture();
    const harness = makeHarness(root);
    await harness.open();

    expect(harness.loads).toEqual([instanceKey]);
    expect(harness.running.get(instanceKey)).toContain("export async function activate()");
    expect(harness.watcher.isWatching(PROJECT_ID)).toBe(true);

    const rebuilt = "export async function activate() {\n  return () => {};\n}\n// rebuilt v2\n";
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), rebuilt);

    expect(await waitFor(() => harness.loads.length === 2)).toBe(true);
    // The old instance was torn down and the new one carries the new source.
    expect(harness.unloads).toEqual([instanceKey]);
    expect(harness.loads).toEqual([instanceKey, instanceKey]);
    expect(harness.running.get(instanceKey)).toBe(rebuilt);
  });

  it("survives a half-written plugin.json without dropping the running plugin", async () => {
    const { root, pluginDir } = await copyFixture();
    const harness = makeHarness(root);
    await harness.open();
    const original = harness.running.get(instanceKey);
    expect(original).toBeTypeOf("string");

    await fsp.writeFile(path.join(pluginDir, "plugin.json"), '{"name": "acme.project-h');
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Still running, still the old artifact — the reprieve, not a teardown.
    expect(harness.unloads).toEqual([]);
    expect(harness.running.get(instanceKey)).toBe(original);

    const manifest = await fsp.readFile(
      path.join(FIXTURE, ".daintree", "plugins", PLUGIN_DIR_NAME, "plugin.json"),
      "utf-8"
    );
    await fsp.writeFile(path.join(pluginDir, "plugin.json"), manifest.replace("0.1.0", "0.2.0"));

    expect(await waitFor(() => harness.loads.length === 2)).toBe(true);
    expect(harness.running.has(instanceKey)).toBe(true);
  });

  it("unloads a plugin whose folder disappears (a branch without it)", async () => {
    const { root, pluginDir } = await copyFixture();
    const harness = makeHarness(root);
    await harness.open();
    expect(harness.running.has(instanceKey)).toBe(true);

    await fsp.rm(pluginDir, { recursive: true, force: true });

    expect(await waitFor(() => harness.unloads.length > 0)).toBe(true);
    expect(harness.running.has(instanceKey)).toBe(false);
    expect(harness.controller.loadedManifestIds(PROJECT_ID)).toEqual([]);
  });

  it("ignores writes under the plugin's src/", async () => {
    const { root, pluginDir } = await copyFixture();
    const harness = makeHarness(root);
    await harness.open();
    expect(harness.loads.length).toBe(1);

    await fsp.mkdir(path.join(pluginDir, "src"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      await fsp.writeFile(path.join(pluginDir, "src", `f${i}.ts`), `export const n = ${i};\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(harness.loads.length).toBe(1);
    expect(harness.unloads).toEqual([]);
  });

  it("stops reloading once the project closes", async () => {
    const { root, pluginDir } = await copyFixture();
    const harness = makeHarness(root);
    await harness.open();

    harness.watcher.stop(PROJECT_ID);
    await harness.controller.onProjectClosed(PROJECT_ID);
    const loadsAtClose = harness.loads.length;

    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "// after close\n");
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(harness.loads.length).toBe(loadsAtClose);
    expect(harness.running.size).toBe(0);
  });
});

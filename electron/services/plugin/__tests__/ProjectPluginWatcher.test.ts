import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

import {
  ProjectPluginWatcher,
  attributeProjectPluginEvent,
  type ProjectPluginWatcherDeps,
} from "../ProjectPluginWatcher.js";
import { discoverProjectPlugins } from "../projectPluginDiscovery.js";

/**
 * Driven with REAL platform watcher subscriptions over REAL temp directories.
 * A debouncer exercised with synthetic events proves nothing about whether the
 * host ever sees a plugin rebuild, which is the entire feature.
 *
 * Cleanup is `afterEach` on purpose: `process.on("exit")` never fires in a
 * vitest forks worker, and a leaked native subscription keeps a thread alive
 * for the rest of the run.
 */

const PROJECT_ID = "p".repeat(64);

const roots: string[] = [];
const watchers: ProjectPluginWatcher[] = [];

/** Fast cadence so backoff costs milliseconds rather than seconds. */
const FAST = {
  debounceMs: 40,
  gitLockPollMs: 30,
  gitLockMaxDeferMs: 3_000,
  invalidManifestRetryMs: 40,
  invalidManifestMaxRetries: 3,
};

function manifestJson(name: string, version = "1.0.0"): string {
  return JSON.stringify({
    name,
    version,
    displayName: name,
    main: "dist/index.js",
    scope: "project",
    activationEvents: [],
    contributes: {},
  });
}

async function makeProject(opts: { withGitDir?: boolean } = {}): Promise<{
  root: string;
  pluginDir: string;
  gitDir: string;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `dt-ppw-${randomUUID()}-`));
  roots.push(root);
  const pluginDir = path.join(root, ".daintree", "plugins", "acme.hello");
  await fsp.mkdir(path.join(pluginDir, "dist"), { recursive: true });
  await fsp.mkdir(path.join(pluginDir, "src"), { recursive: true });
  await fsp.writeFile(path.join(pluginDir, "plugin.json"), manifestJson("acme.hello"));
  await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export function activate() {}\n");
  await fsp.writeFile(path.join(pluginDir, "src", "index.ts"), "export const a = 1;\n");
  const gitDir = path.join(root, ".git");
  if (opts.withGitDir !== false) await fsp.mkdir(gitDir, { recursive: true });
  return { root, pluginDir, gitDir };
}

function makeWatcher(
  overrides: Partial<ProjectPluginWatcherDeps> & { gitDir?: string | null } = {}
): {
  watcher: ProjectPluginWatcher;
  reload: ReturnType<typeof vi.fn>;
  loaded: Set<string>;
} {
  const loaded = new Set<string>(["acme.hello"]);
  const reload = vi.fn(async () => undefined);
  const watcher = new ProjectPluginWatcher({
    discover: (projectRoot) => discoverProjectPlugins(projectRoot),
    loadedManifestIds: () => [...loaded],
    reload,
    viewGenerationsAllocated: () => 7,
    resolveGitDir: async () => overrides.gitDir ?? null,
    timings: FAST,
    ...overrides,
  });
  watchers.push(watcher);
  return { watcher, reload, loaded };
}

/** Poll until `predicate` holds, or give up. Watcher latency is not fixed. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = process.platform === "win32" ? 20_000 : 4_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

async function settleFor(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.dispose();
  // Give the native unsubscribes a tick before the directories vanish.
  await settleFor(50);
  for (const root of roots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("attributeProjectPluginEvent", () => {
  const root = path.join(path.sep, "projects", "x", ".daintree", "plugins");

  it("attributes plugin.json and dist/ writes to their plugin directory", () => {
    expect(attributeProjectPluginEvent(root, path.join(root, "acme.a", "plugin.json"))).toEqual({
      kind: "dir",
      dirName: "acme.a",
    });
    expect(
      attributeProjectPluginEvent(root, path.join(root, "acme.a", "dist", "chunk.js"))
    ).toEqual({ kind: "dir", dirName: "acme.a" });
  });

  it("ignores src/, so a keystroke in a plugin's sources never reloads it", () => {
    expect(attributeProjectPluginEvent(root, path.join(root, "acme.a", "src", "index.ts"))).toEqual(
      { kind: "ignore" }
    );
    expect(
      attributeProjectPluginEvent(root, path.join(root, "acme.a", "node_modules", "x", "i.js"))
    ).toEqual({ kind: "ignore" });
    expect(attributeProjectPluginEvent(root, path.join(root, "acme.a", "README.md"))).toEqual({
      kind: "ignore",
    });
  });

  it("treats a bare directory event as 'rescan that plugin' (FSEvents coalescing)", () => {
    expect(attributeProjectPluginEvent(root, path.join(root, "acme.a"))).toEqual({
      kind: "dir",
      dirName: "acme.a",
    });
  });

  it("treats the plugins root itself as 'rescan everything'", () => {
    expect(attributeProjectPluginEvent(root, root)).toEqual({ kind: "all" });
  });

  it("ignores dot directories and anything outside the plugins root", () => {
    expect(attributeProjectPluginEvent(root, path.join(root, ".git", "index"))).toEqual({
      kind: "ignore",
    });
    expect(attributeProjectPluginEvent(root, path.join(path.sep, "elsewhere", "f.js"))).toEqual({
      kind: "ignore",
    });
  });
});

describe("ProjectPluginWatcher", () => {
  it("reloads the plugin when its dist/ is rewritten", async () => {
    const { root, pluginDir } = await makeProject();
    const { watcher, reload } = makeWatcher();
    await watcher.ensure(PROJECT_ID, root);
    expect(watcher.isWatching(PROJECT_ID)).toBe(true);

    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export const v = 2;\n");

    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
    const [projectId, projectRoot, ids] = reload.mock.calls[0] as [string, string, string[]];
    expect(projectId).toBe(PROJECT_ID);
    expect(projectRoot).toBe(root);
    expect(ids).toEqual(["acme.hello"]);
  });

  it("does not reload when only src/ changes", async () => {
    const { root, pluginDir } = await makeProject();
    const { watcher, reload } = makeWatcher();
    await watcher.ensure(PROJECT_ID, root);

    await fsp.writeFile(path.join(pluginDir, "src", "index.ts"), "export const a = 2;\n");
    await settleFor(400);
    expect(reload).not.toHaveBeenCalled();

    // Sanity: the subscription is live — a dist/ write still gets through.
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export const v = 3;\n");
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
  });

  it("coalesces a burst into one reload", async () => {
    const { root, pluginDir } = await makeProject();
    // ReadDirectoryChangesW can deliver one physical write burst in several
    // callback batches when the runner is saturated. Keep the assertion at
    // exactly one reload, but give those native batches a realistic trailing
    // window instead of asking the test-only 40ms cadence to bridge them.
    const debounceMs = process.platform === "win32" ? 1_000 : FAST.debounceMs;
    const { watcher, reload } = makeWatcher({
      timings: { ...FAST, debounceMs },
    });
    await watcher.ensure(PROJECT_ID, root);

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fsp.writeFile(path.join(pluginDir, "dist", `chunk-${i}.js`), `export const n = ${i};\n`)
      )
    );
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
    await settleFor(process.platform === "win32" ? debounceMs + 200 : 400);
    expect(reload.mock.calls.length).toBe(1);
  });

  it("keeps the running plugin when plugin.json is mid-write, and reloads once it parses", async () => {
    const { root, pluginDir } = await makeProject();
    // A generous retry budget: this test is about the reprieve, not about when
    // it runs out (the next test covers that).
    const { watcher, reload } = makeWatcher({
      timings: { ...FAST, invalidManifestMaxRetries: 200 },
    });
    await watcher.ensure(PROJECT_ID, root);

    // A half-flushed save: the file exists and does not parse.
    await fsp.writeFile(path.join(pluginDir, "plugin.json"), '{"name": "acme.hel');
    await settleFor(400);
    expect(reload).not.toHaveBeenCalled();

    await fsp.writeFile(path.join(pluginDir, "plugin.json"), manifestJson("acme.hello", "1.1.0"));
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
  });

  it("gives up on a manifest that stays broken and lets the reconcile disable it", async () => {
    const { root, pluginDir } = await makeProject();
    const { watcher, reload } = makeWatcher();
    await watcher.ensure(PROJECT_ID, root);

    await fsp.writeFile(path.join(pluginDir, "plugin.json"), "not json at all");
    // FAST: 3 retries × 40ms, then the ordinary reconcile runs.
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
  });

  it("defers entirely while .git/index.lock exists", async () => {
    const { root, pluginDir, gitDir } = await makeProject();
    const { watcher, reload } = makeWatcher({ gitDir });
    await watcher.ensure(PROJECT_ID, root);

    await fsp.writeFile(path.join(gitDir, "index.lock"), "");
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export const v = 4;\n");
    await settleFor(400);
    expect(reload).not.toHaveBeenCalled();

    await fsp.rm(path.join(gitDir, "index.lock"));
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
  });

  it("proceeds once a stale index.lock outlives the deferral ceiling", async () => {
    const { root, pluginDir, gitDir } = await makeProject();
    const { watcher, reload } = makeWatcher({
      gitDir,
      timings: { ...FAST, gitLockMaxDeferMs: 120 },
    });
    await watcher.ensure(PROJECT_ID, root);

    await fsp.writeFile(path.join(gitDir, "index.lock"), "");
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export const v = 5;\n");
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
  });

  it("reloads only the plugin whose directory changed", async () => {
    const { root } = await makeProject();
    const otherDir = path.join(root, ".daintree", "plugins", "acme.other");
    await fsp.mkdir(path.join(otherDir, "dist"), { recursive: true });
    await fsp.writeFile(path.join(otherDir, "plugin.json"), manifestJson("acme.other"));
    await fsp.writeFile(path.join(otherDir, "dist", "index.js"), "export const o = 1;\n");

    const { watcher, reload, loaded } = makeWatcher();
    loaded.add("acme.other");
    await watcher.ensure(PROJECT_ID, root);

    await fsp.writeFile(path.join(otherDir, "dist", "index.js"), "export const o = 2;\n");
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
    expect((reload.mock.calls[0] as [string, string, string[]])[2]).toEqual(["acme.other"]);
  });

  it("stops watching on stop(), and nothing reloads afterwards", async () => {
    const { root, pluginDir } = await makeProject();
    const { watcher, reload } = makeWatcher();
    await watcher.ensure(PROJECT_ID, root);
    expect(watcher.isWatching(PROJECT_ID)).toBe(true);

    watcher.stop(PROJECT_ID);
    expect(watcher.isWatching(PROJECT_ID)).toBe(false);

    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export const v = 6;\n");
    await settleFor(400);
    expect(reload).not.toHaveBeenCalled();
  });

  it("drops an in-flight reload when the project is stopped mid-settle", async () => {
    const { root, pluginDir } = await makeProject();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reload = vi.fn(async () => {
      await gate;
    });
    const { watcher } = makeWatcher({ reload });
    await watcher.ensure(PROJECT_ID, root);

    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export const v = 7;\n");
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);

    watcher.stop(PROJECT_ID);
    release();
    await settleFor(100);

    // A second burst after the stop must not reach the reload edge at all.
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export const v = 8;\n");
    await settleFor(300);
    expect(reload.mock.calls.length).toBe(1);
  });

  it("dispose() releases every project's subscription", async () => {
    const a = await makeProject();
    const b = await makeProject();
    const { watcher } = makeWatcher();
    const otherProject = "q".repeat(64);
    await watcher.ensure(PROJECT_ID, a.root);
    await watcher.ensure(otherProject, b.root);
    expect(watcher.isWatching(PROJECT_ID)).toBe(true);
    expect(watcher.isWatching(otherProject)).toBe(true);

    watcher.dispose();
    expect(watcher.isWatching(PROJECT_ID)).toBe(false);
    expect(watcher.isWatching(otherProject)).toBe(false);
  });

  it("is idempotent — a second ensure() does not open a second subscription", async () => {
    const { root, pluginDir } = await makeProject();
    const { watcher, reload } = makeWatcher();
    await watcher.ensure(PROJECT_ID, root);
    await watcher.ensure(PROJECT_ID, root);
    await watcher.ensure(PROJECT_ID, root);

    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export const v = 9;\n");
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
    await settleFor(300);
    expect(reload.mock.calls.length).toBe(1);
  });

  it("keeps the running plugin while plugin.json is momentarily absent", async () => {
    const { root, pluginDir } = await makeProject();
    const { watcher, reload } = makeWatcher({
      timings: { ...FAST, invalidManifestMaxRetries: 200 },
    });
    await watcher.ensure(PROJECT_ID, root);

    // An editor or build that replaces rather than renames: discovery returns
    // no row at all, which must not be read as "the plugin was deleted".
    const manifest = await fsp.readFile(path.join(pluginDir, "plugin.json"), "utf-8");
    await fsp.rm(path.join(pluginDir, "plugin.json"));
    await settleFor(300);
    expect(reload).not.toHaveBeenCalled();

    await fsp.writeFile(path.join(pluginDir, "plugin.json"), manifest);
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
  });

  it("still reconciles when the whole plugin directory is removed", async () => {
    const { root, pluginDir } = await makeProject();
    const { watcher, reload } = makeWatcher({
      timings: { ...FAST, invalidManifestMaxRetries: 200 },
    });
    await watcher.ensure(PROJECT_ID, root);

    // Moving the directory out of the watched root is the atomic shape a
    // checkout presents. It avoids making this lower-level test depend on how
    // ReadDirectoryChangesW batches every child deletion from a recursive rm;
    // the end-to-end suite separately covers recursive deletion itself.
    await fsp.rename(pluginDir, path.join(root, "removed-acme.hello"));
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
    expect((reload.mock.calls[0] as [string, string, string[]])[2]).toEqual(["acme.hello"]);
  });

  it("arms by itself once the plugins folder is created", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `dt-ppw-sentinel-${randomUUID()}-`));
    roots.push(root);
    await fsp.mkdir(path.join(root, ".daintree"), { recursive: true });
    const { watcher } = makeWatcher();
    await watcher.ensure(PROJECT_ID, root);
    expect(watcher.isWatching(PROJECT_ID)).toBe(false);

    // No second ensure(): the sentinel is what has to notice this.
    await fsp.mkdir(path.join(root, ".daintree", "plugins"), { recursive: true });
    expect(await waitFor(() => watcher.isWatching(PROJECT_ID))).toBe(true);
  });

  it("does not arm when the project has no .daintree/plugins folder", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `dt-ppw-empty-${randomUUID()}-`));
    roots.push(root);
    const { watcher } = makeWatcher();
    await watcher.ensure(PROJECT_ID, root);
    expect(watcher.isWatching(PROJECT_ID)).toBe(false);
  });

  it("arms later, once the plugins folder appears", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `dt-ppw-late-${randomUUID()}-`));
    roots.push(root);
    const { watcher } = makeWatcher();
    await watcher.ensure(PROJECT_ID, root);
    expect(watcher.isWatching(PROJECT_ID)).toBe(false);

    await fsp.mkdir(path.join(root, ".daintree", "plugins"), { recursive: true });
    await watcher.ensure(PROJECT_ID, root);
    // The sentinel may already be arming when the explicit ensure() lands, and
    // the subscribe itself is async either way.
    expect(await waitFor(() => watcher.isWatching(PROJECT_ID))).toBe(true);
  });

  it("reconciles a plugin folder that appears already complete (#12212)", async () => {
    // The headline case: an agent writes the whole plugin at once. `arm()`
    // fingerprints what it finds, so without a forced reconcile the settle
    // that follows sees nothing changed and stops before the controller —
    // the project stays silent, which is the bug this issue is about.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `dt-ppw-whole-${randomUUID()}-`));
    roots.push(root);
    await fsp.mkdir(path.join(root, ".daintree"), { recursive: true });
    // Nothing is loaded yet — this project has never had a plugin.
    const { watcher, reload, loaded } = makeWatcher();
    loaded.clear();
    await watcher.ensure(PROJECT_ID, root);
    expect(watcher.isWatching(PROJECT_ID)).toBe(false);

    // Built elsewhere, then moved in as one unit, so no write ever lands
    // inside the watched tree.
    const staging = await fsp.mkdtemp(path.join(os.tmpdir(), `dt-ppw-stage-${randomUUID()}-`));
    roots.push(staging);
    const pluginDir = path.join(staging, "plugins", "acme.hello");
    await fsp.mkdir(path.join(pluginDir, "dist"), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, "plugin.json"), manifestJson("acme.hello"));
    await fsp.writeFile(
      path.join(pluginDir, "dist", "index.js"),
      "export function activate() {}\n"
    );
    await fsp.rename(path.join(staging, "plugins"), path.join(root, ".daintree", "plugins"));

    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
    // Nothing was loaded, so there is nothing to name — the point is that the
    // controller is asked to rescan at all.
    expect((reload.mock.calls[0] as [string, string, string[]])[2]).toEqual([]);
  });

  it("follows .daintree inward when the project had neither directory (#12212)", async () => {
    // `fs.watch` is not recursive: a sentinel parked on the project root never
    // sees `plugins` created two levels down, so it has to migrate as each
    // ancestor appears.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `dt-ppw-inward-${randomUUID()}-`));
    roots.push(root);
    const { watcher, reload, loaded } = makeWatcher();
    loaded.clear();
    await watcher.ensure(PROJECT_ID, root);
    expect(watcher.isWatching(PROJECT_ID)).toBe(false);

    await fsp.mkdir(path.join(root, ".daintree"), { recursive: true });
    // Let the sentinel notice the ancestor and re-arm on it before the leaf
    // directory appears.
    await settleFor(200);

    const pluginDir = path.join(root, ".daintree", "plugins", "acme.hello");
    await fsp.mkdir(path.join(pluginDir, "dist"), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, "plugin.json"), manifestJson("acme.hello"));

    expect(await waitFor(() => watcher.isWatching(PROJECT_ID))).toBe(true);
    expect(await waitFor(() => reload.mock.calls.length > 0)).toBe(true);
  });

  it("registers an app-quit disposer", async () => {
    const { root } = await makeProject();
    let quit!: () => void;
    const { watcher } = makeWatcher({
      onAppQuit: (dispose) => {
        quit = dispose;
      },
    });
    await watcher.ensure(PROJECT_ID, root);
    expect(watcher.isWatching(PROJECT_ID)).toBe(true);
    expect(quit).toBeTypeOf("function");

    quit();
    expect(watcher.isWatching(PROJECT_ID)).toBe(false);
  });
});

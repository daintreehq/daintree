import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

import {
  PluginDevArtifactWatcher,
  attributeDevPluginEvent,
  type PluginDevArtifactWatcherDeps,
} from "../PluginDevArtifactWatcher.js";

/**
 * Driven with REAL platform watcher subscriptions over REAL temp directories,
 * for the same reason `ProjectPluginWatcher.test.ts` is: the bug this watcher
 * fixes is "the host never sees the rebuild", and synthetic events cannot fail
 * that way. The symlink case in particular only reproduces against a real
 * filesystem — the CLI links the author's project into the plugins root, and a
 * subscription armed on the link rather than its target reports nothing.
 *
 * Cleanup is `afterEach` on purpose: `process.on("exit")` never fires in a
 * vitest forks worker, and a leaked native subscription keeps a thread alive
 * for the rest of the run.
 */

const PLUGIN_ID = "acme.dev";

const roots: string[] = [];
const watchers: PluginDevArtifactWatcher[] = [];

/** Fast cadence so backoff costs milliseconds rather than seconds. */
const FAST = {
  settleDebounceMs: 40,
  stabilityMs: 20,
  rearmDelayMs: 30,
  rearmMaxAttempts: 2,
};

async function makePluginDir(): Promise<{ root: string; pluginDir: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `dt-pdaw-${randomUUID()}-`));
  roots.push(root);
  const pluginDir = path.join(root, PLUGIN_ID);
  await fsp.mkdir(path.join(pluginDir, "dist"), { recursive: true });
  await fsp.mkdir(path.join(pluginDir, "src"), { recursive: true });
  await fsp.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({ name: PLUGIN_ID, version: "1.0.0", main: "dist/index.js" })
  );
  await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export function activate() {}\n");
  await fsp.writeFile(path.join(pluginDir, "dist", "view.js"), "export default () => null;\n");
  await fsp.mkdir(path.join(pluginDir, "dist", "chunks"), { recursive: true });
  await fsp.writeFile(path.join(pluginDir, "dist", "chunks", "shared.js"), "export const x = 1;\n");
  await fsp.writeFile(path.join(pluginDir, "src", "index.ts"), "export const a = 1;\n");
  return { root, pluginDir };
}

function makeWatcher(overrides: Partial<PluginDevArtifactWatcherDeps> = {}): {
  watcher: PluginDevArtifactWatcher;
  reload: ReturnType<typeof vi.fn>;
  states: Array<{ pluginId: string; state: string; detail: string | null }>;
} {
  const reload = vi.fn(async () => true);
  const states: Array<{ pluginId: string; state: string; detail: string | null }> = [];
  const watcher = new PluginDevArtifactWatcher({
    reload,
    onStateChange: (pluginId, state, detail) => {
      states.push({ pluginId, state, detail });
    },
    timings: FAST,
    ...overrides,
  });
  watchers.push(watcher);
  return { watcher, reload, states };
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

/** Arm and wait until the subscription is actually established. */
async function arm(
  watcher: PluginDevArtifactWatcher,
  dir: string,
  pluginId = PLUGIN_ID
): Promise<void> {
  watcher.ensure(pluginId, dir);
  const armed = await waitFor(() => watcher.stateOf(pluginId)?.state === "watching");
  // Asserted, not hoped for: an unarmed watcher makes every "never reloads"
  // case below pass for the wrong reason.
  expect(armed).toBe(true);
}

afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.dispose();
  // Give the native unsubscribes a tick before the directories vanish.
  await settleFor(50);
  for (const root of roots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("attributeDevPluginEvent", () => {
  const root = path.join(path.sep, "plugins", "acme.dev");

  it("attributes plugin.json, dist/ and the dev marker to the artifact", () => {
    expect(attributeDevPluginEvent(root, path.join(root, "plugin.json"))).toBe("artifact");
    expect(attributeDevPluginEvent(root, path.join(root, "dist", "index.js"))).toBe("artifact");
    expect(attributeDevPluginEvent(root, path.join(root, "dist", "chunks", "a.js"))).toBe(
      "artifact"
    );
    expect(attributeDevPluginEvent(root, path.join(root, ".dev-marker"))).toBe("artifact");
  });

  it("counts dist/src/** — a real output chunk an ignore glob would swallow", () => {
    expect(attributeDevPluginEvent(root, path.join(root, "dist", "src", "view.js"))).toBe(
      "artifact"
    );
  });

  it("ignores sources, node_modules and unrelated files", () => {
    expect(attributeDevPluginEvent(root, path.join(root, "src", "index.ts"))).toBe("ignore");
    expect(attributeDevPluginEvent(root, path.join(root, "node_modules", "x", "i.js"))).toBe(
      "ignore"
    );
    expect(attributeDevPluginEvent(root, path.join(root, "README.md"))).toBe("ignore");
  });

  it("treats a bare event on the plugin root as an artifact change (FSEvents coalescing)", () => {
    expect(attributeDevPluginEvent(root, root)).toBe("artifact");
  });

  it("ignores anything outside the plugin root", () => {
    expect(attributeDevPluginEvent(root, path.join(path.sep, "elsewhere", "f.js"))).toBe("ignore");
  });
});

describe("PluginDevArtifactWatcher", () => {
  it("reloads once when the backend entry is rebuilt", async () => {
    const { pluginDir } = await makePluginDir();
    const { watcher, reload } = makeWatcher();
    await arm(watcher, pluginDir);

    await fsp.writeFile(
      path.join(pluginDir, "dist", "index.js"),
      "export function activate(){}//2"
    );

    expect(await waitFor(() => reload.mock.calls.length >= 1)).toBe(true);
    await settleFor(200);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith(PLUGIN_ID);
  });

  it("reloads on a view-only rebuild — the case the old bundle-only watch missed", async () => {
    const { pluginDir } = await makePluginDir();
    const { watcher, reload } = makeWatcher();
    await arm(watcher, pluginDir);

    await fsp.writeFile(path.join(pluginDir, "dist", "view.js"), "export default () => 'v2';\n");

    expect(await waitFor(() => reload.mock.calls.length >= 1)).toBe(true);
    await settleFor(200);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads when only a non-entry chunk changes — the split-chunk case", async () => {
    const { pluginDir } = await makePluginDir();
    const { watcher, reload } = makeWatcher();
    await arm(watcher, pluginDir);

    // Modified, not created: the old watcher filtered to the entry file's own
    // basename, so an existing sibling chunk changing was exactly what it
    // missed. Creating a new file would also trip a name-only filter.
    await fsp.writeFile(
      path.join(pluginDir, "dist", "chunks", "shared.js"),
      "export const x = 2;\n"
    );

    expect(await waitFor(() => reload.mock.calls.length >= 1)).toBe(true);
    await settleFor(200);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads on a manifest-only edit", async () => {
    const { pluginDir } = await makePluginDir();
    const { watcher, reload } = makeWatcher();
    await arm(watcher, pluginDir);

    await fsp.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: PLUGIN_ID, version: "1.0.1", main: "dist/index.js" })
    );

    expect(await waitFor(() => reload.mock.calls.length >= 1)).toBe(true);
    await settleFor(200);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("coalesces a multi-file rebuild burst into exactly one reload", async () => {
    const { pluginDir } = await makePluginDir();
    const { watcher, reload } = makeWatcher();
    await arm(watcher, pluginDir);

    // What a rebuild that empties and rewrites `dist/` actually looks like.
    await fsp.rm(path.join(pluginDir, "dist"), { recursive: true, force: true });
    await fsp.mkdir(path.join(pluginDir, "dist"), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//backend v2\n");
    await fsp.writeFile(path.join(pluginDir, "dist", "view.js"), "//view v2\n");
    await fsp.writeFile(path.join(pluginDir, "dist", "extra.js"), "//chunk v2\n");

    expect(await waitFor(() => reload.mock.calls.length >= 1)).toBe(true);
    await settleFor(250);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads for writes under src/", async () => {
    const { pluginDir } = await makePluginDir();
    const { watcher, reload } = makeWatcher();
    await arm(watcher, pluginDir);

    await fsp.writeFile(path.join(pluginDir, "src", "index.ts"), "export const a = 2;\n");
    await settleFor(300);

    expect(reload).not.toHaveBeenCalled();
  });

  it("watches through the CLI's symlink, not the link itself", async () => {
    // The exact shape `daintree-plugin dev` produces: the author's project is
    // symlinked into the plugins root, and the host only knows the link path.
    const { pluginDir } = await makePluginDir();
    const linkRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `dt-pdaw-link-${randomUUID()}-`));
    roots.push(linkRoot);
    const linkPath = path.join(linkRoot, PLUGIN_ID);
    await fsp.symlink(pluginDir, linkPath);

    const { watcher, reload } = makeWatcher();
    await arm(watcher, linkPath);

    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//through the link\n");

    expect(await waitFor(() => reload.mock.calls.length >= 1)).toBe(true);
  });

  it("does not reload for the history a fresh subscription replays", async () => {
    // FSEvents replays recent writes to a new subscription; the seeded
    // fingerprint is what stops an arm from reloading the plugin that just
    // loaded.
    const { pluginDir } = await makePluginDir();
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//written just before arming\n");

    const { watcher, reload } = makeWatcher();
    await arm(watcher, pluginDir);
    await settleFor(300);

    expect(reload).not.toHaveBeenCalled();
  });

  it("waits for a plugin directory that does not exist yet, then arms", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `dt-pdaw-late-${randomUUID()}-`));
    roots.push(root);
    const pluginDir = path.join(root, PLUGIN_ID);

    const { watcher, states } = makeWatcher();
    watcher.ensure(PLUGIN_ID, pluginDir);
    // ensure starts in "waiting" before async setup has installed the parent
    // watch. Its notification confirms the watch can observe the mkdir below.
    expect(await waitFor(() => states.some((entry) => entry.state === "waiting"))).toBe(true);

    await fsp.mkdir(path.join(pluginDir, "dist"), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, "plugin.json"), "{}");

    expect(await waitFor(() => watcher.stateOf(PLUGIN_ID)?.state === "watching")).toBe(true);
  });

  it("stops reloading once the session is stopped", async () => {
    const { pluginDir } = await makePluginDir();
    const { watcher, reload } = makeWatcher();
    await arm(watcher, pluginDir);

    watcher.stop(PLUGIN_ID);
    expect(watcher.stateOf(PLUGIN_ID)).toBeNull();

    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//after stop\n");
    await settleFor(300);

    expect(reload).not.toHaveBeenCalled();
  });

  it("is idempotent: re-arming the same session does not double-report a rebuild", async () => {
    const { pluginDir } = await makePluginDir();
    const { watcher, reload } = makeWatcher();
    await arm(watcher, pluginDir);
    // What the reconcile itself does: `loadPlugin` re-enters `ensureDevSession`.
    watcher.ensure(PLUGIN_ID, pluginDir);
    watcher.ensure(PLUGIN_ID, pluginDir);

    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//v2\n");

    expect(await waitFor(() => reload.mock.calls.length >= 1)).toBe(true);
    await settleFor(250);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("retries the next rebuild after a reload throws, rather than baselining the failure", async () => {
    const { pluginDir } = await makePluginDir();
    let calls = 0;
    const reload = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("manifest broke");
      return true;
    });
    const { watcher } = makeWatcher({ reload });
    await arm(watcher, pluginDir);

    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//broken\n");
    expect(await waitFor(() => calls >= 1)).toBe(true);

    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//fixed\n");
    expect(await waitFor(() => calls >= 2)).toBe(true);
  });

  it("does not baseline a rebuild the reconcile declined to apply", async () => {
    // `false` means "not adopted" (session stopped, plugin disabled, manifest
    // unparseable). Baselining it would make the author's NEXT save compare
    // equal against bytes that were never loaded, swallowing the build.
    const { pluginDir } = await makePluginDir();
    let applied = false;
    const reload = vi.fn(async () => applied);
    const { watcher } = makeWatcher({ reload });
    await arm(watcher, pluginDir);

    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//declined\n");
    expect(await waitFor(() => reload.mock.calls.length >= 1)).toBe(true);

    // Same bytes, retried: the declined fingerprint must not have stuck.
    applied = true;
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//declined\n");
    expect(await waitFor(() => reload.mock.calls.length >= 2)).toBe(true);
  });

  it("re-arming does not swallow a rebuild that landed while the watch was down", async () => {
    // The rearm path used to re-seed the fingerprint unconditionally, so a
    // build finishing during the outage became the new baseline and was never
    // loaded — hot reload silently skipping one save. Driven through the real
    // recovery entry point, because a backend error is not reproducible from
    // outside the subscription.
    const { pluginDir } = await makePluginDir();
    const { watcher, reload } = makeWatcher();
    await arm(watcher, pluginDir);

    const internals = watcher as unknown as {
      states: Map<string, object>;
      rearmAfterError(state: object, reason: string): void;
    };
    const state = internals.states.get(PLUGIN_ID);
    expect(state).toBeDefined();

    // Written while the watch is being torn down and re-armed, so the new
    // subscription never sees an event for it.
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//built while blind\n");
    internals.rearmAfterError(state as object, "simulated backend failure");

    expect(await waitFor(() => reload.mock.calls.length >= 1)).toBe(true);
    expect(watcher.stateOf(PLUGIN_ID)?.state).toBe("watching");
  });

  it("reports degraded once the rearm budget is spent", async () => {
    const { pluginDir } = await makePluginDir();
    const { watcher } = makeWatcher();
    await arm(watcher, pluginDir);

    const internals = watcher as unknown as {
      states: Map<string, object>;
      rearmAfterError(state: object, reason: string): void;
    };
    const state = internals.states.get(PLUGIN_ID) as object;

    // FAST.rearmMaxAttempts is 2, and a successful re-arm resets the budget —
    // so spend it without letting the retries land.
    for (let i = 0; i <= FAST.rearmMaxAttempts; i++) {
      internals.rearmAfterError(state, "simulated backend failure");
    }

    expect(watcher.stateOf(PLUGIN_ID)?.state).toBe("degraded");
    expect(watcher.stateOf(PLUGIN_ID)?.detail).toContain("stopped reporting changes");
  });

  it("dispose tears every session down", async () => {
    const { pluginDir } = await makePluginDir();
    const { watcher, reload } = makeWatcher();
    await arm(watcher, pluginDir);

    watcher.dispose();
    await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "//after dispose\n");
    await settleFor(300);

    expect(reload).not.toHaveBeenCalled();
    expect(watcher.stateOf(PLUGIN_ID)).toBeNull();
  });
});

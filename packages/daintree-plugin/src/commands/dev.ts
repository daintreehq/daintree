import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ResultPromise } from "execa";
import { runValidate } from "./validate.js";
import { resolveVitePlan, runVitePlanBuild, spawnViteWatch } from "../lib/viteBuild.js";
import { sendCliRequest } from "../ipc/client.js";

// Mirrors the (unexported) DEV_MARKER_FILENAME in
// electron/services/PluginService.ts — its presence at a plugin dir root routes
// the plugin through the hot-reload worker. The host owns the convention; the
// CLI writes the file. Keep these two literals in lockstep.
const DEV_MARKER_FILENAME = ".dev-marker";

export interface DevOptions {
  /** Plugin project directory. Defaults to the cwd. */
  dir?: string;
  /** Skip the initial one-shot build (the watcher still rebuilds on save). */
  skipBuild?: boolean;
  /** Override the plugins root. Defaults to ~/.daintree/plugins. */
  pluginsRoot?: string;
  /**
   * When this aborts, the dev session tears down and `runDev` returns. The
   * SIGINT/SIGTERM handlers are the production stop path; this exists so the
   * session can be driven programmatically (tests, embedding) without signals.
   */
  keepAliveSignal?: AbortSignal;
}

export interface DevLink {
  linkPath: string;
  markerPath: string;
  /**
   * True when this invocation created the symlink, so cleanup may remove it. A
   * pre-existing symlink already pointing at this plugin dir is reused and left
   * in place on teardown.
   */
  createdSymlink: boolean;
}

function defaultPluginsRoot(): string {
  return path.join(os.homedir(), ".daintree", "plugins");
}

/**
 * Symlink the plugin dir into the plugins root and write the `.dev-marker`
 * through the link. The CLI owns this symlink directly (it isn't a real install,
 * so it bypasses `PluginInstaller` and its content-mutation invariant, #9292).
 * Never removes a real directory at the link path — that would be an installed
 * plugin, not ours to delete.
 */
export async function linkDevPlugin(args: {
  pluginDir: string;
  pluginsRoot: string;
  pluginId: string;
}): Promise<DevLink> {
  const { pluginDir, pluginsRoot, pluginId } = args;
  const linkPath = path.join(pluginsRoot, pluginId);
  const symlinkType = process.platform === "win32" ? "junction" : undefined;

  await fs.mkdir(pluginsRoot, { recursive: true });

  let createdSymlink: boolean;
  try {
    await fs.symlink(pluginDir, linkPath, symlinkType);
    createdSymlink = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `Can't dev-link "${pluginId}": ${linkPath} already exists and isn't a symlink. Remove it (or uninstall the plugin) and try again.`,
        { cause: err }
      );
    }
    const existingTarget = await fs.readlink(linkPath);
    const resolvedExisting = path.resolve(path.dirname(linkPath), existingTarget);
    if (resolvedExisting === path.resolve(pluginDir)) {
      // Already linked to this plugin — reuse without claiming ownership.
      createdSymlink = false;
    } else {
      await fs.unlink(linkPath);
      await fs.symlink(pluginDir, linkPath, symlinkType);
      createdSymlink = true;
    }
  }

  const markerPath = path.join(linkPath, DEV_MARKER_FILENAME);
  await fs.writeFile(markerPath, "");

  return { linkPath, markerPath, createdSymlink };
}

/**
 * Remove the dev artifacts. Idempotent and per-step best-effort (one failing
 * step must not strand the others, lesson #9322): the marker comes off first so
 * a half-torn-down state can never leave a dangling marker that reroutes a
 * future load through the dev worker.
 */
export async function cleanupDevLink(link: DevLink): Promise<void> {
  try {
    await fs.unlink(link.markerPath);
  } catch {
    // best-effort — marker may already be gone
  }
  if (link.createdSymlink) {
    try {
      await fs.unlink(link.linkPath);
    } catch {
      // best-effort — symlink may already be gone
    }
  }
}

/** Best-effort unload request — Daintree may have been closed first. */
async function sendDevStop(pluginId: string): Promise<void> {
  try {
    await sendCliRequest("plugin.dev.stop", { pluginId });
  } catch {
    // Daintree gone or unreachable — local fs cleanup still proceeds.
  }
}

/** Kill every watcher, best-effort and independently — one throw must not strand the rest. */
function killWatchers(watchers: readonly ResultPromise[]): void {
  for (const watch of watchers) {
    try {
      watch.kill();
    } catch {
      // already exited
    }
  }
}

/** Stop the build watchers, ask Daintree to unload, and remove the dev artifacts. */
async function stopDev(
  pluginId: string,
  link: DevLink,
  watchers: readonly ResultPromise[]
): Promise<void> {
  killWatchers(watchers);
  await sendDevStop(pluginId);
  await cleanupDevLink(link);
}

/**
 * Run the hot-reload dev loop for the plugin in `dir`: build once, symlink it
 * into the plugins root with a `.dev-marker`, tell the running Daintree to load
 * + activate it, then keep `vite build --watch` alive so saves rebuild `dist/`
 * (Daintree's dev worker watches `dist/` and reloads). A plugin with a Node
 * server entry gets a watcher per config, so worker sources rebuild too.
 * Ctrl-C tears everything back down.
 */
export async function runDev(opts: DevOptions = {}): Promise<void> {
  const dir = path.resolve(opts.dir ?? process.cwd());

  const validation = await runValidate({ dir });
  if (!validation.ok) {
    throw new Error(`Manifest validation failed:\n  ${validation.errors.join("\n  ")}`);
  }

  const manifest = JSON.parse(await fs.readFile(path.join(dir, "plugin.json"), "utf8")) as {
    name: string;
    main?: string;
  };
  if (!manifest.main) {
    throw new Error('Plugin has no "main" entry — dev hot-reload needs a built entry point.');
  }
  const pluginId = manifest.name;
  const pluginsRoot = opts.pluginsRoot ?? defaultPluginsRoot();

  const plan = resolveVitePlan(dir);

  // Build once so dist/<main> exists before Daintree loads the plugin —
  // otherwise the marker is present but the worker has no bundle to import.
  if (!opts.skipBuild) {
    await runVitePlanBuild(dir, plan);
  }

  const link = await linkDevPlugin({ pluginDir: dir, pluginsRoot, pluginId });

  try {
    await sendCliRequest("plugin.dev.start", { pluginId });
  } catch (err) {
    await cleanupDevLink(link);
    throw err;
  }

  // `spawnViteWatch` returns the live child handle synchronously (do NOT await
  // it — awaiting the ResultPromise would block until the watcher exits). If it
  // throws (Vite missing), the plugin is already loaded in Daintree, so unload
  // it and remove the dev artifacts before surfacing the error. A throw on the
  // second spawn must also kill the first, or the failed session leaks a live
  // Vite process.
  const watchers: ResultPromise[] = [];
  try {
    for (const args of plan.watch) {
      watchers.push(spawnViteWatch(dir, args));
    }
  } catch (err) {
    killWatchers(watchers);
    await sendDevStop(pluginId);
    await cleanupDevLink(link);
    throw err;
  }
  // A watch crash is informational, not fatal to the session — surface it via
  // its inherited stdio; don't let the rejection bubble as unhandled.
  for (const watch of watchers) {
    watch.catch(() => {});
  }

  console.log(`Watching ${pluginId} for changes. Press Ctrl-C to stop.`);

  let stopping = false;
  const stopOnce = async (exitAfter: boolean): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await stopDev(pluginId, link, watchers);
    if (exitAfter) process.exit(0);
  };

  const onSignal = (): void => {
    // A second interrupt while teardown is in flight bails hard rather than
    // waiting on a cleanup step that's stuck (lesson #7151).
    if (stopping) {
      process.exit(1);
    }
    void stopOnce(true);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await new Promise<void>((resolve) => {
      const signal = opts.keepAliveSignal;
      if (!signal) return; // production: only a signal ends the wait
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // Reached only via keepAliveSignal (programmatic stop); the signal path
    // exits the process inside stopOnce.
    await stopOnce(false);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

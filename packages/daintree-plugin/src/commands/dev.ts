import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { ResultPromise } from "execa";
import { runValidate } from "./validate.js";
import { resolveVitePlan, runVitePlanBuild, spawnViteWatch } from "../lib/viteBuild.js";
import { sendCliRequest } from "../ipc/client.js";
import { createDevMetricsPoller } from "../lib/devMetrics.js";
import { parseJsonText } from "../lib/parseJsonText.js";

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
  /**
   * Poll Daintree for the plugin's performance measurements and print them
   * against budgets while the session runs. Defaults to on.
   */
  metrics?: boolean;
}

export interface DevLink {
  linkPath: string;
  /** The plugin directory this session serves, resolved. */
  pluginDir: string;
  /**
   * This session's marker, in its own plugin directory. Never reached through
   * the link: a newer session for the same plugin id may have retargeted it.
   */
  markerPath: string;
  /**
   * Stamped into the marker and sent with `plugin.dev.start`/`stop`, so cleanup
   * and Daintree act only on what this session still owns.
   */
  sessionId: string;
  /**
   * True when this invocation created the symlink, so cleanup may remove it. A
   * pre-existing symlink already pointing at this plugin dir is reused and left
   * in place on teardown.
   */
  createdSymlink: boolean;
  /**
   * The link as this session left it: its readlink text and the directory it
   * reached. The session owns the link only while both still hold, so neither
   * a retarget nor a new directory created at a moved plugin dir's path counts.
   */
  linkTarget: string;
  dirIdentity: DirIdentity;
}

interface DirIdentity {
  dev: bigint;
  ino: bigint;
  realPath: string;
}

interface DevMarker {
  sessionId: string;
  pid: number;
}

function defaultPluginsRoot(): string {
  return path.join(os.homedir(), ".daintree", "plugins");
}

/**
 * The session stamped in a marker, or null when there is none to honour: no
 * file, or the empty marker an older CLI writes.
 */
async function readDevMarker(markerPath: string): Promise<DevMarker | null> {
  let text: string;
  try {
    text = await fs.readFile(markerPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<DevMarker> | null;
    if (typeof parsed?.sessionId === "string" && Number.isInteger(parsed.pid)) {
      return { sessionId: parsed.sessionId, pid: parsed.pid as number };
    }
  } catch {
    // Not ours to interpret.
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM is a live process we may not signal. Anything but ESRCH is treated
    // as live too: a false conflict is recoverable, deleting a live session's
    // artifacts is not.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Two sessions in one directory would share a marker and a link, and the first
 * to exit would tear both down, so the second is refused up front. A marker
 * whose process has exited (a crashed session) is stale and can be replaced.
 */
async function assertNoLiveSession(pluginId: string, markerPath: string): Promise<void> {
  const marker = await readDevMarker(markerPath);
  if (marker && isProcessAlive(marker.pid)) {
    throw new Error(
      `A dev session for "${pluginId}" is already running from ${path.dirname(markerPath)} (pid ${marker.pid}). Stop it first, or delete ${markerPath} if that process isn't a dev session.`
    );
  }
}

async function claimDevMarker(
  pluginId: string,
  markerPath: string,
  sessionId: string
): Promise<void> {
  const contents = JSON.stringify({ sessionId, pid: process.pid } satisfies DevMarker);
  try {
    // Exclusive, so of two sessions starting together in one directory only
    // one gets past here.
    await fs.writeFile(markerPath, contents, { flag: "wx" });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  await assertNoLiveSession(pluginId, markerPath);
  await fs.writeFile(markerPath, contents);
}

async function removeOwnMarker(markerPath: string, sessionId: string): Promise<void> {
  if ((await readDevMarker(markerPath))?.sessionId !== sessionId) return;
  await fs.unlink(markerPath);
}

/** The directory a path reaches, or null when it reaches none. */
async function directoryIdentity(p: string): Promise<DirIdentity | null> {
  try {
    const stat = await fs.stat(p, { bigint: true });
    return { dev: stat.dev, ino: stat.ino, realPath: await fs.realpath(p) };
  } catch {
    return null;
  }
}

/**
 * Compared by identity rather than by spelling: a junction's readlink, a
 * case-insensitive volume or a symlinked tmpdir can all spell one directory
 * differently.
 */
function isSameIdentity(a: DirIdentity, b: DirIdentity): boolean {
  // No usable file identity (some network filesystems).
  if (a.ino === 0n || b.ino === 0n) return a.realPath === b.realPath;
  return a.dev === b.dev && a.ino === b.ino;
}

async function isSameDirectory(a: string, b: string): Promise<boolean> {
  const [identityA, identityB] = await Promise.all([directoryIdentity(a), directoryIdentity(b)]);
  return identityA !== null && identityB !== null && isSameIdentity(identityA, identityB);
}

/** Whether the link is still the one this session set up, into its directory. */
async function linkTargetsSession(link: DevLink): Promise<boolean> {
  try {
    if (!(await fs.lstat(link.linkPath)).isSymbolicLink()) return false;
    if ((await fs.readlink(link.linkPath)) !== link.linkTarget) return false;
  } catch {
    return false;
  }
  const reached = await directoryIdentity(link.linkPath);
  // Dangling: the plugin dir was deleted or moved mid-session. The link is
  // still the one this session set up, so it is still this session's.
  if (!reached) return true;
  return isSameIdentity(reached, link.dirIdentity);
}

/**
 * Stamp this session's `.dev-marker` into the plugin dir, then symlink the dir
 * into the plugins root. The CLI owns this symlink directly (it isn't a real
 * install, so it bypasses `PluginInstaller` and its content-mutation invariant,
 * #9292). Never removes a real directory at the link path — that would be an
 * installed plugin, not ours to delete.
 */
export async function linkDevPlugin(args: {
  pluginDir: string;
  pluginsRoot: string;
  pluginId: string;
}): Promise<DevLink> {
  const { pluginsRoot, pluginId } = args;
  const pluginDir = path.resolve(args.pluginDir);
  const linkPath = path.join(pluginsRoot, pluginId);
  const markerPath = path.join(pluginDir, DEV_MARKER_FILENAME);
  const sessionId = randomUUID();
  const symlinkType = process.platform === "win32" ? "junction" : undefined;

  // The marker goes first: one that can't be written leaves no link behind,
  // and a link that can't be made takes the marker back off.
  await claimDevMarker(pluginId, markerPath, sessionId);

  let createdSymlink: boolean;
  let linkTarget: string;
  let dirIdentity: DirIdentity | null;
  try {
    await fs.mkdir(pluginsRoot, { recursive: true });
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
      if (await isSameDirectory(linkPath, pluginDir)) {
        // Already linked to this plugin — reuse without claiming ownership.
        createdSymlink = false;
      } else {
        // Another directory's link (an older session, or one that crashed). That
        // session's exit leaves this link alone once it no longer points there.
        await fs.unlink(linkPath);
        await fs.symlink(pluginDir, linkPath, symlinkType);
        createdSymlink = true;
      }
    }
    linkTarget = await fs.readlink(linkPath);
    dirIdentity = await directoryIdentity(pluginDir);
    if (!dirIdentity) throw new Error(`Can't dev-link "${pluginId}": ${pluginDir} is unreadable.`);
  } catch (err) {
    await removeOwnMarker(markerPath, sessionId).catch(() => {});
    throw err;
  }

  return {
    linkPath,
    pluginDir,
    markerPath,
    sessionId,
    createdSymlink,
    linkTarget,
    dirIdentity,
  };
}

/**
 * Remove what this session still owns. Idempotent and per-step best-effort (one
 * failing step must not strand the others, lesson #9322). A link a newer
 * session has retargeted, and that session's marker, are left alone. The link
 * comes off first: the marker is what reserves this directory, so releasing it
 * earlier would let a session starting here reuse the link and then lose it.
 * Left behind on its own, the marker reroutes nothing — Daintree only ever
 * reaches it through a link.
 */
export async function cleanupDevLink(link: DevLink): Promise<void> {
  if (link.createdSymlink) {
    try {
      // Checked as late as possible: a newer session may have retargeted the
      // link while this one waited on Daintree.
      if (await linkTargetsSession(link)) await fs.unlink(link.linkPath);
    } catch {
      // best-effort — symlink may already be gone
    }
  }
  try {
    await removeOwnMarker(link.markerPath, link.sessionId);
  } catch {
    // best-effort — marker may already be gone
  }
}

/** Best-effort unload request — Daintree may have been closed first. */
async function sendDevStop(pluginId: string, sessionId: string): Promise<void> {
  try {
    await sendCliRequest("plugin.dev.stop", { pluginId, sessionId });
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

/**
 * Stop the build watchers, ask Daintree to unload, and remove the dev artifacts.
 * Once a newer session from another directory has taken the link over, the
 * plugin Daintree has loaded is that session's, so only the local marker goes.
 */
async function stopDev(
  pluginId: string,
  link: DevLink,
  watchers: readonly ResultPromise[]
): Promise<void> {
  killWatchers(watchers);
  if (await linkTargetsSession(link)) await sendDevStop(pluginId, link.sessionId);
  await cleanupDevLink(link);
}

/**
 * Run the hot-reload dev loop for the plugin in `dir`: build once, stamp a
 * `.dev-marker` and symlink it into the plugins root, tell the running Daintree to load
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

  const manifest = parseJsonText(await fs.readFile(path.join(dir, "plugin.json"), "utf8")) as {
    name: string;
    main?: string;
  };
  if (!manifest.main) {
    throw new Error('Plugin has no "main" entry — dev hot-reload needs a built entry point.');
  }
  const pluginId = manifest.name;
  const pluginsRoot = opts.pluginsRoot ?? defaultPluginsRoot();

  // Before the build too, which would rewrite dist/ under the running session.
  await assertNoLiveSession(pluginId, path.join(dir, DEV_MARKER_FILENAME));

  const plan = resolveVitePlan(dir);

  // Build once so dist/<main> exists before Daintree loads the plugin —
  // otherwise the marker is present but the worker has no bundle to import.
  if (!opts.skipBuild) {
    await runVitePlanBuild(dir, plan);
  }

  const link = await linkDevPlugin({ pluginDir: dir, pluginsRoot, pluginId });

  try {
    await sendCliRequest("plugin.dev.start", { pluginId, sessionId: link.sessionId });
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
      const watch = spawnViteWatch(dir, args);
      // Attach before the next spawn can throw, not after the loop: execa
      // rejects on signal termination, so a watcher killed by the catch below
      // would otherwise reject with nobody listening and mask the real error.
      // A watch crash is informational anyway, not fatal to the session — it
      // surfaces through the inherited stdio.
      watch.catch(() => {});
      watchers.push(watch);
    }
  } catch (err) {
    await stopDev(pluginId, link, watchers);
    throw err;
  }

  console.log(`Watching ${pluginId} for changes. Press Ctrl-C to stop.`);

  const metricsPoller =
    opts.metrics === false
      ? null
      : createDevMetricsPoller({
          pluginId,
          request: sendCliRequest,
          print: (text) => console.log(text),
        });
  metricsPoller?.start();

  let stopping = false;
  const stopOnce = async (exitAfter: boolean): Promise<void> => {
    if (stopping) return;
    stopping = true;
    metricsPoller?.stop();
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

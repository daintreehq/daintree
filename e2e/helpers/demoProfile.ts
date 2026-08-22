import type { ElectronApplication, Page } from "@playwright/test";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { removePathSync } from "./fixtures";
import { buildScene, type BuiltScene, type DemoScene } from "./demoScene";
import { closeApp, launchApp } from "./launch";
import { openAndOnboardProject } from "./project";

/**
 * Bake an app profile once, snapshot it, and restore it before every take.
 *
 * The alternative — hand-writing the persisted state — was rejected because
 * Daintree spreads durable state across several independent surfaces with their
 * own migration chains: `daintree.db` (better-sqlite3, WAL), electron-store
 * `config.json`, per-project `projects/<id>/state.json` written by
 * `ProjectStateManager`, and Chromium's persistent partitions. A hand-authored
 * profile would rot the first time any one of them moved. Driving the real app
 * and copying what it wrote is schema-correct by construction — provided every
 * writer has actually stopped first, which is what the quiescence barrier below
 * exists to guarantee.
 */
const PROFILE_MARKER_NAME = ".daintree-demo-profile";

/** Written last, so its presence is what makes a snapshot complete. */
const MANIFEST_NAME = ".daintree-demo-manifest.json";

const MANIFEST_VERSION = 1;

/**
 * Cache-shaped directories, excluded wherever they appear.
 *
 * Depth matters: the renderer runs on a `persist:daintree` partition and
 * browser panels get their own per-project partitions, so the caches that
 * dominate a profile's size live under `Partitions/<name>/`, not at the top
 * level. A top-level-only filter leaves all of them in the snapshot.
 */
const CACHE_DIR_NAMES = new Set([
  "Cache",
  "Cache_Data",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "ShaderCache",
  "blob_storage",
  "compile-cache",
  "agent-compile-cache",
  "Crashpad",
  "component_crx_cache",
  "logs",
]);

/**
 * Top-level entries that would poison a restored profile.
 *
 * These are correctness, not housekeeping:
 *
 * - `crash-loop-state.json` drives crash-loop backoff and safe mode; a stale one
 *   can put a take into safe mode for something that happened days ago.
 * - `trashed-pids.json` is read at startup and its PIDs are killed as orphans.
 *   Restoring a stale list points that at whatever owns those PIDs today.
 * - `watchdog-kill.flag` carries a PID and timestamp from the bake session.
 * - `mcp-pane-configs` holds loopback ports and bearer tokens.
 * - `DevToolsActivePort` advertises a port nothing is listening on.
 * - `gpu-disabled.flag` / `gpu-angle-fallback.flag` encode driver mitigations for
 *   the machine that baked, and take effect before the app is ready.
 * - `assistant-scratch` is explicitly launch-scoped.
 *
 * `running.lock` is deliberately absent: rather than filter the dirty-exit
 * marker away, `snapshotProfile` refuses outright when it is present. Silently
 * dropping it would launder a killed app into a "clean" profile.
 */
const EXCLUDED_TOP_LEVEL = new Set([
  "crash-loop-state.json",
  "trashed-pids.json",
  "watchdog-kill.flag",
  "mcp-pane-configs",
  "DevToolsActivePort",
  "gpu-disabled.flag",
  "gpu-angle-fallback.flag",
  "assistant-scratch",
]);

/**
 * Stale crash-recovery state. It is only consulted alongside a dirty-exit
 * marker, so it cannot misfire on a clean boot — but if a take crashes before
 * writing its own backup, this is what the app would offer to restore.
 * `backups/` itself is kept: `dev-preview-manifest.json` there is intentional
 * durable state a staged dev-preview panel needs.
 */
const EXCLUDED_RELATIVE = new Set([
  path.join("backups", "session-state.json"),
  path.join("backups", "session-state.previous.json"),
]);

const EXCLUDED_PREFIXES = ["Singleton"];

/**
 * Leftover sidecars from an interrupted SQLite backup. A clean shutdown
 * checkpoints and removes the live database's own WAL files, so anything
 * `-wal`/`-shm` still on disk belongs to a temp file rather than to state.
 */
const EXCLUDED_SUFFIXES = [".tmp-wal", ".tmp-shm"];

/** The dirty-exit marker. Its presence means the previous run did not finish. */
const DIRTY_EXIT_MARKER = "running.lock";

type ProfileRole = "snapshot" | "work";

interface ProfileManifest {
  version: number;
  role: ProfileRole;
  slug: string;
  bakedAt: string;
  /** Absolute paths the profile is bound to; a snapshot is not portable. */
  projectPath: string;
  worktreePaths: string[];
  platform: string;
}

interface OwnershipMarker {
  slug: string;
  role: ProfileRole;
}

function markerPath(dir: string): string {
  return path.join(dir, PROFILE_MARKER_NAME);
}

function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_NAME);
}

function readOwnershipMarker(dir: string): OwnershipMarker | null {
  const file = markerPath(dir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as OwnershipMarker).slug === "string"
    ) {
      return parsed as OwnershipMarker;
    }
  } catch {
    // A corrupt marker is not proof of ownership.
  }
  return null;
}

export function readProfileManifest(dir: string): ProfileManifest | null {
  const file = manifestPath(dir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as ProfileManifest).version === MANIFEST_VERSION
    ) {
      return parsed as ProfileManifest;
    }
  } catch {
    // Unreadable manifest means incomplete.
  }
  return null;
}

function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Take ownership of a directory this harness is about to fill, refusing
 * anything it cannot prove it owns.
 *
 * Both the snapshot and the live bake directory get wiped, and the live one is
 * handed straight to Electron as `--user-data-dir`. Pointing that at a real
 * Daintree profile would migrate it, mutate it, and then copy its
 * `config.json` — which holds API keys, forge tokens and environment — into a
 * snapshot. An unmarked, non-empty directory is somebody's real data.
 */
function claimDirectory(dir: string, slug: string, role: ProfileRole): void {
  if (existsSync(dir)) {
    if (!lstatSync(dir).isDirectory()) {
      throw new Error(`Refusing to use ${dir}: it is not a directory`);
    }
    if (existsSync(path.join(dir, DIRTY_EXIT_MARKER))) {
      throw new Error(
        `Refusing to use ${dir}: it contains ${DIRTY_EXIT_MARKER}, so an app may still be running there.`
      );
    }
    const marker = readOwnershipMarker(dir);
    if (!marker) {
      if (!isEmptyDir(dir)) {
        throw new Error(
          `Refusing to overwrite ${dir}: it is not a demo profile this harness created. ` +
            `Point at a dedicated directory, or remove it by hand.`
        );
      }
    } else if (marker.slug !== slug) {
      throw new Error(
        `Refusing to overwrite ${dir}: it belongs to demo profile "${marker.slug}", not "${slug}".`
      );
    }
    removePathSync(dir);
  }
  mkdirSync(dir, { recursive: true });
  const marker: OwnershipMarker = { slug, role };
  writeFileSync(markerPath(dir), JSON.stringify(marker, null, 2) + "\n");
}

function isExcluded(relativePath: string): boolean {
  if (EXCLUDED_RELATIVE.has(relativePath)) return true;

  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => CACHE_DIR_NAMES.has(segment))) return true;

  const [first] = segments;
  if (first === undefined || first.length === 0) return false;
  if (EXCLUDED_TOP_LEVEL.has(first)) return true;
  if (EXCLUDED_PREFIXES.some((prefix) => first.startsWith(prefix))) return true;
  return EXCLUDED_SUFFIXES.some((suffix) => first.endsWith(suffix));
}

function copyProfileTree(sourceDir: string, targetDir: string): void {
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => {
      const relative = path.relative(sourceDir, src);
      if (relative.length === 0) return true;
      if (relative === PROFILE_MARKER_NAME || relative === MANIFEST_NAME) return false;
      if (isExcluded(relative)) return false;
      // Sockets and FIFOs cannot be copied and mean nothing in a snapshot.
      try {
        const stats = lstatSync(src);
        return stats.isFile() || stats.isDirectory() || stats.isSymbolicLink();
      } catch {
        return false;
      }
    },
  });
}

/**
 * A cheap fingerprint of every file in the profile: path, size and mtime.
 * Caches are skipped because they churn continuously and would never settle.
 */
function profileSignature(dir: string, relative = ""): string[] {
  const entries: string[] = [];
  let names: string[];
  try {
    names = readdirSync(path.join(dir, relative)).sort();
  } catch {
    return entries;
  }
  for (const name of names) {
    const childRelative = relative.length === 0 ? name : path.join(relative, name);
    if (isExcluded(childRelative)) continue;
    const absolute = path.join(dir, childRelative);
    try {
      const stats = lstatSync(absolute);
      if (stats.isDirectory()) {
        entries.push(...profileSignature(dir, childRelative));
      } else if (stats.isFile()) {
        entries.push(`${childRelative}:${stats.size}:${stats.mtimeMs}`);
      }
    } catch {
      // Vanished mid-walk — treat as churn; the next poll will see it settle.
      entries.push(`${childRelative}:gone`);
    }
  }
  return entries;
}

export interface QuiescenceOptions {
  /** How long the profile must stop changing for. Must exceed every debounce. */
  settleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Wait until nothing is still writing to the profile.
 *
 * This is the barrier that makes `setup()` reliable. Panel and tab-group state
 * is written through a 500ms debounce (`panelPersistence`), and the renderer's
 * flush API is not reachable from a test without adding product code — so a
 * `setup()` that arranges panels and returns immediately can be snapshotted
 * before any of it reaches disk. Rather than enumerate every writer and its
 * timing, wait for the whole directory to stop changing: that covers SQLite,
 * electron-store, per-project state and anything added later, at once.
 */
export async function waitForProfileQuiescence(
  dir: string,
  options: QuiescenceOptions = {}
): Promise<void> {
  const settleMs = options.settleMs ?? 1_500;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;

  const deadline = Date.now() + timeoutMs;
  let previous = profileSignature(dir).join("\n");
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const current = profileSignature(dir).join("\n");
    if (current === previous) {
      if (Date.now() - stableSince >= settleMs) return;
    } else {
      previous = current;
      stableSince = Date.now();
    }
  }
  throw new Error(
    `Profile at ${dir} never stopped changing within ${timeoutMs}ms — something is still writing.`
  );
}

/**
 * Copy a live profile directory into a snapshot.
 *
 * Publication is atomic: the copy lands in a sibling staging directory and is
 * only swapped into place once complete. A straight delete-then-copy would
 * destroy the last good golden profile on any mid-copy failure and leave a
 * partial directory that still looked valid.
 */
export function snapshotProfile(
  sourceDir: string,
  snapshotDir: string,
  details: { slug: string; projectPath: string; worktreePaths: string[] }
): void {
  if (!existsSync(sourceDir)) {
    throw new Error(`Cannot snapshot ${sourceDir}: it does not exist`);
  }
  if (existsSync(path.join(sourceDir, DIRTY_EXIT_MARKER))) {
    // Filtering the marker away instead would launder a force-killed app into a
    // profile the next launch believes exited cleanly — which also skips the
    // startup database integrity check.
    throw new Error(
      `Refusing to snapshot ${sourceDir}: ${DIRTY_EXIT_MARKER} is present, so the app did not ` +
        `shut down cleanly and its state may be torn.`
    );
  }
  if (path.resolve(sourceDir) === path.resolve(snapshotDir)) {
    throw new Error("Cannot snapshot a directory onto itself");
  }

  const staging = `${snapshotDir}.staging-${process.pid}`;
  removePathSync(staging);
  try {
    claimDirectory(staging, details.slug, "snapshot");
    copyProfileTree(sourceDir, staging);

    const manifest: ProfileManifest = {
      version: MANIFEST_VERSION,
      role: "snapshot",
      slug: details.slug,
      bakedAt: new Date().toISOString(),
      projectPath: path.resolve(details.projectPath),
      worktreePaths: details.worktreePaths.map((p) => path.resolve(p)),
      platform: process.platform,
    };
    // Written last: a snapshot without a manifest is an incomplete one.
    writeFileSync(manifestPath(staging), JSON.stringify(manifest, null, 2) + "\n");

    // Only now is the previous snapshot expendable.
    if (existsSync(snapshotDir)) {
      const marker = readOwnershipMarker(snapshotDir);
      if (!marker && !isEmptyDir(snapshotDir)) {
        throw new Error(
          `Refusing to overwrite ${snapshotDir}: it is not a demo profile this harness created.`
        );
      }
      removePathSync(snapshotDir);
    }
    mkdirSync(path.dirname(snapshotDir), { recursive: true });
    renameSync(staging, snapshotDir);
  } finally {
    removePathSync(staging);
  }
}

/**
 * Reset a working profile back to a snapshot. This is the per-take operation:
 * it must be cheap and total, so the directory is replaced rather than merged.
 */
export function restoreProfile(snapshotDir: string, workDir: string): void {
  if (path.resolve(snapshotDir) === path.resolve(workDir)) {
    throw new Error("Cannot restore a snapshot onto itself");
  }
  const manifest = readProfileManifest(snapshotDir);
  if (!manifest) {
    throw new Error(
      `Cannot restore from ${snapshotDir}: no complete snapshot manifest. It is missing, ` +
        `from an older harness version, or the snapshot did not finish.`
    );
  }
  if (manifest.platform !== process.platform) {
    throw new Error(
      `Cannot restore ${snapshotDir}: baked on ${manifest.platform}, running on ${process.platform}. ` +
        `A profile records absolute paths and is not portable.`
    );
  }
  // The profile references the scene by absolute path; without the scene, a
  // restored take opens a project whose repository no longer exists.
  if (!existsSync(manifest.projectPath)) {
    throw new Error(
      `Cannot restore ${snapshotDir}: its project is gone (${manifest.projectPath}). Rebuild the scene.`
    );
  }

  claimDirectory(workDir, manifest.slug, "work");
  copyProfileTree(snapshotDir, workDir);
  writeFileSync(
    manifestPath(workDir),
    JSON.stringify({ ...manifest, role: "work" } satisfies ProfileManifest, null, 2) + "\n"
  );
}

export interface BakeContext {
  app: ElectronApplication;
  /** The project view's page, already opened and onboarded. */
  page: Page;
  scene: BuiltScene;
}

export interface BakeProfileOptions {
  scene: DemoScene;
  /** Where the reusable snapshot is written. */
  snapshotDir: string;
  /** Live profile used while baking. Defaults to a temp directory. */
  workDir?: string;
  /** Window geometry the take should open at. */
  windowSize?: { width: number; height: number };
  /**
   * Drive the app into the state a take should open on — panels, active
   * worktree, theme, whatever the scene needs. Runs after the project is open
   * and before the profile is allowed to settle and close.
   */
  setup?: (context: BakeContext) => Promise<void>;
  quiescence?: QuiescenceOptions;
}

export interface BakedProfile {
  snapshotDir: string;
  scene: BuiltScene;
  /** Absolute path of the project the profile opens on launch. */
  projectPath: string;
  /** Remove the scene AND the snapshot. Takes stop working once called. */
  cleanup: () => void;
}

/**
 * Build the scene, drive the app once, and snapshot the profile it wrote.
 *
 * The app is closed before the copy, and the profile is allowed to go quiet
 * before that — see `waitForProfileQuiescence` and `snapshotProfile` for why
 * neither step is optional.
 */
export async function bakeProfile(options: BakeProfileOptions): Promise<BakedProfile> {
  const usingTempWorkDir = options.workDir === undefined;
  const workDir = options.workDir ?? mkdtempSync(path.join(tmpdir(), "daintree-demo-profile-"));
  let built: BuiltScene | null = null;
  let app: ElectronApplication | null = null;

  try {
    built = buildScene(options.scene);
    // A caller-supplied work directory is handed to Electron as its user-data
    // dir, so it gets the same refuse-what-we-do-not-own treatment.
    if (!usingTempWorkDir) claimDirectory(workDir, built.slug, "work");

    const context = await launchApp({ userDataDir: workDir });
    app = context.app;

    if (options.windowSize) {
      // launchApp only applies windowSize when it owns the user-data dir, and
      // baking always supplies one — so set the geometry here or it is lost.
      const size = options.windowSize;
      await app.evaluate(({ BrowserWindow }, target) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.setBounds({ width: target.width, height: target.height });
        win?.center();
      }, size);
    }

    const page = await openAndOnboardProject(context.app, context.window, built.dir);
    await options.setup?.({ app: context.app, page, scene: built });

    // Let every writer finish before the process goes away.
    await waitForProfileQuiescence(workDir, options.quiescence);

    await closeApp(app);
    app = null;

    snapshotProfile(workDir, options.snapshotDir, {
      slug: built.slug,
      projectPath: built.dir,
      worktreePaths: built.worktrees.map((worktree) => worktree.path),
    });
  } catch (error) {
    if (app) await closeApp(app).catch(() => {});
    built?.cleanup();
    throw error;
  } finally {
    if (usingTempWorkDir) {
      try {
        removePathSync(workDir);
      } catch {
        // A leftover temp profile is noise, not a failure.
      }
    }
  }

  const scene = built;
  return {
    snapshotDir: options.snapshotDir,
    scene,
    projectPath: scene.dir,
    cleanup: () => {
      scene.cleanup();
      try {
        removePathSync(options.snapshotDir);
      } catch {
        // Best-effort.
      }
    },
  };
}

/** Exposed so tests can reason about what a snapshot keeps. */
export const __testing = { isExcluded };

import path from "path";
import { createHash } from "crypto";
import { existsSync, promises as fsp, watch as fsWatch, type FSWatcher } from "fs";

import type { AsyncSubscription } from "@parcel/watcher";

import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { createLogger } from "../../utils/logger.js";
import { subscribeParcelWatcher } from "../../utils/parcelWatcherBackend.js";
import { getGitDir } from "../../utils/gitUtils.js";
import {
  PROJECT_PLUGINS_DIR_SEGMENTS,
  type ProjectPluginDiscoveryResult,
} from "./projectPluginDiscovery.js";

const logger = createLogger("main:ProjectPluginWatcher");

/**
 * Trailing debounce. A rebuild writes a whole `dist/` and a branch switch
 * rewrites the tree; both arrive as a storm of events whose only useful
 * interpretation is "look again once it stops".
 */
const RELOAD_DEBOUNCE_MS = 200;

/** How often to re-check a `.git/index.lock` we are waiting behind. */
const GIT_LOCK_POLL_MS = 150;

/**
 * Ceiling on that wait. A crashed `git` leaves `index.lock` behind forever, and
 * a watcher that defers forever is a watcher that silently stopped working.
 */
const GIT_LOCK_MAX_DEFER_MS = 30_000;

/** Backoff between re-reads of a manifest that did not parse. */
const INVALID_MANIFEST_RETRY_MS = 400;

/**
 * How many times an unreadable manifest buys the running plugin a reprieve. A
 * mid-write window is milliseconds; past ~2s the file is genuinely broken and
 * the ordinary reconcile should disable it with its own persistent diagnostic
 * (the `invalid` row `listProjectPlugins` already renders).
 */
const INVALID_MANIFEST_MAX_RETRIES = 5;

/**
 * How long to wait before re-arming a subscription that errored, and how many
 * times to try. An erroring watch is usually a deleted-and-recreated root,
 * which inotify and ReadDirectoryChangesW do not follow on their own.
 */
const REARM_DELAY_MS = 1_000;
const REARM_MAX_ATTEMPTS = 5;

/** Overridable cadence, so tests do not have to spend real seconds on backoff. */
export interface ProjectPluginWatcherTimings {
  debounceMs: number;
  gitLockPollMs: number;
  gitLockMaxDeferMs: number;
  invalidManifestRetryMs: number;
  invalidManifestMaxRetries: number;
}

const DEFAULT_TIMINGS: ProjectPluginWatcherTimings = {
  debounceMs: RELOAD_DEBOUNCE_MS,
  gitLockPollMs: GIT_LOCK_POLL_MS,
  gitLockMaxDeferMs: GIT_LOCK_MAX_DEFER_MS,
  invalidManifestRetryMs: INVALID_MANIFEST_RETRY_MS,
  invalidManifestMaxRetries: INVALID_MANIFEST_MAX_RETRIES,
};

export interface ProjectPluginWatcherDeps {
  /** Re-scan the folder. Parses manifests and executes nothing. */
  discover: (projectRoot: string) => Promise<ProjectPluginDiscoveryResult>;
  /** Manifest ids currently loaded for this project. */
  loadedManifestIds: (projectId: string) => readonly string[];
  /**
   * Drop the named plugins and re-run the project-open path. This is the same
   * idempotent reconcile a project switch runs — trust gate, staging rules and
   * generation guard included — not a second loader.
   */
  reload: (projectId: string, projectRoot: string, manifestIds: readonly string[]) => Promise<void>;
  /** Session total of allocated `__dtv-N` view generations, for instrumentation. */
  viewGenerationsAllocated: () => number;
  /** `.git` dir for a project root, or `null` when it is not a repository. */
  resolveGitDir?: (projectRoot: string) => Promise<string | null>;
  /** Register an app-quit disposer. Optional so unit tests need no Electron. */
  onAppQuit?: (dispose: () => void) => void;
  timings?: Partial<ProjectPluginWatcherTimings>;
}

interface WatchState {
  projectId: string;
  /** As the project store knows it. Passed straight back to `reload`. */
  projectRoot: string;
  /** Realpath of `<projectRoot>/.daintree/plugins`, set once armed. */
  pluginsRoot: string;
  /**
   * Bumped by every stop and re-arm. Every post-await step compares it before
   * committing, so a subscription that resolves after a close is unsubscribed
   * rather than stored, and a settle that resumes after a close does nothing.
   */
  generation: number;
  subscription: AsyncSubscription | null;
  /**
   * Cheap single-directory watch armed while `.daintree/plugins/` does not
   * exist, so an agent (or a checkout) creating the folder mid-session is
   * noticed instead of waiting for the next project switch.
   */
  sentinel: FSWatcher | null;
  /**
   * The directory {@link sentinel} is actually watching. `fs.watch` is not
   * recursive, so a sentinel sitting on the project root cannot see
   * `.daintree/plugins` being created two levels down — it has to migrate
   * inward as each ancestor appears (#12212).
   */
  sentinelPath: string | null;
  /**
   * Reconcile on the next settle even when no fingerprint moved.
   *
   * Set when the plugins folder has just appeared. `arm()` seeds a fingerprint
   * for everything it finds, so a folder that arrives complete — an agent
   * writing the whole plugin, a checkout, an atomic rename — settles with
   * nothing "changed" and would return before reaching the controller. The
   * project would then stay silent until an unrelated write, which is the
   * failure #12212 is about.
   */
  forceReconcile: boolean;
  rearmAttempts: number;
  arming: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Plugin directory names implicated by the current burst. */
  changedDirs: Set<string>;
  /** True when the burst touched the plugins root itself and cannot be attributed. */
  reloadAll: boolean;
  invalidRetries: number;
  /** The unreadable set the current retry budget belongs to. */
  invalidRetryKey: string;
  gitLockWaitStartedAt: number | null;
  /** manifest id → directory name, learned from every scan that parsed. */
  dirByManifestId: Map<string, string>;
  /** directory name → artifact fingerprint at the last arm or settle. */
  fingerprintByDir: Map<string, string>;
  /** A settle is in flight; a concurrent burst re-queues instead of racing it. */
  running: boolean;
  rerunRequested: boolean;
  stopped: boolean;
  /** Reloads driven by this watcher, for the generation-accumulation readout. */
  reloadCount: number;
  /** Resolved once, and only when the resolution succeeded. */
  gitDir: string | null;
}

/** Depth and file-count ceilings on a fingerprint walk. A `dist/` is small. */
const FINGERPRINT_MAX_DEPTH = 8;
const FINGERPRINT_MAX_FILES = 4_000;

/** Fingerprint of a directory that is not there at all. */
const ABSENT_FINGERPRINT = "absent";

/**
 * A cheap "did this plugin's loadable artifact actually change?" stamp over
 * `plugin.json` + `dist/`: a hash of every file's path, size and mtime at
 * nanosecond resolution.
 *
 * This is not paranoia about redundant work — it is what makes the watcher
 * usable at all. macOS FSEvents replays recent history to a new subscription,
 * so arming a watcher just after a project open delivers `create` events for
 * every file the checkout (or the loader itself) had just touched. Without a
 * before/after comparison, every project open would immediately restart every
 * plugin it had just loaded.
 *
 * Per file rather than aggregated: totalling sizes and taking the newest mtime
 * lets two rewritten chunks cancel each other out, which is exactly the shape a
 * rebuild produces. A missing directory stamps as {@link ABSENT_FINGERPRINT},
 * which is what makes a deletion a change rather than a silence.
 */
async function fingerprintPluginDir(dir: string): Promise<string> {
  let files = 0;
  const parts: string[] = [];

  const account = async (relPath: string, filePath: string): Promise<void> => {
    try {
      const stat = await fsp.stat(filePath, { bigint: true });
      files++;
      parts.push(`${relPath}\u0000${stat.size}\u0000${stat.mtimeNs}`);
    } catch {
      // Raced with a delete mid-walk; the next settle sees the settled tree.
    }
  };

  const walk = async (dirPath: string, depth: number): Promise<void> => {
    if (depth > FINGERPRINT_MAX_DEPTH || files >= FINGERPRINT_MAX_FILES) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    // Directory order is not stable across filesystems, and the hash is order
    // sensitive.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files >= FINGERPRINT_MAX_FILES) return;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        // Symlinks count too: `stat` follows them, so a repointed link is a
        // changed artifact.
        await account(path.relative(dir, full), full);
      }
    }
  };

  try {
    await fsp.stat(dir);
  } catch {
    return ABSENT_FINGERPRINT;
  }

  await account("plugin.json", path.join(dir, "plugin.json"));
  await walk(path.join(dir, "dist"), 0);
  return createHash("sha1").update(parts.join("\u0001")).digest("hex");
}

type Attribution = { kind: "ignore" } | { kind: "all" } | { kind: "dir"; dirName: string };

/**
 * Which plugin directory a raw watcher event belongs to — and whether it is one
 * we care about at all.
 *
 * Only `plugin.json` and `dist/` count. `src/` is deliberately not watched: the
 * host does not know how a given plugin builds, so a source write says nothing
 * about whether a loadable artifact exists yet, and watching it would fire on
 * every keystroke.
 *
 * On macOS FSEvents coalesces a mass rewrite into a flag on the containing
 * directory, so a bare `<dir>` event is normal and means "rescan that plugin",
 * and an event on the plugins root itself means "rescan everything".
 */
export function attributeProjectPluginEvent(pluginsRoot: string, eventPath: string): Attribution {
  const rel = path.relative(pluginsRoot, eventPath);
  if (rel === "") return { kind: "all" };
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { kind: "ignore" };

  const segments = rel.split(path.sep);
  const dirName = segments[0];
  if (!dirName) return { kind: "ignore" };
  // Discovery skips dot-prefixed names outright, so nothing under one can ever
  // become a plugin.
  if (dirName.startsWith(".")) return { kind: "ignore" };
  if (segments.length === 1) return { kind: "dir", dirName };

  const second = segments[1];
  if (second === "plugin.json" || second === "dist") return { kind: "dir", dirName };
  return { kind: "ignore" };
}

/**
 * Hot reload for project-local plugins (§7.10).
 *
 * One recursive watcher subscription per trusted project, over
 * `<projectRoot>/.daintree/plugins`. A settled burst is treated as "rescan the
 * plugin dir", never as "these exact files changed", and the rescan is handed
 * to the ordinary project-open reconcile rather than to a second loader — which
 * is what makes the trust gate, the staging rules, the per-project
 * serialization chain and the generation guard apply to a hot reload for free.
 *
 * Two properties are this class's own, because nothing upstream provides them:
 *
 * **A git operation is not a plugin change.** While `index.lock` exists the
 * tree is mid-rewrite and any scan of it is a scan of a half-applied state, so
 * the settle defers rather than reconciling against rubble.
 *
 * **A half-written manifest never kills a running plugin.** The rescan happens
 * before anything is unloaded; if a currently-active plugin's `plugin.json` no
 * longer parses, the running version is kept and the settle retries. Only a
 * manifest still broken after the backoff falls through to the ordinary
 * reconcile, which disables it and leaves the `invalid` row as the persistent
 * diagnostic. A folder that has *vanished* is a different signal and unloads
 * immediately, exactly as a branch switch should.
 */
export class ProjectPluginWatcher {
  private readonly states = new Map<string, WatchState>();
  private readonly timings: ProjectPluginWatcherTimings;
  private disposed = false;

  constructor(private readonly deps: ProjectPluginWatcherDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.deps.onAppQuit?.(() => this.dispose());
  }

  /**
   * Watch this project's plugin folder, or keep watching it. Idempotent — the
   * reload path itself re-enters the project-open path, which calls this again.
   */
  async ensure(projectId: string, projectRoot: string): Promise<void> {
    if (this.disposed || !projectId || !projectRoot) return;

    const existing = this.states.get(projectId);
    if (existing) {
      if (existing.projectRoot === projectRoot) {
        // A previous arm found no folder, or its subscribe failed. Retry it —
        // this is how `.daintree/plugins/` appearing mid-session is picked up.
        if (!existing.subscription && !existing.arming) await this.arm(existing);
        return;
      }
      // The project moved. The old subscription points at a stale tree.
      this.stop(projectId);
    }

    const state: WatchState = {
      projectId,
      projectRoot,
      pluginsRoot: path.join(projectRoot, ...PROJECT_PLUGINS_DIR_SEGMENTS),
      generation: 0,
      subscription: null,
      sentinel: null,
      sentinelPath: null,
      forceReconcile: false,
      rearmAttempts: 0,
      arming: false,
      timer: null,
      changedDirs: new Set(),
      reloadAll: false,
      invalidRetries: 0,
      invalidRetryKey: "",
      gitLockWaitStartedAt: null,
      dirByManifestId: new Map(),
      fingerprintByDir: new Map(),
      running: false,
      rerunRequested: false,
      stopped: false,
      reloadCount: 0,
      gitDir: null,
    };
    this.states.set(projectId, state);
    await this.arm(state);
  }

  /** Stop watching one project: close, revoke, or a moved project root. */
  stop(projectId: string): void {
    const state = this.states.get(projectId);
    if (!state) return;
    this.states.delete(projectId);
    this.teardown(state);
  }

  /** App quit, or service disposal. Every native subscription goes with it. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of [...this.states.values()]) this.teardown(state);
    this.states.clear();
  }

  /** Is a live subscription held for this project? Tests and diagnostics only. */
  isWatching(projectId: string): boolean {
    return this.states.get(projectId)?.subscription != null;
  }

  // ---------------------------------------------------------------------

  private teardown(state: WatchState): void {
    state.stopped = true;
    // Bump BEFORE releasing anything, so an arm or a settle already awaiting
    // sees the invalidation the moment it resumes.
    state.generation++;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.disarmSentinel(state);
    const subscription = state.subscription;
    state.subscription = null;
    if (!subscription) return;
    void subscription.unsubscribe().catch((err: unknown) => {
      logger.warn("Unsubscribing the project plugin watcher failed", {
        projectId: state.projectId,
        error: formatErrorMessage(err, "unsubscribe failed"),
      });
    });
  }

  private async arm(state: WatchState): Promise<void> {
    const generation = state.generation;
    // Claimed before the first await, not after: two concurrent `ensure()`
    // calls would otherwise both pass the `!arming` test and open two native
    // subscriptions.
    if (state.arming) return;
    state.arming = true;
    try {
      await this.doArm(state, generation);
    } finally {
      state.arming = false;
    }
  }

  private async doArm(state: WatchState, generation: number): Promise<void> {
    // FSEvents reports realpaths (`/private/var/...` for a `/var/...` watch),
    // and attribution is a path-relative test — so the root we compare against
    // has to be the resolved one. This is also the existence check: no folder,
    // no watcher.
    let pluginsRoot: string;
    try {
      pluginsRoot = await fsp.realpath(state.pluginsRoot);
      const stat = await fsp.stat(pluginsRoot);
      if (!stat.isDirectory()) return;
    } catch {
      // The folder is not there yet. Wait for it rather than going dark until
      // the next project switch — "the agent just created the plugin" is the
      // headline case for this feature.
      if (!this.isStale(state, generation)) this.armSentinel(state, generation);
      return;
    }
    if (this.isStale(state, generation)) return;
    state.pluginsRoot = pluginsRoot;

    // Seed the id → directory map and the artifact fingerprints before the
    // first event can arrive. The map is what lets a later settle tell "the
    // plugin you are running is mid-save" from "the plugin you are running is
    // gone"; the fingerprints are what keep FSEvents' replay of pre-subscribe
    // history from reloading everything the project open just loaded.
    try {
      const scan = await this.deps.discover(state.projectRoot);
      this.rememberDirs(state, scan);
      for (const row of scan.plugins) {
        state.fingerprintByDir.set(row.dirName, await fingerprintPluginDir(row.dir));
      }
    } catch {
      // A failed seed scan is not a reason to skip the watcher; the settle
      // path re-scans anyway and only loses the reprieve for the first burst.
    }
    if (this.isStale(state, generation)) return;

    let subscription: AsyncSubscription;
    try {
      subscription = await subscribeParcelWatcher(
        pluginsRoot,
        (err, events) => {
          if (state.generation !== generation || state.stopped || this.disposed) return;
          if (err) {
            // An error on an established subscription means it is no longer
            // reporting reliably — most often a deleted-and-recreated root,
            // which inotify and ReadDirectoryChangesW do not follow. Drop it
            // and re-arm rather than sitting on a handle that reports nothing.
            logger.warn("Project plugin watcher error; re-arming", {
              projectId: state.projectId,
              error: err.message,
            });
            this.rearmAfterError(state, generation);
            return;
          }
          if (!Array.isArray(events) || events.length === 0) return;
          let relevant = false;
          for (const event of events) {
            if (typeof event?.path !== "string") continue;
            const attribution = attributeProjectPluginEvent(state.pluginsRoot, event.path);
            if (attribution.kind === "ignore") continue;
            relevant = true;
            if (attribution.kind === "all") state.reloadAll = true;
            else state.changedDirs.add(attribution.dirName);
          }
          if (relevant) this.schedule(state, this.timings.debounceMs);
        },
        {
          // Cheap noise reduction only — attribution above is what actually
          // decides. `src/` is the one that matters: a plugin's sources churn
          // on every keystroke and say nothing about its built artifact.
          ignore: ["**/src/**", "**/node_modules/**", "**/.git/**"],
        }
      );
    } catch (err) {
      logger.warn("Subscribing the project plugin watcher failed", {
        projectId: state.projectId,
        pluginsRoot,
        error: formatErrorMessage(err, "subscribe failed"),
      });
      return;
    }

    if (this.isStale(state, generation) || state.subscription) {
      void subscription.unsubscribe().catch(() => {
        // Losing the race is not an error; the winner owns the subscription.
      });
      return;
    }
    state.subscription = subscription;
    state.rearmAttempts = 0;
    this.disarmSentinel(state);
  }

  /**
   * Watch the nearest existing ancestor of the plugins root, non-recursively,
   * until the folder appears. One directory handle, no recursion — the same
   * shape `TopologyWatcher` uses while `.git/worktrees/` does not exist.
   */
  private armSentinel(state: WatchState, generation: number): void {
    const daintreeDir = path.dirname(state.pluginsRoot);
    const parent = existsSync(daintreeDir) ? daintreeDir : state.projectRoot;
    // Already watching the innermost directory that exists.
    if (state.sentinel && state.sentinelPath === parent) return;
    // Watching an outer one: `.daintree` has appeared since, and a
    // non-recursive watch on the project root will never report
    // `.daintree/plugins` being created inside it. Migrate inward.
    if (state.sentinel) this.disarmSentinel(state);
    try {
      const sentinel = fsWatch(parent, { persistent: false }, () => {
        if (this.isStale(state, generation)) return;
        if (!existsSync(state.pluginsRoot)) {
          // Not the folder we are waiting for, but an ancestor of it may have
          // just appeared — re-arm so the next level down is watched too.
          this.armSentinel(state, generation);
          return;
        }
        this.disarmSentinel(state);
        // The folder appeared, possibly with content already in it. `arm()`
        // seeds a fingerprint for everything it finds, so without this the
        // settle below would see nothing changed and stop short of the
        // controller — no prompt, no invalid state, no log (#12212).
        state.forceReconcile = true;
        void this.arm(state).then(() => {
          if (!this.isStale(state, generation)) {
            state.reloadAll = true;
            this.schedule(state, this.timings.debounceMs);
          }
        });
      });
      sentinel.on("error", () => this.disarmSentinel(state));
      state.sentinel = sentinel;
      state.sentinelPath = parent;
    } catch {
      // Exotic filesystem or a watch-limit ceiling. The next project switch
      // re-arms; nothing is lost but the latency.
    }
  }

  private disarmSentinel(state: WatchState): void {
    const sentinel = state.sentinel;
    state.sentinel = null;
    state.sentinelPath = null;
    if (!sentinel) return;
    try {
      sentinel.close();
    } catch {
      // Already closed.
    }
  }

  /** Release an erroring subscription and try once more, up to a ceiling. */
  private rearmAfterError(state: WatchState, generation: number): void {
    if (this.isStale(state, generation)) return;
    const subscription = state.subscription;
    state.subscription = null;
    if (subscription) {
      void subscription.unsubscribe().catch(() => {
        // The handle is already broken; there is nothing further to release.
      });
    }
    if (state.rearmAttempts >= REARM_MAX_ATTEMPTS) return;
    state.rearmAttempts++;
    const timer = setTimeout(() => {
      if (this.isStale(state, generation)) return;
      void this.arm(state);
    }, REARM_DELAY_MS);
    timer.unref?.();
  }

  private isStale(state: WatchState, generation: number): boolean {
    return this.disposed || state.stopped || state.generation !== generation;
  }

  private schedule(state: WatchState, delayMs: number): void {
    if (this.disposed || state.stopped) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.settle(state);
    }, delayMs);
    state.timer.unref?.();
  }

  private commitFingerprints(state: WatchState, next: ReadonlyMap<string, string>): void {
    for (const [dirName, fingerprint] of next) {
      if (fingerprint === ABSENT_FINGERPRINT) state.fingerprintByDir.delete(dirName);
      else state.fingerprintByDir.set(dirName, fingerprint);
    }
  }

  private rememberDirs(state: WatchState, scan: ProjectPluginDiscoveryResult): void {
    for (const row of scan.plugins) {
      if (row.manifest) state.dirByManifestId.set(row.manifest.name, row.dirName);
    }
  }

  private async settle(state: WatchState): Promise<void> {
    if (this.disposed || state.stopped) return;
    // A burst that lands mid-reload re-queues rather than starting a second
    // reload of the same project.
    if (state.running) {
      state.rerunRequested = true;
      return;
    }
    state.running = true;
    const generation = state.generation;
    // Claimed inside the settle, but only discharged once the controller has
    // actually been told. A reconcile that threw on the way there has not
    // happened, so the catch puts the latch back rather than letting a folder
    // that fingerprints as unchanged against its own seed go dark.
    let forced = false;

    try {
      if (await this.deferForGitOperation(state, generation)) return;
      if (this.isStale(state, generation)) return;

      const scan = await this.deps.discover(state.projectRoot);
      if (this.isStale(state, generation)) return;
      this.rememberDirs(state, scan);

      const active = [...this.deps.loadedManifestIds(state.projectId)];
      const unreadable: string[] = [];
      for (const manifestId of active) {
        const dirName = state.dirByManifestId.get(manifestId);
        if (!dirName) continue;
        const row = scan.plugins.find((p) => p.dirName === dirName);
        // A row that is present but has no manifest is a folder whose
        // `plugin.json` is there and does not parse — the mid-write shape.
        if (row !== undefined) {
          if (row.manifest === undefined) unreadable.push(manifestId);
          continue;
        }
        // No row at all is ambiguous: the folder is gone (a branch without the
        // plugin — unload it), or only `plugin.json` is momentarily missing
        // (an editor or build that replaces rather than renames — keep it).
        // The directory itself is what tells them apart.
        if (existsSync(path.join(state.pluginsRoot, dirName))) unreadable.push(manifestId);
      }

      // The retry budget belongs to a specific set of unreadable plugins. A
      // second plugin going mid-write later must not inherit the first one's
      // spent attempts.
      const unreadableKey = [...unreadable].sort().join("\u0000");
      if (unreadableKey !== state.invalidRetryKey) {
        state.invalidRetryKey = unreadableKey;
        state.invalidRetries = 0;
      }

      if (unreadable.length > 0 && state.invalidRetries < this.timings.invalidManifestMaxRetries) {
        state.invalidRetries++;
        logger.warn("Project plugin manifest did not parse; keeping the running version", {
          projectId: state.projectId,
          plugins: unreadable.join(", "),
          attempt: state.invalidRetries,
        });
        this.schedule(state, this.timings.invalidManifestRetryMs);
        return;
      }
      if (unreadable.length > 0) {
        logger.warn("Project plugin manifest is still unreadable; reconciling it away", {
          projectId: state.projectId,
          plugins: unreadable.join(", "),
        });
      }
      state.invalidRetries = 0;
      state.invalidRetryKey = "";

      // Which directories to re-fingerprint. An unattributable burst covers
      // everything the folder has ever held, so a deletion is not missed.
      const candidates = new Set<string>(
        state.reloadAll
          ? [...scan.plugins.map((p) => p.dirName), ...state.fingerprintByDir.keys()]
          : state.changedDirs
      );
      state.reloadAll = false;
      state.changedDirs.clear();
      // Claimed before the fingerprint compare, so a burst arriving mid-settle
      // cannot lose the flag — and cleared here so it is spent exactly once.
      forced = state.forceReconcile;
      state.forceReconcile = false;

      const rowByDir = new Map(scan.plugins.map((p) => [p.dirName, p] as const));
      const changed = new Set<string>();
      // Staged, not committed: a reload that throws must leave the OLD
      // fingerprint in place, or the failed bytes become the new baseline and
      // nothing retries until the author saves again.
      const nextFingerprints = new Map<string, string>();
      for (const dirName of candidates) {
        const dir = rowByDir.get(dirName)?.dir ?? path.join(state.pluginsRoot, dirName);
        const fingerprint = await fingerprintPluginDir(dir);
        if (state.fingerprintByDir.get(dirName) !== fingerprint) changed.add(dirName);
        nextFingerprints.set(dirName, fingerprint);
      }
      if (this.isStale(state, generation)) return;

      // Nothing the host loads actually differs. The commonest cause is
      // FSEvents replaying writes that predate the subscription; a touch or a
      // branch switch back to identical content lands here too.
      if (changed.size === 0 && !forced) {
        this.commitFingerprints(state, nextFingerprints);
        return;
      }

      // Which loaded plugins this burst implicates. Everything else is left
      // alone — editing one plugin must not restart its neighbours.
      const targets = active.filter((manifestId) => {
        const dirName = state.dirByManifestId.get(manifestId);
        return dirName !== undefined && changed.has(dirName);
      });

      await this.deps.reload(state.projectId, state.projectRoot, targets);
      forced = false;
      if (this.isStale(state, generation)) return;
      this.commitFingerprints(state, nextFingerprints);

      state.reloadCount++;
      // The generation counter is the thing the accumulation concern is about:
      // each load permanently adds a module record to the renderer's map, and
      // Chromium has no eviction API. Logging the running total makes a long
      // authoring session measurable instead of assumed.
      logger.info("Project plugins reconciled after a filesystem change", {
        projectId: state.projectId,
        reloaded: targets.length > 0 ? targets.join(", ") : "(rescan only)",
        reloadsThisSession: state.reloadCount,
        viewGenerationsAllocated: this.deps.viewGenerationsAllocated(),
      });
    } catch (err) {
      if (forced && !state.stopped && !this.disposed) state.forceReconcile = true;
      logger.warn("Project plugin hot reload failed", {
        projectId: state.projectId,
        error: formatErrorMessage(err, "reload failed"),
      });
    } finally {
      state.running = false;
      if (state.rerunRequested && !state.stopped && !this.disposed) {
        state.rerunRequested = false;
        this.schedule(state, this.timings.debounceMs);
      }
    }
  }

  /**
   * True when the settle re-queued itself behind a git operation. `index.lock`
   * exists for the whole of a checkout, a rebase step or a pull, and the tree
   * under it is not a state worth reconciling against.
   */
  private async deferForGitOperation(state: WatchState, generation: number): Promise<boolean> {
    if (!state.gitDir) {
      // Only a successful resolution is cached. Caching `null` would defeat
      // `getGitDir`'s own transient-failure TTL and permanently disable the
      // deferral for a repository that is initialised later.
      const resolve = this.deps.resolveGitDir ?? defaultResolveGitDir;
      try {
        state.gitDir = await resolve(state.projectRoot);
      } catch {
        state.gitDir = null;
      }
      if (this.isStale(state, generation)) return true;
    }
    if (!state.gitDir) return false;

    let locked: boolean;
    try {
      await fsp.stat(path.join(state.gitDir, "index.lock"));
      locked = true;
    } catch {
      locked = false;
    }

    if (!locked) {
      state.gitLockWaitStartedAt = null;
      return false;
    }

    state.gitLockWaitStartedAt ??= Date.now();
    if (Date.now() - state.gitLockWaitStartedAt < this.timings.gitLockMaxDeferMs) {
      this.schedule(state, this.timings.gitLockPollMs);
      return true;
    }

    // A crashed git leaves the lock behind. Deferring forever would look
    // exactly like a broken watcher, so proceed and say why.
    logger.warn("Proceeding with a project plugin rescan despite a lingering index.lock", {
      projectId: state.projectId,
      gitDir: state.gitDir,
    });
    state.gitLockWaitStartedAt = null;
    return false;
  }
}

function defaultResolveGitDir(projectRoot: string): Promise<string | null> {
  return getGitDir(projectRoot, { cache: true, logErrors: false });
}

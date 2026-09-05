import path from "path";
import { existsSync, promises as fsp, watch as fsWatch, type FSWatcher } from "fs";

import type { AsyncSubscription } from "@parcel/watcher";

import type { PluginDevWatcherState } from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { createLogger } from "../../utils/logger.js";
import { subscribeParcelWatcher } from "../../utils/parcelWatcherBackend.js";
import { ABSENT_FINGERPRINT, fingerprintPluginDir } from "./pluginArtifactFingerprint.js";

const logger = createLogger("main:PluginDevArtifactWatcher");

/**
 * Trailing debounce over a rebuild burst. Vite rewrites every chunk it owns and
 * re-empties `dist/` on each incremental build, so the only useful reading of a
 * burst is "look again once it stops".
 */
const SETTLE_DEBOUNCE_MS = 200;

/**
 * Quiet period the artifact must survive unchanged before it is treated as a
 * finished build. A debounce alone only says "no event for 200ms", which a
 * builder pausing mid-write satisfies; re-reading the fingerprint after this
 * gap is what distinguishes a settled `dist/` from a half-written one. Without
 * it the worker imports a truncated bundle and the author sees an activation
 * error they did not cause.
 */
const STABILITY_MS = 120;

/**
 * How long to wait before re-arming a subscription that errored, and how many
 * times to try. An erroring watch is usually a deleted-and-recreated root,
 * which the platform backends do not follow on their own. Exhausting the budget
 * is what flips the session to `degraded` — the state the author can actually
 * see, instead of a log line nobody reads.
 */
const REARM_DELAY_MS = 1_000;
const REARM_MAX_ATTEMPTS = 5;

/** Overridable cadence, so tests do not have to spend real seconds on backoff. */
export interface PluginDevArtifactWatcherTimings {
  settleDebounceMs: number;
  stabilityMs: number;
  rearmDelayMs: number;
  rearmMaxAttempts: number;
}

const DEFAULT_TIMINGS: PluginDevArtifactWatcherTimings = {
  settleDebounceMs: SETTLE_DEBOUNCE_MS,
  stabilityMs: STABILITY_MS,
  rearmDelayMs: REARM_DELAY_MS,
  rearmMaxAttempts: REARM_MAX_ATTEMPTS,
};

export interface PluginDevArtifactWatcherDeps {
  /**
   * Reconcile the whole plugin against what is now on disk — manifest, views
   * and backend together. This is the ordinary dev-load path, not a second
   * loader, so the disabled gate, the view-generation mint and the contribution
   * re-registration all apply to a rebuild for free.
   *
   * Resolves `true` only when the artifact on disk was actually adopted. A
   * reconcile that declined (session stopped, plugin disabled, manifest
   * unparseable) reports `false` so the watcher does not baseline bytes it
   * never loaded — that would make the author's next save look like "no
   * change" and silently swallow the build.
   */
  reload: (pluginId: string) => Promise<boolean>;
  /** Called whenever a session's watcher state changes. */
  onStateChange: (pluginId: string, state: PluginDevWatcherState, detail: string | null) => void;
  timings?: Partial<PluginDevArtifactWatcherTimings>;
}

interface WatchState {
  pluginId: string;
  /** The path as the plugins root knows it — for the CLI dev loop, a symlink. */
  linkDir: string;
  /**
   * Realpath of {@link linkDir}, resolved once armed. The CLI symlinks the
   * author's project into the plugins root, and the platform backends report
   * realpaths — so both the subscription root and every attribution compare
   * against this, never the link.
   */
  realDir: string;
  /**
   * Bumped by every stop and re-arm. Every post-await step compares it before
   * committing, so a subscription that resolves after a stop is unsubscribed
   * rather than stored, and a settle that resumes after a stop does nothing.
   */
  generation: number;
  subscription: AsyncSubscription | null;
  /**
   * Cheap single-directory watch armed while the plugin dir does not exist yet,
   * so a link that appears mid-session is noticed instead of going dark.
   */
  sentinel: FSWatcher | null;
  sentinelPath: string | null;
  rearmAttempts: number;
  /**
   * Completed arms that actually resolved the directory. The FIRST one seeds
   * the fingerprint; later ones must not, or a rebuild that landed while the
   * watch was down becomes the baseline and is never loaded.
   */
  armCount: number;
  arming: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Artifact fingerprint as of the last arm or the last successful reload. */
  fingerprint: string;
  /** A settle is in flight; a concurrent burst re-queues instead of racing it. */
  running: boolean;
  rerunRequested: boolean;
  stopped: boolean;
  watcherState: PluginDevWatcherState;
  detail: string | null;
}

type Attribution = "ignore" | "artifact";

/**
 * Whether a raw watcher event touches the plugin's loadable artifact.
 *
 * Only `plugin.json`, `dist/` and the `.dev-marker` count. Sources are
 * deliberately excluded here rather than through the subscription's `ignore`
 * globs: a recursive `src` glob would also swallow a legitimate `dist/src`
 * output chunk, which is a real artifact. On macOS FSEvents coalesces a mass rewrite into a flag on the
 * containing directory, so a bare event on the plugin root is normal and means
 * "re-read the artifact".
 */
export function attributeDevPluginEvent(pluginRoot: string, eventPath: string): Attribution {
  const rel = path.relative(pluginRoot, eventPath);
  if (rel === "") return "artifact";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "ignore";

  const segments = rel.split(path.sep);
  const first = segments[0];
  if (!first) return "ignore";
  if (first === "plugin.json" || first === "dist" || first === ".dev-marker") return "artifact";
  return "ignore";
}

/**
 * Hot reload for a `daintree-plugin dev` session (#12277).
 *
 * One recursive watcher subscription per dev plugin, over the plugin root — not
 * over `dist/`. A watch is bound to the directory it was armed on, and Vite
 * empties `dist/` on every incremental rebuild, so a watch sitting on the build
 * output is one wholesale replacement away from being silently dead. Watching
 * the parent survives that, and the fingerprint below is what turns the
 * resulting event noise back into "the artifact actually changed".
 *
 * A settled burst is handed to the ordinary dev-load reconcile as "re-read this
 * plugin", never as "these exact files changed" — which is what makes a
 * view-only rebuild, a manifest edit and a non-entry backend chunk all announce
 * one complete artifact generation, through one code path, exactly once.
 *
 * The session outlives any individual plugin load. The reconcile it drives
 * unloads and re-loads the plugin, and a reload that fails (a manifest the
 * author is midway through editing) must leave the watch armed so the next save
 * recovers — so only an explicit {@link stop}, or {@link dispose}, ends it.
 */
export class PluginDevArtifactWatcher {
  private readonly states = new Map<string, WatchState>();
  private readonly timings: PluginDevArtifactWatcherTimings;
  private disposed = false;

  constructor(private readonly deps: PluginDevArtifactWatcherDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
  }

  /**
   * Watch this plugin's artifact, or keep watching it. Idempotent — the reload
   * path re-enters `loadPlugin`, which calls this again for the same session.
   */
  ensure(pluginId: string, pluginDir: string): void {
    if (this.disposed || !pluginId || !pluginDir) return;

    const existing = this.states.get(pluginId);
    if (existing) {
      // Same session, already armed or arming. A dev plugin cannot change
      // directory without the CLI re-linking it, which restarts the session.
      if (existing.linkDir === pluginDir) return;
      this.stop(pluginId);
    }

    const state: WatchState = {
      pluginId,
      linkDir: pluginDir,
      realDir: pluginDir,
      generation: 0,
      subscription: null,
      sentinel: null,
      sentinelPath: null,
      rearmAttempts: 0,
      armCount: 0,
      arming: false,
      timer: null,
      fingerprint: ABSENT_FINGERPRINT,
      running: false,
      rerunRequested: false,
      stopped: false,
      watcherState: "waiting",
      detail: null,
    };
    this.states.set(pluginId, state);
    void this.arm(state);
  }

  /** End the dev session. The plugin's own unload is the caller's business. */
  stop(pluginId: string): void {
    const state = this.states.get(pluginId);
    if (!state) return;
    this.states.delete(pluginId);
    this.teardown(state);
  }

  /** Current watcher state for a session, or null when there is no session. */
  stateOf(pluginId: string): { state: PluginDevWatcherState; detail: string | null } | null {
    const state = this.states.get(pluginId);
    if (!state) return null;
    return { state: state.watcherState, detail: state.detail };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.states.values()) this.teardown(state);
    this.states.clear();
  }

  private teardown(state: WatchState): void {
    state.stopped = true;
    // Every in-flight arm, settle and rearm compares this before committing.
    state.generation++;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.disarmSentinel(state);
    const subscription = state.subscription;
    state.subscription = null;
    if (subscription) {
      void subscription.unsubscribe().catch(() => {
        // Best-effort: the session is going away either way.
      });
    }
  }

  private setState(state: WatchState, next: PluginDevWatcherState, detail: string | null): void {
    if (state.watcherState === next && state.detail === detail) return;
    state.watcherState = next;
    state.detail = detail;
    this.deps.onStateChange(state.pluginId, next, detail);
  }

  private isStale(state: WatchState, generation: number): boolean {
    return this.disposed || state.stopped || state.generation !== generation;
  }

  private async arm(state: WatchState): Promise<void> {
    if (state.arming) return;
    state.arming = true;
    try {
      await this.doArm(state, state.generation);
    } finally {
      state.arming = false;
    }
  }

  private async doArm(state: WatchState, generation: number): Promise<void> {
    let realDir: string;
    try {
      realDir = await fsp.realpath(state.linkDir);
      const stat = await fsp.stat(realDir);
      if (!stat.isDirectory()) return;
    } catch {
      // The link (or its target) is not there yet — a `dev` session whose first
      // build has not landed. Wait for it rather than going dark.
      if (!this.isStale(state, generation)) {
        this.armSentinel(state, generation);
        this.setState(state, "waiting", "Waiting for the plugin directory");
      }
      return;
    }
    if (this.isStale(state, generation)) return;
    state.realDir = realDir;
    const isFirstArm = state.armCount === 0;
    state.armCount++;

    if (isFirstArm) {
      // Seed before the first event can arrive: FSEvents replays recent history
      // to a new subscription, so without a baseline the arm itself would look
      // like a rebuild and reload the plugin that just loaded.
      state.fingerprint = await fingerprintPluginDir(realDir);
      if (this.isStale(state, generation)) return;
    }

    let subscription: AsyncSubscription;
    try {
      subscription = await subscribeParcelWatcher(
        realDir,
        (err, events) => {
          if (this.isStale(state, generation)) return;
          if (err) {
            logger.warn("Plugin dev artifact watcher error; re-arming", {
              pluginId: state.pluginId,
              error: err.message,
            });
            this.rearmAfterError(state, err.message);
            return;
          }
          if (!Array.isArray(events) || events.length === 0) return;
          for (const event of events) {
            if (typeof event?.path !== "string") continue;
            if (attributeDevPluginEvent(state.realDir, event.path) === "ignore") continue;
            this.schedule(state);
            return;
          }
        },
        // Noise reduction only — `attributeDevPluginEvent` is what actually
        // decides. Deliberately no `**/src/**`: it would also exclude a
        // `dist/src/**` output chunk, which is a real artifact.
        { ignore: ["**/node_modules/**", "**/.git/**"] }
      );
    } catch (err) {
      const detail = formatErrorMessage(err, "subscribe failed");
      logger.warn("Subscribing the plugin dev artifact watcher failed", {
        pluginId: state.pluginId,
        realDir,
        error: detail,
      });
      // Same budget as a subscription that errors later: a failed subscribe is
      // usually a root mid-replacement, which the next attempt resolves.
      this.rearmAfterError(state, detail);
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
    this.setState(state, "watching", null);
    // Whatever changed while the watch was down produced no event this
    // subscription will ever see, so sweep once rather than waiting for the
    // author's next save to reveal a build that already happened.
    if (!isFirstArm) this.schedule(state);
  }

  /**
   * Watch the nearest existing ancestor of the plugin dir, non-recursively,
   * until it appears. One directory handle, no recursion.
   */
  private armSentinel(state: WatchState, generation: number): void {
    const parent = path.dirname(state.linkDir);
    if (state.sentinel && state.sentinelPath === parent) return;
    this.disarmSentinel(state);
    if (!existsSync(parent)) return;
    try {
      const sentinel = fsWatch(parent, { persistent: false }, () => {
        if (this.isStale(state, generation)) return;
        if (!existsSync(state.linkDir)) return;
        this.disarmSentinel(state);
        void this.arm(state);
      });
      sentinel.on("error", () => this.disarmSentinel(state));
      state.sentinel = sentinel;
      state.sentinelPath = parent;
    } catch {
      // No sentinel is survivable: the next `ensure` re-arms.
    }
  }

  private disarmSentinel(state: WatchState): void {
    if (!state.sentinel) return;
    try {
      state.sentinel.close();
    } catch {
      // already closed
    }
    state.sentinel = null;
    state.sentinelPath = null;
  }

  /**
   * Drop an unreliable subscription and try again. An established subscription
   * reporting an error is no longer reporting changes, so sitting on the handle
   * is indistinguishable from hot reload being switched off — which is the
   * failure this issue is about. Exhausting the budget reports `degraded`
   * rather than continuing to look healthy.
   */
  private rearmAfterError(state: WatchState, reason: string): void {
    if (this.disposed || state.stopped) return;
    const subscription = state.subscription;
    state.subscription = null;
    if (subscription) {
      void subscription.unsubscribe().catch(() => {
        // Already gone; re-arming is what matters.
      });
    }
    // Retire the failed subscription's generation. A callback still in flight
    // from it would otherwise pass the staleness check and spend another
    // attempt from a budget it does not belong to.
    state.generation++;
    const generation = state.generation;
    if (state.rearmAttempts >= this.timings.rearmMaxAttempts) {
      this.setState(state, "degraded", `Watcher stopped reporting changes: ${reason}`);
      return;
    }
    state.rearmAttempts++;
    setTimeout(() => {
      if (this.isStale(state, generation)) return;
      void this.arm(state);
    }, this.timings.rearmDelayMs).unref?.();
  }

  private schedule(state: WatchState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.settle(state);
    }, this.timings.settleDebounceMs);
    state.timer.unref?.();
  }

  private async settle(state: WatchState): Promise<void> {
    if (this.disposed || state.stopped) return;
    if (state.running) {
      // A burst that lands while a reconcile is in flight is not lost: the
      // reconcile re-checks this flag and settles again against the newer tree.
      state.rerunRequested = true;
      return;
    }
    state.running = true;
    const generation = state.generation;
    try {
      do {
        state.rerunRequested = false;
        await this.reconcileOnce(state, generation);
        if (this.isStale(state, generation)) return;
      } while (state.rerunRequested);
    } finally {
      state.running = false;
      // A burst that arrived mid-settle — including the recovery sweep a
      // re-arm schedules — only sets `rerunRequested`. The loop above exits on
      // the staleness check without servicing it, so without this the sweep is
      // dropped and an outage-time build waits for an unrelated save.
      if (state.rerunRequested && !this.disposed && !state.stopped) {
        state.rerunRequested = false;
        this.schedule(state);
      }
    }
  }

  private async reconcileOnce(state: WatchState, generation: number): Promise<void> {
    const observed = await fingerprintPluginDir(state.realDir);
    if (this.isStale(state, generation)) return;
    if (observed === state.fingerprint) return;

    // Two reads either side of a quiet gap. A builder still writing produces
    // two different stamps, and reloading against the first would import a
    // half-written bundle.
    await delay(this.timings.stabilityMs);
    if (this.isStale(state, generation)) return;
    const settled = await fingerprintPluginDir(state.realDir);
    if (this.isStale(state, generation)) return;
    if (settled !== observed) {
      // Still being written. Go back through the debounce rather than looping
      // here, so a long build coalesces into one more attempt at its end
      // instead of one attempt per quiet gap.
      this.schedule(state);
      return;
    }

    let applied: boolean;
    try {
      applied = await this.deps.reload(state.pluginId);
    } catch (err) {
      // A failed reconcile must not become the new baseline, or the fix that
      // follows it looks like "no change" and never reloads.
      logger.warn("Plugin dev reload failed", {
        pluginId: state.pluginId,
        error: formatErrorMessage(err, "reload failed"),
      });
      return;
    }
    if (this.isStale(state, generation) || !applied) return;
    state.fingerprint = settled;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

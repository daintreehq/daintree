import parcelWatcher from "@parcel/watcher";
import { existsSync, watch as fsWatch, type FSWatcher } from "fs";
import { basename, dirname, resolve as pathResolve } from "path";
import PQueue from "p-queue";
import { MutableDisposable } from "../utils/lifecycle.js";
import { withTimeout } from "../utils/withTimeout.js";
import { getGitCommonDir } from "../utils/gitUtils.js";
import { parcelWatcherBackendOption } from "../utils/parcelWatcherBackend.js";
import type { WorkspaceHostEvent } from "../../shared/types/workspace-host.js";
import type { WorktreeMonitor } from "./WorktreeMonitor.js";

// Periodic safety-net reconcile cadence. On macOS the FSEvents-backed topology
// watcher goes silent when `.git/worktrees/` is deleted (last worktree removed)
// and `startWatcher()` no-ops when that dir is absent — so a phantom row can
// persist until the 300s background poll happens to hit the fs.access check.
// This interval bounds that staleness independent of watcher liveness (#8510).
const TOPOLOGY_SAFETY_INTERVAL_MS = 90_000;

// Ceiling for a single topology reconcile holding the concurrency-1 queue. A
// stuck `git worktree prune`/`list` would otherwise pin the only slot and the
// pending flag forever, freezing all worktree add/remove detection.
const TOPOLOGY_RECONCILE_TIMEOUT_MS = 60_000;

// Trailing debounce over buffered watcher events. `git worktree add` writes
// several metadata files within a few milliseconds, so a short window still
// coalesces one operation into one reconcile while keeping pickup latency low
// (a reconcile is one `git worktree list` — cheap enough to run promptly).
const TOPOLOGY_EVENT_DEBOUNCE_MS = 50;

// Rate-limit window after a completed reconcile. Events that land inside it
// set the dirty flag and drain via `armCooldownDrain()` at expiry — the
// cooldown bounds reconcile frequency, it must never strand an external
// change (PERF-139's in-cooldown removal guards exactly this).
const TOPOLOGY_RECONCILE_COOLDOWN_MS = 500;

export interface TopologyWatcherHost {
  readonly pollingEnabled: boolean;
  readonly projectRootPath: string | null;
  readonly activeWorktreeId: string | null;
  readonly monitors: ReadonlyMap<string, WorktreeMonitor>;
  discoverAndSyncWorktrees(): Promise<void>;
  setActiveWorktree(requestId: string, worktreeId: string): void;
  sendEvent(event: WorkspaceHostEvent): void;
}

/**
 * Watches `.git/worktrees/` for externally-created/removed worktrees and
 * drives serialized reconciliation. Owns the parcel-watcher subscription, the
 * pre-dir-exists sentinel, the app-owned-op pending-set suppression, the
 * dark/recovered signal, and the watcher-independent periodic safety net.
 */
export class TopologyWatcher {
  private subscription = new MutableDisposable();
  // Cheap fs.watch on the common git dir, armed only while `.git/worktrees/`
  // doesn't exist (project with zero linked worktrees). Without it the first
  // external `git worktree add` of a session is only discovered by the 90s
  // safety reconcile — startWatcher() no-ops on an absent dir and nothing
  // re-invoked it. Fires once when the dir appears, then hands off to the
  // real parcel watcher and an immediate reconcile.
  private metadataSentinel: FSWatcher | null = null;
  // No constructor `timeout` here: this queue's task wraps runReconcile in
  // withTimeout itself (and always resolves via its own try/catch/finally),
  // so it can never pin the single slot. A p-queue constructor timeout would
  // instead *reject* the add() promise (p-queue passes no fallback to
  // pTimeout), and this add() call is fire-and-forget — that would surface as
  // an unhandled rejection.
  private reconcileQueue = new PQueue({ concurrency: 1 });
  private reconcilePending = false;
  // App-owned worktree create/delete register the metadata-subdir basename
  // here so the watcher event their own `git worktree add/remove` produces is
  // recognized and dropped — instead of blanket-suppressing *all* watcher
  // events for a fixed window, which silently swallowed concurrent external
  // `git worktree remove` calls (#8412). External events whose basename isn't
  // pending still flow through to reconciliation.
  private pendingCreate = new Set<string>();
  private pendingDelete = new Set<string>();
  private pendingSafetyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Events accumulate here across the TOPOLOGY_EVENT_DEBOUNCE_MS window and
  // are filtered against the pending sets at drain time, preserving burst
  // coalescing.
  private eventBuffer: Array<{ path: string; type?: string }> = [];
  private watchCooldownUntil = 0;
  private watchCooldownDirty = false;
  private cooldownDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled = true;
  private generation = 0;
  // One-shot guard for the topology-watcher-dark signal (#9908). Set when the
  // subscribe() rejects at cold start or a 5s pending-event safety valve
  // expires — both mean the watcher is silently unreliable and the worktree
  // list may drift. Cleared only by a *successful* `runReconcile()` (not by
  // the watcher re-arming), because subscription success doesn't prove the
  // topology was re-verified (#8516/#8558).
  private darkNotified = false;
  // Watcher-independent safety net (#8510): the topology watcher can go
  // permanently silent (macOS FSEvents root deletion) or never start (metadata
  // dir absent), so a periodic reconcile bounds phantom-row staleness. Calls
  // are no-ops while paused/disabled via scheduleReconcile's guards.
  private periodicSafetyTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: TopologyWatcherHost) {}

  private handleDark(): void {
    if (this.darkNotified) return;
    this.darkNotified = true;
    this.host.sendEvent({ type: "topology-watcher-dark" });
  }

  /**
   * A topology reconcile completed successfully after a dark period, so the
   * worktree list is current again. Clears the one-shot guard and emits
   * `topology-watcher-recovered` so the renderer hides the indicator. No-op
   * when not dark, so calling it after every reconcile is harmless.
   */
  private handleRecovered(): void {
    if (!this.darkNotified) return;
    this.darkNotified = false;
    this.host.sendEvent({ type: "topology-watcher-recovered" });
  }

  /**
   * Whether the topology watcher is currently dark. Bundled into the
   * `get-all-states` handshake so a late-mounting view hydrates the indicator
   * without waiting for a live event (mirrors `isWatcherDegraded`).
   */
  isDark(): boolean {
    return this.darkNotified;
  }

  private async metadataDirPath(): Promise<string | null> {
    if (!this.host.projectRootPath) return null;
    const commonDir = await getGitCommonDir(this.host.projectRootPath);
    if (!commonDir) return null;
    return `${commonDir}/worktrees`;
  }

  // Idempotent: a second call while the timer is live is a no-op, so the two
  // call sites (load-project path + setPollingEnabled resume) can both invoke
  // it unconditionally. Cleared in stop() (which dispose() and the pause path
  // both call), so the timer never outlives the service.
  startSafetyTimer(): void {
    if (this.periodicSafetyTimer !== null) return;
    const timer = setInterval(() => {
      this.scheduleReconcile();
    }, TOPOLOGY_SAFETY_INTERVAL_MS);
    timer.unref?.();
    this.periodicSafetyTimer = timer;
  }

  async startWatcher(): Promise<void> {
    // The pollingEnabled gate keeps a paused service dark: without it, an
    // ensureAlive() that entered its await before the pause would arm a
    // fresh watcher/sentinel right after stop() tore everything down. Resume
    // re-invokes this symmetrically.
    if (!this.enabled || !this.host.pollingEnabled) return;
    if (this.subscription.value) return;

    const generationAtStart = this.generation;
    const metadataDir = await this.metadataDirPath();
    if (!metadataDir) return;
    // Re-validate after the async commondir resolution: a stop (pause,
    // project switch, dispose) bumps the generation, and a concurrent start
    // that won the race either holds the subscription already or bumped the
    // generation itself below.
    if (
      generationAtStart !== this.generation ||
      !this.enabled ||
      !this.host.pollingEnabled ||
      this.subscription.value
    ) {
      return;
    }
    if (!existsSync(metadataDir)) {
      // No linked worktrees yet — `.git/worktrees/` is created by the first
      // `git worktree add`. Watch for it so that add is discovered in
      // milliseconds instead of by the 90s safety reconcile.
      this.armMetadataSentinel(metadataDir);
      return;
    }
    // The real watcher takes over from here; a sentinel left over from an
    // earlier no-dir phase would just fire redundantly.
    this.disarmMetadataSentinel();

    const generation = ++this.generation;
    const drain = () => this.drainEventBuffer();

    parcelWatcher
      .subscribe(
        metadataDir,
        (err, events) => {
          if (err) {
            // A runtime error on an established subscription means the watcher is
            // no longer reliably reporting changes — same consequence as a
            // subscribe-reject. Go dark; the periodic safety net reconciles.
            if (generation === this.generation) {
              this.handleDark();
            }
          }
          if (Array.isArray(events)) {
            for (const ev of events) {
              const e = ev as { path?: unknown; type?: unknown } | null;
              if (typeof e?.path === "string") {
                this.eventBuffer.push({
                  path: e.path,
                  type: typeof e.type === "string" ? e.type : undefined,
                });
              }
            }
          }
          if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
          }
          this.debounceTimer = setTimeout(drain, TOPOLOGY_EVENT_DEBOUNCE_MS);
        },
        parcelWatcherBackendOption()
      )
      .then((subscription) => {
        if (generation !== this.generation) {
          // stop() incremented the generation — discard.
          subscription.unsubscribe();
          return;
        }
        if (this.subscription.value) {
          subscription.unsubscribe();
          return;
        }
        this.subscription.value = {
          dispose: () => subscription.unsubscribe(),
        };
      })
      .catch((err) => {
        if (generation !== this.generation) {
          // A stop/restart superseded this attempt — the failure is moot.
          return;
        }
        console.warn(
          `[WorkspaceHost] topology watcher subscribe failed for ${metadataDir}: ${(err as Error).message}`
        );
        // No watcher events will ever arrive for this dir. Surface the dark
        // state so the renderer can offer a manual reconcile; the periodic
        // safety net (#8510) is the automatic recovery path.
        this.handleDark();
      });
  }

  /**
   * Arm the fs.watch sentinel that waits for `.git/worktrees/` to appear.
   * Non-persistent and filtered to the single directory entry, so it costs
   * one watch handle on the common git dir. On failure (exotic filesystems,
   * watch limits) discovery falls back to the 90s safety reconcile.
   */
  private armMetadataSentinel(metadataDir: string): void {
    if (this.metadataSentinel) return;
    const commonDir = dirname(metadataDir);
    try {
      const sentinel = fsWatch(commonDir, { persistent: false }, (_eventType, name) => {
        // Only the `worktrees` entry matters — the common dir churns
        // constantly (index, HEAD, refs). A null name can't be classified,
        // so fall through to the existence check.
        if (name && name.toString().replaceAll("\\", "/") !== "worktrees") return;
        if (this.metadataSentinel !== sentinel) return;
        if (!existsSync(metadataDir)) return;
        this.disarmMetadataSentinel();
        void this.startWatcher();
        this.scheduleReconcile();
      });
      sentinel.on("error", () => {
        if (this.metadataSentinel === sentinel) {
          this.disarmMetadataSentinel();
        }
      });
      this.metadataSentinel = sentinel;
    } catch {
      // fs.watch unavailable — the periodic safety reconcile still discovers
      // the first worktree, just slower.
    }
  }

  private disarmMetadataSentinel(): void {
    if (!this.metadataSentinel) return;
    const sentinel = this.metadataSentinel;
    this.metadataSentinel = null;
    try {
      sentinel.close();
    } catch {
      // Stale handle on Windows — ignore.
    }
  }

  /**
   * Post-reconcile self-heal for the topology watcher. Two silent-death
   * cases need it: (1) `.git/worktrees/` was deleted (last linked worktree
   * removed) — the parcel subscription stops reporting without erroring;
   * (2) the dir appeared while neither watcher nor sentinel was live (e.g.
   * the sentinel failed to arm). Runs after the worktree list has been
   * re-verified, so rebuilding here can't mask a missed event.
   */
  private async ensureAlive(): Promise<void> {
    if (!this.enabled || !this.host.pollingEnabled) return;
    if (this.subscription.value) {
      const metadataDir = await this.metadataDirPath();
      if (!metadataDir || existsSync(metadataDir)) return;
      // Watch root vanished — drop the dead subscription and fall through
      // to re-arm via the sentinel path.
      this.generation++;
      this.subscription.value = undefined;
    }
    await this.startWatcher();
  }

  stop(): void {
    // Tearing the watcher down clears the dark state — there's no longer a
    // watcher whose silence matters. Emit recovery (only if dark) so a
    // pause/resume or project switch after a dark event doesn't pin the
    // renderer indicator on with nothing left to clear it.
    this.handleRecovered();
    this.generation++;
    this.subscription.value = undefined;
    this.disarmMetadataSentinel();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.eventBuffer = [];
    // Drop pending entries: with no watcher running nothing will drain them,
    // and a stale entry surviving a pause/resume could suppress a real
    // external change for up to 5s after the watcher restarts.
    for (const timer of this.pendingSafetyTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingSafetyTimers.clear();
    this.pendingCreate.clear();
    this.pendingDelete.clear();
    this.reconcilePending = false;
    this.watchCooldownDirty = false;
    if (this.cooldownDrainTimer) {
      clearTimeout(this.cooldownDrainTimer);
      this.cooldownDrainTimer = null;
    }
    if (this.periodicSafetyTimer !== null) {
      clearInterval(this.periodicSafetyTimer);
      this.periodicSafetyTimer = null;
    }
  }

  // The basename of `.git/worktrees/<name>` is exactly what @parcel/watcher
  // reports for the create/delete of the metadata subdir, so it's the key we
  // match watcher events against. Resolve first so a trailing slash or a
  // relative path normalizes to the same leaf as the event path.
  metadataKey(worktreePath: string): string {
    return basename(pathResolve(worktreePath));
  }

  private markPending(key: string, set: Set<string>): void {
    set.add(key);
    const existing = this.pendingSafetyTimers.get(key);
    if (existing) clearTimeout(existing);
    // Safety valve: if the watcher event never arrives (slow FS, missed
    // event), the entry must not suppress a later real external change
    // indefinitely. Clear-only — the cooldown/dirty path already reschedules
    // any reconcile genuinely needed.
    const timer = setTimeout(() => {
      this.pendingCreate.delete(key);
      this.pendingDelete.delete(key);
      this.pendingSafetyTimers.delete(key);
      // The watcher never delivered the event our own op produced — it's
      // missing events, so it can't be trusted to catch external changes
      // either. Surface the dark state; the periodic safety net reconciles.
      this.handleDark();
    }, 5000);
    timer.unref?.();
    this.pendingSafetyTimers.set(key, timer);
  }

  markPendingCreate(key: string): void {
    this.markPending(key, this.pendingCreate);
  }

  markPendingDelete(key: string): void {
    this.markPending(key, this.pendingDelete);
  }

  clearPending(key: string): void {
    this.pendingCreate.delete(key);
    this.pendingDelete.delete(key);
    const timer = this.pendingSafetyTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pendingSafetyTimers.delete(key);
    }
  }

  private drainEventBuffer(): void {
    const events = this.eventBuffer;
    this.eventBuffer = [];

    let hasUnmatched = false;
    for (const ev of events) {
      const key = basename(ev.path);
      // Gate on event type so a pending *create* can't swallow an external
      // *delete* of a same-named worktree (and vice versa). An absent/unknown
      // type falls back to either set — better an idempotent reconcile than a
      // dropped external change.
      const matched =
        ev.type === "create"
          ? this.pendingCreate.has(key)
          : ev.type === "delete"
            ? this.pendingDelete.has(key)
            : this.pendingCreate.has(key) || this.pendingDelete.has(key);
      if (matched) {
        // App-owned op produced this event — drain the pending entry (and
        // cancel its safety valve) so a *subsequent* external change to the
        // same name is no longer treated as ours.
        this.clearPending(key);
      } else {
        hasUnmatched = true;
      }
    }

    // Empty payloads can't be classified, so fall back to the pre-fix
    // behavior of always reconciling rather than risk dropping a real change.
    if (events.length === 0 || hasUnmatched) {
      this.scheduleReconcile();
    }
  }

  /**
   * Schedules a serialized topology reconcile (full worktree re-discovery).
   * Public so the `reconcile-topology` port action (the "Reconcile now"
   * recovery for the dark state, #9908) can drive it. Internal guards
   * (`enabled`, `pollingEnabled`, cooldown, in-flight) make it safe to call
   * from anywhere — concurrent requests coalesce.
   *
   * `force` is for user-initiated recovery (the Refresh / "Reconcile now"
   * buttons): it bypasses the `pollingEnabled` gate and the post-reconcile
   * cooldown so an explicit user action is never silently swallowed. It still
   * respects the in-flight guard — concurrency is 1 — but coalesces into a
   * follow-up so the user's request always results in a fresh pass.
   */
  scheduleReconcile(force = false): void {
    if (!this.enabled) return;
    if (!force && !this.host.pollingEnabled) return;
    if (!force && Date.now() < this.watchCooldownUntil) {
      // Deferred, not dropped: the drain timer guarantees a pass at cooldown
      // expiry. Without it a change landing here with no reconcile in flight
      // was stranded until the next unrelated event or the 90s safety net.
      this.watchCooldownDirty = true;
      this.armCooldownDrain();
      return;
    }
    if (this.reconcilePending) {
      // A pass is already running. Mark dirty so a follow-up fires once it
      // settles — for both coalesced watcher events and forced user requests.
      // The finally below arms the drain once the new cooldown is known.
      this.watchCooldownDirty = true;
      return;
    }

    this.reconcilePending = true;
    // This pass will observe whatever topology state the deferred request
    // wanted verified — absorb the dirt and its drain timer rather than
    // running a redundant follow-up after the new cooldown.
    this.watchCooldownDirty = false;
    if (this.cooldownDrainTimer) {
      clearTimeout(this.cooldownDrainTimer);
      this.cooldownDrainTimer = null;
    }
    this.reconcileQueue.add(async () => {
      try {
        // Watchdog the reconcile so a stuck `git worktree prune`/`list` can't
        // pin the only slot — and the pending flag — forever. The finally below
        // always runs because withTimeout guarantees the await settles.
        await withTimeout(
          this.runReconcile(),
          TOPOLOGY_RECONCILE_TIMEOUT_MS,
          "topology reconcile watchdog"
        );
      } catch (err) {
        console.warn(`[WorkspaceHost] topology reconciliation failed: ${(err as Error).message}`);
      } finally {
        this.reconcilePending = false;
        this.watchCooldownUntil = Date.now() + TOPOLOGY_RECONCILE_COOLDOWN_MS;
        if (this.watchCooldownDirty) {
          this.armCooldownDrain();
        }
      }
    });
  }

  /**
   * One-shot timer that re-attempts a dirty reconcile just past cooldown
   * expiry. Clears the dirty flag before re-entering scheduleReconcile: a
   * re-deferral (new cooldown, or a pass in flight) re-sets it and re-arms
   * through the paths above, so the flag can never strand. The 5ms epsilon
   * keeps an early-firing timer from landing inside the cooldown it waits on.
   */
  private armCooldownDrain(): void {
    if (this.cooldownDrainTimer) return;
    const delay = Math.max(this.watchCooldownUntil - Date.now(), 0) + 5;
    this.cooldownDrainTimer = setTimeout(() => {
      this.cooldownDrainTimer = null;
      if (!this.watchCooldownDirty) return;
      this.watchCooldownDirty = false;
      this.scheduleReconcile();
    }, delay);
    this.cooldownDrainTimer.unref?.();
  }

  private async runReconcile(): Promise<void> {
    const previousActiveId = this.host.activeWorktreeId;
    await this.host.discoverAndSyncWorktrees();

    // A successful reconcile re-verifies the worktree list, so any prior dark
    // state is resolved — recover here rather than on watcher re-arm, since
    // re-subscribing doesn't prove the topology is current (#8516/#8558).
    this.handleRecovered();

    await this.ensureAlive();

    // Auto-switch to main if the previously-active worktree was removed.
    // syncMonitors nulls activeWorktreeId when pruning the active monitor,
    // so we check: was there a previous active, is it gone from monitors,
    // and has the user NOT already switched to a *different* worktree.
    if (
      previousActiveId &&
      !this.host.monitors.has(previousActiveId) &&
      (this.host.activeWorktreeId === null || this.host.activeWorktreeId === previousActiveId)
    ) {
      let mainId: string | null = null;
      for (const [id, m] of this.host.monitors) {
        if (m.isMainWorktree) {
          mainId = id;
          break;
        }
      }
      if (mainId) {
        this.host.setActiveWorktree("topology-reconcile-auto-switch", mainId);
      }
    }
  }

  clearQueue(): void {
    this.reconcileQueue.clear();
  }
}

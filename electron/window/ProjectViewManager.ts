/**
 * ProjectViewManager — Per-project WebContentsView manager.
 *
 * Each project gets its own WebContentsView with an independent V8 context.
 * Switching projects swaps the visible view (<16ms for cached views).
 *
 * Implementation is split across sibling `electron/window/ProjectView*.ts`
 * modules (#11004): paint-gate bridging, view creation/load, activation/
 * deactivation lifecycle, LRU/memory-pressure eviction, the agent-state
 * cache, persistent WebContents handlers + crash recovery, and the switch
 * driver. Each module operates on this class's shared state via an explicit
 * `host: ProjectViewManager` parameter — this class remains the sole
 * exported entry point and its public API is unchanged.
 */

import { BrowserWindow, type WebContentsView } from "electron";
import { registerProjectView } from "./webContentsRegistry.js";
import { logWarn } from "../utils/logger.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { CHANNELS } from "../ipc/channels.js";
import { freezeWebContents, unfreezeWebContents } from "../utils/webContentsLifecycle.js";
import type { PtyClient } from "../services/PtyClient.js";
import type { AgentState } from "../../shared/types/agent.js";
import * as PaintGateController from "./ProjectViewPaintGateController.js";
import { performSwitch } from "./ProjectViewSwitchController.js";
import { cleanupEntry } from "./ProjectViewLifecycleController.js";
import * as EvictionController from "./ProjectViewEvictionController.js";
import { hasActiveAgent, initAgentStateCache } from "./ProjectViewAgentStateCache.js";
import type { PaintGate, PaintGateOutcome, ViewEntry } from "./ProjectViewManagerTypes.js";

// Trailing-edge debounce on freeze entry: the lag-pressure path can flip
// efficiency on/off without going through the 30 s downgrade hysteresis, so
// a single spike-and-recover would otherwise freeze every cached view for no
// observable benefit. Unfreeze is always immediate — keeping a view frozen
// after we've decided to leave efficiency is the worst-of-both-worlds.
const EFFICIENCY_FREEZE_DEBOUNCE_MS = 500;
// Trailing-edge debounce for forwarding resize-end content bounds to cached
// project views (#10415). Cached renderers are CPU-throttled (and CDP-frozen
// under efficiency), so mid-drag spam is pure waste — only the settled size
// matters. IPC to a frozen renderer queues in Mojo and delivers on unfreeze,
// so no wake cycle is needed. Single debounce on `resize` rather than the
// `resized` event because Linux never emits `resized`.
const BACKGROUND_RESIZE_DEBOUNCE_MS = 300;
/**
 * Soft paint-gate timeout (ms). At this point the gate logs that the
 * incoming view is taking longer than the typical cold start, but the
 * outgoing view stays attached so the user never sees an unfinished
 * frame. Crossing this bound is observable but never user-visible.
 */
const DEFAULT_PAINT_GATE_TIMEOUT_MS = 1_500;
/**
 * Hard paint-gate timeout (ms). Last-resort ceiling — assumes the
 * incoming renderer is stuck or crashed and forcibly detaches the
 * outgoing view. Generous enough that legitimately slow cold starts
 * (low memory, thermal throttling) finish via the signal path instead.
 */
const DEFAULT_PAINT_GATE_HARD_TIMEOUT_MS = 4_000;
/**
 * Soft/hard timeouts for the WARM reactivation paint gate (#9679). A cached
 * view's renderer is already running — only its WebGL atlas repair + one clean
 * rAF stand between reattach and a correct frame — so the bridge can be far
 * tighter than the cold-start gate (no React mount, no data load). The hard
 * ceiling still guarantees the outgoing view is never held hostage by a wake
 * fan-out that stalls (IPC backpressure, oversized incremental restore).
 */
const DEFAULT_WARM_PAINT_GATE_TIMEOUT_MS = 500;
const DEFAULT_WARM_PAINT_GATE_HARD_TIMEOUT_MS = 1_500;
/**
 * Period between renderer-memory samples for cached (non-active) views. 30 s
 * matches `ProcessMemoryMonitor` and keeps the synchronous `app.getAppMetrics()`
 * call (5–50 ms per invocation) out of the budget that would risk main-thread
 * jank. Each tick also evaluates the low-memory pressure floor (see
 * `maybeEvictUnderPressure`), bounding pressure-eviction latency to one
 * sample period without a new timer.
 */
const CACHED_VIEW_MEMORY_SAMPLE_INTERVAL_MS = 30_000;

/** Safe-scalar view inventory entry for the diagnostics export (#10500). */
export interface ViewInventoryEntry {
  projectId: string;
  /** Raw path; sanitized by the diagnostics collector's redactDeep pass. */
  projectPath: string;
  /** webContents id, or -1 if the view was destroyed mid-read. */
  webContentsId: number;
  state: "loading" | "active" | "cached";
  lastUsed: number;
  /** Epoch ms of the project's most recent eviction, if it was ever evicted. */
  evictedAt?: number;
}

export interface ProjectViewManagerOptions {
  dirname: string;
  onRecreateWindow?: () => Promise<void>;
  windowRegistry?: import("./WindowRegistry.js").WindowRegistry;
  /** Called when a view is evicted (destroyed) with its webContents.id, for port cleanup */
  onViewEvicted?: (webContentsId: number) => void;
  /**
   * Called when a view transitions from active to cached with its webContents.id.
   * Mirrors onViewEvicted: live producer ports (worktree, workspace direct) must
   * be closed so messages don't accumulate in a renderer that Chromium may freeze
   * after CPU throttling lands. Reactivation re-brokers a fresh port.
   */
  onViewCached?: (webContentsId: number) => void;
  /** Called on every did-finish-load for any managed view (initial load and reloads) */
  onViewReady?: (webContents: Electron.WebContents) => void;
  /** Called synchronously when a view's renderer process is gone (non-clean), before reload */
  onViewCrashed?: (webContents: Electron.WebContents) => void;
  /** Number of project views to keep cached in memory (1–5, default: 1) */
  cachedProjectViews?: number;
  /**
   * Override the soft paint-gate timeout (default 1500 ms). Crossing this
   * bound only logs `projectview.paintgate.softtimeout` — the outgoing view
   * stays attached. Lower values are useful in tests to exercise the
   * soft-timeout warning path without forcing a real cold start.
   */
  paintGateTimeoutMs?: number;
  /**
   * Override the hard paint-gate timeout (default 4000 ms). At this bound
   * the outgoing view is forcibly detached as a last resort. Lower values
   * are useful in tests to drive both the hard-timeout warning and the
   * fall-through deactivation deterministically.
   */
  paintGateHardTimeoutMs?: number;
  /**
   * Override the soft WARM paint-gate timeout (default 500 ms) used when
   * reactivating a cached view (#9679). Tests that don't exercise the warm
   * anti-flash bridge can set this (and the hard bound) to 0 so warm
   * reactivations resolve immediately instead of waiting on a renderer signal.
   */
  warmPaintGateTimeoutMs?: number;
  /**
   * Override the hard WARM paint-gate timeout (default 1500 ms). At this bound
   * the outgoing bridge view is detached even without a warm paint signal, so a
   * renderer stalled in its wake fan-out can't wedge the reactivation.
   */
  warmPaintGateHardTimeoutMs?: number;
  /**
   * Resolve the Daintree Assistant backend bound to a project — its PTY and the
   * WebContents its help session pinned — or null when it has no session.
   * Injected from the composition root so the eviction policy can consult
   * HelpSessionService without electron/window/ depending on it (#11157).
   * Absent — as in tests that don't exercise the assistant — every project reads
   * as having no backend, which is the pre-#11157 behavior.
   */
  assistantBackendForProject?: (projectId: string) => {
    terminalId: string;
    webContentsId: number;
  } | null;
  /**
   * Whether a PTY is still running. Paired with `assistantBackendForProject`:
   * the help-session binding outlives an assistant that exits on its own, so
   * eviction protection needs a liveness source that tracks exits.
   */
  isTerminalLive?: (terminalId: string) => boolean;
}

export class ProjectViewManager {
  // The fields below are intentionally not `private`: sibling
  // electron/window/ProjectView*.ts modules read/write them via an explicit
  // `host: ProjectViewManager` parameter (#11004). TypeScript `private` is a
  // compile-time-only annotation — this loosening has no runtime effect and
  // no external consumer (this class remains the sole export) touches these
  // fields directly.
  views = new Map<string, ViewEntry>();
  webContentsToProject = new Map<number, string>();
  activeProjectId: string | null = null;
  maxCachedViews = 1;
  lowMemoryFreeThresholdMb: number | null = null;
  win: BrowserWindow;
  dirname: string;
  onRecreateWindow?: () => Promise<void>;
  onViewEvicted?: (webContentsId: number) => void;
  onViewCached?: (webContentsId: number) => void;
  onViewReady?: (webContents: Electron.WebContents) => void;
  onViewCrashed?: (webContents: Electron.WebContents) => void;
  assistantBackendForProject?: (projectId: string) => {
    terminalId: string;
    webContentsId: number;
  } | null;
  isTerminalLive?: (terminalId: string) => boolean;
  windowRegistry?: import("./WindowRegistry.js").WindowRegistry;
  private switchChain: Promise<void> = Promise.resolve();
  private resizeHandler: (() => void) | null = null;
  evictionTimestamps = new Map<string, number>();
  efficiencyFreezeEnabled = false;
  private efficiencyFreezeTimer: NodeJS.Timeout | null = null;
  private backgroundResizeTimer: NodeJS.Timeout | null = null;
  pendingPaintGate: PaintGate | null = null;
  paintGateTimeoutMs = DEFAULT_PAINT_GATE_TIMEOUT_MS;
  paintGateHardTimeoutMs = DEFAULT_PAINT_GATE_HARD_TIMEOUT_MS;
  warmPaintGateTimeoutMs = DEFAULT_WARM_PAINT_GATE_TIMEOUT_MS;
  warmPaintGateHardTimeoutMs = DEFAULT_WARM_PAINT_GATE_HARD_TIMEOUT_MS;
  // One-shot focus intent consumed by the next switchTo for this projectId.
  // Lives on the instance (not module) so multi-window does not cross-leak.
  // Cleared after delivery or discard so a later unrelated switch can't
  // re-trigger a stale focus jump (#4670 lesson).
  pendingFocusIntent: {
    projectId: string;
    intent: "focus-next-waiting";
  } | null = null;
  disposed = false;
  private cachedMemoryTimerCleanup: (() => void) | null = null;

  // Agent-state cache for hasActiveAgent(). The main-process getPtyManager()
  // singleton is never populated (#10054), so the real terminal registry lives
  // in the pty-host and is read async via PtyClient. Eviction scoring is
  // synchronous, so we maintain instance-level maps seeded from the host and
  // kept fresh via the typed event bus. Instance-level (not module-level) so
  // each window's manager scopes to its own terminals (lesson #8607).
  projectByTerminal = new Map<string, string>();
  agentStateByTerminal = new Map<string, AgentState>();
  agentCacheCleanup: Array<() => void> = [];

  constructor(win: BrowserWindow, opts: ProjectViewManagerOptions) {
    this.win = win;
    this.dirname = opts.dirname;
    this.onRecreateWindow = opts.onRecreateWindow;
    this.onViewEvicted = opts.onViewEvicted;
    this.onViewCached = opts.onViewCached;
    this.onViewReady = opts.onViewReady;
    this.onViewCrashed = opts.onViewCrashed;
    this.assistantBackendForProject = opts.assistantBackendForProject;
    this.isTerminalLive = opts.isTerminalLive;
    this.windowRegistry = opts.windowRegistry;
    if (opts.cachedProjectViews != null) {
      this.maxCachedViews = opts.cachedProjectViews;
    }
    if (opts.paintGateTimeoutMs != null) {
      this.paintGateTimeoutMs = Math.max(0, opts.paintGateTimeoutMs);
    }
    if (opts.paintGateHardTimeoutMs != null) {
      this.paintGateHardTimeoutMs = Math.max(0, opts.paintGateHardTimeoutMs);
    }
    if (opts.warmPaintGateTimeoutMs != null) {
      this.warmPaintGateTimeoutMs = Math.max(0, opts.warmPaintGateTimeoutMs);
    }
    if (opts.warmPaintGateHardTimeoutMs != null) {
      this.warmPaintGateHardTimeoutMs = Math.max(0, opts.warmPaintGateHardTimeoutMs);
    }

    // Single resize handler that always updates the active view's bounds.
    // Before registerInitialView() is called, falls back to the first child view
    // (the initial appView attached in createWindow.ts). During a cold-start
    // paint gate the outgoing view is still attached but no longer the
    // active view, so resize it explicitly so its bounds stay in sync with
    // the window while the gate is open.
    this.resizeHandler = () => {
      if (win.isDestroyed()) return;
      const { width, height } = win.getContentBounds();
      const view = this.getActiveView() ?? win.contentView.children[0];
      if (view) {
        (view as WebContentsView).setBounds({ x: 0, y: 0, width, height });
      }
      const outgoing = this.pendingPaintGate?.outgoingView;
      if (outgoing && !outgoing.webContents.isDestroyed() && outgoing !== view) {
        outgoing.setBounds({ x: 0, y: 0, width, height });
      }
      // Defensive (#10806): an orphaned view briefly attached behind the active
      // one (a cancelled paint gate or a destroyView race outside switchChain)
      // never receives bounds updates and drifts to a stale x-offset — two
      // toolbars rendered side by side. Sync every other attached child so any
      // stray duplicate overlaps the active view exactly until
      // pruneOrphanedChildren detaches it.
      for (const child of win.contentView.children as WebContentsView[]) {
        if (child === view || child === outgoing) continue;
        const childWc = child.webContents;
        if (!childWc || childWc.isDestroyed()) continue;
        // Only sync project views. Non-project children (PortalManager parks
        // hidden portal tabs at OFFSCREEN_BOUNDS while still attached, the
        // unbound welcome view, devtools) own their own bounds — forcing them
        // to full-window here would yank a hidden portal onscreen on resize.
        if (!this.webContentsToProject.has(childWc.id)) continue;
        child.setBounds({ x: 0, y: 0, width, height });
      }
      this.scheduleBackgroundResizeNotify();
    };
    win.on("resize", this.resizeHandler);
    win.on("maximize", this.resizeHandler);
    win.on("unmaximize", this.resizeHandler);
    win.on("enter-full-screen", this.resizeHandler);
    win.on("leave-full-screen", this.resizeHandler);

    // Per-instance random phase offset: every window has its own sampler, and
    // app.getAppMetrics() costs 5–50ms of synchronous main-thread work. A
    // wall-clock-aligned interval would collapse all windows onto the same
    // tick and stack those costs; the jittered first delay spreads them across
    // the sample window. try/catch is load-bearing: an uncaught throw would
    // stop rescheduling and reach `uncaughtException`. Sampling failures are
    // pure telemetry and must never destabilise the manager.
    let sampleTimer: NodeJS.Timeout | null = null;
    const scheduleSample = (delayMs: number) => {
      sampleTimer = setTimeout(() => {
        if (this.disposed) return;
        try {
          this.sampleCachedViewMemory();
        } catch (error) {
          logWarn("projectview.cached-memory.error", {
            error: formatErrorMessage(error, "sampleCachedViewMemory threw"),
          });
        }
        try {
          this.maybeEvictUnderPressure();
        } catch (error) {
          logWarn("projectview.pressure-check.error", {
            error: formatErrorMessage(error, "maybeEvictUnderPressure threw"),
          });
        }
        scheduleSample(CACHED_VIEW_MEMORY_SAMPLE_INTERVAL_MS);
      }, delayMs);
      sampleTimer.unref?.();
    };
    scheduleSample(Math.random() * CACHED_VIEW_MEMORY_SAMPLE_INTERVAL_MS);
    this.cachedMemoryTimerCleanup = () => {
      if (sampleTimer) {
        clearTimeout(sampleTimer);
        sampleTimer = null;
      }
    };
  }

  /**
   * Register the initial view created by setupBrowserWindow.
   */
  registerInitialView(view: WebContentsView, projectId: string, projectPath: string): void {
    const entry: ViewEntry = {
      view,
      projectId,
      projectPath,
      lastUsed: Date.now(),
      state: "active",
      crashTimestamps: [],
      cleanupHandlers: () => {},
    };
    this.views.set(projectId, entry);
    this.webContentsToProject.set(view.webContents.id, projectId);
    registerProjectView(projectId, view.webContents);
    this.activeProjectId = projectId;
  }

  /**
   * Switch to a project's view. Creates a new view if none exists.
   * Serialized: rapid switches queue and only the last one's result matters.
   */
  async switchTo(
    projectId: string,
    projectPath: string
  ): Promise<{ view: WebContentsView; isNew: boolean }> {
    const task = this.switchChain.then(() => performSwitch(this, projectId, projectPath));
    this.switchChain = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  /**
   * Repoint a project's cached view at its new folder after a phase-3 relocation
   * (#11282). The view stays on-screen with its live React/xterm state intact —
   * only `ViewEntry.projectPath` (consumed by the next `switchTo`, the
   * swap-failure rollback and diagnostics) is stale after the move. Enqueued on
   * the same `switchChain` as `switchTo`, so it can't interleave with a
   * concurrent switch that would read or overwrite the entry mid-rebind
   * (#10808/#10931). Resolves to the view's live `WebContents` (for the
   * coordinator's targeted repoint send), or `null` when no cached view exists
   * or it was torn down — the Electron 41+ `webContents` getter can be undefined
   * for a destroyed view, so it is guarded before any read.
   */
  async rebindProjectPath(
    projectId: string,
    newPath: string
  ): Promise<Electron.WebContents | null> {
    const task = this.switchChain.then(() => {
      const entry = this.views.get(projectId);
      if (!entry) return null;
      entry.projectPath = newPath;
      const wc = entry.view?.webContents;
      if (!wc || wc.isDestroyed()) return null;
      return wc;
    });
    this.switchChain = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  clearPaintGate(): void {
    PaintGateController.clearPaintGate(this);
  }

  /**
   * Not `private`: kept as a real instance method (rather than calling the
   * ProjectViewPaintGateController export directly from
   * ProjectViewSwitchController) because the existing test suite stubs this
   * out via instance-level replacement (`(manager as unknown as {...}).
   * waitForPaint = ...`) to bypass the real paint-gate timers (#11004).
   */
  waitForPaint(
    webContentsId: number,
    outgoingView: WebContentsView | null,
    outgoingProjectId: string | null,
    onSoftTimeout?: () => void,
    options?: {
      releaseChannel?: "painted" | "warm-painted" | "skeleton-painted";
      softMs?: number;
      hardMs?: number;
    }
  ): Promise<PaintGateOutcome> {
    return PaintGateController.waitForPaint(
      this,
      webContentsId,
      outgoingView,
      outgoingProjectId,
      onSoftTimeout,
      options
    );
  }

  /**
   * Renderer-driven gate release. Called from the `APP_VIEW_PAINTED` IPC
   * handler with the webContentsId of the renderer that just painted.
   */
  signalViewPainted(webContentsId: number): void {
    PaintGateController.signalViewPainted(this, webContentsId);
  }

  /**
   * Early-reveal gate release. Called when an incoming cold-start view's
   * `APP_SKELETON_PARSED` fires. See ProjectViewPaintGateController for
   * the full rationale.
   */
  signalSkeletonPainted(webContentsId: number): void {
    PaintGateController.signalSkeletonPainted(this, webContentsId);
  }

  /**
   * Warm-reactivation gate release. Called from the `APP_VIEW_WARM_PAINTED`
   * IPC handler after a cached view's wake fan-out completes (#9679).
   */
  signalWarmViewPainted(webContentsId: number): void {
    PaintGateController.signalWarmViewPainted(this, webContentsId);
  }

  /**
   * Record a one-shot focus intent to deliver to the renderer after the next
   * switch to `projectId` activates. Consumed exactly once: on cold-start
   * activation (after the paint gate resolves with "signal") or immediately
   * after a cached-view reactivation. Discarded on timeout/cancel/error so a
   * later unrelated switch can't trigger a stale focus jump.
   */
  setPendingFocusIntent(projectId: string, intent: "focus-next-waiting"): void {
    this.pendingFocusIntent = { projectId, intent };
  }

  getActiveProjectId(): string | null {
    return this.activeProjectId;
  }

  /**
   * Project whose view is the still-visible anti-flash bridge of an open paint
   * gate. During a cold switch `activeProjectId` is already the incoming
   * project, but the outgoing project's view stays on-screen until the gate
   * settles — so it is non-evictable for the same reason as the active view.
   * Eviction paths must skip both (mirrors the LRU guard in `evictStaleViews`).
   */
  getOutgoingBridgeProjectId(): string | null {
    return this.pendingPaintGate?.outgoingProjectId ?? null;
  }

  getActiveView(): WebContentsView | null {
    if (!this.activeProjectId) return null;
    return this.views.get(this.activeProjectId)?.view ?? null;
  }

  getProjectIdForWebContents(webContentsId: number): string | null {
    return this.webContentsToProject.get(webContentsId) ?? null;
  }

  /**
   * Record the cold-start preload evaluation cost for a view, keyed by its
   * webContents id (#9770). Called from the perf IPC handler when a view's
   * preload flushes its `preload.eval` span. First-write semantics: the cost is
   * paid once per cold-started view, so a duplicate flush (e.g. a retried IPC)
   * must not clobber the original measurement. No-ops silently when the id is
   * unknown (the flush can race ahead of view registration, or arrive for a
   * non-project webContents).
   */
  recordPreloadDuration(webContentsId: number, durationMs: number): void {
    const projectId = this.webContentsToProject.get(webContentsId);
    if (projectId === undefined) return;
    const entry = this.views.get(projectId);
    if (!entry || entry.preloadEvalDurationMs !== undefined) return;
    entry.preloadEvalDurationMs = durationMs;
  }

  getAllViews(): ViewEntry[] {
    return Array.from(this.views.values());
  }

  /**
   * Safe-scalar projection of the per-project view inventory for the
   * diagnostics export (#10500). Unlike {@link getAllViews}, never exposes the
   * live WebContentsView — only the project id, webContentsId, lifecycle state,
   * last-used time, and (when previously evicted) the eviction timestamp.
   * `projectPath` is returned raw; the diagnostics collector's final
   * `redactDeep` pass sanitizes it, keeping path redaction in one place.
   */
  getViewInventory(): ViewInventoryEntry[] {
    const out: ViewInventoryEntry[] = [];
    for (const entry of this.views.values()) {
      let webContentsId = -1;
      try {
        if (!entry.view.webContents.isDestroyed()) {
          webContentsId = entry.view.webContents.id;
        }
      } catch {
        // View torn down mid-read — leave webContentsId as -1.
      }
      const evictedAt = this.evictionTimestamps.get(entry.projectId);
      out.push({
        projectId: entry.projectId,
        projectPath: entry.projectPath,
        webContentsId,
        state: entry.state,
        lastUsed: entry.lastUsed,
        ...(evictedAt !== undefined ? { evictedAt } : {}),
      });
    }
    return out;
  }

  /** Cache-policy snapshot companion to {@link getViewInventory} (#10500). */
  getCacheConfig(): { maxCachedViews: number; activeProjectId: string | null } {
    return {
      maxCachedViews: this.maxCachedViews,
      activeProjectId: this.activeProjectId,
    };
  }

  getAllWebContentsIds(): number[] {
    return Array.from(this.webContentsToProject.keys());
  }

  setCachedViewLimit(n: number): void {
    const safe = Number.isFinite(n) ? n : 1;
    this.maxCachedViews = Math.max(1, Math.min(5, safe));
    EvictionController.evictStaleViews(this, "limit-change");
  }

  /**
   * Not `private`: kept as real instance methods (rather than the
   * constructor's periodic sampler calling the
   * ProjectViewEvictionController exports directly) because the test suite
   * replaces/spies on these via instance-level overrides (#11004).
   */
  sampleCachedViewMemory(): void {
    EvictionController.sampleCachedViewMemory(this);
  }

  maybeEvictUnderPressure(): void {
    EvictionController.maybeEvictUnderPressure(this);
  }

  /** Returns the number of cached views evicted — 0 means nothing was eligible. */
  reclaimCachedViewsUnderPressure(): number {
    return EvictionController.evictStaleViews(this, "pressure", true);
  }

  /**
   * Set the soft paint-gate timeout (ms). Does NOT retime an in-flight
   * gate — the value is captured at gate creation. Called by
   * `ResourceProfileService` to push per-profile timing.
   */
  setPaintGateTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.paintGateTimeoutMs = ms;
  }

  /**
   * Set the hard paint-gate timeout (ms). Does NOT retime an in-flight
   * gate — the value is captured at gate creation. Called by
   * `ResourceProfileService` to push per-profile timing.
   */
  setPaintGateHardTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.paintGateHardTimeoutMs = ms;
  }

  /**
   * Set the soft warm-reactivation paint-gate timeout (ms). Does NOT retime
   * an in-flight gate — the value is captured at gate creation. Called by
   * `ResourceProfileService` to push per-profile timing.
   */
  setWarmPaintGateTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.warmPaintGateTimeoutMs = ms;
  }

  /**
   * Set the hard warm-reactivation paint-gate timeout (ms). Does NOT retime
   * an in-flight gate — the value is captured at gate creation. Called by
   * `ResourceProfileService` to push per-profile timing.
   */
  setWarmPaintGateHardTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.warmPaintGateHardTimeoutMs = ms;
  }

  /**
   * Set the available-memory floor (MB) below which eviction clamps the
   * effective cap to 1 view for the current pass without mutating
   * `maxCachedViews`. `null` disables the override.
   */
  setLowMemoryFreeThresholdMb(mb: number | null): void {
    if (mb == null || !Number.isFinite(mb) || mb <= 0) {
      this.lowMemoryFreeThresholdMb = null;
    } else {
      this.lowMemoryFreeThresholdMb = mb;
    }
  }

  getLowMemoryFreeThresholdMb(): number | null {
    return this.lowMemoryFreeThresholdMb;
  }

  /**
   * Toggle CDP freeze on cached (non-active) project views. Called by
   * ResourceProfileService when transitioning into / out of the efficiency
   * profile. Freeze entry is trailing-edge debounced; unfreeze is immediate.
   */
  setEfficiencyFreeze(enabled: boolean): void {
    if (enabled === this.efficiencyFreezeEnabled && this.efficiencyFreezeTimer === null) {
      return;
    }
    this.efficiencyFreezeEnabled = enabled;
    if (this.efficiencyFreezeTimer) {
      clearTimeout(this.efficiencyFreezeTimer);
      this.efficiencyFreezeTimer = null;
    }
    if (enabled) {
      this.efficiencyFreezeTimer = setTimeout(() => {
        this.efficiencyFreezeTimer = null;
        if (!this.efficiencyFreezeEnabled) return;
        this.freezeAllCached();
      }, EFFICIENCY_FREEZE_DEBOUNCE_MS);
    } else {
      this.unfreezeAllCached();
    }
  }

  private freezeAllCached(): void {
    for (const [projectId, entry] of this.views) {
      if (projectId === this.activeProjectId) continue;
      // Never freeze a view whose project has a live agent. A frozen renderer
      // cannot run JS, so the queued agent:state-changed IPC sits in Mojo and
      // the background dashboard stays stuck on its pre-freeze state (e.g.
      // "waiting") until the view is foregrounded. Idle/completed projects
      // still freeze for the efficiency win.
      if (hasActiveAgent(this, projectId)) continue;
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      void freezeWebContents(wc);
    }
  }

  // Wake any cached background view whose project gained a live agent after it
  // was already frozen (the seed/state-change races freezeAllCached). Unfreeze
  // only — CPU throttle stays applied; throttling slows JS but does not suspend
  // it, so the queued state event still applies. No-op outside efficiency.
  //
  // Not `private`: called from ProjectViewAgentStateCache's seed() after a
  // fresh agent-state map lands (#11004).
  unfreezeActiveAgentViews(): void {
    if (!this.efficiencyFreezeEnabled) return;
    for (const [projectId, entry] of this.views) {
      if (projectId === this.activeProjectId) continue;
      if (!hasActiveAgent(this, projectId)) continue;
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      void unfreezeWebContents(wc);
    }
  }

  private scheduleBackgroundResizeNotify(): void {
    if (this.backgroundResizeTimer) {
      clearTimeout(this.backgroundResizeTimer);
    }
    this.backgroundResizeTimer = setTimeout(() => {
      this.backgroundResizeTimer = null;
      this.notifyBackgroundResize();
    }, BACKGROUND_RESIZE_DEBOUNCE_MS);
  }

  // Forward the settled content bounds to every cached view so its renderer
  // can keep PTY geometry tracking the window while detached (#10415). The
  // detached view's own viewport stays stale until reattach — setBounds()
  // does not propagate to a detached WebContentsView — so the renderer
  // derives terminal sizes from these bounds instead of from layout.
  private notifyBackgroundResize(): void {
    if (this.disposed || this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    for (const [projectId, entry] of this.views) {
      if (projectId === this.activeProjectId) continue;
      if (entry.state !== "cached") continue;
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      wc.send(CHANNELS.PROJECT_BACKGROUND_RESIZE, { width, height });
    }
  }

  private unfreezeAllCached(): void {
    for (const [projectId, entry] of this.views) {
      if (projectId === this.activeProjectId) continue;
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      void unfreezeWebContents(wc);
    }
  }

  /** Returns true if a cached view existed for the project and was torn down. */
  destroyView(projectId: string): boolean {
    const entry = this.views.get(projectId);
    if (!entry) return false;

    if (this.activeProjectId === projectId) {
      this.activeProjectId = null;
    }

    cleanupEntry(this, projectId);
    return true;
  }

  dispose(): void {
    this.disposed = true;

    for (const cleanup of this.agentCacheCleanup) cleanup();
    this.agentCacheCleanup = [];
    this.projectByTerminal.clear();
    this.agentStateByTerminal.clear();

    if (this.cachedMemoryTimerCleanup) {
      this.cachedMemoryTimerCleanup();
      this.cachedMemoryTimerCleanup = null;
    }

    // Remove window-level listeners
    if (this.resizeHandler) {
      this.win.removeListener("resize", this.resizeHandler);
      this.win.removeListener("maximize", this.resizeHandler);
      this.win.removeListener("unmaximize", this.resizeHandler);
      this.win.removeListener("enter-full-screen", this.resizeHandler);
      this.win.removeListener("leave-full-screen", this.resizeHandler);
      this.resizeHandler = null;
    }

    if (this.efficiencyFreezeTimer) {
      clearTimeout(this.efficiencyFreezeTimer);
      this.efficiencyFreezeTimer = null;
    }
    this.efficiencyFreezeEnabled = false;

    if (this.backgroundResizeTimer) {
      clearTimeout(this.backgroundResizeTimer);
      this.backgroundResizeTimer = null;
    }

    PaintGateController.clearPaintGate(this);
    for (const projectId of Array.from(this.views.keys())) {
      cleanupEntry(this, projectId);
    }
    this.views.clear();
    this.webContentsToProject.clear();
    this.evictionTimestamps.clear();
    this.activeProjectId = null;
  }

  /**
   * Seed and maintain the agent-state cache used by the synchronous
   * `hasActiveAgent()` eviction guard. See ProjectViewAgentStateCache for
   * the full rationale.
   */
  initAgentStateCache(ptyClient: PtyClient): Promise<void> {
    return initAgentStateCache(this, ptyClient);
  }
}

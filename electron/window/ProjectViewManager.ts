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
import { isValidScratchStateId } from "../services/projectStorePaths.js";
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
import type { MemoryPressurePolicy } from "../utils/cachedProjectViews.js";
import type { ProjectFocusOnActivateIntent } from "../../shared/types/ipc/project.js";

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
 * Soft view-load timeout (ms). At this point the cold-start load is taking far
 * longer than the measured distribution (p90 ~177ms) and that fact is logged,
 * but the load keeps running — crossing this bound is observable, never fatal.
 */
const DEFAULT_VIEW_LOAD_TIMEOUT_MS = 10_000;
/**
 * Hard view-load timeout (ms). Absolute ceiling at which the load is abandoned
 * and the switch rolls back. Previously the soft bound doubled as this ceiling,
 * so a load that was merely slow — a main process saturated by concurrent agent
 * CLIs and git enumeration also stalls the `app://` chunks the renderer is
 * waiting on — lost the switch outright (#11459). Progress signals deliberately
 * do NOT extend it: the same stall that delays the load delays any event that
 * would reset it, so only a wall-clock backstop can bound the wait.
 */
const DEFAULT_VIEW_LOAD_HARD_TIMEOUT_MS = 30_000;
/**
 * Period between renderer-memory samples for cached (non-active) views. 30 s
 * matches `ProcessMemoryMonitor` and keeps the synchronous `app.getAppMetrics()`
 * call (5–50 ms per invocation) out of the budget that would risk main-thread
 * jank. Each tick also evaluates the low-memory pressure floor (see
 * `maybeEvictUnderPressure`), bounding pressure-eviction latency to one
 * sample period without a new timer.
 */
const CACHED_VIEW_MEMORY_SAMPLE_INTERVAL_MS = 30_000;

/**
 * Identity of the workspace a view belongs to (#11536). Views are keyed on an
 * opaque workspace id that is either a project id or a scratch id, so `kind`
 * says which — a scratch has no Project row and cannot be looked up through
 * project APIs.
 */
export interface WorkspaceRef {
  kind: "project" | "scratch";
  workspaceId: string;
  workspacePath: string;
}

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
   * Override the soft view-load timeout (default 10000 ms). Crossing this bound
   * only logs `projectview.load.softtimeout` — the load stays alive. Lower
   * values let tests exercise the slow-load warning path without a real stall.
   */
  viewLoadTimeoutMs?: number;
  /**
   * Override the hard view-load timeout (default 30000 ms). At this bound the
   * load is abandoned and the switch rolls back. Lower values let tests drive
   * the rejection deterministically without advancing 30s of fake time.
   */
  viewLoadHardTimeoutMs?: number;
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
  /**
   * Why MCP needs this view kept running right now (#11790) — a live session
   * binding, an in-flight dispatch, or neither. Injected from the composition
   * root for the same reason as `assistantBackendForProject`: electron/window/
   * stays free of the service, and here it also keeps the MCP module graph off
   * eager boot, since it is deliberately behind a dynamic import.
   *
   * Absent — as in tests that don't exercise MCP — every workspace reads as
   * unprotected, which is the pre-#11790 behavior.
   */
  mcpViewActivity?: (workspaceId: string, webContentsId: number) => McpViewActivity | null;
}

/**
 * What MCP is doing with a project view, as read by the freeze and eviction
 * policies (#11790). The two fields earn different protection — see
 * `McpServerService.getWorkspaceViewActivity` for why one is an outright
 * eviction exclusion and the other only a deprioritization.
 */
export interface McpViewActivity {
  /** An MCP request is in flight against this exact view. */
  dispatchLease: boolean;
  /** A live MCP session is bound to this workspace, call or no call. */
  liveBinding: boolean;
}

/**
 * What the freeze and eviction policies actually read: the activity, plus
 * whether the answer could be obtained at all.
 */
export interface McpViewActivityReading extends McpViewActivity {
  /**
   * The wired callback threw, so protection state is genuinely unavailable.
   *
   * Deliberately distinct from the two "definitely not protected" cases — no
   * callback wired, and a callback returning null because MCP has not loaded —
   * because the two policies resolve real uncertainty in OPPOSITE directions.
   * Freezing treats unknown as protected: the cost is one missed optimization
   * on one cached view, against re-creating the 30s stranded dispatch. Eviction
   * must not: an unknown that granted the absolute lease exclusion would let a
   * single broken callback pin every cached view through critical pressure and
   * turn a wiring bug into an OOM. It deprioritizes instead — reclaimable, just
   * last.
   */
  unknown: boolean;
}

const NO_MCP_ACTIVITY: McpViewActivityReading = {
  dispatchLease: false,
  liveBinding: false,
  unknown: false,
};

const UNKNOWN_MCP_ACTIVITY: McpViewActivityReading = {
  dispatchLease: false,
  liveBinding: false,
  unknown: true,
};

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
  memoryPressurePolicy: MemoryPressurePolicy | null = null;
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
  mcpViewActivity?: (workspaceId: string, webContentsId: number) => McpViewActivity | null;
  windowRegistry?: import("./WindowRegistry.js").WindowRegistry;
  private switchChain: Promise<void> = Promise.resolve();
  private resizeHandler: (() => void) | null = null;
  evictionTimestamps = new Map<string, number>();
  efficiencyFreezeEnabled = false;
  private efficiencyFreezeTimer: NodeJS.Timeout | null = null;
  private backgroundResizeTimer: NodeJS.Timeout | null = null;
  pendingPaintGate: PaintGate | null = null;
  /**
   * The cold switch currently between `loadView` starting and the outgoing
   * view being detached (or the switch rolling back).
   *
   * `pendingPaintGate` cannot answer "is the outgoing view still on screen?":
   * the gate resolves on the incoming view's skeleton signal — which lands
   * during the load — and nulls itself, while the outgoing view stays attached
   * and visible until `loadView` resolves. (A focus-intent `"painted"` gate can
   * also hard-time-out inside the load window; a skeleton gate no longer can,
   * since #11765 sizes it past the load's own ceiling.) With the load ceiling
   * raised to 30s (#11459) that divergence is wide enough to matter, so the two
   * consumers that need the real answer read this instead:
   *   - eviction, so a pressure pass can't destroy the visible outgoing view
   *     and leave a blank window behind (the guard in
   *     ProjectViewEvictionController exists for exactly this case but was
   *     keyed off the gate);
   *   - the persistent crash handler, so a renderer that dies mid-load takes
   *     only `loadView`'s rollback and not crash recovery as well.
   */
  pendingColdSwitch: { projectId: string; outgoingProjectId: string | null } | null = null;
  paintGateTimeoutMs = DEFAULT_PAINT_GATE_TIMEOUT_MS;
  paintGateHardTimeoutMs = DEFAULT_PAINT_GATE_HARD_TIMEOUT_MS;
  warmPaintGateTimeoutMs = DEFAULT_WARM_PAINT_GATE_TIMEOUT_MS;
  warmPaintGateHardTimeoutMs = DEFAULT_WARM_PAINT_GATE_HARD_TIMEOUT_MS;
  viewLoadTimeoutMs = DEFAULT_VIEW_LOAD_TIMEOUT_MS;
  viewLoadHardTimeoutMs = DEFAULT_VIEW_LOAD_HARD_TIMEOUT_MS;
  // One-shot focus intent consumed by the next switchTo for this projectId.
  // Lives on the instance (not module) so multi-window does not cross-leak.
  // Cleared after delivery or discard so a later unrelated switch can't
  // re-trigger a stale focus jump (#4670 lesson).
  pendingFocusIntent: {
    projectId: string;
    intent: ProjectFocusOnActivateIntent;
  } | null = null;
  disposed = false;
  /** One-shot latch so a persistently broken activity callback can't flood the log. */
  private warnedMcpActivityFailure = false;
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
    this.mcpViewActivity = opts.mcpViewActivity;
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
    if (opts.viewLoadTimeoutMs != null) {
      this.viewLoadTimeoutMs = Math.max(0, opts.viewLoadTimeoutMs);
    }
    if (opts.viewLoadHardTimeoutMs != null) {
      this.viewLoadHardTimeoutMs = Math.max(0, opts.viewLoadHardTimeoutMs);
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
    // `restore` is what replays a notification `notifyBackgroundResize` declined
    // to send while minimized. Deminiaturizing to the same frame emits no
    // `resize` — the frame did not change — so without this a cached view keeps
    // the geometry it had before the minimize until the next real resize or its
    // own reveal (#11900).
    win.on("restore", this.resizeHandler);

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
        try {
          this.refreezeUnprotectedCachedViews();
        } catch (error) {
          logWarn("projectview.refreeze.error", {
            error: formatErrorMessage(error, "refreezeUnprotectedCachedViews threw"),
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
   * Restart an open skeleton-channel gate's hard timer from now, so the paint
   * bound is spent on the paint rather than on the load that preceded it
   * (#11765). See ProjectViewPaintGateController for the full rationale.
   *
   * A real instance method for the same reason as `waitForPaint`: suites that
   * stub that out never open a gate, and this has to stay a safe no-op there.
   */
  retimeSkeletonPaintGateHardTimeout(webContentsId: number, hardMs: number): boolean {
    return PaintGateController.retimeSkeletonPaintGateHardTimeout(this, webContentsId, hardMs);
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
  setPendingFocusIntent(projectId: string, intent: ProjectFocusOnActivateIntent): void {
    this.pendingFocusIntent = { projectId, intent };
  }

  getActiveProjectId(): string | null {
    return this.activeProjectId;
  }

  /**
   * Project whose view is the still-visible anti-flash bridge of a cold switch.
   * During a cold switch `activeProjectId` is already the incoming project, but
   * the outgoing project's view stays on-screen until the load settles — so it
   * is non-evictable for the same reason as the active view. Eviction paths
   * must skip both (mirrors the LRU guard in `evictStaleViews`).
   *
   * Spans the whole load, not just the paint gate: the gate resolves on the
   * incoming skeleton signal — which lands during the load — and nulls itself,
   * while the outgoing view stays attached until `loadView` settles, up to the
   * load ceiling (#11459). Falling back to `pendingColdSwitch` closes that window
   * for every consumer (hibernation, idle auto-close, relocation, menu state),
   * any of which would otherwise destroy the visible outgoing view and leave
   * rollback with nothing to restore.
   */
  getOutgoingBridgeProjectId(): string | null {
    return (
      this.pendingPaintGate?.outgoingProjectId ?? this.pendingColdSwitch?.outgoingProjectId ?? null
    );
  }

  getActiveView(): WebContentsView | null {
    if (!this.activeProjectId) return null;
    return this.views.get(this.activeProjectId)?.view ?? null;
  }

  getProjectIdForWebContents(webContentsId: number): string | null {
    return this.webContentsToProject.get(webContentsId) ?? null;
  }

  /**
   * Live workspace identity for a view's webContents, or `null` when the id is
   * unknown to this manager (#11536). Sender-scoped by construction — it walks
   * this manager's own reverse mapping, never `activeProjectId` or the global
   * current-project, so a dispatch that landed on a cached (deactivated) view
   * still reports the workspace that view actually belongs to.
   *
   * "Workspace", not "project": views are keyed on an opaque workspace id and
   * a scratch is seeded through the same `switchTo(id, path)` path, so this can
   * legitimately describe a scratch with no Project row. `kind` is derived from
   * the id shape via the owning predicate in `projectStorePaths` — scratch ids
   * are dashed UUIDs and project ids 64 hex chars, which cannot collide — so a
   * caller can tell whether the id is resolvable through project APIs instead
   * of guessing.
   *
   * Reads the path off the live `ViewEntry` rather than a registration-time
   * copy, so a `rebindProjectPath()` (workspace moved on disk) is reflected.
   * Fails closed to `null` if the entry no longer owns the requested webContents
   * or the view has been torn down — callers treat that as "identity unknown"
   * and omit the field rather than reporting a stale workspace.
   */
  getWorkspaceRefForWebContents(webContentsId: number): WorkspaceRef | null {
    const workspaceId = this.webContentsToProject.get(webContentsId);
    if (workspaceId === undefined) return null;
    const entry = this.views.get(workspaceId);
    if (!entry) return null;
    try {
      const wc = entry.view.webContents;
      if (wc.isDestroyed() || wc.id !== webContentsId) return null;
    } catch {
      // View torn down mid-read — identity is unknowable, not stale.
      return null;
    }
    return {
      kind: isValidScratchStateId(entry.projectId) ? "scratch" : "project",
      workspaceId: entry.projectId,
      workspacePath: entry.projectPath,
    };
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
    // Rounded, not just clamped: the cap counts views, and a fractional limit
    // would propagate into the pressure ladder's stepping arithmetic.
    const safe = Number.isFinite(n) ? Math.round(n) : 1;
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
   * Set the soft view-load timeout (ms). Does NOT retime an in-flight load —
   * the value is captured when `loadView` is called. Called by
   * `ResourceProfileService` to push per-profile timing.
   */
  setViewLoadTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.viewLoadTimeoutMs = ms;
  }

  /**
   * Set the hard view-load timeout (ms). Does NOT retime an in-flight load —
   * the value is captured when `loadView` is called. Called by
   * `ResourceProfileService` to push per-profile timing.
   */
  setViewLoadHardTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.viewLoadHardTimeoutMs = ms;
  }

  /**
   * Set the available-memory band governing cached-view reclaim, without
   * mutating `maxCachedViews`. Pushed once at ResourceProfileService start (and
   * per late-created window), never on a profile transition — the band is a
   * property of the machine, not of the profile, so the interactive
   * efficiency→balanced clamp cannot loosen it (#11469). `null` disables
   * reclaim entirely.
   *
   * The pair is copied: the caller's object is a long-lived service field, and
   * an inverted or non-finite edge disables rather than half-arms the policy.
   */
  setMemoryPressurePolicy(policy: MemoryPressurePolicy | null): void {
    if (
      policy == null ||
      !Number.isFinite(policy.criticalMb) ||
      !Number.isFinite(policy.warningMb) ||
      policy.criticalMb <= 0 ||
      policy.warningMb < policy.criticalMb
    ) {
      this.memoryPressurePolicy = null;
      return;
    }
    this.memoryPressurePolicy = { criticalMb: policy.criticalMb, warningMb: policy.warningMb };
  }

  /**
   * Legacy single-floor setter, retained as the E2E escape hatch (six specs
   * push `null` to neutralize pressure eviction so host memory can't perturb
   * their deterministic assertions). A positive value collapses the band to a
   * cliff at `mb`: every reading below it classifies as critical with a
   * `targetMax` of 1.
   *
   * Since #11477 the cliff is a target, not a one-pass collapse. The periodic
   * sampler converges on it one view per tick like any other band; only the
   * forced tier-2 reclaim (`reclaimCachedViewsUnderPressure`) still clears the
   * cache in a single pass.
   */
  setLowMemoryFreeThresholdMb(mb: number | null): void {
    if (mb == null || !Number.isFinite(mb) || mb <= 0) {
      this.memoryPressurePolicy = null;
    } else {
      this.memoryPressurePolicy = { criticalMb: mb, warningMb: mb };
    }
  }

  getLowMemoryFreeThresholdMb(): number | null {
    return this.memoryPressurePolicy?.criticalMb ?? null;
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

  /**
   * What MCP is doing with `workspaceId`'s view right now (#11790).
   *
   * Never throws: the callback reaches a service behind a dynamic import, and a
   * freeze or eviction pass must not be abandoned halfway through the view map
   * because that service was mid-teardown.
   *
   * Three outcomes, not two. No callback wired, a destroyed view, or a null
   * answer (MCP has not loaded, so there are no sessions) are all *known* to be
   * unprotected — the pre-#11790 behavior. A callback that throws is not: that
   * is reported as `unknown` so each policy can resolve it in its own safe
   * direction, and warned once so a broken composition seam is distinguishable
   * from "MCP simply isn't running" in the logs.
   *
   * Takes a workspace id, not a project id: `views` is keyed by the opaque
   * workspace identity (a project's 64-hex id or a scratch workspace's UUID),
   * which is the same vocabulary the MCP session binding stores.
   */
  mcpActivityFor(workspaceId: string, wc: Electron.WebContents): McpViewActivityReading {
    if (!this.mcpViewActivity || wc.isDestroyed()) return NO_MCP_ACTIVITY;
    try {
      const activity = this.mcpViewActivity(workspaceId, wc.id);
      return activity ? { ...activity, unknown: false } : NO_MCP_ACTIVITY;
    } catch (error) {
      if (!this.warnedMcpActivityFailure) {
        this.warnedMcpActivityFailure = true;
        logWarn("projectview.mcp-activity.error", {
          error: formatErrorMessage(error, "mcpViewActivity threw"),
        });
      }
      return UNKNOWN_MCP_ACTIVITY;
    }
  }

  private freezeAllCached(): void {
    for (const [projectId, entry] of this.views) {
      if (projectId === this.activeProjectId) continue;
      // The outgoing anti-flash bridge is still attached and on-screen even
      // though `activeProjectId` already names the incoming project, so it is
      // as un-freezable as the active view (the eviction guard excludes it for
      // the same reason). This pass is periodic now, not just the profile
      // transition, so a sampler tick can land inside any switch: freezing
      // there suspends the renderer painting the frame the user is looking at,
      // and it would also beat `deactivateEntry` to the view, freezing before
      // its requestIdleCallback GC is ever scheduled (lesson #4684).
      if (projectId === this.getOutgoingBridgeProjectId()) continue;
      // Never freeze a view whose project has a live agent. A frozen renderer
      // cannot run JS, so the queued agent:state-changed IPC sits in Mojo and
      // the background dashboard stays stuck on its pre-freeze state (e.g.
      // "waiting") until the view is foregrounded. Idle/completed projects
      // still freeze for the efficiency win.
      if (hasActiveAgent(this, projectId)) continue;
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      // A live MCP session binding is the same argument (#11790): the whole
      // point of binding is to drive this workspace while the user works
      // elsewhere, so its view is a background one by design, and freezing it
      // strands every dispatch until the bridge deadline fires. The bridge also
      // thaws on demand, which covers a session that binds after this pass;
      // this guard is what stops a later pass from re-freezing underneath a
      // session that is already using the view.
      //
      // Unlike eviction, skipping the freeze needs no bounded lease. It costs
      // one optimization on one cached view — CPU throttling and the periodic
      // memory purge still apply — rather than the memory a resident renderer
      // holds, so a quiet binding can hold it for as long as the session lives.
      const mcp = this.mcpActivityFor(projectId, wc);
      if (mcp.liveBinding || mcp.dispatchLease || mcp.unknown) continue;
      void freezeWebContents(wc);
    }
  }

  /**
   * Re-freeze cached views that were thawed for MCP but are no longer
   * protected (#11790).
   *
   * The bridge thaws a bound or pinned view on demand, and nothing puts it
   * back: `freezeAllCached` runs only on the transition INTO the efficiency
   * profile, and `setEfficiencyFreeze(true)` while already enabled is an early
   * no-op. Without this, one dispatch into a cached view leaves it running JS
   * and timers for the rest of the efficiency period, and a session that
   * disconnects never gives its view back — repeated across workspaces, the
   * profile quietly stops doing its job.
   *
   * Piggybacked on the cached-view memory sampler for the same reason
   * `maybeEvictUnderPressure` is: it needs a trigger that doesn't depend on the
   * user switching projects or the profile toggling. Reusing `freezeAllCached`
   * keeps one copy of the guard set, and re-freezing an already-frozen view is
   * a harmless no-op, so this converges rather than tracking which views it
   * personally thawed. A strict no-op outside the efficiency profile.
   */
  refreezeUnprotectedCachedViews(): void {
    if (!this.efficiencyFreezeEnabled) return;
    // A freeze-entry debounce is still pending — let its trailing edge do the
    // work. `setEfficiencyFreeze(true)` flips the flag immediately but delays
    // the sweep, precisely so a profile that flips back inside the window
    // freezes nothing at all; a sampler tick landing in that window would
    // freeze early and defeat it.
    if (this.efficiencyFreezeTimer !== null) return;
    this.freezeAllCached();
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
    // A minimized window's content bounds are platform-dependent and not a
    // layout the renderer can scale against. Forwarding them shrinks every
    // cached pane's geometry proportionally, and a pane that lands on the column
    // floor re-wraps committed scrollback narrow enough to lose it (#11900).
    // Nothing is dropped by skipping: `restore` is registered above and reruns
    // this with usable bounds.
    if (this.win.isMinimized()) return;
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
      this.win.removeListener("restore", this.resizeHandler);
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
    this.pendingColdSwitch = null;
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

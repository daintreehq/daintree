/**
 * ProjectViewManager — Per-project WebContentsView manager.
 *
 * Each project gets its own WebContentsView with an independent V8 context.
 * Switching projects swaps the visible view (<16ms for cached views).
 */

import { app, BrowserWindow, WebContentsView, session, webContents } from "electron";
import path from "path";
import { performance } from "node:perf_hooks";
import {
  registerWebContents,
  registerAppView,
  unregisterWebContents,
  registerProjectView,
  unregisterProjectView,
  registerCachedViewWebContents,
  unregisterCachedViewWebContents,
} from "./webContentsRegistry.js";
import { registerProtocolsForSession, getDistPath } from "../setup/protocols.js";
import { getDevServerUrl } from "../../shared/config/devServer.js";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";
import { isLocalhostUrl, isDevPreviewProxyUrl } from "../../shared/utils/urlUtils.js";
import { isBrowserPartition } from "../../shared/utils/partitionUtils.js";
import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { forgetBlinkSample, forgetEluSample } from "../services/ProcessMemoryMonitor.js";
import type { PtyClient } from "../services/PtyClient.js";
import { events } from "../services/events.js";
import { notifyError } from "../ipc/errorHandlers.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { getAppMetricsSnapshot } from "../utils/appMetricsSnapshot.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  injectSkeletonCss,
  injectSkeletonProjectIdentity,
  resolveInitialColorSchemeId,
  resolveInitialCanvasBackgroundColor,
  resolveE2EPreloadArgs,
  resolveInstanceRole,
  INITIAL_COLOR_SCHEME_ARG,
  INITIAL_PROJECT_ID_ARG,
  INSTANCE_ROLE_ARG,
} from "./skeletonCss.js";
import { isDemoMode } from "../setup/runtimeFlags.js";
import { projectStore } from "../services/ProjectStore.js";
import { CHANNELS } from "../ipc/channels.js";
import {
  attachRendererConsoleCapture,
  detachRendererConsoleCapture,
} from "./rendererConsoleCapture.js";
import {
  freezeWebContents,
  unfreezeWebContents,
  throttleCpuWebContents,
  unthrottleCpuWebContents,
} from "../utils/webContentsLifecycle.js";
import { ACTIVE_AGENT_STATES, type AgentState } from "../../shared/types/agent.js";
import {
  beginWindowRecreating,
  endWindowRecreating,
  isWindowRecreating,
} from "../lifecycle/windowRecreationState.js";

const LOAD_TIMEOUT_MS = 10_000;
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;
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

type ViewState = "loading" | "active" | "cached";

type PaintGateOutcome = "signal" | "hard-timeout" | "cancelled";

interface PaintGate {
  webContentsId: number;
  /**
   * Which renderer signal releases this gate. Cold-start gates normally wait on
   * the one-shot `APP_VIEW_PAINTED` (`"painted"`); fast cold switches instead
   * wait on the earlier one-shot `APP_SKELETON_PARSED` (`"skeleton-painted"`)
   * so the themed first-paint skeleton reveals in hundreds of ms rather than
   * after the full React cold boot. Warm-reactivation gates wait on the
   * re-fireable `APP_VIEW_WARM_PAINTED` (`"warm-painted"`), because a cached
   * view's V8 context already fired its one-shot painted signal on first load
   * and will never re-emit it (#9679). The discriminator keeps a stray signal of
   * the wrong kind from releasing the bridge early; `signalViewPainted` also
   * releases a `"skeleton-painted"` gate as a fallback (a committed React frame
   * is a strict superset of the skeleton having parsed).
   */
  releaseChannel: "painted" | "warm-painted" | "skeleton-painted";
  /**
   * The view that was visible when the gate opened — still attached during the
   * wait. This may be a registered project view or the unbound welcome view on
   * first-run/project-picker windows. Resize events must reach it too so
   * visible bounds stay in sync.
   */
  outgoingView: WebContentsView | null;
  /**
   * Project id for the outgoing view when it is a registered project view.
   * Unbound welcome views have no project id and are never LRU candidates.
   */
  outgoingProjectId: string | null;
  /**
   * Soft timer — fires `onSoftTimeout` but does NOT resolve the gate. The
   * outgoing view stays attached so the soft tail is invisible to the user.
   */
  softTimeout: ReturnType<typeof setTimeout>;
  /**
   * Hard timer — resolves the gate as `"hard-timeout"`, signalling the
   * caller to detach the outgoing view as a last resort.
   */
  hardTimeout: ReturnType<typeof setTimeout>;
  /**
   * Settle the gate. Clears both timers, clears `pendingPaintGate`, and
   * resolves the outer promise. Idempotent — repeat calls no-op.
   */
  resolve: (reason: PaintGateOutcome) => void;
}

type EvictionReason = "lru" | "pressure" | "limit-change";

interface ViewEntry {
  view: WebContentsView;
  projectId: string;
  projectPath: string;
  lastUsed: number;
  state: ViewState;
  crashTimestamps: number[];
  cleanupHandlers: () => void;
  /**
   * Cold-start preload (`preload.cts`) evaluation cost in ms, self-reported by
   * the view's preload via PERF_FLUSH_RENDERER_MARKS (#9770). Set once per view
   * (first-write); surfaced in the `projectview.revival` log so cache-pressure
   * signals carry the preload cost that was paid when the view cold-started.
   */
  preloadEvalDurationMs?: number;
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
}

export class ProjectViewManager {
  private views = new Map<string, ViewEntry>();
  private webContentsToProject = new Map<number, string>();
  private activeProjectId: string | null = null;
  private maxCachedViews = 1;
  private lowMemoryFreeThresholdMb: number | null = null;
  private win: BrowserWindow;
  private dirname: string;
  private onRecreateWindow?: () => Promise<void>;
  private onViewEvicted?: (webContentsId: number) => void;
  private onViewCached?: (webContentsId: number) => void;
  private onViewReady?: (webContents: Electron.WebContents) => void;
  private onViewCrashed?: (webContents: Electron.WebContents) => void;
  private windowRegistry?: import("./WindowRegistry.js").WindowRegistry;
  private switchChain: Promise<void> = Promise.resolve();
  private resizeHandler: (() => void) | null = null;
  private evictionTimestamps = new Map<string, number>();
  private efficiencyFreezeEnabled = false;
  private efficiencyFreezeTimer: NodeJS.Timeout | null = null;
  private backgroundResizeTimer: NodeJS.Timeout | null = null;
  private pendingPaintGate: PaintGate | null = null;
  private paintGateTimeoutMs = DEFAULT_PAINT_GATE_TIMEOUT_MS;
  private paintGateHardTimeoutMs = DEFAULT_PAINT_GATE_HARD_TIMEOUT_MS;
  private warmPaintGateTimeoutMs = DEFAULT_WARM_PAINT_GATE_TIMEOUT_MS;
  private warmPaintGateHardTimeoutMs = DEFAULT_WARM_PAINT_GATE_HARD_TIMEOUT_MS;
  // One-shot focus intent consumed by the next switchTo for this projectId.
  // Lives on the instance (not module) so multi-window does not cross-leak.
  // Cleared after delivery or discard so a later unrelated switch can't
  // re-trigger a stale focus jump (#4670 lesson).
  private pendingFocusIntent: {
    projectId: string;
    intent: "focus-next-waiting";
  } | null = null;
  private disposed = false;
  private cachedMemoryTimerCleanup: (() => void) | null = null;

  // Agent-state cache for hasActiveAgent(). The main-process getPtyManager()
  // singleton is never populated (#10054), so the real terminal registry lives
  // in the pty-host and is read async via PtyClient. Eviction scoring is
  // synchronous, so we maintain instance-level maps seeded from the host and
  // kept fresh via the typed event bus. Instance-level (not module-level) so
  // each window's manager scopes to its own terminals (lesson #8607).
  private projectByTerminal = new Map<string, string>();
  private agentStateByTerminal = new Map<string, AgentState>();
  private agentCacheCleanup: Array<() => void> = [];

  constructor(win: BrowserWindow, opts: ProjectViewManagerOptions) {
    this.win = win;
    this.dirname = opts.dirname;
    this.onRecreateWindow = opts.onRecreateWindow;
    this.onViewEvicted = opts.onViewEvicted;
    this.onViewCached = opts.onViewCached;
    this.onViewReady = opts.onViewReady;
    this.onViewCrashed = opts.onViewCrashed;
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
    const task = this.switchChain.then(() => this.performSwitch(projectId, projectPath));
    this.switchChain = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async performSwitch(
    projectId: string,
    projectPath: string
  ): Promise<{ view: WebContentsView; isNew: boolean }> {
    if (this.win.isDestroyed()) {
      throw new Error("Cannot switch view — window is destroyed");
    }

    // Already active — no-op
    if (this.activeProjectId === projectId) {
      const existing = this.views.get(projectId);
      if (existing) {
        // Consume any pending intent so it doesn't leak into a later switch.
        // The renderer-side global action short-circuits same-project locally,
        // so reaching here with an intent is unusual but possible (e.g. two
        // concurrent switchTo calls); deliver immediately rather than drop.
        const activeIntent = this.consumePendingFocusIntent(projectId);
        if (activeIntent) {
          this.deliverFocusIntent(existing.view, activeIntent);
        }
        return { view: existing.view, isNew: false };
      }
    }

    // Snapshot previous state for rollback
    const previousProjectId = this.activeProjectId;
    const previousEntry = previousProjectId ? (this.views.get(previousProjectId) ?? null) : null;
    const unboundOutgoingView = previousEntry ? null : this.getUnboundOutgoingView();
    const outgoingView = previousEntry?.view ?? unboundOutgoingView;

    // Try to activate cached view (fast path — renderer already mounted).
    const cached = this.views.get(projectId);
    if (cached && !cached.view.webContents.isDestroyed()) {
      // "revival" measures time since this projectId was last evicted — not time
      // since the current cached view (a cold-started successor) was last active.
      // Eviction destroys the original view, so any cache hit for a previously-
      // evicted projectId necessarily hits a later cold-started entry. The
      // timestamp persists across the cold-start so cache-pressure signals stay
      // observable at the project level. Consumed on read to fire only once per
      // eviction → return cycle.
      const evictedAt = this.evictionTimestamps.get(projectId);
      const warmStart = performance.now();

      if (outgoingView) {
        // Warm anti-flash bridge (#9679): the cached view was detached + frozen
        // (Page.setWebLifecycleState) while backgrounded, so on reattach the
        // compositor can push its stale pre-freeze WebGL surface for a frame —
        // visible as flashing solid glyph blocks in agent terminals — before the
        // renderer's visibilitychange-driven wake fan-out repairs each atlas.
        // Mirror the cold-start bridge: keep the outgoing view ON TOP, reattach
        // the cached view BEHIND it (occluded, but unfrozen so its rAF + wake run),
        // and only detach the outgoing once the renderer signals a clean
        // post-repair frame via APP_VIEW_WARM_PAINTED — or the hard timeout fires.
        // notifyViewPainted is one-shot per V8 context, so the warm path needs its
        // own re-fireable channel.
        this.activateView(cached, /* insertBehind */ true);
        const warmSoftMs = this.warmPaintGateTimeoutMs;
        const warmHardMs = Math.max(this.warmPaintGateHardTimeoutMs, warmSoftMs);
        const warmGate = this.waitForPaint(
          cached.view.webContents.id,
          outgoingView,
          previousEntry?.projectId ?? null,
          () => {
            logWarn("projectview.warmpaintgate.softtimeout", {
              projectId,
              waitedMs: warmSoftMs,
            });
          },
          {
            releaseChannel: "warm-painted",
            softMs: warmSoftMs,
            hardMs: warmHardMs,
          }
        );
        const gateResult = await warmGate;
        if (gateResult === "hard-timeout") {
          logWarn("projectview.warmpaintgate.hardtimeout", {
            projectId,
            waitedMs: warmHardMs,
          });
        }
        // Clean frame painted (or grace period exhausted) — detach the outgoing
        // bridge view, revealing the repaired cached view. Guard on the active
        // project still being this one in case a superseding switch cancelled the
        // gate ("cancelled" leaves the new switch to own the teardown).
        if (gateResult !== "cancelled" && this.activeProjectId === projectId) {
          if (previousEntry) {
            this.deactivateEntry(previousEntry);
          } else if (unboundOutgoingView) {
            this.detachUnboundOutgoingView(unboundOutgoingView);
          }
        }
      } else {
        // No outgoing view to bridge through (e.g. first-run with no welcome
        // view) — nothing to flash past, so reveal the cached view immediately.
        this.activateView(cached);
      }

      const visibleMs = Math.round(performance.now() - warmStart);
      if (evictedAt !== undefined) {
        logInfo("projectview.revival", {
          projectId,
          timeSinceEvictionMs: Date.now() - evictedAt,
          visibleMs,
          ...(cached.preloadEvalDurationMs !== undefined
            ? { preloadEvalDurationMs: cached.preloadEvalDurationMs }
            : {}),
        });
        this.evictionTimestamps.delete(projectId);
      }
      logInfo("projectview.warm-swap", {
        projectId,
        visibleMs,
      });
      // Re-assert focus after the bridge teardown — detaching the outgoing view
      // can move focus, and the warm gate may have run for hundreds of ms.
      if (!cached.view.webContents.isDestroyed()) {
        cached.view.webContents.focus();
        // Post-reveal repaint (#10362): the renderer's wake fan-out ran while
        // this view was occluded behind the anti-flash bridge, where Chromium
        // culls paints for a non-foreground WebContentsView — so agent
        // terminals can stay garbled until the user clicks each pane. Now the
        // bridge is gone and the view is the focused foreground surface: force a
        // fresh composite and tell the renderer to re-run its terminal redraw.
        // Skip when a superseding switch has already moved on — this view is no
        // longer the revealed foreground, so repainting it would be wasted work.
        if (this.activeProjectId === projectId) {
          cached.view.webContents.invalidate();
          cached.view.webContents.send(CHANNELS.APP_VIEW_REVEALED);
        }
      }
      const cachedIntent = this.consumePendingFocusIntent(projectId);
      if (cachedIntent) {
        this.deliverFocusIntent(cached.view, cachedIntent);
      }
      // Sweep any outgoing view a cancelled gate or destroyView race left
      // attached behind this one (#10806). Never throws past this point.
      try {
        this.pruneOrphanedChildren();
      } catch (error) {
        console.error("[ProjectViewManager] pruneOrphanedChildren threw:", error);
      }
      return { view: cached.view, isNew: false };
    }

    // Cold start — keep the outgoing view attached until the incoming view
    // signals it has painted, so the swap is seamless instead of flashing
    // through a blank-canvas frame while React mounts.
    if (cached) {
      this.cleanupEntry(projectId);
    }

    const coldStartAt = performance.now();
    const view = this.createView(projectId);
    const entry: ViewEntry = {
      view,
      projectId,
      projectPath,
      lastUsed: Date.now(),
      state: "loading",
      crashTimestamps: [],
      cleanupHandlers: () => {},
    };
    this.views.set(projectId, entry);
    this.webContentsToProject.set(view.webContents.id, projectId);
    registerProjectView(projectId, view.webContents);

    // Set up security handlers and attach to window
    this.setupViewHandlers(view, entry);
    registerWebContents(view.webContents, this.win);
    registerAppView(this.win, view);

    // Register in WindowRegistry for IPC routing
    if (this.windowRegistry) {
      this.windowRegistry.registerAppViewWebContents(this.win.id, view.webContents.id);
    }

    // Insert incoming view BEHIND the outgoing view (index 0). Chromium's
    // `WebContentsView` child stack is z-ordered last-on-top, so this keeps
    // the outgoing view visually on top while the incoming view boots. On a
    // true first-run window the outgoing view is the unbound welcome view, not
    // a registered project entry; it still needs the same anti-flash bridge.
    if (outgoingView) {
      this.win.contentView.addChildView(view, 0);
    } else {
      this.win.contentView.addChildView(view);
    }
    this.updateViewBounds(view);
    this.activeProjectId = projectId;
    entry.state = "active";

    // Arm the paint gate BEFORE `loadView()` so a signal arriving the moment
    // the renderer's double-rAF lands (which can happen on the same tick as
    // `did-finish-load`) is captured instead of dropped. The renderer fires
    // `APP_VIEW_PAINTED` once per V8 context and never retries — without
    // pre-arming, every fast cold switch would fall through to the timeout.
    //
    // Capture both bounds at call time so the warning logs reflect the
    // value actually used by the in-flight gate even if the setters fire
    // a profile push between gate creation and log emission.
    const softMs = this.paintGateTimeoutMs;
    const hardMs = Math.max(this.paintGateHardTimeoutMs, softMs);

    // Reveal the incoming view as soon as its themed first-paint skeleton
    // (`#startup-skeleton`, injected in createView) is parsed into the DOM —
    // signalled early by `public/skeleton-ready.js` via APP_SKELETON_PARSED,
    // well before React mounts — rather than holding the outgoing project on
    // screen for the entire React cold boot. The skeleton is an opaque themed
    // cover over the view's themed canvas background (setBackgroundColor in
    // createView, #9573), so this preserves the anti-flash guarantee while
    // cutting perceived cold-switch latency from ~1.5–4s to a few hundred ms.
    //
    // EXCEPTION: when a focus intent is pending we must keep waiting for the
    // real React paint. The focus-intent IPC listener isn't mounted until React
    // commits, so delivering it into a bare pre-React skeleton would be dropped
    // (#4670). Those (rare) switches keep the legacy `"painted"` gating verbatim.
    const hasPendingFocusIntent = this.pendingFocusIntent?.projectId === projectId;
    const coldReleaseChannel: "painted" | "skeleton-painted" = hasPendingFocusIntent
      ? "painted"
      : "skeleton-painted";
    if (coldReleaseChannel === "skeleton-painted") {
      // Scoped, one-shot receiver for THIS view's skeleton-parsed send. Mirrors
      // createWindow's initial-window skeleton gate, whose listener is bound to
      // the main app webContents and never sees a project-switch view. Optional-
      // chained because the unit-test WebContents mock has no `.ipc`; those
      // tests drive `signalSkeletonPainted()` directly instead. A superseding
      // switch cancels the gate, after which this fire is a harmless no-op
      // (signalSkeletonPainted matches on the pending gate's webContentsId).
      const skeletonWcId = view.webContents.id;
      view.webContents.ipc?.once(CHANNELS.APP_SKELETON_PARSED, () => {
        this.signalSkeletonPainted(skeletonWcId);
      });
    }

    const paintGatePromise = this.waitForPaint(
      view.webContents.id,
      outgoingView,
      previousEntry?.projectId ?? null,
      () => {
        // Soft timeout: outgoing stays attached, gate keeps waiting. Logging
        // only — the user never sees an unfinished frame on the soft path.
        logWarn("projectview.paintgate.softtimeout", {
          projectId,
          waitedMs: softMs,
          releaseChannel: coldReleaseChannel,
        });
      },
      { releaseChannel: coldReleaseChannel }
    );

    let visibleAt: number;
    let loadFinishedAt: number;
    try {
      // Load the renderer with projectId context
      await this.loadView(view, projectId);
      loadFinishedAt = performance.now();

      // The incoming view is stacked behind the still-visible outgoing view,
      // so Chromium's compositor marks it occluded and throttles its
      // requestAnimationFrame callbacks. That stalls the renderer's double-rAF
      // in `notifyViewPainted`, which is exactly the signal the paint gate is
      // waiting on. Page.setWebLifecycleState("active") (via
      // `unfreezeWebContents`) keeps Blink in the foreground lifecycle so rAF
      // keeps firing. Fire-and-forget: the helper swallows the CDP-error
      // swallow-list and `console.warn`s unexpected failures itself, so no
      // `.catch` here. Must run after did-finish-load — calling earlier hangs
      // the CDP session on an uninitialised frame host (Chromium 146).
      void unfreezeWebContents(view.webContents);

      // Wait for the incoming view to signal readiness. On the fast path that
      // is APP_SKELETON_PARSED (themed skeleton parsed, channel
      // `"skeleton-painted"`); on the focus-intent path it is APP_VIEW_PAINTED
      // (React committed its first structural paint after a double-rAF in
      // `notifyViewPainted`, channel `"painted"`), and `signalViewPainted` is
      // the fallback for both. Two-phase: the soft timeout above is observable
      // but never user-visible; only the hard timeout below detaches the
      // outgoing view as a last resort when the renderer is stuck or crashed.
      const gateResult = await paintGatePromise;
      visibleAt = performance.now();
      if (gateResult === "hard-timeout") {
        logWarn("projectview.paintgate.hardtimeout", {
          projectId,
          waitedMs: hardMs,
        });
      }

      // Paint signal received (or hard timeout reached) — detach the
      // outgoing view. On hard timeout the incoming frame may be blank,
      // but the renderer has had its full grace period and holding the
      // outgoing view longer can't recover a stuck renderer.
      if (previousEntry && this.activeProjectId === projectId) {
        this.deactivateEntry(previousEntry);
      } else if (unboundOutgoingView && this.activeProjectId === projectId) {
        this.detachUnboundOutgoingView(unboundOutgoingView);
      }

      logInfo("projectview.coldstart", {
        projectId,
        durationMs: Math.round(performance.now() - coldStartAt),
        visibleMs: Math.round(visibleAt - coldStartAt),
        loadToPaintMs: Math.round(visibleAt - loadFinishedAt),
        paintGateOutcome: gateResult,
        // Which paint-gate channel this cold switch was armed with:
        // `skeleton-painted` (fast path — revealed on the themed skeleton) vs
        // `painted` (focus-intent path — held for the full React paint). Lets
        // telemetry separate fast-path switches from the focus-intent path and
        // measure each one's `visibleMs` independently. A `skeleton-painted`
        // gate may still be released by the `signalViewPainted` fallback when
        // the skeleton signal is missed; this reflects the strategy chosen, not
        // which signal ultimately fired.
        gateChannel: coldReleaseChannel,
      });

      // Focus intent is delivered ONLY on the `"painted"` path — the focus-
      // intent switches that armed for the real React paint, where the
      // renderer's focus-on-activate listener is guaranteed mounted. On the fast
      // skeleton path we never armed for an intent; if one was set mid-flight
      // (a repeated focusNextWaitingGlobal landing during the switch) we must
      // NOT consume it here — delivering into a bare pre-React skeleton would
      // drop it (#4670), and consuming-without-delivering would lose it
      // entirely. Leaving it pending lets the queued/next same-project switch
      // deliver it once React is mounted (intents are project-keyed, so an
      // unrelated switch can't pick it up). On the painted path the intent is
      // still consumed on every outcome (incl. hard timeout) so a stale focus
      // can't leak forward.
      if (coldReleaseChannel === "painted") {
        const coldIntent = this.consumePendingFocusIntent(projectId);
        if (coldIntent && gateResult === "signal") {
          this.deliverFocusIntent(view, coldIntent);
        }
      }
    } catch (loadError) {
      // Cold-start failed before the swap happened — outgoing view is still
      // attached and visible. Tear down the failed incoming view, restore the
      // previous app-view registration (`registerAppView` was overwritten to
      // point at the failed view), and let the still-attached outgoing view
      // resume as the active view.
      this.clearPaintGate();
      // Discard any pending focus intent for the failed projectId so a later
      // unrelated switch can't pick it up.
      this.consumePendingFocusIntent(projectId);
      this.cleanupEntry(projectId);

      this.activeProjectId = previousProjectId;
      if (previousEntry && !previousEntry.view.webContents.isDestroyed()) {
        // Restore app-view registration so getAppWebContents() resolves back
        // to the still-visible previous project view instead of falling
        // through to the bare BrowserWindow's webContents.
        registerAppView(this.win, previousEntry.view);
        // If the failure landed after the outgoing view was already
        // deactivated (which now marks it invisible), restore its visibility
        // so the rolled-back active view is composited again.
        try {
          previousEntry.view.setVisible(true);
        } catch {
          // non-critical
        }
        previousEntry.state = "active";
        previousEntry.lastUsed = Date.now();
        // Re-fire the view-ready hook so per-view IPC helpers re-bind to the
        // rolled-back active view, matching the load/reload path that normally
        // fires it for the active view.
        this.onViewReady?.(previousEntry.view.webContents);
      } else if (unboundOutgoingView && !unboundOutgoingView.webContents.isDestroyed()) {
        // Same rollback requirement for first-run/unbound windows: the visible
        // welcome view is not a project entry, but IPC helpers still need
        // getAppWebContents() to resolve to it after a failed first switch.
        registerAppView(this.win, unboundOutgoingView);
      }

      // Sweep any orphan that leaked before this failed switch (#10806). The
      // rollback above restores the previous view as active; prune removes any
      // other stray project view still attached behind it. Best-effort.
      try {
        this.pruneOrphanedChildren();
      } catch (pruneError) {
        console.error("[ProjectViewManager] pruneOrphanedChildren threw:", pruneError);
      }

      notifyError(loadError, { source: "project-switch" });

      throw loadError;
    }

    // Explicit focus after swap
    if (!view.webContents.isDestroyed()) {
      view.webContents.focus();
    }

    // Evict LRU views if over limit — deferred off the switch promise;
    // evictStaleViews re-checks all state at run time.
    setImmediate(() => {
      if (!this.disposed && !this.win.isDestroyed()) {
        this.evictStaleViews("lru");
      }
    });

    // Sweep any outgoing view a cancelled gate or destroyView race left
    // attached behind this one (#10806). Never throws past this point.
    try {
      this.pruneOrphanedChildren();
    } catch (error) {
      console.error("[ProjectViewManager] pruneOrphanedChildren threw:", error);
    }

    return { view, isNew: true };
  }

  /**
   * Resolve when the renderer with `webContentsId` posts `APP_VIEW_PAINTED`
   * via {@link signalViewPainted}, when the hard timeout elapses, or when a
   * superseding switch cancels the gate. Only one paint gate is tracked at
   * a time — opening a new gate cancels any prior pending one.
   *
   * Two-phase timing:
   *   - Soft (`paintGateTimeoutMs`): fires `onSoftTimeout` for observability.
   *     The gate stays open and the outgoing view stays attached.
   *   - Hard (`paintGateHardTimeoutMs`): resolves the gate as
   *     `"hard-timeout"`, prompting the caller to detach the outgoing view.
   *
   * Both timer values are captured at gate creation. A later
   * `setPaintGateTimeoutMs` / `setPaintGateHardTimeoutMs` call updates the
   * fields but does NOT retime an in-flight gate.
   */
  private waitForPaint(
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
    // Cancel any prior gate from a previous switch attempt. Should not
    // normally occur (switchChain serializes), but guards against re-entry
    // from rollback paths.
    this.clearPaintGate();

    const releaseChannel = options?.releaseChannel ?? "painted";
    const softMs = options?.softMs ?? this.paintGateTimeoutMs;
    // Guarantee hard >= soft at gate-creation time so the soft callback
    // always fires before the hard fall-through, regardless of how the two
    // setters are ordered by the resource-profile push.
    const hardMs = Math.max(options?.hardMs ?? this.paintGateHardTimeoutMs, softMs);

    return new Promise<PaintGateOutcome>((resolveOuter) => {
      let settled = false;
      const gate: PaintGate = {
        webContentsId,
        releaseChannel,
        outgoingView,
        outgoingProjectId,
        softTimeout: setTimeout(() => {
          // Soft tail: log only. Keep waiting for either the paint signal
          // or the hard timeout — DO NOT resolve.
          if (this.pendingPaintGate !== gate) return;
          try {
            onSoftTimeout?.();
          } catch (err) {
            console.error("[ProjectViewManager] paint-gate soft callback threw:", err);
          }
        }, softMs),
        hardTimeout: setTimeout(() => {
          gate.resolve("hard-timeout");
        }, hardMs),
        resolve: (reason) => {
          if (settled) return;
          settled = true;
          clearTimeout(gate.softTimeout);
          clearTimeout(gate.hardTimeout);
          if (this.pendingPaintGate === gate) {
            this.pendingPaintGate = null;
          }
          resolveOuter(reason);
        },
      };
      this.pendingPaintGate = gate;
    });
  }

  private clearPaintGate(): void {
    const gate = this.pendingPaintGate;
    if (!gate) return;
    gate.resolve("cancelled");
  }

  /**
   * Renderer-driven gate release. Called from the `APP_VIEW_PAINTED` IPC
   * handler with the webContentsId of the renderer that just painted. Releases
   * a cold `"painted"` gate and ALSO a `"skeleton-painted"` early-reveal gate:
   * React having committed its first frame is a strict superset of the skeleton
   * having parsed, so this is the fallback that still detaches the bridge if the
   * one-shot `APP_SKELETON_PARSED` was somehow missed (degrading to today's
   * behaviour, never worse). Warm gates own a distinct re-fireable channel and
   * are left for `signalWarmViewPainted`. A mismatch (e.g. a signal arriving
   * after a superseding switch already moved on) is silently ignored.
   */
  signalViewPainted(webContentsId: number): void {
    const gate = this.pendingPaintGate;
    if (!gate) return;
    if (gate.releaseChannel === "warm-painted") return;
    if (gate.webContentsId !== webContentsId) return;
    gate.resolve("signal");
  }

  /**
   * Early-reveal gate release. Called when an incoming cold-start view's
   * `APP_SKELETON_PARSED` fires — i.e. its themed first-paint skeleton
   * (`#startup-skeleton`, injected in `createView`) is in the DOM, well before
   * React mounts. Releasing here lets the outgoing view detach and the branded
   * skeleton show in hundreds of ms instead of holding the old project on
   * screen for the full ~1.5–4s React cold boot. The skeleton is an opaque
   * themed cover over the view's themed canvas background, so the anti-flash
   * guarantee (no blank-canvas frame) is preserved. Only releases a gate
   * explicitly armed for the skeleton channel; a stray signal arriving with a
   * cold `"painted"` or warm gate pending (or no gate) is ignored, so the
   * scoped renderer fire is a safe no-op when main isn't bridging an early
   * reveal.
   */
  signalSkeletonPainted(webContentsId: number): void {
    const gate = this.pendingPaintGate;
    if (!gate) return;
    if (gate.releaseChannel !== "skeleton-painted") return;
    if (gate.webContentsId !== webContentsId) return;
    gate.resolve("signal");
  }

  /**
   * Warm-reactivation gate release. Called from the `APP_VIEW_WARM_PAINTED` IPC
   * handler after a cached view's wake fan-out completes and a clean
   * post-atlas-repair frame paints (#9679). Only releases a gate that is
   * actually waiting on the warm channel — a warm signal arriving with a
   * cold-start gate pending (or no gate at all) is silently ignored, so the
   * unconditional renderer-side fire is a safe no-op when main isn't bridging.
   */
  signalWarmViewPainted(webContentsId: number): void {
    const gate = this.pendingPaintGate;
    if (!gate) return;
    if (gate.releaseChannel !== "warm-painted") return;
    if (gate.webContentsId !== webContentsId) return;
    gate.resolve("signal");
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

  private consumePendingFocusIntent(projectId: string): "focus-next-waiting" | null {
    const pending = this.pendingFocusIntent;
    if (!pending) return null;
    this.pendingFocusIntent = null;
    if (pending.projectId !== projectId) return null;
    return pending.intent;
  }

  private deliverFocusIntent(view: WebContentsView, intent: "focus-next-waiting"): void {
    if (view.webContents.isDestroyed()) return;
    // Targeted send to the specific incoming view — never broadcast (#4641, #5010).
    view.webContents.send(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, { intent });
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
    this.evictStaleViews("limit-change");
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
      if (this.hasActiveAgent(projectId)) continue;
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      void freezeWebContents(wc);
    }
  }

  // Wake any cached background view whose project gained a live agent after it
  // was already frozen (the seed/state-change races freezeAllCached). Unfreeze
  // only — CPU throttle stays applied; throttling slows JS but does not suspend
  // it, so the queued state event still applies. No-op outside efficiency.
  private unfreezeActiveAgentViews(): void {
    if (!this.efficiencyFreezeEnabled) return;
    for (const [projectId, entry] of this.views) {
      if (projectId === this.activeProjectId) continue;
      if (!this.hasActiveAgent(projectId)) continue;
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

    this.cleanupEntry(projectId);
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

    this.clearPaintGate();
    for (const projectId of Array.from(this.views.keys())) {
      this.cleanupEntry(projectId);
    }
    this.views.clear();
    this.webContentsToProject.clear();
    this.evictionTimestamps.clear();
    this.activeProjectId = null;
  }

  // ── Private ──

  private deactivateEntry(current: ViewEntry): void {
    if (this.win.isDestroyed()) return;

    try {
      this.win.contentView.removeChildView(current.view);
    } catch {
      // View may not be attached
    }
    // Mark the parked view invisible so Chromium's compositor releases its GPU
    // tile textures (VRAM) and macOS WindowServer stops compositing it. Removal
    // from the hierarchy alone leaves stacked offscreen views being composited;
    // setVisible(false) is what actually makes a frozen-but-alive cached view
    // cheap to retain. Reactivation restores visibility in activateView().
    try {
      current.view.setVisible(false);
    } catch {
      // non-critical
    }
    current.state = "cached";
    current.lastUsed = Date.now();

    // Throttle background view to reduce CPU and allow Chromium to reclaim memory
    if (!current.view.webContents.isDestroyed()) {
      const cachedWcId = current.view.webContents.id;
      // Mark cached so visible-only broadcasts (log batches) skip this
      // renderer — pushed messages have no backpressure once throttled/frozen.
      registerCachedViewWebContents(current.view.webContents);
      // Tell the renderer it's being cached so it cancels any in-flight wake/
      // repaint rAFs and reveal backstops scheduled for the view it's leaving —
      // otherwise those fire against a now-occluded/frozen view, or survive to
      // run stale work on the next reactivation. Sent before the CPU throttle so
      // the renderer can still process it.
      try {
        current.view.webContents.send(CHANNELS.APP_VIEW_CACHED);
      } catch {
        // ignore — a destroyed/closing renderer has nothing to cancel
      }
      // Close live producer ports BEFORE applying CPU throttle. Once throttled,
      // Chromium can freeze the renderer after ~5 min hidden or under memory
      // pressure; any messages still posted by main/utility processes
      // accumulate in the frozen renderer's task queue (no native
      // backpressure). Reactivation re-brokers a fresh port via activateView.
      try {
        this.onViewCached?.(cachedWcId);
      } catch (error) {
        console.error("[ProjectViewManager] onViewCached threw during deactivate:", error);
      }
      // Use CDP Emulation.setCPUThrottlingRate (per-renderer) instead of
      // WebContents.setBackgroundThrottling — the latter is window-wide in
      // Electron 28+, so the active view's setBackgroundThrottling(false)
      // silently un-throttled every cached sibling (#8599). CPU throttling
      // keeps the event loop and MessagePort dispatch alive while slowing
      // V8/Blink CPU time for this single renderer.
      void throttleCpuWebContents(current.view.webContents);

      // <webview> guests (browser/dev-preview panels) are separate renderer
      // processes with their own CDP targets — the host's throttle does not
      // propagate. Throttle each guest too, or a cached project's dev-preview
      // SPA keeps running at full rate with only native 1 Hz timer
      // throttling. Guests are intentionally NOT CDP-frozen: freezing kills
      // dev-server HMR websockets and would fight the dock-hide freeze owned
      // by useWebviewThrottle.
      this.forEachGuest(current.view.webContents, (guest) => {
        void throttleCpuWebContents(guest);
      });

      // Flush pending DOMStorage writes (synchronous — view stays alive in
      // cache, so data loss is not a concern)
      try {
        current.view.webContents.session.flushStorageData();
      } catch {
        // Renderer may have torn down between the isDestroyed check and this call
      }

      // Release back-forward history entries to free associated DOM/JS state
      try {
        current.view.webContents.navigationHistory.clear();
      } catch {
        // Renderer may have torn down between the isDestroyed check and this call
      }

      // Trigger V8 GC during idle callbacks so the call doesn't synchronously
      // block the renderer. The timeout (1s) guarantees it runs even under
      // background throttling.
      const capturedProjectId = current.projectId;
      const { view, webContents } = { view: current.view, webContents: current.view.webContents };
      const liveEntry = this.views.get(capturedProjectId);
      if (
        liveEntry &&
        liveEntry.view === view &&
        liveEntry.state === "cached" &&
        !webContents.isDestroyed()
      ) {
        webContents
          .executeJavaScript(
            "requestIdleCallback(() => { if (window.gc) window.gc(); }, { timeout: 1000 })"
          )
          .catch(() => {});
      }

      // Freeze AFTER GC scheduling — Page.setWebLifecycleState suspends the
      // renderer event loop, so the requestIdleCallback above would never run
      // if we froze first (lesson #4684). Skip the freeze for a project with a
      // live agent: a frozen renderer can't apply queued agent:state-changed
      // events, stranding the background dashboard on a stale state (mirrors
      // the freezeAllCached guard).
      if (
        this.efficiencyFreezeEnabled &&
        !webContents.isDestroyed() &&
        !this.hasActiveAgent(capturedProjectId)
      ) {
        void freezeWebContents(webContents);
      }
    }
  }

  /**
   * Defensive sweep for orphaned project views still attached to
   * `contentView.children` (#10806). The warm/cold anti-flash bridge skips
   * `deactivateEntry(previousEntry)` whenever the paint gate resolves
   * `"cancelled"` or `activeProjectId` no longer matches the switch target —
   * the latter happens when `HibernationService.destroyView` runs outside
   * `switchChain` and nulls `activeProjectId` mid-gate. A superseding switch
   * only tears down its own `previousEntry`, so an earlier outgoing view can
   * stay attached behind the newly active one, compositing two renderers at
   * once (the duplicated forge toolbar). Called on each switch's success path —
   * after the gate has settled and `pendingPaintGate` is already null — so it
   * detaches any project view that is neither the active view nor an in-flight
   * gate's outgoing bridge. Known live entries are parked as reusable cached
   * views via `deactivateEntry` (preserving cleanup handlers, #6085); stray
   * children the registry no longer tracks are simply removed.
   */
  private pruneOrphanedChildren(): void {
    if (this.win.isDestroyed()) return;
    const activeView = this.getActiveView();
    const gateOutgoing = this.pendingPaintGate?.outgoingView ?? null;
    // Snapshot — removeChildView/deactivateEntry mutate contentView.children.
    const children = [...this.win.contentView.children] as WebContentsView[];
    for (const child of children) {
      if (child === activeView || child === gateOutgoing) continue;
      const wc = child.webContents;
      // Unbound/welcome views (not in webContentsToProject) own their own
      // teardown via detachUnboundOutgoingView — never prune them here.
      if (!wc || wc.isDestroyed() || !this.webContentsToProject.has(wc.id)) continue;
      const projectId = this.webContentsToProject.get(wc.id) ?? null;
      // Belt-and-suspenders: never detach the active project's view even if
      // getActiveView() returned null (e.g. a destroyView race nulled
      // activeProjectId but left the entry mid-teardown).
      if (projectId !== null && projectId === this.activeProjectId) continue;
      const entry = projectId ? this.views.get(projectId) : undefined;
      try {
        if (entry && entry.state !== "cached") {
          this.deactivateEntry(entry);
        } else {
          this.win.contentView.removeChildView(child);
        }
        logWarn("projectview.orphan-pruned", { projectId });
      } catch (error) {
        console.error("[ProjectViewManager] pruneOrphanedChildren failed:", error);
      }
    }
  }

  private activateView(entry: ViewEntry, insertBehind = false): void {
    registerAppView(this.win, entry.view);

    // Restore visibility BEFORE unfreezing: deactivateEntry() called
    // setVisible(false) to release this view's GPU tile textures while cached.
    // The compositor must know the view is visible again before the "active"
    // CDP lifecycle command lands, so first paint after wake targets a live
    // layer rather than a discarded one.
    try {
      entry.view.setVisible(true);
    } catch {
      // non-critical
    }

    if (!entry.view.webContents.isDestroyed()) {
      unregisterCachedViewWebContents(entry.view.webContents.id);
    }

    // Defensive unfreeze BEFORE restoring CPU rate: efficiency transitions and
    // view activations are async, so an activating view may still be frozen
    // even if we've left efficiency in the meantime. Chromium does not
    // auto-resume on focus or re-attach — explicit "active" required.
    // Fire-and-forget: there is a sub-millisecond window between addChildView
    // making the view visible and Chromium processing the "active" CDP command.
    // Awaiting would force activateView to be async and ripple through all
    // call sites (performSwitch, rollback path) for a window that has not
    // been observable in testing.
    if (!entry.view.webContents.isDestroyed()) {
      void unfreezeWebContents(entry.view.webContents);
    }

    // Restore full CPU rate before making visible. Uses
    // Emulation.setCPUThrottlingRate (per-renderer) — see deactivateEntry for
    // why setBackgroundThrottling is unsuitable (window-wide in Electron 28+).
    if (!entry.view.webContents.isDestroyed()) {
      void unthrottleCpuWebContents(entry.view.webContents);
      // Mirror the guest throttle applied in deactivateEntry. CPU rate only —
      // a guest the dock-hide path froze stays frozen (separate mechanism,
      // released by useWebviewThrottle when its tab is shown).
      this.forEachGuest(entry.view.webContents, (guest) => {
        void unthrottleCpuWebContents(guest);
      });
    }

    // `insertBehind` stacks the incoming view at z-index 0 (below the still-
    // attached outgoing view) so it can wake + repair its WebGL atlas while
    // occluded, before the warm paint gate detaches the outgoing bridge (#9679).
    // Top-attach (default) is the immediate-reveal path used everywhere else.
    if (insertBehind) {
      this.win.contentView.addChildView(entry.view, 0);
    } else {
      this.win.contentView.addChildView(entry.view);
    }
    this.updateViewBounds(entry.view);

    // Explicit focus — addChildView does not auto-focus. Skip it while the view
    // is bridged BEHIND the still-visible outgoing view: keyboard focus and menu
    // shortcuts should stay with what the user actually sees until the warm gate
    // reveals the cached view. performSwitch re-focuses once the bridge tears
    // down (#9679); the cold-start path likewise defers focus until after its gate.
    if (!insertBehind && !entry.view.webContents.isDestroyed()) {
      entry.view.webContents.focus();
    }

    entry.state = "active";
    entry.lastUsed = Date.now();
    this.activeProjectId = entry.projectId;
  }

  /**
   * Invoke `fn` for every live <webview> guest embedded in `hostWc`. There is
   * no main-side attach tracking, so guests are resolved by scanning
   * webContents.getAllWebContents() for hostWebContents identity —
   * O(total webContents), called only on view activation/deactivation.
   */
  private forEachGuest(
    hostWc: Electron.WebContents,
    fn: (guest: Electron.WebContents) => void
  ): void {
    try {
      for (const guest of webContents.getAllWebContents()) {
        if (guest.isDestroyed()) continue;
        if (guest.hostWebContents !== hostWc) continue;
        fn(guest);
      }
    } catch {
      // Best-effort: enumeration unavailable (tests / teardown) — guests
      // simply keep their current CPU rate.
    }
  }

  /** Sum the footprint of `hostWc`'s <webview> guests from a pid index. */
  private sumGuestMemoryKb(
    hostWc: Electron.WebContents,
    memoryByPid: ReadonlyMap<number, number>
  ): number {
    let totalKb = 0;
    this.forEachGuest(hostWc, (guest) => {
      try {
        const getPid = (guest as { getOSProcessId?: () => number }).getOSProcessId;
        if (typeof getPid !== "function") return;
        const pid = getPid.call(guest);
        if (typeof pid !== "number" || pid <= 0) return;
        totalKb += memoryByPid.get(pid) ?? 0;
      } catch {
        // Guest telemetry is best-effort; keep the host sample intact.
      }
    });
    return totalKb;
  }

  private getUnboundOutgoingView(): WebContentsView | null {
    if (this.win.isDestroyed()) return null;
    const candidate = this.win.contentView.children[0] as WebContentsView | undefined;
    if (!candidate?.webContents || candidate.webContents.isDestroyed()) return null;
    if (this.webContentsToProject.has(candidate.webContents.id)) return null;
    return candidate;
  }

  private detachUnboundOutgoingView(view: WebContentsView): void {
    if (!this.win.isDestroyed()) {
      try {
        this.win.contentView.removeChildView(view);
      } catch {
        // The welcome view may already have been detached by window teardown.
      }
    }

    const wc = view.webContents;
    const wcId = wc.id;
    if (this.windowRegistry) {
      this.windowRegistry.unregisterAppViewWebContents(this.win.id, wcId);
    }
    forgetBlinkSample(wcId);
    forgetEluSample(wcId);

    try {
      this.onViewEvicted?.(wcId);
    } catch (error) {
      console.error("[ProjectViewManager] onViewEvicted threw for unbound view:", error);
    }

    if (!wc.isDestroyed()) {
      detachRendererConsoleCapture(wc);
      unregisterWebContents(wc);
      wc.close();
    }
  }

  private createView(projectId: string): WebContentsView {
    const ses = session.fromPartition("persist:daintree");

    // Register app:// and daintree-file:// protocol handlers on this session.
    // protocol.handle() only covers the default session — custom partitions need explicit setup.
    const distPath = getDistPath();
    if (distPath) {
      registerProtocolsForSession(ses, distPath);
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(this.dirname, "preload.cjs"),
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        navigateOnDragDrop: false,
        // Matches createWindow.ts: write the V8 code cache on first load so
        // post-install/update launches warm up one launch sooner.
        v8CacheOptions: app.isPackaged ? "bypassHeatCheck" : "code",
        // Seed the renderer with the persisted theme so project-switch cold
        // starts and LRU-evicted views paint the saved scheme on first frame
        // instead of a prefers-color-scheme default (#9169). The project id is
        // threaded the same way instead of via a `?projectId=` query string so
        // the document URL stays static and the V8 bytecode cache is shared
        // across projects (#9162).
        // The instance role rides along so LRU-evicted and project-switch
        // views keep suppressing background GitHub polling in worker
        // instances (#10123).
        additionalArguments: [
          `${INITIAL_COLOR_SCHEME_ARG}=${resolveInitialColorSchemeId()}`,
          `${INITIAL_PROJECT_ID_ARG}=${projectId}`,
          `${INSTANCE_ROLE_ARG}=${resolveInstanceRole()}`,
          ...resolveE2EPreloadArgs(),
          // Demo mode is gated in the renderer on process.argv. Electron does
          // not forward main-process CLI switches to renderer argv, so the
          // `--demo-mode` flag must be threaded explicitly for the DemoCursor /
          // DemoOverlay / DemoCaptureBridge components to mount and the
          // window.electron.demo bridge to be exposed.
          ...(isDemoMode ? ["--demo-mode"] : []),
        ],
      },
    });
    // Set the compositor background color before loadURL so the view never
    // shows the default white background during the cold-start paint gap (#9573).
    view.setBackgroundColor(resolveInitialCanvasBackgroundColor());
    return view;
  }

  private loadView(view: WebContentsView, projectId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wc = view.webContents;
      let settled = false;

      const cleanup = () => {
        wc.removeListener("did-finish-load", onFinish);
        wc.removeListener("did-fail-load", onFail);
        wc.removeListener("preload-error", onPreloadError);
        wc.removeListener("render-process-gone", onProcessGone);
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        fn();
      };

      const timeout = setTimeout(() => {
        settle(() => reject(new Error("View load timed out")));
      }, LOAD_TIMEOUT_MS);

      const onFinish = () => {
        void this.verifyProjectBootstrap(wc, projectId).then(
          () => settle(() => resolve()),
          (error) => settle(() => reject(error))
        );
      };
      const onFail = (_event: Electron.Event, errorCode: number, errorDescription: string) =>
        settle(() => reject(new Error(`View load failed: ${errorDescription} (${errorCode})`)));
      const onPreloadError = (_event: Electron.Event, _preloadPath: string, error: Error) =>
        settle(() => reject(error ?? new Error("Preload script failed")));
      const onProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) =>
        settle(() => reject(new Error(`Renderer process gone during load: ${details.reason}`)));

      wc.once("did-finish-load", onFinish);
      wc.once("did-fail-load", onFail);
      wc.once("preload-error", onPreloadError);
      wc.once("render-process-gone", onProcessGone);

      // Paint the skeleton on `dom-ready`, NOT before `loadURL`. `insertCSS`
      // and `executeJavaScript` are scoped to the live document, and the
      // navigation that `loadURL` kicks off discards anything injected into the
      // prior (about:blank) context — so injecting here pre-navigation was a
      // silent no-op. Mirrors the `dom-ready` wiring in createWindow.ts. `once`
      // is correct because each cold start creates a fresh WebContentsView.
      // Re-read the project inside the handler rather than closing over a value
      // captured now, so the freshest name/emoji/color is painted (#9162).
      wc.once("dom-ready", () => {
        if (wc.isDestroyed()) return;
        const project = projectStore.getProjectById(projectId);
        // instantReveal drops index.html's 400ms Doherty entry delay: a cold
        // switch reveals on APP_SKELETON_PARSED (~150ms), which lands inside
        // that delay, so without this the revealed view shows a blank themed
        // canvas instead of the skeleton until ~480ms. The gate stays in place
        // for the initial app launch (createWindow.ts), where it belongs.
        injectSkeletonCss(wc, project, { instantReveal: true });
        injectSkeletonProjectIdentity(wc, project);
      });

      // The document URL is intentionally static (no `?projectId=`): the id
      // travels via additionalArguments so the V8 bytecode cache stays shared
      // across projects instead of fragmenting one entry per project (#9162).
      //
      // Outer .catch surfaces any rejection from `wc.loadURL` itself; the inner
      // did-fail-load / preload-error / timeout handlers already reject the
      // outer Promise with a descriptive Error. ERR_ABORTED is the dominant
      // normal case during rapid project switching and renderer teardown — drop
      // it silently to avoid log noise.
      const onLoadURLReject = (err: unknown, url: string) => {
        if (err instanceof Error && err.message.includes("ERR_ABORTED")) return;
        logWarn("Project view loadURL rejected", {
          projectId,
          url,
          error: formatErrorMessage(err, "loadURL failed"),
        });
      };
      if (process.env.NODE_ENV === "development") {
        const url = getDevServerUrl();
        wc.loadURL(url).catch((err) => onLoadURLReject(err, url));
      } else {
        const url = "app://daintree/index.html";
        wc.loadURL(url).catch((err) => onLoadURLReject(err, url));
      }
    });
  }

  private async verifyProjectBootstrap(wc: Electron.WebContents, projectId: string): Promise<void> {
    const loadedProjectId = await wc.executeJavaScript(
      "globalThis.__DAINTREE_INITIAL_PROJECT__?.id ?? null"
    );
    // The production expression above always returns a string or null. Some
    // unit-test WebContents mocks return undefined for unmodelled scripts;
    // leave those legacy mocks neutral while still rejecting real missing
    // bootstrap state (null) and wrong-project bootstraps.
    if (loadedProjectId === undefined) return;
    if (loadedProjectId !== projectId) {
      throw new Error(
        `Project view loaded without project bootstrap for ${projectId}; got ${String(loadedProjectId)}`
      );
    }
  }

  private updateViewBounds(view: WebContentsView): void {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  }

  private setupViewHandlers(view: WebContentsView, entry: ViewEntry): void {
    const wc = view.webContents;
    const win = this.win;

    attachRendererConsoleCapture(wc);

    wc.setWindowOpenHandler(({ url }) => {
      if (url && canOpenExternalUrl(url)) {
        void openExternalUrl(url).catch((error) => {
          console.error("[ProjectViewManager] Failed to open external URL:", error);
        });
      } else {
        console.warn(`[ProjectViewManager] Blocked window.open for unsupported URL: ${url}`);
      }
      return { action: "deny" };
    });

    const handleWillNavigate = (event: Electron.Event, navigationUrl: string) => {
      if (!isTrustedRendererUrl(navigationUrl)) {
        console.error("[ProjectViewManager] Blocked navigation to untrusted URL:", navigationUrl);
        event.preventDefault();
      }
    };

    const handleWillRedirect = (event: Electron.Event, redirectUrl: string) => {
      if (!isTrustedRendererUrl(redirectUrl)) {
        console.error("[ProjectViewManager] Blocked redirect to untrusted URL:", redirectUrl);
        event.preventDefault();
      }
    };

    const handleWillAttachWebview = (
      event: Electron.Event,
      webPreferences: Electron.WebPreferences,
      params: Record<string, string>
    ) => {
      // Dev-preview webviews load the stable proxy origin (dp-*.localhost), which
      // isLocalhostUrl rejects — accept it explicitly (#9100).
      const isAllowedLocalhostUrl = isLocalhostUrl(params.src) || isDevPreviewProxyUrl(params.src);
      const partition = params.partition ?? "";
      const isValidPartition =
        isBrowserPartition(partition) ||
        partition === "persist:dev-preview" ||
        partition.startsWith("persist:dev-preview-");

      if (!isAllowedLocalhostUrl || !isValidPartition) {
        console.warn(
          `[ProjectViewManager] Blocked webview: url=${params.src}, partition=${params.partition}`
        );
        event.preventDefault();
        return;
      }

      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.navigateOnDragDrop = false;
      webPreferences.disableBlinkFeatures = "Auxclick";
      webPreferences.partition = params.partition;
    };

    const handleBeforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
      const isMac = process.platform === "darwin";
      const key = input.key.toLowerCase();
      const isTerminalFocusShortcut =
        input.type === "keyDown" &&
        (key === "tab" || input.code === "Tab") &&
        input.control &&
        !input.meta &&
        !input.alt;
      if (isTerminalFocusShortcut) {
        event.preventDefault();
        wc.send(CHANNELS.MENU_ACTION, {
          actionId: input.shift ? "terminal.focusPrevious" : "terminal.focusNext",
        });
        return;
      }

      const isCloseShortcut =
        input.type === "keyDown" &&
        key === "w" &&
        ((isMac && input.meta && !input.control) || (!isMac && input.control && !input.meta)) &&
        !input.alt;
      wc.setIgnoreMenuShortcuts(isCloseShortcut);
    };

    // Fire onViewReady on load/reload, but ONLY for the active view.
    // A cached view reloading (e.g. after crash recovery) must not steal
    // the PTY MessagePort from the currently visible view.
    const handleDidFinishLoad = () => {
      if (wc.isDestroyed()) return;
      const projectId = this.webContentsToProject.get(wc.id);
      if (projectId && projectId === this.activeProjectId) {
        this.onViewReady?.(wc);
      }
    };

    const handleRenderProcessGone = (
      _event: Electron.Event,
      details: Electron.RenderProcessGoneDetails
    ) => {
      if (details.reason === "clean-exit") return;

      const projectId = this.webContentsToProject.get(wc.id);
      console.error(
        `[ProjectViewManager] View renderer gone (project: ${projectId}):`,
        details.reason,
        details.exitCode
      );
      // Memory eviction is not a crash — skip the one-shot crash log so a
      // genuine crash in the same session can still be recorded.
      if (details.reason !== "memory-eviction") {
        getCrashRecoveryService().recordCrash(
          new Error(`View renderer gone: ${details.reason} (exit code ${details.exitCode})`)
        );
      }

      if (win.isDestroyed()) return;

      const crashEntry = projectId ? this.views.get(projectId) : null;

      // If the view is still loading, loadView's one-shot handler will handle
      // the failure and trigger rollback — skip crash recovery here.
      if (crashEntry?.state === "loading") return;

      // Synchronously notify subscribers (e.g. PtyClient) so per-window
      // MessagePorts can be torn down before reload re-issues fresh ones.
      // Without this, a stale port can keep PortQueueManager wedged in a
      // backpressure-pause loop for the entire reload window (#6244).
      // Scoped to the active project: only the active view ever owns the
      // per-window port (handleDidFinishLoad gates onViewReady on
      // activeProjectId), so a cached-view crash must not tear it down.
      if (projectId && projectId === this.activeProjectId) {
        this.onViewCrashed?.(wc);
      }

      // "oom" is Windows-specific (pagefile exhaustion). On macOS/Linux, V8
      // heap exhaustion surfaces as "crashed" and the OS OOM-killer surfaces
      // as "killed". We detect probable OOM by checking available memory
      // against the profile threshold. exitCode is intentionally not used —
      // sources disagree on its value for V8 heap OOM (5 vs 132).
      // Performance profile sets the threshold to null to disable the
      // heuristic for memory-unconstrained sessions.
      const availableMb = this.getAvailableMemoryMb();
      const isProbableOom =
        details.reason === "oom" ||
        ((details.reason === "crashed" || details.reason === "killed") &&
          this.lowMemoryFreeThresholdMb !== null &&
          availableMb !== null &&
          availableMb < this.lowMemoryFreeThresholdMb);

      // OS-pressure memory eviction is distinct from a crash: the renderer is
      // reclaimed by the OS without a V8 abort. For the ACTIVE view the blank
      // frame is user-visible, so an explicit reload is required. It does not
      // count toward the crash-loop guard because repeated OS evictions under
      // memory pressure are not a sign of a looping crash bug.
      if (details.reason === "memory-eviction") {
        if (projectId && projectId === this.activeProjectId) {
          notifyError(new Error("A project view was reloaded due to memory pressure."), {
            source: "renderer-crash",
          });
          setImmediate(() => {
            if (!wc.isDestroyed()) wc.reload();
          });
          return;
        }
        // Cached view: the OS reclaimed this renderer precisely because
        // memory is scarce. A background reload would immediately respawn a
        // full renderer (~100-500 MB) under the same pressure — and since
        // memory-eviction is exempt from the crash-loop guard, the
        // evict→reload→evict cycle has no backstop. Treat it as an LRU
        // eviction instead: memory stays reclaimed and the next visit goes
        // through the existing cold-start paint-gate path.
        if (projectId && crashEntry?.state === "cached") {
          console.warn(
            `[ProjectViewManager] Cached view reclaimed by OS memory pressure; evicting (project: ${projectId})`
          );
          this.evictDeadView(projectId, wc, "memory-eviction");
          return;
        }
        setImmediate(() => {
          if (!wc.isDestroyed()) wc.reload();
        });
        return;
      }

      const crashTimestamps = crashEntry?.crashTimestamps ?? [];
      const now = Date.now();
      while (crashTimestamps.length > 0 && now - crashTimestamps[0] > CRASH_LOOP_WINDOW_MS) {
        crashTimestamps.shift();
      }
      crashTimestamps.push(now);

      if (crashTimestamps.length >= CRASH_LOOP_THRESHOLD) {
        console.error("[ProjectViewManager] Crash loop detected, loading recovery page");
        setImmediate(() => {
          if (wc.isDestroyed()) return;
          const params = new URLSearchParams({
            reason: details.reason,
            exitCode: String(details.exitCode),
          });
          if (crashEntry?.projectPath) {
            params.set("project", path.basename(crashEntry.projectPath));
          }
          const recoverySvc = getCrashRecoveryService();
          const backupTimestamp = recoverySvc.getLastBackupTimestamp();
          if (backupTimestamp !== null) {
            params.set("backupTimestamp", String(backupTimestamp));
          }
          const panelCount = recoverySvc.getBackupPanelCount(true);
          if (panelCount !== null) {
            params.set("panelCount", String(panelCount));
          }
          if (process.env.NODE_ENV === "development") {
            wc.loadURL(`${getDevServerUrl()}/recovery.html?${params}`);
          } else {
            wc.loadURL(`app://daintree/recovery.html?${params}`);
          }
        });
      } else if (isProbableOom && this.onRecreateWindow) {
        console.warn("[ProjectViewManager] OOM crash, destroying and recreating window");
        notifyError(new Error("A project view ran out of memory and the window was recreated."), {
          source: "renderer-crash",
        });
        setImmediate(() => {
          // Increment the guard before `destroy()` — Electron emits
          // `window-all-closed` synchronously inside the destroy call.
          beginWindowRecreating();
          if (!win.isDestroyed()) win.destroy();
          this.onRecreateWindow!()
            .catch((err) => {
              console.error("[ProjectViewManager] Failed to recreate window after OOM:", err);
            })
            .finally(() => {
              endWindowRecreating();
              // The suppressed `window-all-closed` event must be replayed if
              // the recreation failed — otherwise on non-darwin the process
              // hangs headless with no windows and no quit path. Skip when
              // another OOM recreate is still in flight or any window remains
              // (the natural `window-all-closed` path will cover those cases).
              if (
                !isWindowRecreating() &&
                process.platform !== "darwin" &&
                BrowserWindow.getAllWindows().length === 0
              ) {
                app.quit();
              }
            });
        });
      } else if (
        projectId &&
        projectId !== this.activeProjectId &&
        crashEntry?.state === "cached"
      ) {
        // A crashed cached view has no user-visible reason to be resurrected
        // in the background — evict it and let the next visit cold-start
        // instead of paying a full renderer respawn now.
        console.warn(
          `[ProjectViewManager] Cached view crashed; evicting instead of background reload (project: ${projectId})`
        );
        this.evictDeadView(projectId, wc, "crash");
      } else {
        console.log("[ProjectViewManager] Renderer crash, auto-reloading view");
        if (projectId && projectId === this.activeProjectId) {
          notifyError(new Error("A project view crashed and was automatically reloaded."), {
            source: "renderer-crash",
          });
        }
        setImmediate(() => {
          if (!wc.isDestroyed()) wc.reload();
        });
      }
    };

    wc.on("will-navigate", handleWillNavigate);
    wc.on("will-redirect", handleWillRedirect);
    wc.on("will-attach-webview", handleWillAttachWebview);
    wc.on("before-input-event", handleBeforeInputEvent);
    wc.on("did-finish-load", handleDidFinishLoad);
    wc.on("render-process-gone", handleRenderProcessGone);

    // Capture wc in closure: post-eviction the view's webContents getter may be
    // undefined (Electron #50249). Removing listeners must happen before close()
    // so any queued event from Chromium cannot fire against stale view state.
    let cleaned = false;
    entry.cleanupHandlers = () => {
      if (cleaned) return;
      wc.removeListener("will-navigate", handleWillNavigate);
      wc.removeListener("will-redirect", handleWillRedirect);
      wc.removeListener("will-attach-webview", handleWillAttachWebview);
      wc.removeListener("before-input-event", handleBeforeInputEvent);
      wc.removeListener("did-finish-load", handleDidFinishLoad);
      wc.removeListener("render-process-gone", handleRenderProcessGone);
      detachRendererConsoleCapture(wc);
      cleaned = true;
    };

    // Fullscreen events are handled by the window-level resize handler
    // and the sendToRenderer in createWindow.ts — no per-view listeners needed.
  }

  /**
   * Evict a cached view whose renderer is already gone (OS memory eviction or
   * crash) instead of reloading it in the background. Deferred one tick like
   * the reload branches; re-checks state at run time — if the view was
   * activated between the event and this tick, reload instead so the user
   * isn't left on a blank frame.
   */
  private evictDeadView(
    projectId: string,
    wc: Electron.WebContents,
    trigger: "memory-eviction" | "crash"
  ): void {
    setImmediate(() => {
      if (this.disposed || this.win.isDestroyed()) return;
      const entry = this.views.get(projectId);
      if (!entry || entry.view.webContents.id !== wc.id) return;
      if (entry.state !== "cached" || projectId === this.activeProjectId) {
        if (!wc.isDestroyed()) wc.reload();
        return;
      }
      logInfo("projectview.eviction", {
        projectId,
        reason: trigger,
        ageMs: Date.now() - entry.lastUsed,
        activeAgent: this.hasActiveAgent(projectId),
      });
      this.evictionTimestamps.set(projectId, Date.now());
      this.cleanupEntry(projectId);
    });
  }

  private cleanupEntry(projectId: string): void {
    const entry = this.views.get(projectId);
    if (!entry) return;

    // Detach persistent webContents listeners before close() so any queued
    // event (did-finish-load, render-process-gone, etc.) cannot fire against
    // an evicted view and act on stale views/activeProjectId state.
    try {
      entry.cleanupHandlers();
    } catch (error) {
      console.error("[ProjectViewManager] cleanupHandlers threw during eviction:", error);
    }

    // Remove from window if attached
    if (!this.win.isDestroyed()) {
      try {
        this.win.contentView.removeChildView(entry.view);
      } catch {
        // May not be attached
      }
    }

    // Unregister from WindowRegistry
    const wcId = entry.view.webContents.id;
    if (this.windowRegistry) {
      this.windowRegistry.unregisterAppViewWebContents(this.win.id, wcId);
    }

    this.webContentsToProject.delete(wcId);
    unregisterProjectView(wcId);
    forgetBlinkSample(wcId);
    forgetEluSample(wcId);

    // Notify listeners (e.g. WorkspaceClient) so they can clean up direct ports
    this.onViewEvicted?.(wcId);

    // Close webContents — only unregister from webContentsRegistry, NOT unregisterAppView
    // (which would remove the active view's registration)
    if (!entry.view.webContents.isDestroyed()) {
      unregisterWebContents(entry.view.webContents);
      entry.view.webContents.close();
    }

    this.views.delete(projectId);
  }

  /**
   * Seed and maintain the agent-state cache used by the synchronous
   * `hasActiveAgent()` eviction guard. Fire-and-forget: until the first seed
   * resolves the maps are empty and `hasActiveAgent()` returns false (the
   * conservative pre-regression behavior — an in-flight view is never wrongly
   * treated as protected). Idempotent listener wiring: cleanup callbacks are
   * cleared first so re-invocation doesn't double-subscribe.
   */
  initAgentStateCache(ptyClient: PtyClient): Promise<void> {
    for (const cleanup of this.agentCacheCleanup) cleanup();
    this.agentCacheCleanup = [];

    const seed = async () => {
      try {
        const terminals = await ptyClient.getAllTerminalsAsync();
        if (this.disposed) return;
        this.projectByTerminal.clear();
        this.agentStateByTerminal.clear();
        for (const t of terminals) {
          if (t.projectId) this.projectByTerminal.set(t.id, t.projectId);
          if (t.agentState) this.agentStateByTerminal.set(t.id, t.agentState);
        }
        // A background agent may have gone active (or been spawned) after the
        // debounced freeze fired but before it was mapped here, so its view was
        // frozen with hasActiveAgent() still false. Now that the maps are fresh,
        // wake any such view so its queued state event applies.
        this.unfreezeActiveAgentViews();
      } catch {
        // Host unavailable — leave maps as-is; hasActiveAgent stays conservative.
      }
    };

    const onStateChanged = (payload: { terminalId?: string; state: AgentState }) => {
      // No projectId on this event — the seed map owns the terminal→project
      // link. Skip terminals we haven't seeded yet (a spawn-result reseed will
      // pick them up). On terminal exit the state machine emits exited/completed
      // (neither in ACTIVE_AGENT_STATES), so a killed terminal self-heals to
      // unprotected here; a missed final event is corrected by the next
      // spawn-result/host-crash reseed.
      if (!payload.terminalId) return;
      this.agentStateByTerminal.set(payload.terminalId, payload.state);
      // Wake a view that was frozen before its agent became active: the freeze
      // blocks the renderer from ever applying this very event, so unfreeze the
      // owning project's cached view now. If the terminal isn't mapped to a
      // project yet (pre-seed race), the spawn-result reseed's
      // unfreezeActiveAgentViews() pass catches it.
      if (this.efficiencyFreezeEnabled && ACTIVE_AGENT_STATES.has(payload.state)) {
        const projectId = this.projectByTerminal.get(payload.terminalId);
        if (projectId && projectId !== this.activeProjectId) {
          const entry = this.views.get(projectId);
          if (entry && !entry.view.webContents.isDestroyed()) {
            void unfreezeWebContents(entry.view.webContents);
          }
        }
      }
    };
    const offStateChanged = events.on("agent:state-changed", onStateChanged);

    const onSpawnResult = () => void seed();
    const onHostCrash = () => void seed();
    // Drop a terminal from the freeze-seed maps when it exits, so a dead
    // terminal can't leave a stale project/agent-state entry that keeps
    // hasActiveAgent() reporting a phantom active agent for its project.
    const onTerminalExit = (id: string) => {
      this.projectByTerminal.delete(id);
      this.agentStateByTerminal.delete(id);
    };
    ptyClient.on("spawn-result", onSpawnResult);
    ptyClient.on("host-crash", onHostCrash);
    ptyClient.on("exit", onTerminalExit);

    this.agentCacheCleanup.push(offStateChanged);
    this.agentCacheCleanup.push(() => ptyClient.off("spawn-result", onSpawnResult));
    this.agentCacheCleanup.push(() => ptyClient.off("host-crash", onHostCrash));
    this.agentCacheCleanup.push(() => ptyClient.off("exit", onTerminalExit));

    return seed();
  }

  private hasActiveAgent(projectId: string): boolean {
    for (const [terminalId, termProjectId] of this.projectByTerminal) {
      if (termProjectId !== projectId) continue;
      const state = this.agentStateByTerminal.get(terminalId);
      if (state != null && ACTIVE_AGENT_STATES.has(state)) return true;
    }
    return false;
  }

  private evictStaleViews(reason: EvictionReason): void {
    // Override the user-configured cap when system memory is low so we can
    // reclaim Chromium renderers (~100–500 MB each) before the OS hits
    // compressed-RAM throttling. The override is per-pass — `maxCachedViews`
    // is never mutated, so once pressure subsides the user's setting takes
    // effect on the next eviction.
    const availableMb = this.getAvailableMemoryMb();
    const lowMemoryOverride =
      this.lowMemoryFreeThresholdMb != null &&
      availableMb != null &&
      availableMb < this.lowMemoryFreeThresholdMb;
    const effectiveMax = lowMemoryOverride ? 1 : this.maxCachedViews;
    const effectiveReason: EvictionReason = lowMemoryOverride ? "pressure" : reason;

    if (this.views.size <= effectiveMax) return;
    if (this.activeProjectId === null) return;

    if (lowMemoryOverride) {
      logInfo("projectview.pressure-override", {
        availableMb,
        thresholdMb: this.lowMemoryFreeThresholdMb,
        configuredMax: this.maxCachedViews,
        effectiveMax,
      });
    }

    // Build pid → privateBytes index from the synchronous app.getAppMetrics()
    // snapshot. Joined per-view via `webContents.getOSProcessId()` so the
    // eviction log line can record each evicted view's footprint. Memory size
    // does not drive eviction order — the largest renderer is typically the
    // project the user has been working in, so size-first ordering destroys
    // the most valuable view. Eviction is pure LRU (see #8602).
    const memoryByPid = new Map<number, number>();
    try {
      // Shared TTL snapshot: the eviction log line tolerates a few seconds of
      // staleness, so a pass landing near another sampler's sweep reuses it.
      for (const proc of getAppMetricsSnapshot()) {
        const kb = proc.memory.privateBytes ?? proc.memory.workingSetSize;
        if (typeof kb === "number" && kb > 0) {
          memoryByPid.set(proc.pid, kb);
        }
      }
    } catch {
      // app.getAppMetrics() throwing is non-fatal — memoryKb is simply omitted
      // from the eviction log line below.
    }
    const memoryFor = (entry: ViewEntry): number => {
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) return 0;
      const getPid = (wc as { getOSProcessId?: () => number }).getOSProcessId;
      if (typeof getPid !== "function") return 0;
      const pid = getPid.call(wc);
      if (typeof pid !== "number" || pid <= 0) return 0;
      return memoryByPid.get(pid) ?? 0;
    };
    const guestMemoryFor = (entry: ViewEntry): number =>
      entry.view.webContents.isDestroyed()
        ? 0
        : this.sumGuestMemoryKb(entry.view.webContents, memoryByPid);

    // Outgoing view of an open paint gate is still on-screen and serving as
    // the anti-flash bridge — treat it as non-evictable, same as the active
    // view. Without this, a setCachedViewLimit(1) call landing mid-gate
    // (e.g. an efficiency-profile transition firing during a slow cold
    // start) would evict the outgoing view and expose the unpainted
    // incoming frame, re-creating the exact flash this gate prevents.
    const gateOutgoingProjectId = this.pendingPaintGate?.outgoingProjectId ?? null;

    const evictable = Array.from(this.views.entries())
      .filter(([id]) => id !== this.activeProjectId && id !== gateOutgoingProjectId)
      // Oldest lastUsed first — pure LRU. Sequential switchTo calls stamp
      // distinct millisecond timestamps so equal-lastUsed ties don't arise
      // in practice; Array.sort stability handles them deterministically.
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);

    // Partition: evict views without active agents first, only fall back to
    // active-agent views when safe candidates are exhausted. This keeps memory
    // bounded (each WebContentsView is ~400-500MB) without silently killing
    // agent renderers mid-task.
    const safeToEvict: Array<[string, ViewEntry, boolean]> = [];
    const activeAgentFallback: Array<[string, ViewEntry, boolean]> = [];
    for (const [projectId, entry] of evictable) {
      const active = this.hasActiveAgent(projectId);
      if (active) {
        activeAgentFallback.push([projectId, entry, true]);
      } else {
        safeToEvict.push([projectId, entry, false]);
      }
    }

    const candidates = [...safeToEvict, ...activeAgentFallback];

    while (this.views.size > effectiveMax && candidates.length > 0) {
      const [projectId, entry, activeAgent] = candidates.shift()!;
      const ageMs = Date.now() - entry.lastUsed;
      const memoryKb = memoryFor(entry);
      const guestMemoryKb = guestMemoryFor(entry);
      const ctx: Record<string, unknown> = {
        projectId,
        reason: effectiveReason,
        ageMs,
        activeAgent,
      };
      if (memoryKb > 0) ctx.memoryKb = memoryKb;
      if (guestMemoryKb > 0) ctx.guestMemoryKb = guestMemoryKb;
      if (availableMb != null) ctx.memoryAvailableMb = availableMb;
      logInfo("projectview.eviction", ctx);
      this.evictionTimestamps.set(projectId, Date.now());
      this.cleanupEntry(projectId);
    }
  }

  /**
   * Periodic renderer-memory sample for cached (non-active) project views.
   * Silent telemetry only — emits one `projectview.cached-memory` event per
   * cached view per tick so the keep-warm cost is observable in logs without
   * any user-visible behaviour change. Skips when the cache holds only the
   * active view (or fewer) so a single-project session generates no events.
   */
  private sampleCachedViewMemory(): void {
    if (this.views.size <= 1) return;
    const activeProjectId = this.activeProjectId;

    const memoryByPid = new Map<number, number>();
    try {
      // Shared TTL snapshot — telemetry tolerates staleness; per-window
      // samplers near the 30s aligned sweeps reuse them instead of stacking
      // additional full-process-table scans.
      for (const proc of getAppMetricsSnapshot()) {
        const kb = proc.memory.privateBytes ?? proc.memory.workingSetSize;
        if (typeof kb === "number" && kb > 0) {
          memoryByPid.set(proc.pid, kb);
        }
      }
    } catch {
      // app.getAppMetrics() throwing is non-fatal — skip this tick.
      return;
    }

    for (const [projectId, entry] of this.views) {
      if (projectId === activeProjectId) continue;
      // Per-view try/catch keeps a TOCTOU-killed renderer (or any other
      // per-view glitch) from skipping the rest of the cache in this tick.
      try {
        const wc = entry.view.webContents;
        if (wc.isDestroyed()) continue;
        const getPid = (wc as { getOSProcessId?: () => number }).getOSProcessId;
        if (typeof getPid !== "function") continue;
        const pid = getPid.call(wc);
        if (typeof pid !== "number" || pid <= 0) continue;
        const memoryKb = memoryByPid.get(pid);
        if (typeof memoryKb !== "number" || memoryKb <= 0) continue;
        // Webview guests (browser/dev-preview panels) are separate processes
        // whose footprint the host pid lookup misses entirely — for a
        // dev-preview page the guest is often larger than the host. Reported
        // as a separate component so the keep-warm cost stays decomposable.
        const guestMemoryKb = this.sumGuestMemoryKb(wc, memoryByPid);
        const ctx: Record<string, unknown> = {
          projectId,
          memoryKb,
          pid,
        };
        if (guestMemoryKb > 0) ctx.guestMemoryKb = guestMemoryKb;
        logInfo("projectview.cached-memory", ctx);
      } catch {
        // Telemetry only — skip this view and continue with the rest.
      }
    }
  }

  /**
   * Periodic pressure check, piggybacked on the cached-view memory sampler so
   * the `lowMemoryFreeThresholdMb` floor has a trigger that doesn't depend on
   * the user switching projects. Without this, a session idling with several
   * cached views (~100–500 MB each) while free RAM drifts below the floor
   * reclaims nothing until the next cold-start switch or profile-driven
   * `setCachedViewLimit` call. Delegates to `evictStaleViews`, so the LRU
   * ordering, agent protection, and paint-gate exclusions all apply.
   */
  private maybeEvictUnderPressure(): void {
    if (this.views.size <= 1) return;
    if (this.lowMemoryFreeThresholdMb == null) return;
    const availableMb = this.getAvailableMemoryMb();
    if (availableMb == null || availableMb >= this.lowMemoryFreeThresholdMb) return;
    this.evictStaleViews("pressure");
  }

  /**
   * Read system-wide available memory in MB. On macOS, "available" = free +
   * purgeable, because Darwin holds reclaimable pages as purgeable rather
   * than free — using `free` alone would fire false positives on every
   * healthy mac. On Windows/Linux, `free` alone is accurate. Returns null
   * when the Chromium API is unavailable (e.g., under test mocks).
   */
  private getAvailableMemoryMb(): number | null {
    try {
      const getInfo = (
        process as {
          getSystemMemoryInfo?: () => { free: number; purgeable?: number; total: number };
        }
      ).getSystemMemoryInfo;
      if (typeof getInfo !== "function") return null;
      const info = getInfo.call(process);
      const freeKb = typeof info.free === "number" ? info.free : 0;
      const purgeableKb = typeof info.purgeable === "number" ? info.purgeable : 0;
      const availableKb = freeKb + purgeableKb;
      if (availableKb <= 0) return null;
      return availableKb / 1024;
    } catch {
      return null;
    }
  }
}

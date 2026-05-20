/**
 * ProjectViewManager — Per-project WebContentsView manager.
 *
 * Each project gets its own WebContentsView with an independent V8 context.
 * Switching projects swaps the visible view (<16ms for cached views).
 */

import { app, BrowserWindow, WebContentsView, session } from "electron";
import path from "path";
import { performance } from "node:perf_hooks";
import {
  registerWebContents,
  registerAppView,
  unregisterWebContents,
  registerProjectView,
  unregisterProjectView,
} from "./webContentsRegistry.js";
import { registerProtocolsForSession, getDistPath } from "../setup/protocols.js";
import { getDevServerUrl } from "../../shared/config/devServer.js";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";
import { isLocalhostUrl } from "../../shared/utils/urlUtils.js";
import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { forgetBlinkSample, forgetEluSample } from "../services/ProcessMemoryMonitor.js";
import { getPtyManager } from "../services/PtyManager.js";
import { notifyError } from "../ipc/errorHandlers.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { injectSkeletonCss } from "./skeletonCss.js";
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
import { ACTIVE_AGENT_STATES } from "../../shared/types/agent.js";
import { setAlignedInterval } from "../utils/setAlignedInterval.js";
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
/**
 * Maximum time to wait for the incoming view's renderer to signal
 * `APP_VIEW_PAINTED` before unconditionally tearing down the outgoing
 * view. Three seconds keeps a slow renderer from leaving the outgoing
 * view attached indefinitely on a stuck or crashed cold start, while
 * comfortably covering the realistic worst case (~1s on cold disk).
 */
const PAINT_GATE_TIMEOUT_MS = 3_000;
/**
 * Period between renderer-memory samples for cached (non-active) views. 30 s
 * matches `ProcessMemoryMonitor` and keeps the synchronous `app.getAppMetrics()`
 * call (5–50 ms per invocation) out of the budget that would risk main-thread
 * jank. The sampler is silent telemetry only — no behaviour change.
 */
const CACHED_VIEW_MEMORY_SAMPLE_INTERVAL_MS = 30_000;

type ViewState = "loading" | "active" | "cached";

interface PaintGate {
  webContentsId: number;
  /**
   * The view that was active when the gate opened — still attached during the
   * wait. Resize events must reach it too so visible bounds stay in sync.
   */
  outgoingEntry: ViewEntry | null;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (reason: "signal" | "timeout" | "cancelled") => void;
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
   * Override the paint-gate fallback timeout (default 3000 ms). Lower values
   * are useful in tests so the cold-start swap proceeds without waiting on
   * a real renderer paint signal.
   */
  paintGateTimeoutMs?: number;
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
  private pendingPaintGate: PaintGate | null = null;
  private paintGateTimeoutMs = PAINT_GATE_TIMEOUT_MS;
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
      const outgoing = this.pendingPaintGate?.outgoingEntry;
      if (outgoing && !outgoing.view.webContents.isDestroyed() && outgoing.view !== view) {
        outgoing.view.setBounds({ x: 0, y: 0, width, height });
      }
    };
    win.on("resize", this.resizeHandler);
    win.on("maximize", this.resizeHandler);
    win.on("unmaximize", this.resizeHandler);
    win.on("enter-full-screen", this.resizeHandler);
    win.on("leave-full-screen", this.resizeHandler);

    // Outer try/catch is load-bearing: `setAlignedInterval` calls the callback
    // synchronously on the first aligned tick BEFORE installing the recurring
    // `setInterval`. If the first tick throws, the recurring interval is never
    // installed and all subsequent sampling is silently lost. Any uncaught throw
    // also reaches `uncaughtException`. Sampling failures are pure telemetry
    // and must never destabilise the manager.
    this.cachedMemoryTimerCleanup = setAlignedInterval(() => {
      if (this.disposed) return;
      try {
        this.sampleCachedViewMemory();
      } catch (error) {
        logWarn("projectview.cached-memory.error", {
          error: formatErrorMessage(error, "sampleCachedViewMemory threw"),
        });
      }
    }, CACHED_VIEW_MEMORY_SAMPLE_INTERVAL_MS);
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

    // Try to activate cached view (fast path — already painted, no skeleton gate needed)
    const cached = this.views.get(projectId);
    if (cached && !cached.view.webContents.isDestroyed()) {
      // Detach current active view immediately for cached reactivations —
      // the cached view is already rendered and there is no perceptible flash
      // window to bridge.
      this.deactivateCurrentView();
      // "revival" measures time since this projectId was last evicted — not time
      // since the current cached view (a cold-started successor) was last active.
      // Eviction destroys the original view, so any cache hit for a previously-
      // evicted projectId necessarily hits a later cold-started entry. The
      // timestamp persists across the cold-start so cache-pressure signals stay
      // observable at the project level. Consumed on read to fire only once per
      // eviction → return cycle.
      const evictedAt = this.evictionTimestamps.get(projectId);
      // `activateView` re-attaches the already-painted renderer; `notifyViewPainted`
      // is one-shot per V8 context and will not re-fire, so the synchronous
      // attach window is the only measurable "made visible" delta available.
      // Lower bound (DOM attach, not GPU paint) but consistent across cache hits.
      const warmStart = performance.now();
      this.activateView(cached);
      const visibleMs = Math.round(performance.now() - warmStart);
      if (evictedAt !== undefined) {
        logInfo("projectview.revival", {
          projectId,
          timeSinceEvictionMs: Date.now() - evictedAt,
          visibleMs,
        });
        this.evictionTimestamps.delete(projectId);
      }
      logInfo("projectview.warm-swap", {
        projectId,
        visibleMs,
      });
      const cachedIntent = this.consumePendingFocusIntent(projectId);
      if (cachedIntent) {
        this.deliverFocusIntent(cached.view, cachedIntent);
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
    // the outgoing view visually on top while the incoming view boots.
    this.win.contentView.addChildView(view, 0);
    this.updateViewBounds(view);
    this.activeProjectId = projectId;
    entry.state = "active";

    // Arm the paint gate BEFORE `loadView()` so a signal arriving the moment
    // the renderer's double-rAF lands (which can happen on the same tick as
    // `did-finish-load`) is captured instead of dropped. The renderer fires
    // `APP_VIEW_PAINTED` once per V8 context and never retries — without
    // pre-arming, every fast cold switch would fall through to the timeout.
    const paintGatePromise = this.waitForPaint(view.webContents.id, previousEntry);

    let visibleAt: number;
    try {
      // Load the renderer with projectId context
      await this.loadView(view, projectId);

      // Wait for the renderer to confirm React has committed its first
      // structural paint (sent via `APP_VIEW_PAINTED` after a double-rAF in
      // `notifyViewPainted`). Bounded by `PAINT_GATE_TIMEOUT_MS` so a stuck
      // renderer cannot leave the outgoing view attached forever.
      const gateResult = await paintGatePromise;
      visibleAt = performance.now();
      if (gateResult === "timeout") {
        logWarn("projectview.paintgate.timeout", {
          projectId,
          waitedMs: this.paintGateTimeoutMs,
        });
      }

      // Paint signal received (or timed out) — safe to detach the outgoing view.
      if (previousEntry && this.activeProjectId === projectId) {
        this.deactivateEntry(previousEntry);
      }

      logInfo("projectview.coldstart", {
        projectId,
        durationMs: Math.round(performance.now() - coldStartAt),
        visibleMs: Math.round(visibleAt - coldStartAt),
        paintGateOutcome: gateResult,
      });

      // Deliver pending focus intent only when the renderer has confirmed
      // first paint. On timeout the renderer may be stuck or unresponsive —
      // dropping the intent is safer than firing into a partially-mounted
      // view (the subscriber is registered before `notifyViewPainted`, but
      // a paint-gate timeout means we have no positive evidence of that).
      // The intent is always consumed (cleared) regardless of outcome to
      // prevent a later unrelated switch from picking up a stale focus.
      const coldIntent = this.consumePendingFocusIntent(projectId);
      if (coldIntent && gateResult === "signal") {
        this.deliverFocusIntent(view, coldIntent);
      }
    } catch (loadError) {
      // Cold-start failed before the swap happened — outgoing view is still
      // attached and visible. Tear down the failed incoming view, restore the
      // previous app-view registration (`registerAppView` was overwritten to
      // point at the failed view), and let the still-attached outgoing view
      // resume as the active view.
      this.clearPaintGate("cancelled");
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
        previousEntry.state = "active";
        previousEntry.lastUsed = Date.now();
      }

      notifyError(loadError, { source: "project-switch" });

      throw loadError;
    }

    // Explicit focus after swap
    if (!view.webContents.isDestroyed()) {
      view.webContents.focus();
    }

    // Evict LRU views if over limit
    this.evictStaleViews("lru");

    return { view, isNew: true };
  }

  /**
   * Resolve when the renderer with `webContentsId` posts `APP_VIEW_PAINTED`
   * via {@link signalViewPainted}, or when `PAINT_GATE_TIMEOUT_MS` elapses,
   * or when a superseding switch cancels the gate. Only one paint gate is
   * tracked at a time — opening a new gate cancels any prior pending one.
   */
  private waitForPaint(
    webContentsId: number,
    outgoingEntry: ViewEntry | null
  ): Promise<"signal" | "timeout" | "cancelled"> {
    // Cancel any prior gate from a previous switch attempt. Should not
    // normally occur (switchChain serializes), but guards against re-entry
    // from rollback paths.
    this.clearPaintGate("cancelled");

    return new Promise((resolveOuter) => {
      const gate: PaintGate = {
        webContentsId,
        outgoingEntry,
        timeout: setTimeout(() => {
          if (this.pendingPaintGate === gate) {
            this.pendingPaintGate = null;
            resolveOuter("timeout");
          }
        }, this.paintGateTimeoutMs),
        resolve: (reason) => {
          clearTimeout(gate.timeout);
          if (this.pendingPaintGate === gate) {
            this.pendingPaintGate = null;
          }
          resolveOuter(reason);
        },
      };
      this.pendingPaintGate = gate;
    });
  }

  private clearPaintGate(reason: "signal" | "timeout" | "cancelled"): void {
    const gate = this.pendingPaintGate;
    if (!gate) return;
    this.pendingPaintGate = null;
    clearTimeout(gate.timeout);
    gate.resolve(reason);
  }

  /**
   * Renderer-driven gate release. Called from the `APP_VIEW_PAINTED` IPC
   * handler with the webContentsId of the renderer that just painted. A
   * mismatch (e.g. signal arriving after a superseding switch already moved
   * on) is silently ignored.
   */
  signalViewPainted(webContentsId: number): void {
    const gate = this.pendingPaintGate;
    if (!gate) return;
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

  getActiveView(): WebContentsView | null {
    if (!this.activeProjectId) return null;
    return this.views.get(this.activeProjectId)?.view ?? null;
  }

  getProjectIdForWebContents(webContentsId: number): string | null {
    return this.webContentsToProject.get(webContentsId) ?? null;
  }

  getAllViews(): ViewEntry[] {
    return Array.from(this.views.values());
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
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      void freezeWebContents(wc);
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

  destroyView(projectId: string): void {
    const entry = this.views.get(projectId);
    if (!entry) return;

    if (this.activeProjectId === projectId) {
      this.activeProjectId = null;
    }

    this.cleanupEntry(projectId);
  }

  dispose(): void {
    this.disposed = true;

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

    this.clearPaintGate("cancelled");
    for (const projectId of Array.from(this.views.keys())) {
      this.cleanupEntry(projectId);
    }
    this.views.clear();
    this.webContentsToProject.clear();
    this.evictionTimestamps.clear();
    this.activeProjectId = null;
  }

  // ── Private ──

  private deactivateCurrentView(): void {
    if (!this.activeProjectId) return;
    const current = this.views.get(this.activeProjectId);
    if (!current) return;
    this.deactivateEntry(current);
  }

  private deactivateEntry(current: ViewEntry): void {
    if (this.win.isDestroyed()) return;

    try {
      this.win.contentView.removeChildView(current.view);
    } catch {
      // View may not be attached
    }
    current.state = "cached";
    current.lastUsed = Date.now();

    // Throttle background view to reduce CPU and allow Chromium to reclaim memory
    if (!current.view.webContents.isDestroyed()) {
      const cachedWcId = current.view.webContents.id;
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
      // if we froze first (lesson #4684).
      if (this.efficiencyFreezeEnabled && !webContents.isDestroyed()) {
        void freezeWebContents(webContents);
      }
    }
  }

  private activateView(entry: ViewEntry): void {
    registerAppView(this.win, entry.view);

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
    }

    this.win.contentView.addChildView(entry.view);
    this.updateViewBounds(entry.view);

    // Explicit focus — addChildView does not auto-focus
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.focus();
    }

    entry.state = "active";
    entry.lastUsed = Date.now();
    this.activeProjectId = entry.projectId;
  }

  private createView(_projectId: string): WebContentsView {
    const ses = session.fromPartition("persist:daintree");

    // Register app:// and daintree-file:// protocol handlers on this session.
    // protocol.handle() only covers the default session — custom partitions need explicit setup.
    const distPath = getDistPath();
    if (distPath) {
      registerProtocolsForSession(ses, distPath);
    }

    return new WebContentsView({
      webPreferences: {
        preload: path.join(this.dirname, "preload.cjs"),
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        navigateOnDragDrop: false,
        v8CacheOptions: "code",
      },
    });
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

      const onFinish = () => settle(() => resolve());
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

      injectSkeletonCss(wc);

      const encodedId = encodeURIComponent(projectId);
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
        const devServerUrl = getDevServerUrl();
        const url = `${devServerUrl}?projectId=${encodedId}`;
        wc.loadURL(url).catch((err) => onLoadURLReject(err, url));
      } else {
        const url = `app://daintree/index.html?projectId=${encodedId}`;
        wc.loadURL(url).catch((err) => onLoadURLReject(err, url));
      }
    });
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
      const allowedPartitions = ["persist:browser", "persist:dev-preview"];
      const isAllowedLocalhostUrl = isLocalhostUrl(params.src);
      const isValidPartition =
        allowedPartitions.includes(params.partition || "") ||
        (params.partition?.startsWith("persist:dev-preview-") ?? false);

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
      getCrashRecoveryService().recordCrash(
        new Error(`View renderer gone: ${details.reason} (exit code ${details.exitCode})`)
      );

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
          const backupTimestamp = getCrashRecoveryService().getLastBackupTimestamp();
          if (backupTimestamp !== null) {
            params.set("backupTimestamp", String(backupTimestamp));
          }
          if (process.env.NODE_ENV === "development") {
            wc.loadURL(`${getDevServerUrl()}/recovery.html?${params}`);
          } else {
            wc.loadURL(`app://daintree/recovery.html?${params}`);
          }
        });
      } else if (details.reason === "oom" && this.onRecreateWindow) {
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
      } else {
        console.log("[ProjectViewManager] Renderer crash, auto-reloading view");
        // Only the active view's crash is observable to the user — a cached
        // view auto-reloading silently has no UI signal worth a toast.
        if (projectId && projectId === this.activeProjectId) {
          notifyError(new Error("A project view crashed and was automatically reloaded."), {
            source: "renderer-crash",
          });
        } else {
          console.warn(
            `[ProjectViewManager] Cached view crashed and was auto-reloaded (project: ${projectId})`
          );
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

  private hasActiveAgent(projectId: string): boolean {
    const terminals = getPtyManager().getAll();
    return terminals.some(
      (t) =>
        t.projectId === projectId && t.agentState != null && ACTIVE_AGENT_STATES.has(t.agentState)
    );
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
      for (const proc of app.getAppMetrics()) {
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

    const evictable = Array.from(this.views.entries())
      .filter(([id]) => id !== this.activeProjectId)
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
      const ctx: Record<string, unknown> = {
        projectId,
        reason: effectiveReason,
        ageMs,
        activeAgent,
      };
      if (memoryKb > 0) ctx.memoryKb = memoryKb;
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
      for (const proc of app.getAppMetrics()) {
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
        logInfo("projectview.cached-memory", {
          projectId,
          memoryKb,
          pid,
        });
      } catch {
        // Telemetry only — skip this view and continue with the rest.
      }
    }
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

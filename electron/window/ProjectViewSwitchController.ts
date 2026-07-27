/**
 * Project-switch driver for ProjectViewManager — the warm cached-view
 * reactivation path, cold-start view creation, and rollback-on-failure.
 * Extracted from ProjectViewManager (#11004); called from `switchTo`, which
 * serializes calls through `switchChain` so only one switch runs at a time.
 */

import type { WebContentsView } from "electron";
import { performance } from "node:perf_hooks";
import {
  registerWebContents,
  registerAppView,
  registerProjectView,
} from "./webContentsRegistry.js";
import { notifyError } from "../ipc/errorHandlers.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { CHANNELS } from "../ipc/channels.js";
import { unfreezeWebContents } from "../utils/webContentsLifecycle.js";
import { createView, loadView, updateViewBounds } from "./ProjectViewFactory.js";
import {
  activateView,
  deactivateEntry,
  cleanupEntry,
  detachUnboundOutgoingView,
  getUnboundOutgoingView,
  pruneOrphanedChildren,
} from "./ProjectViewLifecycleController.js";
import { setupViewHandlers } from "./ProjectViewHandlers.js";
import { evictStaleViews } from "./ProjectViewEvictionController.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { ViewEntry } from "./ProjectViewManagerTypes.js";

function consumePendingFocusIntent(
  host: ProjectViewManager,
  projectId: string
): "focus-next-waiting" | null {
  const pending = host.pendingFocusIntent;
  if (!pending) return null;
  host.pendingFocusIntent = null;
  if (pending.projectId !== projectId) return null;
  return pending.intent;
}

function deliverFocusIntent(view: WebContentsView, intent: "focus-next-waiting"): void {
  if (view.webContents.isDestroyed()) return;
  // Targeted send to the specific incoming view — never broadcast (#4641, #5010).
  view.webContents.send(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, { intent });
}

export async function performSwitch(
  host: ProjectViewManager,
  projectId: string,
  projectPath: string
): Promise<{ view: WebContentsView; isNew: boolean }> {
  // A switch queued behind switchChain can land after dispose() (window
  // close mid-queue). Creating a view on a disposed manager would leak it:
  // no timer sweeps, no eviction, no dispose pass will ever reach it.
  if (host.disposed) {
    throw new Error("Cannot switch view — manager is disposed");
  }
  if (host.win.isDestroyed()) {
    throw new Error("Cannot switch view — window is destroyed");
  }

  // Already active — no-op
  if (host.activeProjectId === projectId) {
    const existing = host.views.get(projectId);
    if (existing) {
      // Consume any pending intent so it doesn't leak into a later switch.
      // The renderer-side global action short-circuits same-project locally,
      // so reaching here with an intent is unusual but possible (e.g. two
      // concurrent switchTo calls); deliver immediately rather than drop.
      const activeIntent = consumePendingFocusIntent(host, projectId);
      if (activeIntent) {
        deliverFocusIntent(existing.view, activeIntent);
      }
      return { view: existing.view, isNew: false };
    }
  }

  // Snapshot previous state for rollback
  const previousProjectId = host.activeProjectId;
  const previousEntry = previousProjectId ? (host.views.get(previousProjectId) ?? null) : null;
  const unboundOutgoingView = previousEntry ? null : getUnboundOutgoingView(host);
  const outgoingView = previousEntry?.view ?? unboundOutgoingView;

  // Try to activate cached view (fast path — renderer already mounted).
  const cached = host.views.get(projectId);
  if (cached && !cached.view.webContents.isDestroyed()) {
    // "revival" measures time since this projectId was last evicted — not time
    // since the current cached view (a cold-started successor) was last active.
    // Eviction destroys the original view, so any cache hit for a previously-
    // evicted projectId necessarily hits a later cold-started entry. The
    // timestamp persists across the cold-start so cache-pressure signals stay
    // observable at the project level. Consumed on read to fire only once per
    // eviction → return cycle.
    const evictedAt = host.evictionTimestamps.get(projectId);
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
      activateView(host, cached, /* insertBehind */ true);
      const warmSoftMs = host.warmPaintGateTimeoutMs;
      const warmHardMs = Math.max(host.warmPaintGateHardTimeoutMs, warmSoftMs);
      const warmGate = host.waitForPaint(
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
      // Deterministic wake trigger: a detached + setVisible(false) cached
      // view never gets `visibilitychange`, and `resume` only fires when the
      // Efficiency profile actually froze it — so on most reactivations the
      // renderer had NO signal to run its wake fan-out and the warm gate sat
      // until the hard timeout (~1.5s per warm switch). Main knows exactly
      // when it re-attaches a cached view, so tell the renderer directly;
      // the visibility/resume listeners remain as fallbacks. Sent after the
      // gate is armed so the wake's completion signal can't slip past it.
      if (!cached.view.webContents.isDestroyed()) {
        cached.view.webContents.send(CHANNELS.APP_VIEW_WARM_ACTIVATED);
      }
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
      if (gateResult !== "cancelled" && host.activeProjectId === projectId) {
        if (previousEntry) {
          deactivateEntry(host, previousEntry);
        } else if (unboundOutgoingView) {
          detachUnboundOutgoingView(host, unboundOutgoingView);
        }
      }
    } else {
      // No outgoing view to bridge through (e.g. first-run with no welcome
      // view) — nothing to flash past, so reveal the cached view immediately.
      activateView(host, cached);
      // Same deterministic wake trigger as the bridged path: the reattach
      // emits no visibility/resume event, so the terminals' refit/repaint
      // fan-out needs an explicit signal here too.
      if (!cached.view.webContents.isDestroyed()) {
        cached.view.webContents.send(CHANNELS.APP_VIEW_WARM_ACTIVATED);
      }
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
      host.evictionTimestamps.delete(projectId);
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
      if (host.activeProjectId === projectId) {
        cached.view.webContents.invalidate();
        cached.view.webContents.send(CHANNELS.APP_VIEW_REVEALED);
      }
    }
    const cachedIntent = consumePendingFocusIntent(host, projectId);
    if (cachedIntent) {
      deliverFocusIntent(cached.view, cachedIntent);
    }
    // Sweep any outgoing view a cancelled gate or destroyView race left
    // attached behind this one (#10806). Never throws past this point.
    try {
      pruneOrphanedChildren(host);
    } catch (error) {
      console.error("[ProjectViewManager] pruneOrphanedChildren threw:", error);
    }
    return { view: cached.view, isNew: false };
  }

  // Cold start — keep the outgoing view attached until the incoming view
  // signals it has painted, so the swap is seamless instead of flashing
  // through a blank-canvas frame while React mounts.
  if (cached) {
    cleanupEntry(host, projectId);
  }

  const coldStartAt = performance.now();
  const view = createView(host, projectId);
  const entry: ViewEntry = {
    view,
    projectId,
    projectPath,
    lastUsed: Date.now(),
    state: "loading",
    crashTimestamps: [],
    cleanupHandlers: () => {},
  };
  host.views.set(projectId, entry);
  host.webContentsToProject.set(view.webContents.id, projectId);
  registerProjectView(projectId, view.webContents);

  // Set up security handlers and attach to window
  setupViewHandlers(host, view, entry);
  registerWebContents(view.webContents, host.win);
  registerAppView(host.win, view);

  // Register in WindowRegistry for IPC routing
  if (host.windowRegistry) {
    host.windowRegistry.registerAppViewWebContents(host.win.id, view.webContents.id);
  }

  // Insert incoming view BEHIND the outgoing view (index 0). Chromium's
  // `WebContentsView` child stack is z-ordered last-on-top, so this keeps
  // the outgoing view visually on top while the incoming view boots. On a
  // true first-run window the outgoing view is the unbound welcome view, not
  // a registered project entry; it still needs the same anti-flash bridge.
  if (outgoingView) {
    host.win.contentView.addChildView(view, 0);
  } else {
    host.win.contentView.addChildView(view);
  }
  updateViewBounds(host, view);
  host.activeProjectId = projectId;
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
  const softMs = host.paintGateTimeoutMs;
  const hardMs = Math.max(host.paintGateHardTimeoutMs, softMs);

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
  const hasPendingFocusIntent = host.pendingFocusIntent?.projectId === projectId;
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
      host.signalSkeletonPainted(skeletonWcId);
    });
  }

  const paintGatePromise = host.waitForPaint(
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
    // Load the renderer with projectId context. Timing is captured here as
    // primitives so a resource-profile transition mid-load can't retime an
    // in-flight load, matching the paint gate's capture-at-creation contract.
    await loadView(view, projectId, {
      softMs: host.viewLoadTimeoutMs,
      hardMs: host.viewLoadHardTimeoutMs,
    });
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
    if (previousEntry && host.activeProjectId === projectId) {
      deactivateEntry(host, previousEntry);
    } else if (unboundOutgoingView && host.activeProjectId === projectId) {
      detachUnboundOutgoingView(host, unboundOutgoingView);
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
      const coldIntent = consumePendingFocusIntent(host, projectId);
      if (coldIntent && gateResult === "signal") {
        deliverFocusIntent(view, coldIntent);
      }
    }
  } catch (loadError) {
    // Cold-start failed before the swap happened — outgoing view is still
    // attached and visible. Tear down the failed incoming view, restore the
    // previous app-view registration (`registerAppView` was overwritten to
    // point at the failed view), and let the still-attached outgoing view
    // resume as the active view.
    host.clearPaintGate();
    // Discard any pending focus intent for the failed projectId so a later
    // unrelated switch can't pick it up.
    consumePendingFocusIntent(host, projectId);
    cleanupEntry(host, projectId);

    host.activeProjectId = previousProjectId;
    if (previousEntry && !previousEntry.view.webContents.isDestroyed()) {
      // Restore app-view registration so getAppWebContents() resolves back
      // to the still-visible previous project view instead of falling
      // through to the bare BrowserWindow's webContents.
      registerAppView(host.win, previousEntry.view);
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
      // If the failure landed after deactivateEntry, this view already received
      // APP_VIEW_CACHED and demoted its periodic terminal work (watchdog sweep,
      // reflow heartbeat, activity markers — #11212). It is about to be the
      // visible active view again, so it needs the matching un-gate signal:
      // without it a rolled-back view stays demoted for the rest of its life,
      // and an xterm renderer paused while it was occluded would never unpause.
      // Warm-activated is the right edge — reveal is reserved for the composited
      // foreground and is skipped when a switch is superseded.
      try {
        previousEntry.view.webContents.send(CHANNELS.APP_VIEW_WARM_ACTIVATED);
      } catch {
        // non-critical — a destroyed renderer has nothing to un-gate
      }
      // Re-fire the view-ready hook so per-view IPC helpers re-bind to the
      // rolled-back active view, matching the load/reload path that normally
      // fires it for the active view.
      host.onViewReady?.(previousEntry.view.webContents);
    } else if (unboundOutgoingView && !unboundOutgoingView.webContents.isDestroyed()) {
      // Same rollback requirement for first-run/unbound windows: the visible
      // welcome view is not a project entry, but IPC helpers still need
      // getAppWebContents() to resolve to it after a failed first switch.
      registerAppView(host.win, unboundOutgoingView);
    }

    // Sweep any orphan that leaked before this failed switch (#10806). The
    // rollback above restores the previous view as active; prune removes any
    // other stray project view still attached behind it. Best-effort.
    try {
      pruneOrphanedChildren(host);
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
    if (!host.disposed && !host.win.isDestroyed()) {
      evictStaleViews(host, "lru");
    }
  });

  // Sweep any outgoing view a cancelled gate or destroyView race left
  // attached behind this one (#10806). Never throws past this point.
  try {
    pruneOrphanedChildren(host);
  } catch (error) {
    console.error("[ProjectViewManager] pruneOrphanedChildren threw:", error);
  }

  return { view, isNew: true };
}

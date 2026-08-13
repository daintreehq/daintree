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
import { AppError } from "../utils/errorTypes.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { CHANNELS } from "../ipc/channels.js";
import { unfreezeWebContents } from "../utils/webContentsLifecycle.js";
import {
  createView,
  isViewLoadCancelled,
  loadView,
  updateViewBounds,
} from "./ProjectViewFactory.js";
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
import type { ProjectFocusOnActivateIntent } from "../../shared/types/ipc/project.js";

/**
 * Largest delay `setTimeout` stores as-is (INT32_MAX ms, ~24.9 days). Anything
 * beyond it wraps to 1ms, turning a deliberately distant deadline into an
 * immediate one.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

function consumePendingFocusIntent(
  host: ProjectViewManager,
  projectId: string
): ProjectFocusOnActivateIntent | null {
  const pending = host.pendingFocusIntent;
  if (!pending) return null;
  host.pendingFocusIntent = null;
  if (pending.projectId !== projectId) return null;
  return pending.intent;
}

function deliverFocusIntent(view: WebContentsView, intent: ProjectFocusOnActivateIntent): void {
  if (view.webContents.isDestroyed()) return;
  // Targeted send to the specific incoming view — never broadcast (#4641, #5010).
  view.webContents.send(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, intent);
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
  const paintHardMs = Math.max(host.paintGateHardTimeoutMs, softMs);

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

  // Both load bounds are captured once, here: the gate's provisional ceiling is
  // sized against them and `loadView` below runs on the same numbers, so a
  // resource-profile push landing between the two reads cannot leave the gate
  // sized for a load budget the load is no longer using. `loadHardMs` mirrors
  // loadView's own `max(hard, soft)` clamp so this is the bound it will apply.
  const loadSoftMs = host.viewLoadTimeoutMs;
  const loadHardMs = Math.max(host.viewLoadHardTimeoutMs, loadSoftMs);

  // The `"painted"` channel holds for the whole React cold boot — ~1.5–4s per
  // the note above, which the paint-gate hard bound (4s balanced) does not
  // bracket, and the bound is spent from before `loadView` so it also pays for
  // renderer spawn, preload eval and navigation. Exhausting it there means
  // "slow", not "wrong document", and abandoning would turn a cold
  // focus-next-waiting into an error toast. Stretch it to the view-load soft
  // bound — the same family's profile-scaled "something is genuinely wrong"
  // threshold.
  //
  // `"skeleton-painted"` keeps that same tight bound but spends it from when
  // the load settles rather than from here: it is armed wide enough to outlast
  // the load's own fatal ceiling, then retimed back down to `paintHardMs` the
  // moment `loadView` resolves (#11765). Pre-arming is what makes the one-shot
  // signal reliable, and it is also what made the bound pay for the load — a
  // cold load slow enough to blow 4s of it (cold disk cache, no V8 code cache,
  // a contended main process) is slow, not broken, and abandoning it lost a
  // switch that was about to succeed. The provisional bound is deliberately
  // larger than `loadHardMs` rather than equal to it: this timer is armed
  // before `loadView` arms its own, so equal delays would expire this one first.
  //
  // What the gate still catches is unchanged, and is now the whole of its job —
  // a document that loaded and verified, then produced no readiness frame at
  // all. The wrong-document case it used to also cover now rejects inside
  // `loadView`, where `verifyProjectBootstrap` probes for `#root` and the
  // bootstrap id (#11635), well before this gate is ever awaited. That leaves a
  // verdict only meaningful once the load has settled — which is exactly when
  // the tight bound now starts.
  //
  // Clamped to the largest delay Node can hold: a sum past it wraps to a 1ms
  // timer, which would fire the provisional gate almost immediately and abandon
  // every cold switch. The clamp cannot cost anything the load does not already
  // cost — a `loadHardMs` big enough to reach it overflows loadView's own timer
  // the same way, and that rejection clears this gate.
  const hardMs =
    coldReleaseChannel === "painted"
      ? Math.max(paintHardMs, loadSoftMs)
      : Math.min(loadHardMs + paintHardMs, MAX_TIMEOUT_MS);

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
    { releaseChannel: coldReleaseChannel, softMs, hardMs }
  );

  let visibleAt: number;
  let loadFinishedAt: number;
  // Mark the window in which the outgoing view is still attached and visible
  // while the incoming one loads. Cleared in the `finally` below, on both the
  // success and rollback paths.
  host.pendingColdSwitch = {
    projectId,
    outgoingProjectId: previousEntry?.projectId ?? null,
  };
  try {
    // Load the renderer with projectId context. Timing is captured here as
    // primitives so a resource-profile transition mid-load can't retime an
    // in-flight load, matching the paint gate's capture-at-creation contract.
    await loadView(view, projectId, {
      softMs: loadSoftMs,
      hardMs: loadHardMs,
    });
    loadFinishedAt = performance.now();

    // The skeleton gate's tight paint bound starts HERE, not at arm time — see
    // the sizing note above. `false` on the common fast path, where the
    // parse-time skeleton signal already released the gate during the load, and
    // on a switch a later one has superseded. Runs before the unfreeze below so
    // the window a slow rAF is measured against is already the right one.
    const paintGateRetimed =
      coldReleaseChannel === "skeleton-painted" &&
      host.retimeSkeletonPaintGateHardTimeout(view.webContents.id, paintHardMs);

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
    // but never user-visible; the hard timeout below abandons the switch and
    // rolls back to the outgoing view, which is never detached without a
    // signal.
    const gateResult = await paintGatePromise;
    visibleAt = performance.now();
    if (gateResult === "hard-timeout") {
      // The bound that actually expired: once a skeleton gate has been retimed
      // the provisional `hardMs` is dead, and reporting it would overstate the
      // wait by the whole load. `hardTimeoutOrigin` says which clock it was
      // spent from — `waitedMs` alone cannot distinguish a paint that never
      // came from a budget that also paid for the load.
      const effectiveHardMs = paintGateRetimed ? paintHardMs : hardMs;
      logWarn("projectview.paintgate.hardtimeout", {
        projectId,
        waitedMs: effectiveHardMs,
        releaseChannel: coldReleaseChannel,
        hardTimeoutOrigin: paintGateRetimed ? "load-finished" : "gate-armed",
      });
      // Abandon rather than commit. Both release signals are document-owned
      // (APP_SKELETON_PARSED from a script tag in index.html, APP_VIEW_PAINTED
      // from React), so exhausting the budget without either means this view
      // gave no evidence it can render. Reaching here now means specifically
      // that: the load already settled and `verifyProjectBootstrap` already
      // vouched for the document (#11635), so what timed out is a verified
      // application document that produced no frame — not a wrong document, and
      // not merely a slow one (#11765). Detaching the outgoing view here strands
      // the user on that frame with no in-app recovery, while rolling back
      // keeps a known-good view on screen and stays retryable. Thrown BEFORE
      // any detach so the rollback restores an attached view. #11462 still
      // holds where it applies: the soft timeout keeps waiting and "slow but
      // succeeding" lands via the signal — only "never painted" reaches here.
      //
      // Logged here, not in the catch: this is the failure the gate exists to
      // measure, and the timing locals are only live in this scope.
      logInfo("projectview.coldstart.rejected", {
        projectId,
        durationMs: Math.round(visibleAt - coldStartAt),
        loadToGateMs: Math.round(visibleAt - loadFinishedAt),
        paintGateOutcome: gateResult,
        gateChannel: coldReleaseChannel,
        rollbackProjectId: previousProjectId,
      });
      throw new AppError({
        code: "INTERNAL",
        message: "View never painted: project view abandoned after paint gate hard timeout",
        context: { phase: "paint", projectId, waitedMs: effectiveHardMs },
      });
    }

    // Paint signal received — detach the outgoing view.
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
    // unrelated switch can't pick it up). A painted-path hard timeout never
    // reaches here — it throws above — but its intent is still consumed, by the
    // `consumePendingFocusIntent` call in the catch below, so a stale focus
    // can't leak forward on that outcome either.
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

    // The manager/window is going away — window close, app quit, dispose()
    // landing on a queued switch (#11458). Everything above is local cleanup
    // that runs either way; everything below restores the previous view as the
    // visible active one, which teardown has already destroyed: `dispose()`
    // nulled `activeProjectId`, so rolling it back resurrects what teardown
    // just cleared. Reporting is wrong too — this spurious error toast
    // arriving after an ordinary window close is the bug.
    //
    // Keyed on host liveness ALONE, deliberately not on the rejection being a
    // cancellation. `wc.close()` aborts the in-flight navigation, so a
    // teardown often surfaces as did-fail-load/ERR_ABORTED settling the load
    // first (the "dominant normal case" loadView's own comment describes) —
    // which removes the destroyed listener and rejects as INTERNAL. Gating on
    // the error class would let that far-from-rare ordering fall through to a
    // full rollback against dead state. Why the load failed and whether the
    // host survives are independent questions; only the latter belongs here.
    //
    // A view dying under a still-live manager is the opposite case: the
    // outgoing view remains attached and visible, so `activeProjectId` must
    // follow it back or pointer and view disagree. That keeps the rollback
    // below, and still gains the prompt settle. Rethrown either way — a
    // half-loaded view is never a successful switch result.
    if (host.disposed || host.win.isDestroyed()) {
      logInfo("projectview.coldstart.abandoned", {
        projectId,
        cancelled: isViewLoadCancelled(loadError),
      });
      throw loadError;
    }

    host.activeProjectId = previousProjectId;
    if (previousEntry && !previousEntry.view.webContents.isDestroyed()) {
      // Full reactivation, not a hand-rolled subset. This previously did only
      // `registerAppView` + `setVisible(true)`, which is registry bookkeeping
      // plus a flag: `deactivateEntry` does a real `removeChildView`, and
      // `setVisible(true)` on a view that is no longer in the tree composites
      // nothing, so a failure landing after the detach rolled back to a blank
      // window (#11635). `activateView` owns the matching `addChildView` and
      // is the path every other reactivation already takes — re-adding a view
      // whose parent is unchanged reorders it rather than duplicating it, so
      // this is also correct on the common path where nothing was detached.
      // Set BEFORE this call as well as inside it: activateView assigns the
      // same id, but doing it first keeps getActiveView() and the prune sweep
      // below consistent even if activation throws partway.
      activateView(host, previousEntry);
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
  } finally {
    // By this point the outgoing view has either been detached (success) or
    // restored as the active view (rollback), so it no longer needs the
    // bridge protections.
    host.pendingColdSwitch = null;
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

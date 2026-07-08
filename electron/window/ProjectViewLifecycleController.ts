/**
 * View activation/deactivation lifecycle for ProjectViewManager — parking a
 * view as a cached background view, reviving it, purging idle memory, and
 * final teardown. Extracted from ProjectViewManager (#11004).
 */

import { webContents, type WebContentsView } from "electron";
import {
  registerAppView,
  registerCachedViewWebContents,
  unregisterCachedViewWebContents,
  unregisterProjectView,
  unregisterWebContents,
} from "./webContentsRegistry.js";
import { forgetBlinkSample, forgetEluSample } from "../services/ProcessMemoryMonitor.js";
import { forgetRendererTerminalDiagnostics } from "../services/RendererTerminalDiagnosticsCache.js";
import { detachRendererConsoleCapture } from "./rendererConsoleCapture.js";
import {
  freezeWebContents,
  unfreezeWebContents,
  throttleCpuWebContents,
  unthrottleCpuWebContents,
  purgeMemoryWebContents,
} from "../utils/webContentsLifecycle.js";
import { CHANNELS } from "../ipc/channels.js";
import { logWarn } from "../utils/logger.js";
import * as AgentStateCache from "./ProjectViewAgentStateCache.js";
import { updateViewBounds } from "./ProjectViewFactory.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { ViewEntry } from "./ProjectViewManagerTypes.js";

// Cached-view memory purge cadence. The delay keeps the likely next-switch
// target (a just-cached view) fully warm so fast switch-back pays nothing;
// the interval re-purges long-cached views whose background work (agent
// output, worktree events) keeps re-accumulating garbage. Purge is per-target
// CDP — the active view is never touched.
const CACHED_VIEW_PURGE_DELAY_MS = 20_000;
const CACHED_VIEW_PURGE_INTERVAL_MS = 60_000;

export function deactivateEntry(host: ProjectViewManager, current: ViewEntry): void {
  if (host.win.isDestroyed()) return;

  // Stale-entry guard: destroyView (HibernationService runs outside
  // switchChain) or an eviction can tear this entry down while it serves as
  // a paint-gate bridge, and the gate's settle path still holds the old
  // reference. Deactivating the torn-down entry would re-register its
  // closing webContents as a cached view (a mark with no destroy listener
  // left to clear it), fire onViewCached for a dead renderer, and mutate a
  // dead entry's state. Detach only and leave the teardown path's work alone.
  if (host.views.get(current.projectId) !== current) {
    try {
      host.win.contentView.removeChildView(current.view);
    } catch {
      // Already detached by the teardown path.
    }
    logWarn("projectview.stale-deactivate", { projectId: current.projectId });
    return;
  }

  try {
    host.win.contentView.removeChildView(current.view);
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
      host.onViewCached?.(cachedWcId);
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
    forEachGuest(current.view.webContents, (guest) => {
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
    const { view, webContents: vc } = { view: current.view, webContents: current.view.webContents };
    const liveEntry = host.views.get(capturedProjectId);
    if (liveEntry && liveEntry.view === view && liveEntry.state === "cached" && !vc.isDestroyed()) {
      vc.executeJavaScript(
        "requestIdleCallback(() => { if (window.gc) window.gc(); }, { timeout: 1000 })"
      ).catch(() => {});
    }

    // Freeze AFTER GC scheduling — Page.setWebLifecycleState suspends the
    // renderer event loop, so the requestIdleCallback above would never run
    // if we froze first (lesson #4684). Skip the freeze for a project with a
    // live agent: a frozen renderer can't apply queued agent:state-changed
    // events, stranding the background dashboard on a stale state (mirrors
    // the freezeAllCached guard).
    if (
      host.efficiencyFreezeEnabled &&
      !vc.isDestroyed() &&
      !AgentStateCache.hasActiveAgent(host, capturedProjectId)
    ) {
      void freezeWebContents(vc);
    }

    schedulePurge(host, current, CACHED_VIEW_PURGE_DELAY_MS);
  }
}

/**
 * Delayed + periodic memory purge for a cached view. The renderer-side
 * `requestIdleCallback(gc)` above is best-effort inside a throttled
 * renderer; this is the guaranteed main-side counterpart (works throttled
 * or frozen) and additionally purges Blink's discardable caches. Purging
 * does not stop timers, ports, or agent output processing — it only drops
 * reclaimable memory — so it is safe for cached views with live agents.
 */
function schedulePurge(host: ProjectViewManager, entry: ViewEntry, delayMs: number): void {
  clearPurgeTimer(entry);
  const timer = setTimeout(() => {
    const live = host.views.get(entry.projectId);
    if (live !== entry || entry.state !== "cached") return;
    const wc = entry.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    void purgeMemoryWebContents(wc);
    schedulePurge(host, entry, CACHED_VIEW_PURGE_INTERVAL_MS);
  }, delayMs);
  timer.unref?.();
  entry.purgeTimer = timer;
}

function clearPurgeTimer(entry: ViewEntry): void {
  if (entry.purgeTimer) {
    clearTimeout(entry.purgeTimer);
    entry.purgeTimer = undefined;
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
export function pruneOrphanedChildren(host: ProjectViewManager): void {
  if (host.win.isDestroyed()) return;
  const activeView = host.getActiveView();
  const gateOutgoing = host.pendingPaintGate?.outgoingView ?? null;
  // Snapshot — removeChildView/deactivateEntry mutate contentView.children.
  const children = [...host.win.contentView.children] as WebContentsView[];
  for (const child of children) {
    if (child === activeView || child === gateOutgoing) continue;
    const wc = child.webContents;
    // Unbound/welcome views (not in webContentsToProject) own their own
    // teardown via detachUnboundOutgoingView — never prune them here.
    if (!wc || wc.isDestroyed() || !host.webContentsToProject.has(wc.id)) continue;
    const projectId = host.webContentsToProject.get(wc.id) ?? null;
    // Belt-and-suspenders: never detach the active project's view even if
    // getActiveView() returned null (e.g. a destroyView race nulled
    // activeProjectId but left the entry mid-teardown).
    if (projectId !== null && projectId === host.activeProjectId) continue;
    const entry = projectId ? host.views.get(projectId) : undefined;
    try {
      if (entry && entry.state !== "cached") {
        deactivateEntry(host, entry);
      } else {
        host.win.contentView.removeChildView(child);
      }
      logWarn("projectview.orphan-pruned", { projectId });
    } catch (error) {
      console.error("[ProjectViewManager] pruneOrphanedChildren failed:", error);
    }
  }
}

export function activateView(
  host: ProjectViewManager,
  entry: ViewEntry,
  insertBehind = false
): void {
  // A view being activated must never take a scheduled cache purge.
  clearPurgeTimer(entry);
  registerAppView(host.win, entry.view);

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
    forEachGuest(entry.view.webContents, (guest) => {
      void unthrottleCpuWebContents(guest);
    });
  }

  // `insertBehind` stacks the incoming view at z-index 0 (below the still-
  // attached outgoing view) so it can wake + repair its WebGL atlas while
  // occluded, before the warm paint gate detaches the outgoing bridge (#9679).
  // Top-attach (default) is the immediate-reveal path used everywhere else.
  if (insertBehind) {
    host.win.contentView.addChildView(entry.view, 0);
  } else {
    host.win.contentView.addChildView(entry.view);
  }
  updateViewBounds(host, entry.view);

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
  host.activeProjectId = entry.projectId;
}

/**
 * Invoke `fn` for every live <webview> guest embedded in `hostWc`. There is
 * no main-side attach tracking, so guests are resolved by scanning
 * webContents.getAllWebContents() for hostWebContents identity —
 * O(total webContents), called only on view activation/deactivation.
 */
function forEachGuest(
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
export function sumGuestMemoryKb(
  hostWc: Electron.WebContents,
  memoryByPid: ReadonlyMap<number, number>
): number {
  let totalKb = 0;
  forEachGuest(hostWc, (guest) => {
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

export function getUnboundOutgoingView(host: ProjectViewManager): WebContentsView | null {
  if (host.win.isDestroyed()) return null;
  const candidate = host.win.contentView.children[0] as WebContentsView | undefined;
  if (!candidate?.webContents || candidate.webContents.isDestroyed()) return null;
  if (host.webContentsToProject.has(candidate.webContents.id)) return null;
  return candidate;
}

export function detachUnboundOutgoingView(host: ProjectViewManager, view: WebContentsView): void {
  if (!host.win.isDestroyed()) {
    try {
      host.win.contentView.removeChildView(view);
    } catch {
      // The welcome view may already have been detached by window teardown.
    }
  }

  const wc = view.webContents;
  const wcId = wc.id;
  if (host.windowRegistry) {
    host.windowRegistry.unregisterAppViewWebContents(host.win.id, wcId);
  }
  forgetBlinkSample(wcId);
  forgetEluSample(wcId);
  forgetRendererTerminalDiagnostics(wcId);

  try {
    host.onViewEvicted?.(wcId);
  } catch (error) {
    console.error("[ProjectViewManager] onViewEvicted threw for unbound view:", error);
  }

  if (!wc.isDestroyed()) {
    detachRendererConsoleCapture(wc);
    unregisterWebContents(wc);
    wc.close();
  }
}

export function cleanupEntry(host: ProjectViewManager, projectId: string): void {
  const entry = host.views.get(projectId);
  if (!entry) return;

  clearPurgeTimer(entry);

  // Detach persistent webContents listeners before close() so any queued
  // event (did-finish-load, render-process-gone, etc.) cannot fire against
  // an evicted view and act on stale views/activeProjectId state.
  try {
    entry.cleanupHandlers();
  } catch (error) {
    console.error("[ProjectViewManager] cleanupHandlers threw during eviction:", error);
  }

  // Remove from window if attached
  if (!host.win.isDestroyed()) {
    try {
      host.win.contentView.removeChildView(entry.view);
    } catch {
      // May not be attached
    }
  }

  // Electron 41 (#50249): view.webContents is undefined once the view is
  // destroyed, and a teardown race (window close ordering, OS-level view
  // destruction) can land cleanupEntry after that point. Fall back to the
  // reverse map so registry/port cleanup still runs with the last-known id
  // instead of throwing and stranding the entry in `views`.
  let wc: Electron.WebContents | null = null;
  let wcId: number | null = null;
  try {
    const maybeWc = entry.view.webContents ?? null;
    if (maybeWc) {
      wcId = maybeWc.id;
      wc = maybeWc;
    }
  } catch {
    // Getter or id read threw — treat the webContents as unreachable.
  }
  if (wcId === null) {
    for (const [mappedWcId, mappedProjectId] of host.webContentsToProject) {
      if (mappedProjectId === projectId) {
        wcId = mappedWcId;
        break;
      }
    }
  }

  if (wcId !== null) {
    // Unregister from WindowRegistry
    if (host.windowRegistry) {
      host.windowRegistry.unregisterAppViewWebContents(host.win.id, wcId);
    }

    host.webContentsToProject.delete(wcId);
    unregisterProjectView(wcId);
    forgetBlinkSample(wcId);
    forgetEluSample(wcId);
    forgetRendererTerminalDiagnostics(wcId);

    // Notify listeners (e.g. WorkspaceClient) so they can clean up direct
    // ports. Isolated so a throwing callback cannot abort the eviction loop
    // or dispose() mid-iteration and strand this entry with its listeners
    // already detached.
    try {
      host.onViewEvicted?.(wcId);
    } catch (error) {
      console.error("[ProjectViewManager] onViewEvicted threw during eviction:", error);
    }
  }

  // Close webContents — only unregister from webContentsRegistry, NOT unregisterAppView
  // (which would remove the active view's registration)
  if (wc && !wc.isDestroyed()) {
    unregisterWebContents(wc);
    wc.close();
  }

  host.views.delete(projectId);
}

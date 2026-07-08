import type { ManagedTerminal } from "./types";
import { TerminalRefreshTier } from "@/types";
import { forceXtermReflow } from "./TerminalReflowController";
import { usePanelStore } from "@/store/panelStore";
import { logWarn } from "@/utils/logger";

// Debounce on the visibility-driven WebGL restore path. Show waits this long
// before re-acquiring so rapid tab/panel toggles don't thrash WebglAddon
// load/unload (each cycle reallocates GPU resources).
const WEBGL_RESTORE_DEBOUNCE_MS = 100;

// Release hysteresis on the visibility-driven hide path. Holding the context
// for this long before releasing covers normal panel-toggle and focus-cycle
// cadences (~100–300ms) without over-occupying the 12-slot WebGL pool under
// multi-terminal hide. Authoritative release paths (tier demotion, agent
// demotion, destroy, hibernation) cancel this timer and release immediately.
const WEBGL_HIDE_DWELL_MS = 500;

export interface TerminalRevealControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  hostHasRenderableDims: (managed: ManagedTerminal) => boolean;
  ensureOpened: (id: string, managed: ManagedTerminal) => void;
  handlePostWake: (id: string) => void;
  deferGridChangeForStream: (managed: ManagedTerminal, gridWouldChange: boolean) => boolean;
  applyRendererPolicy: (id: string, tier: TerminalRefreshTier) => void;
  applyDeferredResize: (id: string) => void;
  lockResize: (id: string, locked: boolean, customTtlMs?: number) => void;
  reconcileGeometryFresh: (id: string) => boolean;
  resumeFlush: (id: string) => void;
  checkStaleDirecting: (id: string) => void;
  shouldRestoreWebGL: (
    managed: ManagedTerminal,
    opts?: { trustDomVisibility?: boolean }
  ) => boolean;
  isWebGLActive: (id: string) => boolean;
  ensureWebGL: (id: string, managed: ManagedTerminal) => void;
  releaseWebGL: (id: string) => void;
  repairAtlasForReactivation: (id: string) => boolean;
  cancelWebGLHideTimer: (managed: ManagedTerminal) => void;
}

/**
 * Owns visibility, wake, and reveal/repaint ordering — `setVisible` straddles
 * WebGL + resize + reflow. Two past incidents (#5878 want-membership,
 * #7762 backgrounded-terminal geometry corruption from reveal/resize/reflow
 * ordering) shipped in exactly this code; treat any change here as
 * high-risk, not a routine edit. Preserve call order verbatim, especially
 * "reconcile geometry before repaint" and the wake-resync bypass of the
 * settled debounce.
 */
export class TerminalRevealController {
  constructor(private deps: TerminalRevealControllerDeps) {}

  setVisible(id: string, isVisible: boolean, expectedGeneration?: number): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    // Guard: if a generation was provided and it doesn't match the current
    // attach generation, this is a stale cleanup from a previous mount — skip.
    if (expectedGeneration !== undefined && managed.attachGeneration !== expectedGeneration) {
      return;
    }

    // Cold-mount observer flaps are not authoritative. XtermAdapter forces
    // visibility true immediately after attach() so the terminal can paint
    // before IntersectionObserver settles. During recipe/bulk-open insertion
    // the grid may briefly report "not intersecting"; persisting that false
    // value would strand renderer recovery behind visibility guards. Real
    // unmounts go through detach(), which marks the instance invisible.
    if (!isVisible && managed.isAttaching) {
      if (managed.webGLRestoreTimer !== undefined) {
        clearTimeout(managed.webGLRestoreTimer);
        managed.webGLRestoreTimer = undefined;
      }
      this.deps.cancelWebGLHideTimer(managed);
      return;
    }

    const wasVisible = managed.isVisible;
    if (wasVisible !== isVisible) {
      managed.isVisible = isVisible;
      managed.lastActiveTime = Date.now();

      if (managed.webGLRestoreTimer !== undefined) {
        clearTimeout(managed.webGLRestoreTimer);
        managed.webGLRestoreTimer = undefined;
      }
      this.deps.cancelWebGLHideTimer(managed);

      if (isVisible) {
        if (managed.isAttaching) {
          return;
        }

        // Reconcile xterm's grid with dimensions captured while background
        // before the renderer policy runs its refresh. The bulk-output
        // garbling in #7741 manifests when xterm.cols/rows still reflect the
        // previous active geometry but the PTY (and incoming output) have
        // already advanced — refreshing into the old grid paints stale glyphs.
        // Order matters: must precede the lastWidth/lastHeight rect update so
        // that if cellDims were unavailable during background and latestCols/
        // latestRows are stale, the rect-update doesn't dedup-poison the next
        // ResizeObserver tick.
        this.deps.applyDeferredResize(id);

        const rect = managed.hostElement.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const widthChanged = Math.abs(managed.lastWidth - rect.width) >= 1;
          const heightChanged = Math.abs(managed.lastHeight - rect.height) >= 1;

          if (widthChanged || heightChanged) {
            managed.lastWidth = rect.width;
            managed.lastHeight = rect.height;
          }
        }

        const tier = managed.getRefreshTier
          ? managed.getRefreshTier()
          : TerminalRefreshTier.VISIBLE;
        this.deps.applyRendererPolicy(id, tier);

        const termEl = managed.terminal.element;
        if (termEl && managed.terminal.modes?.synchronizedOutputMode !== true) {
          forceXtermReflow(termEl);
        } else if (termEl) {
          // Defer the unpause reflow while a DEC 2026 synchronized-output block is
          // open (#10632). forceXtermReflow bypasses xterm's atomic-at-ESU
          // buffering and would interleave a torn frame — the invariant
          // TerminalReflowController.maybeReflow enforces at :139. This path IS
          // reachable on switch-back: the grid IntersectionObserver
          // (TerminalPane) fires setVisible(id, true) as the pane re-enters the
          // viewport while an agent is mid-stream. applyDeferredResize above
          // already synced geometry and applyRendererPolicy still ran; hand the
          // unpause/repaint to the watchdog's reveal-pending backstop, which
          // re-runs it once the block closes and the pane is on-screen.
          managed.revealPendingRepair = true;
          managed.revealPendingGeneration = managed.attachGeneration;
        }

        // Debounced WebGL restore for same-tier transitions. If
        // applyRendererPolicy above triggers a tier upgrade (e.g.
        // BACKGROUND→VISIBLE), onTierApplied loads the addon immediately
        // and this timer becomes a (harmless) idempotent re-apply. The
        // debounce only meaningfully gates rapid hide→show toggles where
        // the tier doesn't change, since same-tier applyRendererPolicy
        // is a no-op.
        managed.webGLRestoreTimer = window.setTimeout(() => {
          const current = this.deps.getInstance(id);
          if (!current) return;
          current.webGLRestoreTimer = undefined;
          if (!this.deps.shouldRestoreWebGL(current)) return;
          this.deps.ensureWebGL(id, current);
        }, WEBGL_RESTORE_DEBOUNCE_MS);
      } else {
        // Going offscreen. Hold the WebGL context for WEBGL_HIDE_DWELL_MS so
        // rapid hide→show cycles (panel toggles, focus oscillation) don't
        // churn the pool. The timer callback re-fetches `managed` to avoid
        // stale refs (same pattern as webGLRestoreTimer above) and re-checks
        // isVisible so a show during the dwell window keeps the context.
        managed.webGLHideTimer = window.setTimeout(() => {
          const current = this.deps.getInstance(id);
          if (!current) return;
          current.webGLHideTimer = undefined;
          if (current.isVisible) return;
          this.deps.releaseWebGL(id);
        }, WEBGL_HIDE_DWELL_MS);
      }
    }
  }

  wake(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    // A click/focus/reveal of a live pane is a PLAIN REPAINT. The pane stayed
    // fully live in the background (no suspend/resync anymore), so
    // repaintForReveal (WebGL reacquire + atlas/refresh + geometry re-fit) is
    // sufficient and safe. A not-yet-opened pane (a parked dock tab on first
    // reveal) takes the visibility-restore path, which opens it then repaints.
    if (!managed.isOpened) {
      void this.fullWakeForVisibilityRestore(id);
      return;
    }
    this.repaintForReveal(id);
  }

  /**
   * Focus/click-driven wake. The wake-on-focus safety net (51ba86d8d) heals a
   * frozen/garbled pane on click. `wake()` is now a plain repaint (WebGL
   * reacquire + atlas/refresh + geometry re-fit), so it is safe for a
   * main-buffer pane. For a LIVE, foreground alt-screen TUI (OpenCode, any agent
   * with blockAltScreen disabled) even a geometry reconcile can reflow the
   * absolutely-positioned frame, so a co-visible alt-screen pane fed by the live
   * PTY stream is already current and is left untouched. A genuinely off-screen
   * pane (backgrounded, parked dock tab) still takes the repaint reveal owned by
   * the visibility path.
   */
  wakeForFocus(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    const panelState = usePanelStore.getState();
    const panel = panelState.panelsById[id];
    const needsRealRestore =
      managed.needsWake === true ||
      panel?.location === "background" ||
      panelState.backgroundedTerminals.has(id);

    if (needsRealRestore || managed.isAltBuffer !== true) {
      this.wake(id);
      return;
    }
    // Live foreground alt-screen TUI: already current from the live PTY stream.
    // No geometry reconcile (reflows the frame). The reflow controller's
    // focus/heartbeat recovery and the reconciliation watchdog handle any
    // genuine renderer staleness.
  }

  /**
   * Run the full reveal repaint on a visible terminal whose project view just
   * regained visibility (#8562). Hibernation removed: there is no lossy
   * wake/resync on this path — the pane stays fully live in the background so
   * its buffer is already current. This method runs `applyDeferredResize`,
   * `forceXtermReflow`,
   * `repairAtlasForReactivation`, `xterm.refresh`, `handlePostWake`, and
   * `dataBuffer.resumeFlush` (open + geometry + repaint, no reset+replay).
   * Without the full sequence, visible terminals show stale geometry until the
   * user clicks each pane.
   *
   * Bypasses {@link TerminalRendererPolicy.applyRendererPolicy} — that path
   * early-returns on tier equality and a backgrounded view's terminals stay
   * at VISIBLE the whole time. Bypasses the resize lock the same way the
   * attach path does (record remaining suppression TTL, unlock, resize,
   * relock with remaining TTL) so geometry resync doesn't silently no-op
   * while project-switch suppression is active.
   */
  async fullWakeForVisibilityRestore(id: string): Promise<void> {
    const current = this.deps.getInstance(id);
    if (!current) return;
    if (!current.isOpened) {
      // A not-yet-opened pane (a parked dock tab, or one whose host had no
      // measurable layout box at attach time — e.g. behind the warm anti-flash
      // bridge #9679) deferred its open to "attach() on next mount". But the
      // React tree is never remounted on a warm project-view return, so attach()
      // never re-fires and nothing re-opens it — leaving the terminal stuck
      // blank/wonky until the user clicks it.
      //
      // This same method is re-run from the foreground reveal pass
      // (repaintActiveWorktreeTerminals on `app:view-revealed`, via
      // revealTerminal). By then the view is foreground-presented and the host
      // has a real layout box, so finish the open here using attach()'s exact
      // sequence. While still occluded (zero box) we leave it deferred — the
      // reveal pass retries once layout is valid.
      if (this.deps.hostHasRenderableDims(current)) {
        this.deps.ensureOpened(id, current);
      }
      if (!current.isOpened) return;
    }

    // Set the deferred-wake flag before the geometry sync so an unexpected
    // throw from applyDeferredResize (e.g. a terminal disposed between the
    // lookup above and here) can't strand it: while attaching the async wake
    // must re-run once attach settles, so the flag has to survive a throw. On
    // the proceed path we clear it again below.
    current.pendingVisibilityWake = current.isAttaching === true;

    // Geometry sync runs synchronously even while attaching (#10070).
    // applyDeferredResize only calls terminal.resize() — no buffer reset, no
    // async — so it is safe mid-attach and corrects the grid before the warm
    // paint gate releases the bridge view. Without this, an attaching terminal
    // stays at the default 80x24 until the deferred wake re-runs after the
    // bridge has already dropped, producing the visible render-small-then-snap.
    //
    // EXCEPT for a STREAMING main-buffer pane whose grid would actually change
    // (#10863's missing half): terminal.resize() re-wraps committed scrollback
    // while an Ink-style CLI is still repainting its sticky region with
    // cursor-relative erase math sized for the old grid — the wake-path twin of
    // the reveal-path re-wrap reconcileGeometryFresh already defers. The
    // assistant's cold-resume boot is the canonical victim: this sweep fires on
    // the same switch-back that just spawned it, mid-splash. Defer the geometry
    // sync to the reconciliation watchdog (the same revealPendingRepair
    // obligation the sync-block defer below uses); its reveal-pending branch
    // runs the fresh atomic reconcile once the stream quiesces. A no-change
    // pass falls through — applyDeferredResize's cache==current early-return
    // makes it free, and skipping it would strand the #10070 correction.
    const gridWouldChange =
      Number.isInteger(current.latestCols) &&
      Number.isInteger(current.latestRows) &&
      (current.terminal.cols !== current.latestCols ||
        current.terminal.rows !== current.latestRows);
    if (this.deps.deferGridChangeForStream(current, gridWouldChange)) {
      // Deferred to the watchdog — nothing to do here.
    } else {
      // Unlock symmetrically with the relock in the finally below: bypass the
      // lock whenever resize is suppressed, even if the suppression end time was
      // already cleared (the timer can fire between switch-back and this deferred
      // wake). Without the unlock, applyDeferredResize would no-op under the lock
      // and geometry would stay stale.
      const needsLockBypass = current.isResizeSuppressed === true;
      let remainingMs = 0;
      if (needsLockBypass) {
        remainingMs = current.resizeSuppressionEndTime
          ? Math.max(0, current.resizeSuppressionEndTime - Date.now())
          : 0;
        this.deps.lockResize(id, false);
      }
      try {
        this.deps.applyDeferredResize(id);
      } finally {
        if (needsLockBypass) {
          this.deps.lockResize(id, true, remainingMs);
        }
      }
    }

    // Attach is in progress — running the async wake now would race the
    // attach's own post-rAF reconciliation, which calls terminal.reset()
    // during buffer restore. The geometry sync above is safe to keep, but the
    // async wake must defer: pendingVisibilityWake was already set true above
    // so notifyAttachSettledWaiters re-runs this wake once attach settles
    // (#9702).
    if (current.isAttaching) {
      return;
    }

    // We're proceeding with the full wake now, so clear any stale deferred-wake
    // flag (e.g. a prior skip whose deferred re-run we are now satisfying).
    current.pendingVisibilityWake = false;

    // Never interleave the RENDER ops (forceXtermReflow, repairAtlasForReactivation,
    // the post-wake refresh) into an OPEN DEC 2026 synchronized-output block
    // (#10632). forceXtermReflow bypasses xterm's atomic-at-ESU buffering and
    // would paint a partial frame — the exact invariant TerminalReflowController
    // enforces at maybeReflow. The DATA path stays unconditional: applyDeferredResize
    // (above), handlePostWake (its only reflow routes through the guarded
    // maybeReflowTerminal), and the held-byte flush all still run.
    //
    // This method has no retry-return like repaintForReveal, so when paint is
    // deferred hand the obligation to the reconciliation watchdog via
    // revealPendingRepair: its reveal-pending branch re-runs the atomic repair
    // (geometry + atlas + unpause) once the block closes and the pane is on-screen.
    const deferPaintForSync = current.terminal.modes?.synchronizedOutputMode === true;

    const termEl = current.terminal.element;
    if (termEl && !deferPaintForSync) {
      try {
        forceXtermReflow(termEl);
      } catch (error) {
        logWarn(`forceXtermReflow failed for ${id}`, { error });
      }
    }

    // Repair the stale local WebGL glyph model synchronously, before the view's
    // first composited frame. On warm project-view reactivation the compositor
    // can flash the pre-freeze atlas state; resetting the local model here (no
    // breaker, no shared-atlas churn) clears it in place. No-op for DOM-renderer
    // terminals. Deferred mid-block.
    if (!deferPaintForSync) {
      this.deps.repairAtlasForReactivation(id);
    }

    // Hibernation removed: a visibility restore is a PLAIN REPAINT. The pane
    // stayed fully live in the background, so its buffer is already current —
    // geometry was re-fit (applyDeferredResize above) and the atlas/reflow
    // repaired; here we repaint the live buffer, run the post-wake reflow/unpause
    // (handlePostWake — never reset+replays; a no-op for alt-screen), and flush
    // any straggler bytes.
    if (!deferPaintForSync) {
      current.terminal.refresh(0, current.terminal.rows - 1);
    }
    this.deps.handlePostWake(id);
    this.deps.resumeFlush(id);

    // Paint was deferred to avoid interleaving an open synchronized-output block.
    // The watchdog's reveal-pending branch re-runs the full atomic repair once
    // the block closes and the pane is on-screen — the durable backstop this
    // retry-less method otherwise lacks.
    if (deferPaintForSync) {
      current.revealPendingRepair = true;
      current.revealPendingGeneration = current.attachGeneration;
    }
  }

  /**
   * Post-reveal repaint for a visible terminal whose project view has just been
   * detached from the warm anti-flash bridge and focused as the foreground
   * surface (#10362).
   *
   * `fullWakeForVisibilityRestore` runs the redraw on visibilitychange/resume —
   * while the cached view is still occluded BEHIND the bridge (#9679). Chromium
   * culls paints for a non-foreground WebContentsView, so that repair can fail
   * to stick and agent terminals stay garbled until the user clicks each pane.
   * This re-runs the render repair once the compositor will actually present
   * the frame, driven by the `app:view-revealed` signal.
   *
   * Self-heals both failure modes a manual click fixes: a WebGL context the
   * freeze/thaw cycle dropped (VRAM reclaim) is re-attached, then the stale
   * local glyph model is repaired (or a DOM-renderer pane plain-refreshed) and
   * the grid re-fit. Unlike a click it does NOT call `terminal.focus()` —
   * focusing every pane would steal DOM focus and emit focus-reporting
   * sequences into every agent; exactly one pane owns focus, this is a
   * fleet-wide repaint. The byte-pull is intentionally skipped: the headless
   * mirror sync already ran behind the bridge (IPC data is not culled like a
   * paint is), so only the repaint needs replaying.
   */
  repaintForReveal(id: string, opts?: { trustDomVisibility?: boolean }): boolean {
    const managed = this.deps.getInstance(id);
    if (!managed) return false;
    // Health-check on DOM ground truth (isConnected + checkVisibility + size),
    // NOT the reactive `managed.isVisible` flag (#10632 item 4). On a warm
    // WebContentsView resume the attach effect — the one place that force-sets
    // isVisible=true (XtermAdapter) — does not re-run, and the
    // IntersectionObserver that would flip it can lag a frame or be culled while
    // the view un-occludes, so a stale isVisible=false would no-op the exact
    // repaint the reveal needs. resetRenderer (manual Redraw) already keys off
    // connected+size for this reason; unify on the same DOM-truth signal here.
    // The element.isConnected + checkVisibility + >=50px box guards below are the
    // real preconditions.
    if (!managed.isOpened) return false;

    const element = managed.terminal.element;
    if (!element || !element.isConnected) return false;

    // A not-yet-laid-out, content-visibility:hidden, or zero/occluded host has no
    // model worth repainting — its first real resize builds it fresh. Use the
    // same hostHasRenderableDims gate (isConnected + checkVisibility + box) that
    // ensureOpened/fit rely on, then refine with resetRenderer's >=50px floor.
    // Report "not paintable yet" (false) so the reveal sweep retries on a later
    // frame once the foreground view has settled its layout, rather than burning
    // its one shot against a zero box.
    if (!this.deps.hostHasRenderableDims(managed)) return false;
    if (managed.hostElement.clientWidth < 50 || managed.hostElement.clientHeight < 50) {
      return false;
    }

    // Never repaint into an OPEN DEC 2026 synchronized-output block (#10632). The
    // atlas repair, forceXtermReflow, and reconcileGeometryFresh below would each
    // interleave a paint with the buffered range and corrupt a live agent frame.
    // The watchdog repair path already defers on this; the reveal path must too —
    // dropping the !isVisible guard above made repaintForReveal more reachable, so
    // the never-interleave-mid-block guarantee has to hold here as well. Report
    // "not paintable yet" so the reveal sweep retries on a later frame once the
    // block closes; the reconciliation watchdog is the backstop if it outlasts
    // the sweep.
    if (managed.terminal.modes?.synchronizedOutputMode === true) return false;

    // Re-attach a WebGL context the freeze/thaw cycle may have dropped before
    // repairing the local model. The warm view-reveal caller (revealTerminal)
    // passes trustDomVisibility so a stale reactive isVisible=false on warm
    // WebContentsView resume doesn't skip the reattach and strand non-focused
    // agent panes on the DOM renderer. Assistant show/hide-transition callers
    // pass nothing, so they keep the isVisible gate — a transform-hidden pane
    // must not accumulate a fleet-wide WebGL want (#10671).
    if (!this.deps.isWebGLActive(id) && this.deps.shouldRestoreWebGL(managed, opts)) {
      this.deps.ensureWebGL(id, managed);
    }

    // Drop the stale local glyph model and repaint. repairAtlasForReactivation
    // returns false for DOM-renderer terminals — fall back to a plain refresh so
    // the pane still repaints.
    try {
      if (!this.deps.repairAtlasForReactivation(id)) {
        managed.terminal.refresh(0, managed.terminal.rows - 1);
      }
    } catch (error) {
      logWarn(`repaintForReveal repair failed for ${id}`, { error });
    }

    // Force a layout reflow so a renderer xterm paused while the view was
    // occluded actually resumes drawing. This is the exact step a manual Redraw
    // (resetRenderer) and a click both supply, and the one repaintForReveal was
    // missing: handlePostWake unpauses standard agents via maybeReflowTerminal,
    // but EARLY-RETURNS for settled-strategy agents (Codex, Gemini, Cursor,
    // Copilot, …), so for those the atlas repair above landed in a still-paused
    // renderer and the pane stayed garbled until the next write, the 3s
    // heartbeat, or a click. Without this the reveal was not click-equivalent
    // for most agent terminals.
    try {
      forceXtermReflow(element);
    } catch (error) {
      logWarn(`repaintForReveal reflow failed for ${id}`, { error });
    }

    // Reconcile geometry from a FRESH DOM measurement. handlePostWake could not
    // do this on reveal: the project-switch resize lock is still active here
    // (reveal fires ~0.5–1.5s after the switch, lock TTL 5s), so its fit()
    // returns null under isResizeLocked and falls back to a PTY-only resize; and
    // for settled-strategy agents (Codex, Gemini, …) it skips fit() entirely and
    // only re-sends CACHED dims. Either way xterm's grid was never re-fit, so a
    // container size change that happened while the view was backgrounded left
    // the buffer wrapping at the wrong column until a manual Redraw fired after
    // the lock expired (the long-standing garbled-line-flow-on-return bug).
    // reconcileGeometryFresh measures the live box, ignores the lock for this one
    // reveal correction WITHOUT clearing it (so the ResizeObserver-storm damping
    // the lock provides survives), and resizes xterm + PTY atomically — safe for
    // settled agents. It returns false on an unmeasurable transitional box
    // (zero/occluded), so report "not paintable yet" and let the reveal sweep
    // retry on a later frame.
    // Clear any stale "directing" agent state the wake path would have cleared.
    // Runs before the geometry guard so it still fires on a not-yet-measurable
    // box, matching the old handlePostWake ordering.
    this.deps.checkStaleDirecting(id);

    if (!this.deps.reconcileGeometryFresh(id)) return false;

    // Clear the reflow throttle so the next write or the 3s heartbeat reflows
    // immediately rather than being debounced away (mirrors resetRenderer).
    managed.lastReflowAt = 0;

    return true;
  }

  /**
   * Watchdog-driven, alt-buffer-safe reveal repair (#10632) — the closed-loop
   * "is it correct now" correction that the open-loop reveal backstops never
   * reliably delivered. This is the ATOMIC half of a manual Redraw: re-fit
   * geometry from a FRESH DOM measurement (xterm + PTY resized together via
   * {@link TerminalResizeController.reconcileGeometryFresh}) and repair the local
   * WebGL glyph model (or plain-refresh a DOM-renderer pane).
   *
   * Deliberately omits `forceXtermReflow`: a layout reflow mid DEC 2026
   * synchronized-output block would interleave a paint with the buffered range,
   * so the watchdog gates the unpause reflow on `synchronizedOutputMode`
   * separately and only calls this once a block has closed. The atomic resize is
   * safe for settled-strategy agents (no 500ms xterm/PTY split).
   *
   * Returns reconcileGeometryFresh's verdict: false on an unmeasurable /
   * transitional box (zero/occluded/content-visibility:hidden) so the watchdog
   * keeps the reveal-pending obligation and retries on a later tick once the
   * foreground view has settled — the present-ordering guarantee that a repaint
   * is never issued into an occluded surface.
   */
  reconcileRevealGeometry(id: string): boolean {
    const managed = this.deps.getInstance(id);
    if (!managed) return false;
    if (!this.deps.reconcileGeometryFresh(id)) return false;

    try {
      if (!this.deps.repairAtlasForReactivation(id)) {
        managed.terminal.refresh(0, managed.terminal.rows - 1);
      }
    } catch (error) {
      logWarn(`reconcileRevealGeometry repair failed for ${id}`, { error });
    }

    // Clear the reflow throttle so a follow-up unpause reflow (the watchdog's
    // render-pause branch, or the next write/heartbeat) fires immediately.
    managed.lastReflowAt = 0;
    return true;
  }

  /**
   * Foreground reveal entry point for a single grid terminal, driven by the
   * `app:view-revealed` fan-out ({@link repaintActiveWorktreeTerminals}) once
   * the cached project view is detached from the anti-flash bridge and actually
   * presented.
   *
   * Splits the two states a long-dwell return can leave a terminal in:
   *
   * - **Unopened** — the occluded warm wake could not open the xterm instance
   *   (no measurable host box behind the bridge). The lightweight repaint can't
   *   help (it guards on `isOpened`), so run the full
   *   {@link fullWakeForVisibilityRestore}: now that the host has real layout it
   *   opens, pulls the missed range from the headless mirror, and repaints. This
   *   is the gap the older reveal patches (#10362) left open for the long-dwell
   *   case.
   * - **Already opened and woken** (the common warm path) — only the culled
   *   paint needs replaying, so take the cheap {@link repaintForReveal}.
   *
   * @returns `true` when the terminal was paintable and the repaint/open ran
   * (or the terminal is gone — nothing to retry); `false` when it isn't paintable
   * yet (host not laid out / not visible) and the caller should retry on a later
   * frame. {@link repaintActiveWorktreeTerminals} drives that retry.
   */
  async revealTerminal(id: string): Promise<boolean> {
    const managed = this.deps.getInstance(id);
    // Gone — nothing to repaint and nothing to retry, so report "settled".
    if (!managed) return true;
    if (!managed.isOpened) {
      // An unopened pane needs the full open+wake, but
      // fullWakeForVisibilityRestore only opens once the host has a real layout
      // box. While the foreground view is still settling that box can read zero
      // (or the host is visibility:hidden), so report "not paintable yet" and
      // let the reveal sweep retry on a later frame rather than spending the
      // open attempt against an unmeasurable host.
      if (!this.deps.hostHasRenderableDims(managed)) return false;
      await this.fullWakeForVisibilityRestore(id);
      const after = this.deps.getInstance(id);
      // Gone mid-wake → nothing left to retry. Otherwise it's settled only once
      // the pane actually opened AND the wake wasn't merely DEFERRED:
      // fullWakeForVisibilityRestore sets pendingVisibilityWake and returns early
      // while an attach is in flight (notifyAttachSettledWaiters re-runs it on
      // settle). Report "retry" until the open+wake has truly landed so the
      // sweep's confirm paints aren't spent against a not-yet-revealed pane.
      return (
        !after ||
        (after.isOpened === true &&
          after.isAttaching !== true &&
          after.pendingVisibilityWake !== true)
      );
    }
    // The warm view-reveal sweep has confirmed the foreground view is presented,
    // so trust DOM-truth visibility for the WebGL reattach — the reactive
    // isVisible flag is stale-false on a warm resume. Assistant-transition
    // callers of repaintForReveal deliberately do NOT trust it.
    return this.repaintForReveal(id, { trustDomVisibility: true });
  }
}

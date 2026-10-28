import type { ILinkHandler, Terminal } from "@xterm/xterm";
import { loadXtermCore } from "./xtermCore";
import { TerminalRefreshTier } from "@/types";
import type { ManagedTerminal } from "./types";
import { setupTerminalAddons } from "./TerminalAddonManager";
import { TerminalParserHandler } from "./TerminalParserHandler";
import { hideTerminalLinkTooltip } from "./terminalLinkTooltip";
import { resetRendererUnpauseBreaker } from "./TerminalReflowController";
import {
  installTerminalBoundListeners,
  type TerminalListenerInstallDeps,
} from "./TerminalListenerInstaller";
import { applyXtermReflowFastpath } from "@shared/utils/xtermReflowFastpath";
import { usePanelStore } from "@/store/panelStore";
import { logDebug, logWarn, logError } from "@/utils/logger";
import { getErrorMessage } from "@/utils/errorContext";

/**
 * Automatic rebuild budget for a terminal that cannot be opened (#11776).
 * Three is enough to ride out a transient cause (a view mid-teardown, a host
 * that was momentarily unmeasurable) without turning a genuinely unrenderable
 * pane into a rebuild loop. The user's Retry resets it.
 */
const MAX_ATTACH_RECOVERY_ATTEMPTS = 3;

/**
 * How long a rebuild waits for xterm's write queue to settle before giving up
 * on the attempt. Generous on purpose: exceeding it means abandoning the
 * rebuild entirely (disposing with writes in flight would strand flow-control
 * credit), so a slow drain should wait rather than skip.
 */
const ATTACH_RECOVERY_DRAIN_TIMEOUT_MS = 2000;

export interface TerminalAttachRecoveryControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  hostHasRenderableDims: (managed: ManagedTerminal) => boolean;
  ensureOpened: (id: string, managed: ManagedTerminal) => void;
  /** The xterm `linkHandler` option, shared with the creation path. */
  makeLinkHandler: (id: string) => ILinkHandler;
  makeListenerInstallDeps: () => TerminalListenerInstallDeps;
  applyDeferredResize: (id: string) => void;
  drawDataLossMarker: (id: string, droppedBytes: number) => void;
  cancelAttachReveal: (managed: ManagedTerminal) => void;
  clearResizeJob: (managed: ManagedTerminal) => void;
  clearSettledTimer: (id: string) => void;
  forgetWrites: (id: string) => void;
  cancelWebGLHideTimer: (managed: ManagedTerminal) => void;
  onWebGLTerminalDestroyed: (id: string) => void;
  rebindWorkerIngest: (id: string, managed: ManagedTerminal) => void;
  reseedMirrorGeometry: (id: string, managed: ManagedTerminal) => void;
  applyRendererPolicy: (id: string, tier: TerminalRefreshTier) => void;
  fit: (id: string) => void;
  fetchAndRestore: (id: string) => Promise<boolean>;
  notifyAttachSettled: (id: string) => void;
}

/**
 * Brings back a terminal whose xterm instance cannot be opened (#11776): the
 * automatic attempt budget, the drain that must settle before anything is
 * disposed, the rebuild itself and its terminal-scoped teardown.
 *
 * Owns no instances. The service keeps the authoritative `instances` map and
 * every in-flight creation; recovery state rides on the `ManagedTerminal`, and
 * each step re-reads the live instance through `getInstance`, so a terminal
 * destroyed or replaced mid-rebuild is never resurrected.
 */
export class TerminalAttachRecoveryController {
  constructor(private deps: TerminalAttachRecoveryControllerDeps) {}

  /**
   * Options for a replacement terminal (#11776). Sourced from the live
   * instance's own `options` rather than a remembered creation snapshot, so
   * everything applied since — font changes, agent promotion's cursorBlink
   * clamp, theme updates — carries across the rebuild. The link handler is
   * rebuilt rather than copied: the old one is fine, but re-deriving keeps the
   * two construction paths on one definition.
   */
  private rebuildOptionsFor(managed: ManagedTerminal): ConstructorParameters<typeof Terminal>[0] {
    let inherited: Partial<Terminal["options"]> = {};
    try {
      inherited = { ...managed.terminal.options };
    } catch (error) {
      logWarn("[TIS] Could not read options off the terminal being rebuilt", {
        id: managed.id,
        error,
      });
    }
    return {
      ...inherited,
      rescaleOverlappingGlyphs: true,
      linkHandler: this.deps.makeLinkHandler(managed.id),
    };
  }

  /**
   * Record a failed open and schedule recovery (#11776).
   *
   * Deliberately does NOT rethrow. The previous behaviour let the error escape
   * `attach()` into XtermAdapter's catch, which skipped every remaining attach
   * step and left the user with a blank pane and no signal. Failing quietly
   * here and rebuilding in the background is strictly more recoverable.
   *
   * The diagnostic (`lastAttachError`) is recorded immediately; the T3 pane
   * banner is NOT. A failed open is an auto-recovering state, and publishing it
   * here made every self-healing attach flash a red "Terminal display failed"
   * that `clearAttachError` retracted a few frames later — the rebuild always
   * crosses a drain sentinel, an addon await and an `open()` reflow, so React
   * gets to paint it. {@link publishUnrecoveredAttachError} raises the banner
   * once recovery has actually failed to restore the pane, per the runtime-signal
   * tiering rule (auto-recovering stays quiet until recovery is exhausted).
   */
  handleFailedOpen(id: string, managed: ManagedTerminal, error: unknown): void {
    managed.isOpened = false;
    managed.lastAttachError = getErrorMessage(error);
    logError("[TIS] Terminal open failed", error, { id });
    void this.recoverPoisonedTerminal(id);
  }

  /**
   * Escalate an attach failure to the pane once rebuilding has given up.
   *
   * Called from every path where recovery resolves false — a failed attempt, a
   * deferred one (no measurable host yet), or the exhausted budget. Guarded on
   * the pane still being broken and still being the instance we started with, so
   * a rebuild that succeeded on a later attempt, or a terminal destroyed/replaced
   * mid-recovery, never raises a banner for a pane that is painting fine.
   */
  private publishUnrecoveredAttachError(id: string, managed: ManagedTerminal): void {
    if (this.deps.getInstance(id) !== managed) return;
    if (managed.isOpened) return;
    const message = managed.lastAttachError;
    if (message === undefined) return;
    // Optional-called: many suites stub usePanelStore with a partial action
    // surface, and a missing banner setter must not turn a recoverable open
    // failure into a thrown one.
    usePanelStore.getState().setTerminalAttachError?.(id, message);
  }

  /**
   * Drop a resolved attach failure from both the instance and the pane.
   *
   * The store write is unconditional, NOT gated on this instance having
   * recorded an error. A restart or any same-id recreation hands us a brand-new
   * ManagedTerminal with a clean `lastAttachError` while the pane still carries
   * the previous instance's banner — gating on the local flag would leave that
   * banner up forever behind a terminal that is painting fine.
   */
  clearAttachError(id: string, managed: ManagedTerminal): void {
    managed.attachRecoveryAttempts = 0;
    managed.lastAttachError = undefined;
    usePanelStore.getState().clearTerminalAttachError?.(id);
  }

  /**
   * Rebuild a terminal whose xterm instance can no longer be opened (#11776).
   *
   * Retrying `open()` is structurally incapable of working: xterm's re-entry
   * guard is satisfied by fields assigned before `_renderService`, so a
   * half-opened instance early-returns forever. The only way back is a fresh
   * `Terminal`. The `ManagedTerminal` itself survives — same id, same host
   * element, same PTY, same subscribers — so the panel store, the agent state
   * machine and the backend never see a lifecycle event; only the renderer-side
   * object is swapped underneath.
   *
   * Scoped strictly to the terminal. Anything keyed on the PTY or the pane's
   * identity (the leading `listeners` entries, exit/agent-state/alt-buffer
   * subscribers, the restore controller's deferred-output ledger, the port-ack
   * FIFO) is left alone — tearing those down is what `destroy()` is for, and
   * doing it here would drop output the rebuild is meant to preserve.
   *
   * Bounded and deduplicated: concurrent triggers (attach, reveal, the
   * watchdog, the banner's Retry) share one in-flight rebuild, and automatic
   * attempts stop after {@link MAX_ATTACH_RECOVERY_ATTEMPTS} so a host that is
   * genuinely never renderable degrades to a banner instead of looping.
   */
  async recoverPoisonedTerminal(id: string, options?: { manual?: boolean }): Promise<boolean> {
    const managed = this.deps.getInstance(id);
    if (!managed) return false;
    // A manual Retry is the user telling us conditions changed (they resized,
    // un-occluded the pane, or simply want another go), so it refills the
    // automatic budget rather than being blocked by it. Applied BEFORE the
    // in-flight check: the loop re-reads the budget each iteration, so a click
    // landing during the final automatic attempt still buys more attempts
    // instead of being swallowed by the shared promise.
    if (options?.manual === true) managed.attachRecoveryAttempts = 0;

    if (managed.attachRecoveryInFlight) return managed.attachRecoveryInFlight;

    const run = this.runRecoveryAttempts(id, managed)
      // The loop is started with `void` from a synchronous open failure, so an
      // escaping rejection would surface as an unhandled promise rejection with
      // no owner. Contain it here and report the honest boolean.
      .catch((error: unknown) => {
        logError("[TIS] Terminal rebuild threw", error, { id });
        return false;
      })
      .finally(() => {
        managed.attachRecoveryInFlight = undefined;
      })
      // The single escalation point: recovery is over and, on false, the pane is
      // still unpaintable — a failed attempt, one deferred for want of a
      // measurable host, or the exhausted budget. Raising the banner here rather
      // than on the first failed open is what keeps a self-healing attach silent.
      .then((recovered) => {
        if (!recovered) this.publishUnrecoveredAttachError(id, managed);
        return recovered;
      });
    managed.attachRecoveryInFlight = run;
    return run;
  }

  /**
   * Drive rebuild attempts until one paints or the budget runs out.
   *
   * The loop lives here rather than relying on the failure path re-triggering
   * itself: a replacement that also fails calls `handleFailedOpen`, which
   * re-enters `recoverPoisonedTerminal` and gets handed the very promise this
   * loop is running under. Without an explicit loop that re-entry is a no-op
   * and the advertised budget silently collapses to a single attempt.
   */
  private async runRecoveryAttempts(id: string, managed: ManagedTerminal): Promise<boolean> {
    for (;;) {
      const attempts = managed.attachRecoveryAttempts ?? 0;
      if (attempts >= MAX_ATTACH_RECOVERY_ATTEMPTS) {
        logWarn("[TIS] Terminal rebuild attempts exhausted — leaving the banner up", {
          id,
          attempts,
        });
        return false;
      }

      const outcome = await this.rebuildTerminalInstance(id, managed);
      if (outcome === "rebuilt") return true;
      // Deferred is not a failed attempt — the host simply had no layout box
      // yet, so it must not burn budget. A later attach/reveal/watchdog pass
      // retries once the pane is measurable.
      if (outcome === "deferred") return false;

      managed.attachRecoveryAttempts = attempts + 1;
      // Destroyed or replaced while we were awaiting — there is nothing left to
      // rebuild, and looping would resurrect a dead id.
      if (this.deps.getInstance(id) !== managed) return false;
    }
  }

  /**
   * Settle xterm's write queue before the instance is disposed.
   *
   * Disposing with writes still queued is silently destructive: xterm's
   * `WriteBuffer` drops its pending callbacks on dispose rather than invoking
   * them, and those callbacks are what send the port ack, return flow-control
   * credit to the pty-host, and decrement the ingest's in-flight byte count.
   * Losing them leaves the backend believing this terminal is still chewing
   * through a batch, so it throttles or stops streaming — the rebuilt pane
   * would open cleanly and then sit there receiving nothing, which is a worse
   * bug than the one being fixed.
   *
   * One sentinel is not enough. A poisoned terminal is usually still receiving
   * output at full rate, so fresh batches land BEHIND the sentinel while it
   * waits — their callbacks would be exactly the ones dropped. Re-arm until the
   * ack-bearing queue is actually empty, bounded by one shared deadline.
   *
   * Parsing does not need a renderer, so a poisoned terminal does drain; the
   * deadline only exists so a terminal streaming without pause degrades to "try
   * again later" rather than taking the dispose path anyway.
   */
  private async drainWritesBeforeDispose(id: string, managed: ManagedTerminal): Promise<boolean> {
    const deadline = Date.now() + ATTACH_RECOVERY_DRAIN_TIMEOUT_MS;
    // At least one pass runs unconditionally: `pendingWrites` counts only
    // ack-bearing batches, and untracked writes (scrollback replay, the
    // data-loss marker) can still be sitting in the buffer ahead of us.
    for (;;) {
      if (!(await this.queueDrainSentinel(id, managed, deadline))) return false;
      if ((managed.pendingWrites ?? 0) === 0) return true;
      if (Date.now() >= deadline) {
        logWarn("[TIS] Writes kept arriving during the pre-rebuild drain", {
          id,
          pendingWrites: managed.pendingWrites ?? 0,
        });
        return false;
      }
    }
  }

  /** One FIFO barrier through xterm's write queue. */
  private queueDrainSentinel(
    id: string,
    managed: ManagedTerminal,
    deadline: number
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(drained);
      };
      const timer = setTimeout(
        () => {
          logWarn("[TIS] Timed out draining writes before rebuild", {
            id,
            pendingWrites: managed.pendingWrites ?? 0,
          });
          finish(false);
        },
        Math.max(0, deadline - Date.now())
      );
      try {
        // An empty write parses to nothing but still queues behind everything
        // already in the buffer, so its callback fires only once the backlog —
        // and every ack riding those earlier callbacks — has landed.
        managed.terminal.write("", () => finish(true));
      } catch (error) {
        // Over the discard watermark, or already disposed. Either way we cannot
        // establish the barrier, so we must not dispose.
        logWarn("[TIS] Could not queue a drain write before rebuild", { id, error });
        finish(false);
      }
    });
  }

  private async rebuildTerminalInstance(
    id: string,
    managed: ManagedTerminal
  ): Promise<"rebuilt" | "deferred" | "failed"> {
    // Opening against a zero-box host is a plausible cause of the original
    // failure, so a rebuild that ignored it would just poison the fresh
    // instance too. Leave the banner up; the reveal pass retries once the pane
    // has real layout.
    if (!this.deps.hostHasRenderableDims(managed)) {
      logDebug(`[TIS] Deferring rebuild of ${id} — host has no renderable box yet`);
      return "deferred";
    }

    // Already loaded (a terminal exists to rebuild), so this resolves at once.
    const { Terminal } = await loadXtermCore();

    // Before anything is torn down: an undrainable buffer means we must not
    // dispose at all (see drainWritesBeforeDispose).
    if (!(await this.drainWritesBeforeDispose(id, managed))) return "deferred";
    // Destroyed while draining.
    if (this.deps.getInstance(id) !== managed) return "failed";

    logWarn("[TIS] Rebuilding unpaintable terminal", { id, error: managed.lastAttachError });

    try {
      this.teardownTerminalForRebuild(id, managed);
    } catch (error) {
      logError("[TIS] Failed to tear down terminal for rebuild", error, { id });
      return "failed";
    }

    let terminal: Terminal | undefined;
    try {
      terminal = new Terminal(this.rebuildOptionsFor(managed));
      applyXtermReflowFastpath(terminal);
      const addons = await setupTerminalAddons(terminal);
      // The instance can be destroyed while we await the (module-cached, but
      // still async) addon setup. Bail before publishing the new terminal.
      if (this.deps.getInstance(id) !== managed) {
        terminal.dispose();
        return "failed";
      }
      Object.assign(managed, addons);
      managed.terminal = terminal;
      // The receipt flag describes the buffer, and this one is empty. The
      // replay below restamps it on success; on failure the pane is back to
      // never-fed, so missing-output recovery may take it on (#12754).
      managed.hasReceivedOutput = false;
      managed.outputRecoveryFirstSeenAt = undefined;
      managed.outputRecoveryNextProbeAt = undefined;
      managed.outputRecoveryFailures = undefined;
      managed.outputRecoveryGaveUp = undefined;
      managed.outputRecoveryInFlight = undefined;
      // A replacement Terminal brings a brand-new RenderService with its own
      // pause state. attachGeneration doesn't move here, so without this the
      // fresh renderer inherits the old one's give-up latch and — since it
      // starts paused and only an observed unpause re-arms — would be denied
      // its first repair forever (#11800).
      resetRendererUnpauseBreaker(managed);
    } catch (error) {
      logError("[TIS] Failed to construct replacement terminal", error, { id });
      // The old instance is already disposed and `managed.terminal` may still
      // point at it, so drop the half-built replacement rather than leaking a
      // Terminal nothing will ever dispose.
      try {
        terminal?.dispose();
      } catch {
        /* the replacement never got far enough to need disposing */
      }
      return "failed";
    }

    // Same shared installer every other construction path uses — never a
    // hand-rolled subset, or the rebuilt pane silently loses copy-on-select,
    // title forwarding and the agent-state hooks.
    managed.parserHandler = new TerminalParserHandler(
      managed,
      () => this.deps.applyDeferredResize(id),
      (droppedBytes) => this.deps.drawDataLossMarker(id, droppedBytes)
    );
    installTerminalBoundListeners(terminal, managed, id, this.deps.makeListenerInstallDeps());

    // XtermAdapter installs this once per mount and will not re-run for a
    // rebuild, so re-attach it here; `keyHandlerInstalled` staying true against
    // a handler-less Terminal would leave the pane unable to take input.
    if (managed.customKeyEventHandler) {
      terminal.attachCustomKeyEventHandler(managed.customKeyEventHandler);
    } else {
      managed.keyHandlerInstalled = false;
    }

    // Geometry dedup caches describe the disposed instance's grid.
    managed.lastWidth = 0;
    managed.lastHeight = 0;
    managed.pendingWrites = 0;
    managed.writeChain = Promise.resolve();
    managed.isOpened = false;

    // The worker-ingest resize bridge is an xterm-bound listener that the
    // shared installer does not own, so the teardown dropped it and nothing
    // else would put it back — leaving the background mirror parsing at a
    // frozen geometry. Bind only here; the mirror's geometry seed waits for the
    // open below, or it would park at the construction grid.
    this.deps.rebindWorkerIngest(id, managed);

    // The replacement was CONSTRUCTED at whatever cols/rows the dead instance's
    // options carried, which is NOT its live grid: xterm copies the grid into
    // `options.cols/rows` only in `reset()`, never in `resize()`, so anything
    // resized since construction hands over a stale size — 80x24 for the common
    // case. Seed the open-time target so `ensureOpened` sizes the grid before
    // `open()`, and before the replay below reads it as the grid to reflow back
    // to (a wrong seed there is the #11718/#11552 corruption family: a pane
    // parsing a ~200-column agent at 80 columns, and a snapshot replayed then
    // snapped to a width it was never captured at). Same idiom as
    // `detachForProjectSwitch`: background-tier resizes only ever write
    // latestCols/latestRows, so those are the only record of the real grid.
    const seededTargetGeometry = !managed.targetCols && managed.latestCols > 0;
    if (seededTargetGeometry) {
      managed.targetCols = managed.latestCols;
      managed.targetRows = managed.latestRows;
    }

    this.deps.ensureOpened(id, managed);
    if (!managed.isOpened) {
      // ensureOpened already recorded the failure; the recovery loop owns the
      // next attempt.
      logWarn("[TIS] Replacement terminal failed to open", { id });
      return "failed";
    }

    // Consumed by the open above. Leaving a target we invented behind would make
    // the next reparent-attach apply it instead of fitting, pinning the pane to
    // this grid after its container had changed size.
    if (seededTargetGeometry) {
      managed.targetCols = undefined;
      managed.targetRows = undefined;
    }

    this.deps.reseedMirrorGeometry(id, managed);

    this.deps.applyRendererPolicy(
      id,
      managed.getRefreshTier?.() ?? managed.lastAppliedTier ?? TerminalRefreshTier.FOCUSED
    );

    // Measure against the host now that the pane can paint. Nothing else will:
    // `attach()`'s nested-rAF fit is gated on `isOpened`, which the failed open
    // had already set false, and the ResizeObserver stays quiet because the host
    // box never changed. Without this a rebuild triggered from a cold attach —
    // no measured grid to seed from above — would sit on xterm's 80x24 default
    // until the user happened to resize the window. Runs BEFORE the replay so
    // the restore's geometry seed reads the settled grid; a no-op while resizes
    // are locked or the host is unmeasurable, and idempotent when the seed
    // already landed the right size.
    this.deps.fit(id);

    // Repopulate from the headless mirror. The disposed instance's buffer went
    // with it, and it never painted anything the user saw anyway, so this is
    // the scrollback — not a nicety.
    try {
      await this.deps.fetchAndRestore(id);
    } catch (error) {
      logWarn("[TIS] Rebuilt terminal could not restore scrollback", {
        id,
        error: getErrorMessage(error),
      });
    }

    // This rebuild IS an attach settling. `attach()`'s own failure path already
    // released the waiters it knew about, but anything that registered between
    // that failure and now is waiting on a terminal that has only just become
    // paintable.
    this.deps.notifyAttachSettled(id);

    logDebug(`[TIS] Rebuilt terminal ${id}`);
    return "rebuilt";
  }

  /**
   * Terminal-scoped teardown for {@link rebuildTerminalInstance} — the subset
   * of `destroy()` that belongs to the xterm instance rather than to the pane.
   */
  private teardownTerminalForRebuild(id: string, managed: ManagedTerminal): void {
    this.deps.cancelAttachReveal(managed);
    this.deps.clearResizeJob(managed);
    this.deps.clearSettledTimer(id);
    this.deps.forgetWrites(id);
    this.deps.cancelWebGLHideTimer(managed);
    if (managed.webGLRestoreTimer !== undefined) {
      clearTimeout(managed.webGLRestoreTimer);
      managed.webGLRestoreTimer = undefined;
    }
    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
      managed.tierChangeTimer = undefined;
    }

    // Only the xterm-bound tail. The leading entries unsubscribe the PTY data
    // and exit streams, which must keep running across the swap — dropping them
    // would silently detach the pane from its process.
    const boundStart = managed.ipcListenerCount;
    for (const unsub of managed.listeners.slice(boundStart)) {
      try {
        unsub();
      } catch (error) {
        logWarn("Error unsubscribing terminal-bound listener during rebuild", { id, error });
      }
    }
    managed.listeners.length = boundStart;

    managed.parserHandler?.dispose();
    managed.parserHandler = undefined;

    managed.lastActivityMarker?.dispose();
    managed.lastActivityMarker = undefined;
    managed.postCompleteMarker?.dispose();
    managed.postCompleteMarker = undefined;

    // ImageAddon first and by name: its dispose() is what restores the
    // `_core.open` it monkey-patched. Disposing the terminal with the patch
    // still installed is how the wedge survives a rebuild.
    hideTerminalLinkTooltip(managed.terminal);
    for (const [label, disposable] of [
      ["image addon", managed.imageAddon],
      ["file links", managed.fileLinksDisposable],
      ["image links", managed.imageLinksDisposable],
      ["command links", managed.commandLinksDisposable],
      ["plugin links", managed.pluginLinksDisposable],
      ["web links", managed.webLinksAddon],
    ] as const) {
      try {
        disposable?.dispose();
      } catch (error) {
        logWarn(`Error disposing ${label} during rebuild`, { id, error });
      }
    }
    managed.imageAddon = null;
    managed.fileLinksDisposable = null;
    managed.imageLinksDisposable = null;
    managed.commandLinksDisposable = null;
    managed.pluginLinksDisposable = null;
    managed.webLinksAddon = null;

    // Before dispose: the manager holds pool/lease references to this exact
    // Terminal, and releasing them afterwards would touch a dead object.
    this.deps.onWebGLTerminalDestroyed(id);

    try {
      managed.terminal.dispose();
    } catch (error) {
      logWarn("Error disposing terminal during rebuild", { id, error });
    }

    // xterm removes its own `.xterm` element on dispose, but a terminal that
    // threw partway through open() may have left one behind — the host is
    // reused as-is for the new open(), so clear any orphan.
    managed.hostElement.replaceChildren();
  }
}

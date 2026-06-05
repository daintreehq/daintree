import { Terminal, ILink, IBufferRange } from "@xterm/xterm";
import { isMac } from "@/lib/platform";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import type { AgentState } from "@/types";
import {
  ManagedTerminal,
  RefreshTierProvider,
  AgentStateCallback,
  PostCompleteHook,
  isWebGLEligibleTier,
  WRITE_BURST_DECAY_MS,
  HIBERNATION_DELAY_PRESSURE_TIER1_MS,
  HIBERNATION_DELAY_PRESSURE_TIER2_MS,
} from "./types";
import {
  setupTerminalAddons,
  createImageAddon,
  createFileLinksAddon,
  createWebLinksAddon,
} from "./TerminalAddonManager";
import { TerminalOutputIngestService } from "./TerminalOutputIngestService";
import { TerminalParserHandler } from "./TerminalParserHandler";
import { TerminalUnseenOutputTracker, UnseenOutputSnapshot } from "./TerminalUnseenOutputTracker";
import { TerminalOffscreenManager } from "./TerminalOffscreenManager";
import { TerminalLinkHandler } from "./TerminalLinkHandler";
import { TerminalResizeController } from "./TerminalResizeController";
import { TerminalRendererPolicy } from "./TerminalRendererPolicy";
import { TerminalWebGLManager } from "./TerminalWebGLManager";
import { TerminalWakeManager } from "./TerminalWakeManager";
import { TerminalAgentStateController } from "./TerminalAgentStateController";
import { TerminalRestoreController } from "./TerminalRestoreController";
import { TerminalHibernationManager } from "./TerminalHibernationManager";
import { TerminalReflowController, forceXtermReflow } from "./TerminalReflowController";
import { TerminalWriteController } from "./TerminalWriteController";
import {
  installTerminalBoundListeners,
  type TerminalListenerInstallDeps,
} from "./TerminalListenerInstaller";
import { reduceScrollback, restoreScrollback } from "./TerminalScrollbackController";
import { DEFAULT_TERMINAL_FONT_FAMILY, onTerminalFontArrivedLate } from "@/config/terminalFont";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { usePanelStore } from "@/store/panelStore";
import { logDebug, logWarn, logError } from "@/utils/logger";
import { yieldToScheduler } from "@/lib/schedulerYield";
import { SCROLLBACK_BACKGROUND } from "@shared/config/scrollback";
import { stripAnsiAndOscCodes } from "@shared/utils/urlUtils";

export { isNonKeyboardInput } from "./inputUtils";
// Re-exported so existing consumers (notably tests) that import
// `forceXtermReflow` from this module don't need to update their imports.
export { forceXtermReflow };

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

// Trailing-edge window for `scheduleBatchResize`. A burst of grid open/close
// resizes within this gap collapses into one pass — long enough to coalesce a
// rapid close stream, short enough that survivors settle promptly after it.
const GRID_RESIZE_COALESCE_MS = 120;

// Terminals resized per task inside `runResizePass`, yielding to the scheduler
// between chunks. xterm.js 6.0 reflows the whole scrollback on a
// column-changing resize (~15-40ms each), so one-per-task keeps every task
// under the ~50ms long-task threshold and lets paint + input run between
// terminals instead of freezing the renderer for the whole batch.
const RESIZE_PASS_CHUNK_SIZE = 1;

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: number;
}

function canAutoInitializeTerminalIngest(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.electron?.terminal?.getSharedBuffers === "function"
  );
}

class TerminalInstanceService {
  private instances = new Map<string, ManagedTerminal>();
  private dataBuffer = new TerminalOutputIngestService(
    (id, data) => this.writeToTerminal(id, data),
    (id) => this.instances.get(id)?.getRefreshTier?.() ?? TerminalRefreshTier.FOCUSED
  );
  private suppressedExitUntil = new Map<string, number>();
  private unseenTracker = new TerminalUnseenOutputTracker();
  private hibernationListeners = new Map<string, Set<() => void>>();
  private cwdProviders = new Map<string, () => string>();
  private readinessWaiters = new Map<string, Waiter[]>();
  private attachSettledWaiters = new Map<string, Waiter[]>();
  private offscreenManager = new TerminalOffscreenManager();
  private linkHandler = new TerminalLinkHandler();
  private cachedSelections = new Map<string, string>();
  private resizeController: TerminalResizeController;
  private rendererPolicy: TerminalRendererPolicy;
  private webGLManager = new TerminalWebGLManager();
  private wakeManager: TerminalWakeManager;
  private agentStateController: TerminalAgentStateController;
  private restoreController: TerminalRestoreController;
  private hibernationManager: TerminalHibernationManager;
  private reflowController: TerminalReflowController;
  private writeController: TerminalWriteController;

  constructor() {
    if (canAutoInitializeTerminalIngest()) {
      void this.dataBuffer.initialize();
    }

    this.resizeController = new TerminalResizeController({
      getInstance: (id) => this.instances.get(id),
      dataBuffer: this.dataBuffer,
    });

    this.agentStateController = new TerminalAgentStateController({
      getInstance: (id) => this.instances.get(id),
    });

    this.restoreController = new TerminalRestoreController({
      getInstance: (id) => this.instances.get(id),
      writeData: (id, data) => this.writeToTerminal(id, data),
    });

    this.writeController = new TerminalWriteController({
      getInstance: (id) => this.instances.get(id),
      acknowledgePortData: (id, bytes) => terminalClient.acknowledgePortData(id, bytes),
      acknowledgeData: (id, bytes) => terminalClient.acknowledgeData(id, bytes),
      notifyWriteComplete: (id, bytes) => this.dataBuffer.notifyWriteComplete(id, bytes),
      incrementUnseen: (id, isScrolledBack) =>
        this.unseenTracker.incrementUnseen(id, isScrolledBack),
      onWrite: (id) => this.onPtyWrite(id),
    });

    this.hibernationManager = new TerminalHibernationManager({
      getInstance: (id) => this.instances.get(id),
      destroyRestoreState: (id) => this.restoreController.destroy(id),
      resetBufferedOutput: (id) => this.dataBuffer.resetForTerminal(id),
      releaseWebGL: (id) => this.webGLManager.onTerminalDestroyed(id),
      clearResizeJob: (managed) => this.resizeController.clearResizeJob(managed),
      clearSettledTimer: (id) => this.resizeController.clearSettledTimer(id),
      applyDeferredResize: (id) => this.resizeController.applyDeferredResize(id),
      openLink: (url, id, event) => this.linkHandler.openLink(url, id, event),
      getCwdProvider: (id) => this.cwdProviders.get(id),
      onHibernationChanged: (id) => this.notifyHibernationListeners(id),
      getIsBackgrounded: (id) => usePanelStore.getState().backgroundedTerminals.has(id),
      ...this.makeListenerInstallDeps(),
    });

    this.reflowController = new TerminalReflowController({
      getInstances: () => this.instances.values(),
    });

    this.wakeManager = new TerminalWakeManager({
      getInstance: (id) => this.instances.get(id),
      hasInstance: (id) => this.instances.has(id),
      restoreFromSerialized: (id, state) => this.restoreController.restoreFromSerialized(id, state),
      restoreFromSerializedIncremental: (id, state) =>
        this.restoreController.restoreFromSerializedIncremental(id, state),
    });

    this.rendererPolicy = new TerminalRendererPolicy({
      getInstance: (id) => this.instances.get(id),
      wakeAndRestore: (id) => {
        const m = this.instances.get(id);
        if (m?.isHibernated) this.unhibernate(id);
        return this.wakeManager.wakeAndRestore(id);
      },
      onPostWake: (id) => this.handlePostWake(id),
      onResumeFlush: (id) => this.dataBuffer.resumeFlush(id),
      applyDeferredResize: (id) => this.resizeController.applyDeferredResize(id),
      onTierApplied: (id, tier, managed) => {
        // Enter scheduleHibernation whenever the terminal is BACKGROUND and
        // offscreen, even if it's not eligible right now. scheduleHibernation
        // owns the decision: arm the regular 30s timer if eligible now, or
        // arm a one-shot eligibility re-check for active-state agents that
        // are silent but inside the AGENT_IDLE_SILENCE_MS window. Gating
        // here on isHibernationEligible (as the original did) makes the
        // re-check unreachable — a recently-active agent that drops to
        // BACKGROUND would be permanently exempt, the exact regression
        // this feature was built to fix.
        if (tier === TerminalRefreshTier.BACKGROUND && !managed.isVisible) {
          this.scheduleHibernation(id, managed);
        } else {
          this.cancelHibernation(managed);
        }

        if (tier === TerminalRefreshTier.BACKGROUND) {
          reduceScrollback(managed, SCROLLBACK_BACKGROUND);

          // Clear the resize dedup cache so the first ResizeObserver
          // observation after the terminal returns to an active tier is
          // processed, even if the pixel width/height match the values
          // recorded before the background transition. Without this reset,
          // a container that resized while hidden (e.g. window resize during
          // bulk worktree activity) can dedup-suppress the corrective resize
          // that re-syncs xterm and the PTY on wake (issue #7741).
          managed.lastWidth = 0;
          managed.lastHeight = 0;

          if (managed.imageAddon) {
            try {
              managed.imageAddon.dispose();
            } catch {
              /* ignore */
            }
            managed.imageAddon = null;
          }
          if (managed.fileLinksDisposable) {
            try {
              managed.fileLinksDisposable.dispose();
            } catch {
              /* ignore */
            }
            managed.fileLinksDisposable = null;
          }
          if (managed.webLinksAddon) {
            try {
              managed.webLinksAddon.dispose();
            } catch {
              /* ignore */
            }
            managed.webLinksAddon = null;
          }
          managed.hoveredLink = null;
        } else {
          // Tier upgrade path: clear the reduce cooldown so restoreScrollback
          // is unconditional and the next BACKGROUND drop isn't artificially
          // delayed by stale state from a long-completed reduce.
          managed.lastScrollbackReduceAt = undefined;
          restoreScrollback(managed);

          if (!managed.imageAddon) {
            try {
              managed.imageAddon = createImageAddon(managed.terminal);
            } catch (err) {
              logWarn("Failed to recreate ImageAddon", { id, error: err });
            }
          }
          if (!managed.fileLinksDisposable) {
            try {
              managed.fileLinksDisposable = createFileLinksAddon(
                managed.terminal,
                () => (this.cwdProviders.get(id) ?? (() => ""))(),
                (link) => {
                  const current = this.instances.get(id);
                  if (!current) return;
                  current.hoveredLink = link;
                }
              );
            } catch (err) {
              logWarn("Failed to recreate FileLinksAddon", { id, error: err });
            }
          }
          if (!managed.webLinksAddon) {
            try {
              managed.webLinksAddon = createWebLinksAddon(
                managed.terminal,
                (event, uri) => this.linkHandler.openLink(uri, id, event),
                {
                  hover: (_event, text) => {
                    const current = this.instances.get(id);
                    if (!current) return;
                    current.hoveredLink = this.makeSyntheticLink(text, null, id);
                  },
                  leave: () => {
                    const current = this.instances.get(id);
                    if (!current) return;
                    current.hoveredLink = null;
                  },
                }
              );
            } catch (err) {
              logWarn("Failed to recreate WebLinksAddon", { id, error: err });
            }
          }
        }

        if (managed.runtimeAgentId) {
          if (isWebGLEligibleTier(tier)) {
            this.webGLManager.ensureContext(id, managed);
          } else if (!managed.isVisible) {
            // Keep WebGL while visible — releasing here causes a one-frame renderer gap.
            // Tier demotion is an authoritative signal — cancel any pending
            // hide-dwell and release immediately.
            this.cancelWebGLHideTimer(managed);
            const hadWebGL = this.webGLManager.isActive(id);
            this.webGLManager.releaseContext(id);
            // Only refresh for a visible terminal — repainting an offscreen
            // DOM produces a stale frame that flashes on next show (#6802).
            if (hadWebGL && managed.isVisible && managed.terminal.rows > 0) {
              managed.terminal.refresh(0, managed.terminal.rows - 1);
            }
          }
        }

        // Cursor blink is policy-driven: plain terminals run the blink timer
        // only at FOCUSED/BURST, agent terminals never. Centralised in the
        // service helper so updateOptions/applyAgentPromotion/getOrCreate all
        // reach the same answer.
        this.applyCursorBlinkPolicy(managed);
      },
    });

    // If JetBrains Mono loads after the startup timeout already opened terminals
    // against the fallback stack, repair every live grid once it arrives (#9776).
    onTerminalFontArrivedLate(() => this.repairFontGrid());
  }

  setGPUHardwareAvailable(available: boolean): void {
    this.webGLManager.setHardwareAvailable(available);
  }

  // Triggered when the renderer receives a new ResourceProfilePayload — the
  // thresholds have already been written into TerminalWebGLConfig by the time
  // this runs, so we just nudge the manager to re-check its mode against the
  // new band. Without this, a profile downgrade can leave more wants on WebGL
  // than the new upper allows until the next consumer event happens to land.
  refreshWebGLMode(): void {
    this.webGLManager.refreshMode();
  }

  notifyUserInput(id: string, data = ""): void {
    this.onUserInput(id, data);
  }

  notifyEnterPressed(id: string): void {
    this.onEnterPressed(id);
  }

  /**
   * Builds the deps surface consumed by `installTerminalBoundListeners`. Both
   * the create path (`getOrCreate`) and the wake path (via
   * `TerminalHibernationManager.unhibernate`) install the same listener set
   * by passing this through, so adding a new terminal-bound listener is a
   * one-edit operation in `TerminalListenerInstaller.ts`.
   */
  private makeListenerInstallDeps(): TerminalListenerInstallDeps {
    return {
      onBufferModeChange: (id, isAltBuffer) => this.handleBufferModeChange(id, isAltBuffer),
      notifyParsed: (id) => this.dataBuffer.notifyParsed(id),
      scrollToBottomSafe: (managed) => this.scrollToBottomSafe(managed),
      updateScrollState: (id, isScrolledBack) =>
        this.unseenTracker.updateScrollState(id, isScrolledBack),
      clearUnseen: (id, fromUser) => this.unseenTracker.clearUnseen(id, fromUser),
      onWriteParsedReflow: (managed) => this.maybeReflowTerminal(managed),
      setCachedSelection: (id, selection) => this.cachedSelections.set(id, selection),
      deleteCachedSelection: (id) => this.cachedSelections.delete(id),
      getCachedSelection: (id) => this.cachedSelections.get(id),
      getBracketedPasteMode: (id) =>
        this.instances.get(id)?.terminal.modes.bracketedPasteMode ?? false,
      isDisposed: (id) => !this.instances.has(id),
      isInputLocked: (id) => this.instances.get(id)?.isInputLocked ?? false,
      notifyUserInput: (id) => this.notifyUserInput(id),
      clearDirectingState: (id, trigger) =>
        this.agentStateController.clearDirectingState(id, trigger),
      onUserInput: (id, data) => this.onUserInput(id, data),
      onEnterPressed: (id) => this.onEnterPressed(id),
      updateLastObservedTitle: (id, title) =>
        usePanelStore.getState().updateLastObservedTitle(id, title),
      notifyXtermFocused: () => {
        // Idempotent setter: store no-ops when value is unchanged, so the
        // burst of focusin events that xterm emits during selection,
        // mouse-mode reporting, and IME composition does not cause renders.
        usePanelStore.getState().setPreferredTerminalFocusTarget("xterm");
      },
    };
  }

  /**
   * Returns the text of the currently-hovered link, if any. Used by the
   * right-click context menu to show "Open Link"/"Copy Link Address" based
   * on the same detection xterm uses (WebLinksAddon, FileLinksAddon, OSC 8).
   */
  getHoveredLinkText(id: string): string | null {
    return this.instances.get(id)?.hoveredLink?.text ?? null;
  }

  /**
   * Opens the currently-hovered link by delegating to its own activate()
   * method. File links route through the actionService (file.view); URL and
   * OSC 8 links route through TerminalLinkHandler (localhost → browser panel
   * when modifier pressed, external open otherwise).
   */
  openHoveredLink(id: string, event?: MouseEvent): void {
    const managed = this.instances.get(id);
    const link = managed?.hoveredLink;
    if (!link) return;
    const mouseEvent = event ?? new MouseEvent("click");
    try {
      link.activate(mouseEvent, link.text);
    } catch (error) {
      logWarn("Failed to activate hovered link", { id, error });
    }
  }

  /**
   * Builds a synthetic ILink for WebLinksAddon and OSC 8 link sources (which
   * don't expose an ILink natively). activate() routes through the link
   * handler so localhost URLs hit the browser-panel path when needed.
   */
  private makeSyntheticLink(text: string, range: IBufferRange | null, terminalId: string): ILink {
    return {
      range: range ?? { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
      text,
      activate: (event: MouseEvent, uri: string) => {
        this.linkHandler.openLink(uri, terminalId, event);
      },
    };
  }

  /**
   * Thin delegate to {@link TerminalReflowController.maybeReflow}. Kept on
   * the service for the existing test fixtures that cast the service to a
   * structural type containing this method.
   */
  private maybeReflowTerminal(managed: ManagedTerminal): void {
    this.reflowController.maybeReflow(managed);
  }

  /**
   * Resolves the correct cursorBlink value for a terminal based on its agent
   * identity and current tier. Single source of truth for the blink policy:
   * — agent terminals (`runtimeAgentId` set, including runtime-promoted ones):
   *   always off (the blink timer's eyeball-attractor behaviour fights the
   *   agent state machine's own indicators).
   * — plain terminals: on only at FOCUSED/BURST. Off at VISIBLE/BACKGROUND so
   *   the xterm CursorBlinkStateManager `setInterval` doesn't run in
   *   non-focused splits or background tabs.
   *
   * Falls back to the live `getRefreshTier()` provider when `lastAppliedTier`
   * hasn't been recorded yet (initial-create path before the first
   * `applyRendererPolicy` cycle completes).
   */
  private applyCursorBlinkPolicy(managed: ManagedTerminal): void {
    const desired = (() => {
      if (managed.runtimeAgentId) return false;
      const tier =
        managed.lastAppliedTier ?? managed.getRefreshTier?.() ?? TerminalRefreshTier.FOCUSED;
      return tier === TerminalRefreshTier.FOCUSED || tier === TerminalRefreshTier.BURST;
    })();
    if (managed.terminal.options.cursorBlink !== desired) {
      managed.terminal.options.cursorBlink = desired;
    }
  }

  /**
   * Eligibility for visibility-driven WebGL restore. Mirrors the gates in
   * onTierApplied (agent identity + visible/focused tier) plus liveness
   * checks (opened, not attaching, not hibernated). Used by the debounced
   * timer in setVisible() before re-acquiring a context.
   */
  private shouldRestoreWebGL(managed: ManagedTerminal): boolean {
    if (!managed.runtimeAgentId) return false;
    if (!managed.isOpened) return false;
    if (!managed.isVisible) return false;
    if (managed.isAttaching) return false;
    if (managed.isHibernated) return false;
    return isWebGLEligibleTier(managed.lastAppliedTier ?? managed.getRefreshTier?.());
  }

  private onUserInput(id: string, data: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    this.rendererPolicy.applyRendererPolicy(id, TerminalRefreshTier.BURST);

    if (managed.inputBurstTimer !== undefined) {
      clearTimeout(managed.inputBurstTimer);
    }
    managed.inputBurstTimer = window.setTimeout(() => {
      const current = this.instances.get(id);
      if (!current) return;
      current.inputBurstTimer = undefined;
      this.rendererPolicy.applyRendererPolicy(id, current.getRefreshTier());
    }, 1000);

    this.agentStateController.onUserInput(id, data);
  }

  /**
   * Write-driven BURST tier: each PTY write extends the burst window in O(1)
   * by bumping `writeBurstDeadline`. A single self-rearming timer handles
   * decay — it re-checks the deadline on fire and either reschedules for the
   * remaining time (if a write extended the window while it was pending) or
   * reverts the tier via the panel's current `getRefreshTier()`.
   *
   * Avoiding per-write clearTimeout/setTimeout matters: at 60fps+ output the
   * naive pattern thrashes Chromium's timer queue and produces GC pressure.
   *
   * `applyRendererPolicy(BURST)` is called on every write: when BURST is
   * already applied the policy returns early (line 50 of
   * TerminalRendererPolicy) and as a load-bearing side-effect clears any
   * pending tierChangeTimer — that cancellation is what prevents a
   * concurrent focus-loss-scheduled downgrade from firing unopposed and
   * stranding the terminal at FOCUSED/VISIBLE/BACKGROUND mid-stream.
   */
  private onPtyWrite(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.writeBurstDeadline = Date.now() + WRITE_BURST_DECAY_MS;
    this.rendererPolicy.applyRendererPolicy(id, TerminalRefreshTier.BURST);

    if (managed.writeBurstTimer === undefined) {
      this.scheduleWriteBurstDecay(id, WRITE_BURST_DECAY_MS);
    }
  }

  private scheduleWriteBurstDecay(id: string, delayMs: number): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    managed.writeBurstTimer = window.setTimeout(() => {
      const current = this.instances.get(id);
      if (!current) return;
      current.writeBurstTimer = undefined;
      const deadline = current.writeBurstDeadline;
      const nowFire = Date.now();
      if (deadline !== undefined && nowFire < deadline) {
        this.scheduleWriteBurstDecay(id, deadline - nowFire);
        return;
      }
      current.writeBurstDeadline = undefined;
      this.rendererPolicy.applyRendererPolicy(id, current.getRefreshTier());
    }, delayMs);
  }

  private onEnterPressed(id: string): void {
    this.agentStateController.onEnterPressed(id);
  }

  clearDirectingState(id: string): void {
    this.agentStateController.clearDirectingState(id);
  }

  prewarmTerminal(
    id: string,
    launchAgentId: string | undefined,
    options: ConstructorParameters<typeof Terminal>[0],
    params: { offscreen?: boolean; widthPx?: number; heightPx?: number } = {}
  ): ManagedTerminal {
    const managed = this.getOrCreate(
      id,
      launchAgentId,
      options,
      () => TerminalRefreshTier.BACKGROUND,
      undefined
    );

    if (!params.offscreen) {
      return managed;
    }

    const widthPx = params.widthPx ?? 800;
    const heightPx = params.heightPx ?? 600;
    const slot = this.offscreenManager.getOrCreateOffscreenSlot(id, widthPx, heightPx);
    this.attach(id, slot);

    this.resizeController.fit(id);
    return managed;
  }

  suppressNextExit(id: string, ttlMs: number = 2000): void {
    this.suppressedExitUntil.set(id, Date.now() + ttlMs);
  }

  private shouldSuppressExit(id: string): boolean {
    const until = this.suppressedExitUntil.get(id);
    if (!until) return false;
    if (Date.now() > until) {
      this.suppressedExitUntil.delete(id);
      return false;
    }
    this.suppressedExitUntil.delete(id);
    return true;
  }

  stopPolling(): void {
    this.dataBuffer.stopPolling();
  }

  /**
   * Thin delegate to {@link TerminalWriteController.write}. Kept on the
   * service for the existing test fixtures that cast the service to a
   * structural type containing this method.
   */
  private writeToTerminal(id: string, data: string | Uint8Array): void {
    this.writeController.write(id, data);
  }

  setVisible(id: string, isVisible: boolean, expectedGeneration?: number): void {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return;

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
      this.cancelWebGLHideTimer(managed);
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
      this.cancelWebGLHideTimer(managed);

      if (isVisible) {
        // Revealing an on-screen terminal — make sure it doesn't get hibernated.
        // Tier may still be BACKGROUND (non-focused split view), so applying
        // the renderer policy alone isn't enough to clear the timer.
        this.cancelHibernation(managed);

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
        this.resizeController.applyDeferredResize(id);

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
        this.rendererPolicy.applyRendererPolicy(id, tier);

        const termEl = managed.terminal.element;
        if (termEl) {
          forceXtermReflow(termEl);
        }

        // Debounced WebGL restore for same-tier transitions. If
        // applyRendererPolicy above triggers a tier upgrade (e.g.
        // BACKGROUND→VISIBLE), onTierApplied loads the addon immediately
        // and this timer becomes a (harmless) idempotent re-apply. The
        // debounce only meaningfully gates rapid hide→show toggles where
        // the tier doesn't change, since same-tier applyRendererPolicy
        // is a no-op.
        managed.webGLRestoreTimer = window.setTimeout(() => {
          const current = this.instances.get(id);
          if (!current) return;
          current.webGLRestoreTimer = undefined;
          if (!this.shouldRestoreWebGL(current)) return;
          this.webGLManager.ensureContext(id, current);
        }, WEBGL_RESTORE_DEBOUNCE_MS);
      } else {
        // Going offscreen. Hold the WebGL context for WEBGL_HIDE_DWELL_MS so
        // rapid hide→show cycles (panel toggles, focus oscillation) don't
        // churn the pool. The timer callback re-fetches `managed` to avoid
        // stale refs (same pattern as webGLRestoreTimer above) and re-checks
        // isVisible so a show during the dwell window keeps the context.
        managed.webGLHideTimer = window.setTimeout(() => {
          const current = this.instances.get(id);
          if (!current) return;
          current.webGLHideTimer = undefined;
          if (current.isVisible) return;
          this.webGLManager.releaseContext(id);
        }, WEBGL_HIDE_DWELL_MS);

        // If we're already in BACKGROUND tier, onTierApplied won't fire to
        // start the timer — do it here instead. Pass to scheduleHibernation
        // even when not eligible right now (active-state agent with recent
        // writes); the function arms either the regular timer or a one-shot
        // eligibility re-check that fires when the silence window expires.
        const tier = managed.lastAppliedTier ?? managed.getRefreshTier?.();
        if (tier === TerminalRefreshTier.BACKGROUND) {
          this.scheduleHibernation(id, managed);
        }
      }
    }
  }

  lockResize(id: string, locked: boolean, customTtlMs?: number): void {
    this.resizeController.lockResize(id, locked, customTtlMs);
  }

  private layoutTransitionTimer: number | undefined;

  suppressResizesDuringLayoutTransition(panelIds: string[], durationMs: number): void {
    if (panelIds.length === 0) return;

    if (this.layoutTransitionTimer !== undefined) {
      clearTimeout(this.layoutTransitionTimer);
    }

    const safetyTtl = durationMs + 100;
    for (const id of panelIds) {
      this.resizeController.lockResize(id, true, safetyTtl);
    }

    this.layoutTransitionTimer = window.setTimeout(() => {
      this.layoutTransitionTimer = undefined;
      for (const id of panelIds) {
        if (!this.instances.has(id)) continue;
        this.resizeController.lockResize(id, false);
      }
      // ResizeObserver doesn't retroactively fire when a lock releases, so a
      // corrective pass is required to pick up the post-transition geometry.
      // runResizePass chunks the work and yields between terminals so a
      // post-transition correction never freezes the renderer, and a later
      // close/open supersedes it cleanly (#8597). The grid hook
      // (useContentGridContext) also schedules a pass ~50ms later when grid
      // deps change; the resize() dedup guard absorbs the overlap.
      this.runResizePass(panelIds);
    }, durationMs);
  }

  suppressResizesDuringProjectSwitch(panelIds: string[], durationMs: number): void {
    panelIds.forEach((id) => {
      const instance = this.instances.get(id);
      if (!instance) return;

      if (instance.resizeSuppressionTimer) {
        clearTimeout(instance.resizeSuppressionTimer);
      }

      instance.isResizeSuppressed = true;
      instance.resizeSuppressionEndTime = Date.now() + durationMs;
      this.resizeController.lockResize(id, true);

      instance.resizeSuppressionTimer = window.setTimeout(() => {
        instance.isResizeSuppressed = false;
        instance.resizeSuppressionEndTime = undefined;
        instance.resizeSuppressionTimer = undefined;
        this.resizeController.lockResize(id, false);
      }, durationMs);
    });
  }

  setTargetSize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id);
    if (!instance) return;

    if (
      Number.isFinite(cols) &&
      Number.isFinite(rows) &&
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      cols > 0 &&
      cols <= 500 &&
      rows > 0 &&
      rows <= 500
    ) {
      instance.targetCols = cols;
      instance.targetRows = rows;
    }
  }

  clearResizeSuppression(id: string): void {
    const instance = this.instances.get(id);
    if (!instance) return;

    if (instance.resizeSuppressionTimer) {
      clearTimeout(instance.resizeSuppressionTimer);
      instance.resizeSuppressionTimer = undefined;
    }

    instance.isResizeSuppressed = false;
    instance.resizeSuppressionEndTime = undefined;
    this.resizeController.lockResize(id, false);
  }

  wake(id: string): void {
    const managed = this.instances.get(id);
    if (managed?.isHibernated) {
      this.unhibernate(id);
    }
    this.wakeManager.wake(id);
  }

  /**
   * Run the full click-equivalent wake sequence on a visible terminal whose
   * project view just regained visibility (#8562). This method is the complete
   * path: it runs `applyDeferredResize`, `forceXtermReflow`,
   * `repairAtlasForReactivation`, `wakeAndRestore`, `xterm.refresh`,
   * `handlePostWake`, and `dataBuffer.resumeFlush`. The plain `wake(id)` path
   * (used on click/focus) only triggers buffer restore + xterm.refresh. Without
   * the full sequence, visible terminals show stale geometry and missing recent
   * output until the user clicks each pane.
   *
   * Bypasses {@link TerminalRendererPolicy.applyRendererPolicy} — that path
   * early-returns on tier equality and a backgrounded view's terminals stay
   * at VISIBLE the whole time. Bypasses the resize lock the same way the
   * attach path does (record remaining suppression TTL, unlock, resize,
   * relock with remaining TTL) so geometry resync doesn't silently no-op
   * while project-switch suppression is active.
   */
  async fullWakeForVisibilityRestore(id: string): Promise<void> {
    const managed = this.instances.get(id);
    if (!managed) return;

    if (managed.isHibernated) {
      this.unhibernate(id);
    }

    // Re-fetch after unhibernate so we operate on the current instance.
    const current = this.instances.get(id);
    if (!current) return;
    if (!current.isOpened) return;

    // Attach is in progress — running the wake now would race the attach's own
    // post-rAF reconciliation. That reconciliation path does NOT run the full
    // visibility-restore sequence, so we can't simply defer to it: mark the
    // terminal so notifyAttachSettledWaiters re-runs this wake once attach
    // settles (#9702).
    if (current.isAttaching) {
      current.pendingVisibilityWake = true;
      return;
    }

    // We're proceeding with the full wake now, so clear any stale deferred-wake
    // flag (e.g. a prior skip whose deferred re-run we are now satisfying).
    current.pendingVisibilityWake = false;

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
      this.resizeController.lockResize(id, false);
    }
    try {
      this.resizeController.applyDeferredResize(id);
    } finally {
      if (needsLockBypass) {
        this.resizeController.lockResize(id, true, remainingMs);
      }
    }

    const termEl = current.terminal.element;
    if (termEl) {
      try {
        forceXtermReflow(termEl);
      } catch (error) {
        logWarn(`forceXtermReflow failed for ${id}`, { error });
      }
    }

    // Repair the stale local WebGL glyph model synchronously, before the async
    // wakeAndRestore IPC and before the view's first composited frame. On warm
    // project-view reactivation the compositor can flash the pre-freeze atlas
    // state; resetting the local model here (no breaker, no shared-atlas churn)
    // clears it in place. No-op for DOM-renderer terminals.
    this.webGLManager.repairAtlasForReactivation(id);

    const ok = await this.wakeManager.wakeAndRestore(id);

    // Re-check after async: terminal may have been destroyed, hibernated, or
    // replaced while wakeAndRestore was in flight.
    const after = this.instances.get(id);
    if (!after || after !== current) return;
    if (after.isHibernated) return;

    after.terminal.refresh(0, after.terminal.rows - 1);

    if (ok) {
      this.handlePostWake(id);
    }
    this.dataBuffer.resumeFlush(id);
  }

  /**
   * Signal a PTY data-loss discontinuity at the point where the pty-host
   * discarded bytes from the IPC fallback queue. Instead of writing a styled
   * ANSI line directly (which embeds presentation in the wire format and can't
   * be asserted in WebGL-disabled E2E), this writes a structured private-use
   * OSC 57301 sequence carrying the dropped byte count and a reason code. The
   * handler registered in `TerminalParserHandler` parses it and fires the
   * `onDataLoss` callback wired in `getOrCreate`, which draws the yellow
   * marker. The leading `\x18` (CAN) cancels any partial in-progress escape
   * sequence so the OSC parses cleanly mid-stream.
   */
  injectDataLossMarker(id: string, droppedBytes: number): void {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return;
    managed.terminal.write(`\x18\x1b]57301;${droppedBytes};backpressure\x07`);
  }

  /**
   * Draw the user-visible yellow data-loss marker. Deferred via
   * `queueMicrotask` because it is reached from inside the OSC 57301 parse
   * callback — calling `terminal.write` synchronously during parsing would be
   * reentrant. Re-checks instance state because hibernation can occur between
   * the OSC write and this microtask.
   */
  private drawDataLossMarker(id: string, droppedBytes: number): void {
    queueMicrotask(() => {
      const managed = this.instances.get(id);
      if (!managed || managed.isHibernated) return;
      const label = droppedBytes > 0 ? `~${droppedBytes} bytes` : "output";
      managed.terminal.write(`\r\n\x1b[33m⚠ Output dropped (${label})\x1b[0m\r\n`);
    });
  }

  getOrCreate(
    id: string,
    launchAgentId: string | undefined,
    options: ConstructorParameters<typeof Terminal>[0],
    getRefreshTier: RefreshTierProvider = () => TerminalRefreshTier.FOCUSED,
    onInput?: (data: string) => void,
    getCwd?: () => string
  ): ManagedTerminal {
    const existing = this.instances.get(id);
    if (existing) {
      existing.getRefreshTier = getRefreshTier;
      existing.onInput = onInput;
      if (getCwd) {
        this.cwdProviders.set(id, getCwd);
      }
      if (options) {
        this.updateOptions(id, options);
      }
      if (launchAgentId !== undefined && !existing.isHibernated) {
        existing.terminal.options.cursorBlink = false;
      }
      return existing;
    }

    const openLink = (url: string, event?: MouseEvent) => {
      this.linkHandler.openLink(url, id, event);
    };

    const setHoveredLink = (link: ILink | null) => {
      const current = this.instances.get(id);
      if (!current) return;
      current.hoveredLink = link;
    };

    const terminalOptions = {
      ...options,
      rescaleOverlappingGlyphs: true,
      reflowCursorLine: true,
      linkHandler: {
        activate: (event: MouseEvent, text: string) => openLink(text, event),
        hover: (_event: MouseEvent, text: string, range: IBufferRange) => {
          setHoveredLink(this.makeSyntheticLink(text, range, id));
        },
        leave: () => setHoveredLink(null),
      },
    };

    if (launchAgentId !== undefined) {
      terminalOptions.cursorBlink = false;
    }

    const terminal = new Terminal(terminalOptions);
    this.cwdProviders.set(id, getCwd ?? (() => ""));
    const addons = setupTerminalAddons(
      terminal,
      () => (this.cwdProviders.get(id) ?? (() => ""))(),
      (event, uri) => openLink(uri, event),
      (link) => setHoveredLink(link),
      {
        hover: (_event, text) => setHoveredLink(this.makeSyntheticLink(text, null, id)),
        leave: () => setHoveredLink(null),
      }
    );

    const hostElement = document.createElement("div");
    hostElement.style.width = "100%";
    hostElement.style.height = "100%";
    hostElement.style.overflow = "hidden";
    hostElement.style.position = "relative";

    const listeners: Array<() => void> = [];
    const exitSubscribers = new Set<(exitCode: number) => void>();
    const agentStateSubscribers = new Set<AgentStateCallback>();

    const unsubData = terminalClient.onData(id, (data: string | Uint8Array) => {
      if (this.dataBuffer.isPolling()) return;
      this.dataBuffer.bufferData(id, data);
    });
    listeners.push(unsubData);

    const unsubExit = terminalClient.onExit((termId, exitCode) => {
      if (termId !== id) return;
      if (this.shouldSuppressExit(id)) {
        return;
      }
      const current = this.instances.get(id);
      if (current && !current.isHibernated) {
        current.terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
      }
      exitSubscribers.forEach((cb) => cb(exitCode));
    });
    listeners.push(unsubExit);

    const kind = "terminal" as const;

    const managed: ManagedTerminal = {
      terminal,
      kind,
      launchAgentId,
      runtimeAgentId: launchAgentId,
      agentState: undefined,
      agentStateSubscribers,
      ...addons,
      hoveredLink: null,
      hostElement,
      isOpened: false,
      listeners,
      exitSubscribers,
      getRefreshTier,
      keyHandlerInstalled: false,
      lastAttachAt: 0,
      lastDetachAt: 0,
      isVisible: false,
      lastActiveTime: Date.now(),
      lastWidth: 0,
      lastHeight: 0,
      latestCols: 0,
      latestRows: 0,
      latestWasAtBottom: true,
      isUserScrolledBack: false,
      isFocused: false,
      writeChain: Promise.resolve(),
      restoreGeneration: 0,
      isSerializedRestoreInProgress: false,
      deferredOutput: [],
      scrollbackRestoreState: "none",
      attachGeneration: 0,
      attachRevealToken: 0,
      isAltBuffer: false,
      altBufferListeners: new Set(),
      ipcListenerCount: listeners.length,
      onInput,
    };

    managed.parserHandler = new TerminalParserHandler(
      managed,
      () => {
        this.resizeController.applyDeferredResize(id);
      },
      (droppedBytes) => {
        this.drawDataLossMarker(id, droppedBytes);
      }
    );

    installTerminalBoundListeners(terminal, managed, id, this.makeListenerInstallDeps());

    this.instances.set(id, managed);

    const initialTier = getRefreshTier ? getRefreshTier() : TerminalRefreshTier.FOCUSED;
    this.rendererPolicy.applyRendererPolicy(id, initialTier);

    // For terminals starting at BACKGROUND tier, dispose tier-managed addons
    // immediately. The first applyRendererPolicy call is a no-op when initial
    // tier matches, so onTierApplied won't fire to dispose them. We also set
    // lastAppliedTier so that a later promotion is seen as an upgrade.
    if (initialTier === TerminalRefreshTier.BACKGROUND) {
      managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      // Seed the renderer-policy backend tier so the first promotion is seen
      // as a real BACKGROUND→active transition. Without this, lastBackendTier
      // is unset, prevBackendTier defaults to "active", and the wake/flush
      // path is skipped — bytes held by the background gate would never drain.
      this.rendererPolicy.initializeBackendTier(id, "background");
      try {
        managed.imageAddon?.dispose();
      } catch {
        /* ignore */
      }
      managed.imageAddon = null;
      try {
        managed.fileLinksDisposable?.dispose();
      } catch {
        /* ignore */
      }
      managed.fileLinksDisposable = null;
      try {
        managed.webLinksAddon?.dispose();
      } catch {
        /* ignore */
      }
      managed.webLinksAddon = null;
    }

    // The first applyRendererPolicy call is a no-op when the requested tier
    // matches lastAppliedTier (or the live getRefreshTier()), so onTierApplied
    // does not fire and the cursorBlink policy is not enforced. Apply it once
    // here for any non-FOCUSED/BURST initial tier (VISIBLE prewarms in a
    // non-focused split, or BACKGROUND prewarms in a non-focused tab).
    this.applyCursorBlinkPolicy(managed);

    this.notifyReadinessWaiters(id);

    return managed;
  }

  get(id: string): ManagedTerminal | null {
    return this.instances.get(id) ?? null;
  }

  /**
   * Stable accessor for E2E hooks. Avoids the bracket-notation
   * `service["instances"]` reach-around the test harness used to do, which
   * would silently break if the private field were renamed or refactored
   * away. Production code should not use this — use `get(id)` instead.
   */
  getInstanceForE2E(id: string): ManagedTerminal | undefined {
    return this.instances.get(id);
  }

  getCachedSelection(id: string): string {
    return this.cachedSelections.get(id) ?? "";
  }

  waitForInstance(id: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const existing = this.instances.get(id);
    if (existing) {
      return Promise.resolve();
    }

    const timeoutMs = options.timeoutMs ?? 5000;

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.removeReadinessWaiter(id, resolve);
        reject(new Error(`Terminal ${id} frontend readiness timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiters = this.readinessWaiters.get(id) || [];
      waiters.push({ resolve, reject, timeout });
      this.readinessWaiters.set(id, waiters);
    });
  }

  waitForAttachSettled(id: string, options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.isAttachSettled(id)) {
      return Promise.resolve();
    }

    const timeoutMs = options.timeoutMs ?? 1500;

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.removeAttachSettledWaiter(id, resolve);
        reject(new Error(`Terminal ${id} attach settle timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiters = this.attachSettledWaiters.get(id) || [];
      waiters.push({ resolve, reject, timeout });
      this.attachSettledWaiters.set(id, waiters);
    });
  }

  private isAttachSettled(id: string): boolean {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return false;
    return (
      managed.isOpened &&
      managed.isAttaching !== true &&
      managed.hostElement.isConnected &&
      managed.terminal.element !== undefined
    );
  }

  private notifyReadinessWaiters(id: string): void {
    const waiters = this.readinessWaiters.get(id);
    if (!waiters) return;

    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }

    this.readinessWaiters.delete(id);
  }

  private removeReadinessWaiter(id: string, resolve: () => void): void {
    const waiters = this.readinessWaiters.get(id);
    if (!waiters) return;

    const index = waiters.findIndex((w) => w.resolve === resolve);
    if (index >= 0) {
      waiters.splice(index, 1);
    }

    if (waiters.length === 0) {
      this.readinessWaiters.delete(id);
    }
  }

  private notifyAttachSettledWaiters(id: string): void {
    if (!this.isAttachSettled(id)) return;

    // Consume a deferred visibility wake that was skipped while this terminal
    // was mid-attach (#9702). Read and clear the flag before dispatching so a
    // re-entrant call can't double-fire; fullWakeForVisibilityRestore guards
    // against stale/replaced instances on its own.
    const managed = this.instances.get(id);
    const deferredWake = managed?.pendingVisibilityWake === true;
    if (managed) managed.pendingVisibilityWake = false;

    const waiters = this.attachSettledWaiters.get(id);
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve();
      }
      this.attachSettledWaiters.delete(id);
    }

    if (deferredWake) {
      void this.fullWakeForVisibilityRestore(id).catch((error) => {
        logWarn(`deferred fullWakeForVisibilityRestore failed for ${id}`, {
          error,
        });
      });
    }
  }

  private removeAttachSettledWaiter(id: string, resolve: () => void): void {
    const waiters = this.attachSettledWaiters.get(id);
    if (!waiters) return;

    const index = waiters.findIndex((w) => w.resolve === resolve);
    if (index >= 0) {
      waiters.splice(index, 1);
    }

    if (waiters.length === 0) {
      this.attachSettledWaiters.delete(id);
    }
  }

  private cancelAttachReveal(managed: ManagedTerminal): void {
    managed.attachRevealToken++;
    if (managed.attachRevealTimer !== undefined) {
      clearTimeout(managed.attachRevealTimer);
      managed.attachRevealTimer = undefined;
    }
    if (managed.attachRevealDisposable) {
      managed.attachRevealDisposable.dispose();
      managed.attachRevealDisposable = undefined;
    }
    managed.hostElement.style.opacity = "";
  }

  private cancelWebGLHideTimer(managed: ManagedTerminal): void {
    if (managed.webGLHideTimer !== undefined) {
      clearTimeout(managed.webGLHideTimer);
      managed.webGLHideTimer = undefined;
    }
  }

  attach(id: string, container: HTMLElement): ManagedTerminal | null {
    const managed = this.instances.get(id);
    if (!managed) {
      logDebug(`[TIS.attach] No managed instance for ${id}`);
      return null;
    }

    if (managed.isHibernated) {
      this.unhibernate(id);
    }

    const wasDetached = managed.isDetached === true;
    const wasAlreadyOpened = managed.isOpened;
    const wasReparented = managed.hostElement.parentElement !== container;
    logDebug(`[TIS.attach] ${id}`, {
      wasReparented,
      wasDetached,
      isOpened: managed.isOpened,
      bufferRows: managed.terminal.buffer?.active?.length ?? 0,
      containerRect: container.getBoundingClientRect(),
    });

    if (wasReparented) {
      if (managed.isOpened) {
        this.cancelAttachReveal(managed);
        managed.hostElement.style.opacity = "0";
      }
      container.appendChild(managed.hostElement);
    }

    if (!managed.isOpened) {
      // Seed xterm's grid before open() so cold-start restore paints at the
      // saved size instead of flashing 80x24 then snapping (#6983).
      if (managed.targetCols && managed.targetRows) {
        managed.terminal.resize(managed.targetCols, managed.targetRows);
      }
      managed.terminal.open(managed.hostElement);
      managed.isOpened = true;
      logDebug(`[TIS.attach] Opened terminal ${id}`);
      if (managed.runtimeAgentId && isWebGLEligibleTier(managed.lastAppliedTier)) {
        this.webGLManager.ensureContext(id, managed);
      }
    }
    managed.attachGeneration++;
    managed.lastAttachAt = Date.now();
    managed.isDetached = false;

    // Belt-and-braces: a terminal rehydrated from panel store can carry a
    // stale "directing" agentState with no live controller timer to clear it.
    // Sweep before the user sees the stuck indicator.
    this.agentStateController.checkStaleDirecting(id);

    // For warm terminals (previously opened, detached during project switch) with
    // saved target dimensions, apply the resize synchronously before the rAF reveal.
    // This runs inside useLayoutEffect (before browser paint), eliminating the visible
    // layout snap that occurs when resize is deferred to the double-nested rAF.
    let earlyResizeApplied = false;
    if (wasDetached && wasAlreadyOpened && managed.targetCols && managed.targetRows) {
      const needsLockBypass = managed.isResizeSuppressed;
      let remainingMs = 0;
      if (needsLockBypass && managed.resizeSuppressionEndTime) {
        remainingMs = Math.max(0, managed.resizeSuppressionEndTime - Date.now());
        this.resizeController.lockResize(id, false);
      }
      try {
        this.resizeController.applyResize(id, managed.targetCols, managed.targetRows);
        managed.targetCols = undefined;
        managed.targetRows = undefined;
        earlyResizeApplied = true;
      } finally {
        if (needsLockBypass) {
          this.resizeController.lockResize(id, true, remainingMs);
        }
      }
    }

    if (wasReparented && managed.isOpened) {
      const revealToken = managed.attachRevealToken;
      requestAnimationFrame(() => {
        if (this.instances.get(id) !== managed) return;
        if (managed.attachRevealToken !== revealToken) return;
        managed.isAttaching = false;

        // Post-attach renderer recovery: reconcile the renderer policy now that
        // isAttaching is cleared. During attach, setVisible(id, true) sets
        // isVisible but early-returns before applying the renderer policy or
        // scheduling a refresh (guarded by isAttaching). Without this
        // reconciliation, terminals prewarmed at BACKGROUND tier never get
        // upgraded to VISIBLE/FOCUSED, causing frozen display in switched-to
        // projects where applyWorktreeTerminalPolicy already ran before the
        // terminal was created.
        if (managed.isVisible && managed.getRefreshTier) {
          const currentTier = managed.getRefreshTier();
          if (managed.lastAppliedTier === undefined || currentTier !== managed.lastAppliedTier) {
            this.rendererPolicy.applyRendererPolicy(id, currentTier);
          }
        }

        // Restore WebGL after a same-tier reparent: setVisible(true) above
        // returned early because isAttaching was set, so no debounce timer
        // was armed. If tier didn't change either, applyRendererPolicy
        // above is a no-op. Re-acquire the context here so an agent
        // terminal that released WebGL on hide doesn't stay on the DOM
        // renderer permanently after a project switch or grid reflow.
        if (
          managed.isVisible &&
          !this.webGLManager.isActive(id) &&
          this.shouldRestoreWebGL(managed)
        ) {
          this.webGLManager.ensureContext(id, managed);
        }

        if (!managed.terminal.element) {
          managed.hostElement.style.opacity = "";
          this.notifyAttachSettledWaiters(id);
          return;
        }

        const termEl = managed.terminal.element;
        if (termEl) {
          forceXtermReflow(termEl);
        }

        const reveal = () => {
          if (managed.attachRevealToken !== revealToken) return;
          managed.hostElement.style.opacity = "";
          if (managed.attachRevealTimer !== undefined) {
            clearTimeout(managed.attachRevealTimer);
            managed.attachRevealTimer = undefined;
          }
          if (managed.attachRevealDisposable) {
            managed.attachRevealDisposable.dispose();
            managed.attachRevealDisposable = undefined;
          }
        };

        managed.attachRevealDisposable = managed.terminal.onRender(() => {
          reveal();
        });

        managed.attachRevealTimer = setTimeout(reveal, 150);

        managed.terminal.refresh(0, managed.terminal.rows - 1);

        requestAnimationFrame(() => {
          if (this.instances.get(id) !== managed) return;

          if (earlyResizeApplied) {
            this.notifyAttachSettledWaiters(id);
            return;
          }

          if (wasDetached) {
            const rect = container.getBoundingClientRect();
            const widthMatch =
              managed.lastWidth > 0 && Math.abs(managed.lastWidth - rect.width) < 2;
            const heightMatch =
              managed.lastHeight > 0 && Math.abs(managed.lastHeight - rect.height) < 2;
            if (widthMatch && heightMatch) {
              logDebug(`[TIS.attach] Skipping resize for ${id} — dimensions match after detach`);
              managed.targetCols = undefined;
              managed.targetRows = undefined;
              this.notifyAttachSettledWaiters(id);
              return;
            }
          }

          // Temporarily bypass resize lock for the initial attach fit, then re-lock.
          // Don't call clearResizeSuppression() — the suppression window must remain
          // active to block ResizeObserver and batch-fit events while layout settles.
          const needsLockBypass = managed.isResizeSuppressed;
          let remainingSuppressionMs = 0;

          if (needsLockBypass) {
            // Calculate remaining suppression time to use for re-lock
            if (managed.resizeSuppressionEndTime) {
              remainingSuppressionMs = Math.max(0, managed.resizeSuppressionEndTime - Date.now());
            }
            this.resizeController.lockResize(id, false);
          }

          try {
            if (managed.targetCols && managed.targetRows) {
              this.resizeController.applyResize(id, managed.targetCols, managed.targetRows);
              managed.targetCols = undefined;
              managed.targetRows = undefined;
            } else {
              this.resizeController.fit(id);
            }
          } finally {
            if (needsLockBypass) {
              // Re-lock with remaining suppression time to maintain full protection window
              this.resizeController.lockResize(id, true, remainingSuppressionMs);
            }
          }
          this.notifyAttachSettledWaiters(id);
        });
      });
    } else {
      managed.isAttaching = false;
      this.notifyAttachSettledWaiters(id);
    }

    return managed;
  }

  getAttachGeneration(id: string): number {
    return this.instances.get(id)?.attachGeneration ?? 0;
  }

  detach(id: string, container: HTMLElement | null): void {
    const managed = this.instances.get(id);
    if (!managed || !container || managed.isHibernated) {
      logDebug(`[TIS.detach] Skipping ${id} - no managed:${!managed}, no container:${!container}`);
      return;
    }
    this.cancelAttachReveal(managed);

    const isDirectChild = managed.hostElement.parentElement === container;
    logDebug(`[TIS.detach] ${id}`, {
      isDirectChild,
      bufferRows: managed.terminal.buffer?.active?.length ?? 0,
    });

    if (isDirectChild) {
      const slot = this.offscreenManager.getOffscreenSlot(id);
      if (slot) {
        logDebug(`[TIS.detach] Moving ${id} to offscreen slot`);
        slot.appendChild(managed.hostElement);
      } else {
        const hiddenContainer = this.offscreenManager.ensureHiddenContainer();
        if (hiddenContainer) {
          logDebug(`[TIS.detach] Moving ${id} to hidden container`);
          hiddenContainer.appendChild(managed.hostElement);
        } else {
          logDebug(`[TIS.detach] Removing ${id} from DOM (no fallback container)`);
          container.removeChild(managed.hostElement);
        }
      }
    }
    managed.terminal.blur();
    managed.hoveredLink = null;
    managed.lastDetachAt = Date.now();
    managed.isVisible = false;
    managed.isDetached = true;
  }

  detachForProjectSwitch(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    this.cancelAttachReveal(managed);

    logDebug(`[TIS.detachForProjectSwitch] ${id}`);

    managed.isVisible = false;
    managed.isDetached = true;

    this.resizeController.clearResizeJob(managed);
    this.resizeController.clearSettledTimer(id);

    if (managed.hostElement.parentElement) {
      const hiddenContainer = this.offscreenManager.ensureHiddenContainer();
      if (hiddenContainer && managed.hostElement.parentElement !== hiddenContainer) {
        hiddenContainer.appendChild(managed.hostElement);
      }
    }

    managed.terminal.blur();
    managed.hoveredLink = null;
    managed.lastDetachAt = Date.now();
  }

  fit(id: string): { cols: number; rows: number } | null {
    return this.resizeController.fit(id);
  }

  flushResize(id: string): void {
    this.resizeController.flushResize(id);
  }

  /**
   * Cancel a panel's pending resize job and debounce timer *without* applying
   * it. Used on optimistic close: `flushResize` would force-drain queued
   * output and reflow scrollback synchronously inside the close click, but the
   * pending job still has to be cleared so no stale resize fires after the
   * panel is detached or restored from trash.
   */
  cancelPendingResize(id: string): void {
    const managed = this.instances.get(id);
    if (managed) this.resizeController.clearResizeJob(managed);
  }

  sendPtyResize(id: string, cols: number, rows: number): void {
    this.resizeController.sendPtyResize(id, cols, rows);
  }

  resize(
    id: string,
    width: number,
    height: number,
    options: { immediate?: boolean } = {}
  ): { cols: number; rows: number } | null {
    return this.resizeController.resize(id, width, height, options);
  }

  /**
   * Resize a set of panels in a single read-all / write-all pass (#8597).
   *
   * The previous grid-fit batch chained one `fit()` per requestAnimationFrame,
   * which (a) spread the visual settle across N frames and (b) interleaved
   * `fitAddon.fit()`'s `getComputedStyle` read with the per-panel xterm write
   * for every panel — classic layout thrash. Here we phase the work: phase 1
   * reads `getBoundingClientRect()` for every eligible panel up front (cheap
   * thanks to per-panel `contain: layout style`), phase 2 calls
   * `resizeController.resize()` for each collected rect. `resize()` computes
   * cols/rows from cached cell metrics without touching the DOM, so the write
   * phase performs no further layout reads. The whole pass completes in a
   * single task.
   *
   * Eligibility guards mirror the per-panel checks the old chained-fit loop
   * relied on: instance must exist, host element must be connected and
   * visible (xterm's `fit()` path checks `checkVisibility()`, but `resize()`
   * does not, so we apply it here), and the panel must not be resize-locked.
   * Caller is responsible for the `isDragging` guard since the React ref
   * holding that state is owned by the grid hook.
   *
   * Private — this is the synchronous primitive. Callers outside this service
   * must go through {@link runResizePass} (chunked, cancellable) or
   * {@link scheduleBatchResize} (coalesced) so a survivor reflow never freezes
   * the renderer in one task. `executeResizePass` invokes this one id at a time.
   */
  private batchResize(ids: string[]): void {
    if (ids.length === 0) return;

    type Pending = { id: string; width: number; height: number };
    const seen = new Set<string>();
    const pending: Pending[] = [];

    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);

      const managed = this.instances.get(id);
      if (!managed) continue;
      if (!managed.hostElement.isConnected) continue;
      if (!managed.hostElement.checkVisibility()) continue;
      if (this.resizeController.isResizeLocked(id)) continue;

      const rect = managed.hostElement.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) continue;

      pending.push({ id, width: rect.width, height: rect.height });
    }

    for (const { id, width, height } of pending) {
      this.resizeController.resize(id, width, height);
    }
  }

  private gridResizeTimer: number | undefined;
  private readonly gridResizePendingIds = new Set<string>();
  private resizePassAbort: AbortController | undefined;

  /**
   * Coalesced variant of `batchResize`. A burst of grid open/close events each
   * union their ids and reset a trailing-edge timer; the actual resize runs
   * once the burst settles, on the next frame — so it never lands on the
   * synchronous open/close path the user is waiting on.
   */
  scheduleBatchResize(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) this.gridResizePendingIds.add(id);
    if (this.gridResizeTimer !== undefined) {
      clearTimeout(this.gridResizeTimer);
    }
    this.gridResizeTimer = window.setTimeout(() => {
      this.gridResizeTimer = undefined;
      const pendingIds = [...this.gridResizePendingIds];
      this.gridResizePendingIds.clear();
      requestAnimationFrame(() => this.runResizePass(pendingIds));
    }, GRID_RESIZE_COALESCE_MS);
  }

  /**
   * Resize a set of panels as a chunked, cancellable pass instead of one
   * synchronous loop. Closing or opening a panel resizes every surviving
   * xterm; in xterm.js 6.0 a column-changing resize reflows the entire
   * scrollback (O(scrollback)), so resizing ~15 terminals in a single
   * synchronous loop freezes the renderer for hundreds of ms — the
   * "app stops responding" the user feels on Cmd+W.
   *
   * This runs `RESIZE_PASS_CHUNK_SIZE` terminal(s) per task and yields to the
   * scheduler between chunks (see {@link yieldToScheduler}), so paint and
   * input stay live while the survivors settle progressively. The focused
   * panel resizes first so the pane the user is looking at settles in the
   * first frame; far corners of a large grid settle a beat later, unnoticed.
   *
   * Each new pass aborts any in-flight one: once a newer pass starts, the
   * survivor set the old one was resizing is already stale, so its remaining
   * reflows are cancelled. The trailing-edge debounce in
   * {@link scheduleBatchResize} coalesces a close/open burst before a pass
   * starts; this abort handles the case where a burst arrives once a pass is
   * already running. Fire-and-forget — callers never await it.
   */
  runResizePass(ids: string[]): void {
    if (ids.length === 0) return;
    // A newer pass supersedes any in-flight one — its survivor set is stale.
    this.resizePassAbort?.abort();
    const controller = new AbortController();
    this.resizePassAbort = controller;
    const run = () => this.executeResizePass(ids, controller);
    const task =
      typeof scheduler !== "undefined" && typeof scheduler.postTask === "function"
        ? scheduler.postTask(run, { priority: "user-visible", signal: controller.signal })
        : run();
    void task.catch((error) => {
      if (error instanceof Error && error.name === "AbortError") return;
      logError("terminal resize pass failed", error);
    });
  }

  private async executeResizePass(ids: string[], controller: AbortController): Promise<void> {
    const { signal } = controller;
    try {
      const ordered = this.orderFocusedFirst([...new Set(ids)]);
      for (let i = 0; i < ordered.length; i += RESIZE_PASS_CHUNK_SIZE) {
        if (signal.aborted) return;
        // batchResize re-applies every eligibility guard (instance exists,
        // connected, visible, not resize-locked) and reads fresh geometry —
        // correct here because layout has settled across the yields.
        this.batchResize(ordered.slice(i, i + RESIZE_PASS_CHUNK_SIZE));
        if (i + RESIZE_PASS_CHUNK_SIZE < ordered.length) {
          await yieldToScheduler();
        }
      }
    } finally {
      if (this.resizePassAbort === controller) {
        this.resizePassAbort = undefined;
      }
    }
  }

  /**
   * Order the resize set so the focused panel settles first. The user's eye
   * is on the focused pane; resizing it in the first chunk makes the pass
   * feel instant even though total work is unchanged.
   */
  private orderFocusedFirst(ids: string[]): string[] {
    const focusedId = usePanelStore.getState().focusedId;
    if (!focusedId || !ids.includes(focusedId)) return ids;
    return [focusedId, ...ids.filter((id) => id !== focusedId)];
  }

  scrollToBottom(id: string): void {
    const managed = this.instances.get(id);
    if (managed && !managed.isHibernated) {
      this.scrollToBottomSafe(managed);
    }
  }

  private scrollToBottomSafe(managed: ManagedTerminal): void {
    managed._suppressScrollTracking = true;
    try {
      managed.terminal.scrollToBottom();
    } finally {
      managed._suppressScrollTracking = false;
    }
    managed.isUserScrolledBack = false;
    managed.latestWasAtBottom = true;
  }

  scrollToLastActivity(id: string): void {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return;

    if (managed.isAltBuffer) {
      managed.terminal.scrollToBottom();
      return;
    }

    const marker = managed.lastActivityMarker;
    if (!marker || marker.isDisposed || marker.line < 0) {
      managed.terminal.scrollToBottom();
      return;
    }

    const viewportY = managed.terminal.buffer.active.viewportY;
    if (Math.abs(viewportY - marker.line) < 2) {
      managed.terminal.scrollToBottom();
      return;
    }

    managed.terminal.scrollToLine(marker.line);
  }

  subscribeUnseenOutput(id: string, listener: () => void): () => void {
    return this.unseenTracker.subscribe(id, listener);
  }

  subscribeHibernation(id: string, listener: () => void): () => void {
    let listeners = this.hibernationListeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.hibernationListeners.set(id, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.hibernationListeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.hibernationListeners.delete(id);
      }
    };
  }

  private notifyHibernationListeners(id: string): void {
    const listeners = this.hibernationListeners.get(id);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        logWarn("Hibernation listener error", { error });
      }
    }
  }

  getUnseenOutputSnapshot(id: string): UnseenOutputSnapshot {
    return this.unseenTracker.getSnapshot(id);
  }

  getLastWheelAt(id: string): number {
    return this.instances.get(id)?.lastWheelAt ?? 0;
  }

  resumeAutoScroll(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.isUserScrolledBack = false;
    this.unseenTracker.clearUnseen(id, false);
    this.scrollToBottomSafe(managed);
  }

  setAgentState(id: string, state: AgentState): void {
    this.agentStateController.setAgentState(id, state);
  }

  private handlePostWake(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    // Wake path can restore a terminal whose persisted agentState is "directing"
    // with no controller-owned timer. Clear before any other post-wake work.
    this.agentStateController.checkStaleDirecting(id);

    // Settled-strategy agents require atomic xterm+PTY resize (deferred 500ms).
    // fit() would immediately resize xterm.js while PTY lags, breaking atomicity.
    // Skip fit() for settled agents and use sendPtyResize which preserves the contract.
    if (this.getResizeStrategyForTerminal(managed) === "settled") {
      const cols = managed.latestCols;
      const rows = managed.latestRows;
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        this.resizeController.sendPtyResize(id, cols, rows);
      }
      // Clear throttle so the next write — or the 3s heartbeat — triggers an
      // immediate reflow. We don't call maybeReflowTerminal() inline here
      // because the deferred PTY resize above hasn't landed yet; reflowing
      // mid-resize would jitter against the pending dimension change. The
      // heartbeat and focus paths cover any IO unpause within 3s.
      managed.lastReflowAt = 0;
      return;
    }

    // Re-measure container dimensions after wake so latestCols/latestRows
    // reflect the current window size rather than pre-hibernation cache.
    // fit() already guards against offscreen/small terminals (returns null).
    const fitResult = this.resizeController.fit(id);
    if (!fitResult) {
      // Fallback: fit() returned null (terminal offscreen or container too small).
      this.resizeController.forceImmediateResize(id);
    }

    // Kick the IO unpause path for standard terminals that just woke up —
    // without this, a renderer that was paused pre-hibernation can stay
    // blank until the next write or the 3s heartbeat. Throttle is cleared
    // first so this runs unconditionally.
    managed.lastReflowAt = 0;
    this.maybeReflowTerminal(managed);
  }

  private getResizeStrategyForTerminal(managed: ManagedTerminal): "default" | "settled" {
    if (!managed.runtimeAgentId) return "default";
    const config = getEffectiveAgentConfig(managed.runtimeAgentId);
    return config?.capabilities?.resizeStrategy ?? "default";
  }

  private handleBufferModeChange(id: string, isAltBuffer: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    for (const callback of managed.altBufferListeners) {
      try {
        callback(isAltBuffer);
      } catch (err) {
        logError("Alt buffer callback error", err);
      }
    }

    // Don't call fit() here. The alt buffer listeners update React state which
    // changes container padding, and the ResizeObserver on the container handles
    // the resulting layout change. Calling fit() in a rAF would double-trigger
    // the resize path, sending redundant PTY resize events that cause Ink-based
    // TUIs (Gemini CLI) to detect idle re-render loops.
    this.resizeController.clearResizeJob(managed);

    if (!isAltBuffer && managed.lastAppliedTier === TerminalRefreshTier.BACKGROUND) {
      reduceScrollback(managed, SCROLLBACK_BACKGROUND);
    }
  }

  addAltBufferListener(id: string, callback: (isAltBuffer: boolean) => void): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};

    managed.altBufferListeners.add(callback);

    if (managed.isAltBuffer !== undefined) {
      try {
        callback(managed.isAltBuffer);
      } catch (err) {
        logError("Alt buffer callback error", err);
      }
    }

    return () => {
      managed.altBufferListeners.delete(callback);
    };
  }

  getAltBufferState(id: string): boolean {
    const managed = this.instances.get(id);
    return managed?.isAltBuffer ?? false;
  }

  /**
   * Returns whether DEC private mode 2026 (Synchronized Output / BSU+ESU) is
   * currently open on the terminal. Returns `null` when the terminal is
   * unknown or its xterm instance hasn't surfaced the mode (e.g. test mocks).
   *
   * Diagnostic-only — the value lags `terminal.write()` by one parser tick
   * because xterm processes writes asynchronously, so it should not be used
   * to gate writes synchronously.
   */
  getSynchronizedOutputMode(id: string): boolean | null {
    const managed = this.instances.get(id);
    if (!managed) return null;
    const mode = managed.terminal.modes?.synchronizedOutputMode;
    return typeof mode === "boolean" ? mode : null;
  }

  getAgentState(id: string): AgentState | undefined {
    const managed = this.instances.get(id);
    return managed?.agentState;
  }

  addAgentStateListener(id: string, callback: AgentStateCallback): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};

    managed.agentStateSubscribers.add(callback);

    if (managed.agentState !== undefined) {
      try {
        callback(managed.agentState);
      } catch (err) {
        logError("Agent state callback error", err);
      }
    }

    return () => {
      managed.agentStateSubscribers.delete(callback);
    };
  }

  captureBufferText(id: string, maxChars: number = 20000): string {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return "";

    const buf = managed.terminal.buffer.active;
    if (buf.length === 0) return "";

    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }

    let text = stripAnsiAndOscCodes(lines.join("\n"));

    if (text.length > maxChars) {
      text = text.slice(-maxChars);
    }

    return text;
  }

  registerPostCompleteHook(id: string, callback: PostCompleteHook): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};

    managed.postCompleteMarker?.dispose();
    managed.postCompleteHook = callback;

    if (!managed.isAltBuffer) {
      managed.postCompleteMarker = managed.terminal.registerMarker(0);
    } else {
      managed.postCompleteMarker = undefined;
    }

    return () => {
      this.unregisterPostCompleteHook(id);
    };
  }

  unregisterPostCompleteHook(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.postCompleteMarker?.dispose();
    managed.postCompleteMarker = undefined;
    managed.postCompleteHook = undefined;
  }

  setFocused(id: string, isFocused: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.isFocused = isFocused;
    managed.lastActiveTime = Date.now();
  }

  isFocused(id: string): boolean {
    return this.instances.get(id)?.isFocused === true;
  }

  focus(id: string): void {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return;

    const terminal = managed.terminal;
    const buffer = terminal.buffer.active;
    const savedViewportY = buffer.viewportY;
    const wasAtBottom = savedViewportY >= buffer.baseY;

    // xterm 6.0 wraps `.xterm-screen` in a VS-Code-derived SmoothScrollableElement
    // whose internal `_handleScroll` mirrors native `scrollTop` changes back into
    // `buffer.ydisp`. `CoreBrowserTerminal.focus()` calls
    // `textarea.focus({ preventScroll: true })`, but Chromium bypasses that flag
    // when IME composition initializes or the Selection API touches the textarea
    // synchronously after focus. When the bypass fires, the browser runs
    // `scrollIntoView` to reveal the helper textarea (styled `top: 0; left: -9999em`
    // by default), yanking the scroll wrapper to y=0 — which xterm mirrors back
    // into ydisp=0, flashing the terminal to the top of scrollback for one frame.
    // The flash is only visible on taller terminals where the scroll distance
    // from cursor to row 0 is large enough to perceive. Smooth-scroll is disabled
    // (smoothScrollDuration=0), so the scroll sync is synchronous — restoring
    // ydisp inline here runs before any render commits.
    managed._suppressScrollTracking = true;
    try {
      terminal.focus();

      const curBuffer = terminal.buffer.active;
      if (wasAtBottom) {
        if (curBuffer.viewportY < curBuffer.baseY) {
          terminal.scrollToBottom();
        }
      } else if (curBuffer.viewportY !== savedViewportY) {
        terminal.scrollToLine(savedViewportY);
      }
    } finally {
      managed._suppressScrollTracking = false;
    }
  }

  resetRenderer(id: string): void {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return;

    try {
      if (!managed.hostElement.isConnected) {
        logDebug(`resetRenderer skipped for ${id}: not connected`);
        return;
      }
      if (managed.hostElement.clientWidth < 50 || managed.hostElement.clientHeight < 50) {
        logDebug(
          `resetRenderer skipped for ${id}: too small (${managed.hostElement.clientWidth}x${managed.hostElement.clientHeight})`
        );
        return;
      }

      logDebug(`resetRenderer running for ${id}`);

      // Recover this terminal's renderer WITHOUT clearing the shared texture
      // atlas: clearTextureAtlas() flushes xterm's module-global atlas shared by
      // every WebGL terminal with matching font/theme, blanking co-owner panes
      // until they get their own resize/click trigger (#9701). repairAtlasForReactivation
      // does a local-only model reset + refresh on this terminal's pool entry and
      // returns false for DOM-renderer terminals, where we fall back to a plain
      // refresh so the targeted pane still repaints.
      if (!this.webGLManager.repairAtlasForReactivation(id)) {
        managed.terminal.refresh(0, managed.terminal.rows - 1);
      }

      try {
        this.resizeController.fit(id);
      } catch (error) {
        logError(`resetRenderer fit failed for ${id}`, error);
      }
    } catch (error) {
      logError(`resetRenderer failed for ${id}`, error);
    }

    // Force IO re-evaluation so a DOM-renderer terminal that got stuck
    // with _isPaused=true actually resumes drawing. Runs independently of
    // the refresh/fit block so the user-invokable escape hatch works even
    // when fit() throws. Clear the throttle so any follow-up automatic
    // reflow (onWriteParsed, heartbeat, focus) fires immediately.
    const termEl = managed.terminal.element;
    if (termEl) {
      try {
        forceXtermReflow(termEl);
      } catch (error) {
        logWarn(`forceXtermReflow failed for ${id}`, { error });
      }
      managed.lastReflowAt = 0;
    }
  }

  handleBackendRecovery(): void {
    this.instances.forEach((managed, id) => {
      if (managed.isHibernated) return;
      try {
        managed.terminal.write("\x1b[!p");

        this.resetRenderer(id);

        managed.fitAddon?.fit();

        const timestamp = new Date().toLocaleTimeString();
        managed.terminal.write(
          `\r\n\x1b[33m[${timestamp}] Terminal backend reconnected\x1b[0m\r\n`
        );
      } catch (error) {
        logError(`Failed to recover terminal ${id}`, error);
      }
    });
  }

  updateOptions(id: string, options: Partial<Terminal["options"]>): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    const textMetricKeys = ["fontSize", "fontFamily", "lineHeight", "letterSpacing", "fontWeight"];
    const textMetricsChanged = textMetricKeys.some((key) => key in options);

    if (!managed.isHibernated) {
      Object.entries(options).forEach(([key, value]) => {
        // @ts-expect-error xterm options are indexable
        managed.terminal.options[key] = value;
      });
      // Theme/font/etc. updates flow through `BASE_TERMINAL_OPTIONS` which
      // unconditionally sets cursorBlink:true — re-clamp through the policy
      // helper so a BACKGROUND/VISIBLE plain terminal doesn't silently start
      // its blink timer again on a font or theme change.
      this.applyCursorBlinkPolicy(managed);
    }

    if (textMetricsChanged) {
      managed.lastWidth = 0;
      managed.lastHeight = 0;
    }

    if (!managed.isHibernated) {
      if (textMetricsChanged) {
        this.resizeController.fit(id);
      }
      if ("theme" in options) {
        managed.terminal.refresh(0, managed.terminal.rows - 1);
      }
    }
  }

  applyGlobalOptions(options: Partial<Terminal["options"]>): void {
    const textMetricKeys = ["fontSize", "fontFamily", "lineHeight", "letterSpacing", "fontWeight"];
    const textMetricsChanged = textMetricKeys.some((key) => key in options);

    this.instances.forEach((managed, id) => {
      if (!managed.isHibernated) {
        Object.entries(options).forEach(([key, value]) => {
          // @ts-expect-error xterm options are indexable
          managed.terminal.options[key] = value;
        });
        // Same rationale as updateOptions: re-clamp cursorBlink so a global
        // theme/font change doesn't silently re-enable the blink timer on
        // backgrounded plain terminals.
        this.applyCursorBlinkPolicy(managed);
      }

      if (textMetricsChanged) {
        managed.lastWidth = 0;
        managed.lastHeight = 0;
      }

      if (!managed.isHibernated) {
        if (textMetricsChanged) {
          this.resizeController.fit(id);
        }
        if ("theme" in options) {
          managed.terminal.refresh(0, managed.terminal.rows - 1);
        }
      }
    });
  }

  /**
   * Re-measure character cell metrics for every live terminal and refit.
   *
   * Called when JetBrains Mono finishes loading *after* the startup font timeout
   * already unblocked `terminal.open()` (#9776). Those terminals measured their
   * cell size against the fallback monospace stack, so the grid is sized wrong
   * for the rest of the session. xterm's CharSizeService only re-measures on a
   * genuine `fontFamily`/`fontSize` change — `OptionsService` dedups same-value
   * sets — so we briefly poke `fontFamily` to a distinct (but visually
   * identical, trailing-space) string and restore it, firing the re-measure,
   * then refit so cols/rows recompute against the corrected cell metrics.
   */
  repairFontGrid(): void {
    this.instances.forEach((managed, id) => {
      if (managed.isHibernated) return;
      try {
        const current = managed.terminal.options.fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY;
        // A trailing space parses identically in CSS (no visible flicker) but is
        // a distinct string, so it defeats OptionsService's same-value dedup and
        // fires onMultipleOptionChange -> CharSizeService.measure() twice.
        managed.terminal.options.fontFamily = `${current} `;
        managed.terminal.options.fontFamily = current;
        // fit() doesn't read these, but the ResizeObserver-driven resize() path
        // dedups by pixel size — reset so the next observation isn't suppressed.
        managed.lastWidth = 0;
        managed.lastHeight = 0;
        this.resizeController.fit(id);
      } catch (error) {
        logError("Failed to repair terminal font grid", error, { id });
      }
    });
  }

  applyRendererPolicy(id: string, tier: TerminalRefreshTier): void {
    this.rendererPolicy.applyRendererPolicy(id, tier);
  }

  updateRefreshTierProvider(id: string, provider: RefreshTierProvider): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    managed.getRefreshTier = provider;
  }

  boostRefreshRate(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    this.rendererPolicy.applyRendererPolicy(id, TerminalRefreshTier.BURST);
  }

  /**
   * Initialize the backend tier state for a reconnected terminal.
   * This ensures proper wake behavior after project switch by setting
   * the frontend's lastBackendTier to match the actual backend state.
   */
  initializeBackendTier(id: string, tier: "active" | "background"): void {
    this.rendererPolicy.initializeBackendTier(id, tier);
  }

  reduceScrollback(id: string, targetLines: number): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    reduceScrollback(managed, targetLines);
  }

  restoreScrollback(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    restoreScrollback(managed);
  }

  applyAgentPromotion(id: string, agentId: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    if (managed.runtimeAgentId === agentId) {
      restoreScrollback(managed);
      return;
    }
    managed.runtimeAgentId = agentId;
    // Runtime-promoted agents (detected via parser, not launchAgentId) start
    // life as plain terminals and may have cursorBlink:true. Force the agent
    // policy now so background promotions don't keep the blink timer alive.
    this.applyCursorBlinkPolicy(managed);
    restoreScrollback(managed);
    if (managed.isOpened && isWebGLEligibleTier(managed.lastAppliedTier)) {
      this.webGLManager.ensureContext(id, managed);
    }
  }

  clearAgentPromotion(id: string): void {
    const managed = this.instances.get(id);
    if (!managed?.runtimeAgentId) return;
    managed.runtimeAgentId = undefined;
    // Demoted to plain terminal — re-evaluate the blink policy so a focused
    // pane gets its blinking cursor back.
    this.applyCursorBlinkPolicy(managed);
    restoreScrollback(managed);
    // Agent demotion is authoritative — cancel any pending hide-dwell so the
    // timer can't fire later and call releaseContext on a stale slot.
    this.cancelWebGLHideTimer(managed);
    this.webGLManager.releaseContext(id);
    this.maybeReflowTerminal(managed);
  }

  reduceScrollbackAllBackground(targetLines: number): void {
    for (const managed of this.instances.values()) {
      if (managed.isHibernated) continue;
      if (managed.isFocused) continue;
      if (
        managed.runtimeAgentId &&
        managed.canonicalAgentState !== "completed" &&
        managed.canonicalAgentState !== "exited"
      )
        continue;
      // Force-bypass the per-terminal cooldown. This is a deliberate bulk
      // memory-pressure shrink (resource-profile downshift / explicit purge),
      // not the tab-flip path the cooldown protects against.
      reduceScrollback(managed, targetLines, { force: true });
    }
  }

  addExitListener(id: string, cb: (exitCode: number) => void): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};
    managed.exitSubscribers.add(cb);
    return () => managed.exitSubscribers.delete(cb);
  }

  isHibernated(id: string): boolean {
    return this.instances.get(id)?.isHibernated === true;
  }

  hibernate(id: string): void {
    this.hibernationManager.hibernate(id);
  }

  unhibernate(id: string): void {
    this.hibernationManager.unhibernate(id);
  }

  private scheduleHibernation(id: string, managed: ManagedTerminal, delayMs?: number): void {
    this.hibernationManager.scheduleHibernation(id, managed, delayMs);
  }

  private cancelHibernation(managed: ManagedTerminal): void {
    this.hibernationManager.cancelHibernation(managed);
  }

  /**
   * Memory-pressure accelerator. Sweep every BACKGROUND-tier instance and
   * re-arm its hibernation timer with a shorter delay so idle terminals
   * release memory immediately under OS pressure instead of waiting for the
   * fixed 30s window.
   *
   * - Level 1 (mild pressure): HIBERNATION_DELAY_PRESSURE_TIER1_MS (5s).
   *   Enough headroom for a write burst to drain and to absorb tab-flip
   *   oscillation, but ~6x faster than the normal window.
   * - Level 2 (sustained pressure): HIBERNATION_DELAY_PRESSURE_TIER2_MS (0).
   *   Fire immediately; the `hibernate()` safety guard still blocks
   *   actively-writing or recently-active agent terminals.
   *
   * Skips visible terminals (the user is looking at them) and terminals that
   * are not currently in BACKGROUND tier (those are protected by the
   * renderer policy). Already-hibernated terminals are skipped.
   */
  accelerateHibernation(level: 1 | 2): void {
    const delayMs =
      level === 1 ? HIBERNATION_DELAY_PRESSURE_TIER1_MS : HIBERNATION_DELAY_PRESSURE_TIER2_MS;
    for (const [id, managed] of this.instances.entries()) {
      if (managed.isHibernated) continue;
      if (managed.isVisible) continue;
      if (managed.lastAppliedTier !== TerminalRefreshTier.BACKGROUND) continue;
      // Cancel the existing 30s timer so we don't race two pending
      // hibernations against each other. The new schedule re-runs the
      // eligibility check, so active-agent terminals with recent writes
      // still wait out their silence window (their eligibility re-check
      // timer takes over from here).
      this.cancelHibernation(managed);
      this.scheduleHibernation(id, managed, delayMs);
    }
  }

  /**
   * Called when the user explicitly backgrounds a panel. A terminal that was
   * already offscreen at BACKGROUND tier had its hibernation timer armed by
   * the earlier tier drop — and for a still-active agent inside the silence
   * window that means a one-shot eligibility re-check that waits out the full
   * AGENT_IDLE_SILENCE_MS. That re-check predates the backgrounded bypass, so
   * without this nudge the bypass wouldn't take effect until the window
   * expired anyway. Cancel the pending timer and reschedule so the bypass
   * (`getIsBackgrounded` is now true) arms the normal hibernation timer
   * immediately. Visible panels are skipped — backgrounding unmounts them,
   * and the resulting detach → setVisible(false) → onTierApplied path arms
   * the timer with the bypass already in effect.
   */
  onPanelBackgrounded(id: string): void {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated || managed.isVisible) return;
    if (managed.lastAppliedTier !== TerminalRefreshTier.BACKGROUND) return;
    this.cancelHibernation(managed);
    this.scheduleHibernation(id, managed);
  }

  destroy(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    const waiters = this.readinessWaiters.get(id);
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(`Terminal ${id} destroyed before frontend became ready`));
      }
      this.readinessWaiters.delete(id);
    }

    const attachWaiters = this.attachSettledWaiters.get(id);
    if (attachWaiters) {
      for (const waiter of attachWaiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(`Terminal ${id} destroyed before attach settled`));
      }
      this.attachSettledWaiters.delete(id);
    }

    this.cancelAttachReveal(managed);
    this.agentStateController.destroy(id);
    this.restoreController.destroy(id);

    if (managed.scrollbackRestoreDisposable) {
      managed.scrollbackRestoreDisposable.dispose();
      managed.scrollbackRestoreDisposable = undefined;
    }
    managed.scrollbackRestoreState = "none";

    this.instances.delete(id);

    for (const unsub of managed.listeners) {
      try {
        unsub();
      } catch (error) {
        logWarn("Error unsubscribing listener", { error });
      }
    }
    managed.listeners.length = 0;

    this.resizeController.clearResizeJob(managed);
    this.resizeController.clearResizeLock(id);
    this.resizeController.clearSettledTimer(id);
    this.dataBuffer.resetForTerminal(id);
    this.unseenTracker.destroy(id);
    this.hibernationListeners.delete(id);

    if (managed.hibernationTimer) {
      clearTimeout(managed.hibernationTimer);
      managed.hibernationTimer = undefined;
    }
    if (managed.hibernationEligibilityTimer) {
      clearTimeout(managed.hibernationEligibilityTimer);
      managed.hibernationEligibilityTimer = undefined;
    }
    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
      managed.tierChangeTimer = undefined;
    }
    if (managed.inputBurstTimer !== undefined) {
      clearTimeout(managed.inputBurstTimer);
      managed.inputBurstTimer = undefined;
    }
    if (managed.writeBurstTimer !== undefined) {
      clearTimeout(managed.writeBurstTimer);
      managed.writeBurstTimer = undefined;
    }
    managed.writeBurstDeadline = undefined;
    if (managed.titleReportTimer !== undefined) {
      clearTimeout(managed.titleReportTimer);
      managed.titleReportTimer = undefined;
      managed.pendingTitleState = undefined;
    }
    if (managed.observedTitleTimer !== undefined) {
      clearTimeout(managed.observedTitleTimer);
      managed.observedTitleTimer = undefined;
      managed.pendingObservedTitle = undefined;
    }
    if (managed.resizeSuppressionTimer !== undefined) {
      clearTimeout(managed.resizeSuppressionTimer);
      managed.resizeSuppressionTimer = undefined;
    }
    if (managed.webGLRestoreTimer !== undefined) {
      clearTimeout(managed.webGLRestoreTimer);
      managed.webGLRestoreTimer = undefined;
    }
    if (managed.webGLHideTimer !== undefined) {
      clearTimeout(managed.webGLHideTimer);
      managed.webGLHideTimer = undefined;
    }

    managed.lastActivityMarker?.dispose();
    managed.postCompleteMarker?.dispose();
    managed.postCompleteMarker = undefined;
    managed.postCompleteHook = undefined;
    managed.exitSubscribers.clear();
    managed.agentStateSubscribers.clear();
    managed.altBufferListeners.clear();

    if (!managed.isHibernated) {
      managed.parserHandler?.dispose();

      try {
        managed.fileLinksDisposable?.dispose();
      } catch (error) {
        logWarn("Error disposing file links", { error });
      }
      try {
        managed.webLinksAddon?.dispose();
      } catch (error) {
        logWarn("Error disposing web links addon", { error });
      }
      try {
        managed.imageAddon?.dispose();
      } catch (error) {
        logWarn("Error disposing image addon", { error });
      }

      this.webGLManager.onTerminalDestroyed(id);
      managed.terminal.dispose();

      if (managed.hostElement.parentElement) {
        managed.hostElement.parentElement.removeChild(managed.hostElement);
      }
    }

    this.offscreenManager.removeOffscreenSlot(id);
    this.suppressedExitUntil.delete(id);
    this.cwdProviders.delete(id);
    this.cachedSelections.delete(id);
    this.wakeManager.clearWakeState(id);
    this.rendererPolicy.clearTierState(id);
  }

  dispose(): void {
    this.stopPolling();
    // Abort any in-flight chunked resize pass so its yielded continuation
    // doesn't resume against a torn-down service.
    this.resizePassAbort?.abort();
    this.resizePassAbort = undefined;
    this.reflowController.dispose();
    this.instances.forEach((_, id) => this.destroy(id));
    this.offscreenManager.dispose();
    this.wakeManager.dispose();
    this.webGLManager.dispose();
    this.rendererPolicy.dispose();
    this.agentStateController.dispose();
    this.restoreController.dispose();
  }

  async restoreFetchedState(id: string, serializedState: string | null): Promise<boolean> {
    return this.restoreController.restoreFetchedState(id, serializedState);
  }

  async fetchAndRestore(id: string): Promise<boolean> {
    return this.restoreController.fetchAndRestore(id);
  }

  restoreFromSerialized(id: string, serializedState: string): boolean {
    return this.restoreController.restoreFromSerialized(id, serializedState);
  }

  restoreFromSerializedIncremental(id: string, serializedState: string): Promise<boolean> {
    return this.restoreController.restoreFromSerializedIncremental(id, serializedState);
  }

  setInputLocked(id: string, locked: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.isInputLocked = locked;
    if (!managed.isHibernated) {
      managed.terminal.options.disableStdin = locked;
    }
  }
}

export const terminalInstanceService = new TerminalInstanceService();

// Expose terminal buffer reader for E2E tests (WebGL renderer has no DOM text).
// Registered unconditionally but gated at call time — the function is harmless
// in production and avoids import-time env var timing issues.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__daintreeReadTerminalBuffer = (
    panelId: string
  ): string => {
    const managed = terminalInstanceService.getInstanceForE2E(panelId);
    if (!managed) return "";
    const buf = managed.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  };

  (window as unknown as Record<string, unknown>).__daintreeSelectTerminalAll = (
    panelId: string
  ): boolean => {
    const managed = terminalInstanceService.getInstanceForE2E(panelId);
    if (!managed) return false;
    managed.terminal.selectAll();
    return true;
  };

  (window as unknown as Record<string, unknown>).__daintreeGetTerminalBufferLength = (
    panelId: string
  ): number => {
    const managed = terminalInstanceService.getInstanceForE2E(panelId);
    if (!managed) return 0;
    return managed.terminal.buffer.active.length;
  };

  (window as unknown as Record<string, unknown>).__daintreeGetTerminalDimensions = (
    panelId: string
  ): { cols: number; rows: number } | null => {
    const managed = terminalInstanceService.getInstanceForE2E(panelId);
    if (!managed) return null;
    return { cols: managed.terminal.cols, rows: managed.terminal.rows };
  };

  type TerminalScrollSnapshotForE2E = {
    viewportY: number;
    baseY: number;
    isUserScrolledBack: boolean;
  };

  const readTerminalScrollSnapshotForE2E = (
    panelId: string
  ): TerminalScrollSnapshotForE2E | null => {
    const managed = terminalInstanceService.getInstanceForE2E(panelId);
    if (!managed) return null;
    const buffer = managed.terminal.buffer.active;
    return {
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      isUserScrolledBack: managed.isUserScrolledBack,
    };
  };

  Object.assign(window, {
    __daintreeGetTerminalScrollState: (panelId: string): TerminalScrollSnapshotForE2E | null =>
      readTerminalScrollSnapshotForE2E(panelId),
    __daintreeScrollTerminalLines: (
      panelId: string,
      lines: number
    ): TerminalScrollSnapshotForE2E | null => {
      const managed = terminalInstanceService.getInstanceForE2E(panelId);
      if (!managed || !Number.isFinite(lines)) return null;
      managed.terminal.scrollLines(Math.trunc(lines));
      return readTerminalScrollSnapshotForE2E(panelId);
    },
  });

  // Test-only: drive the frontend tier directly so E2E specs can reproduce
  // the BACKGROUND→active transition without depending on full panel-location
  // moves. Accepts the canonical tier names ("FOCUSED", "BURST", "VISIBLE",
  // "AMBIENT", "BACKGROUND").
  (window as unknown as Record<string, unknown>).__daintreeApplyTerminalTier = (
    panelId: string,
    tierName: string
  ): boolean => {
    const tier = (TerminalRefreshTier as unknown as Record<string, TerminalRefreshTier>)[tierName];
    if (typeof tier !== "number") return false;
    if (!terminalInstanceService.getInstanceForE2E(panelId)) return false;
    terminalInstanceService.applyRendererPolicy(panelId, tier);
    return true;
  };

  // Test-only: invoke TerminalResizeController.resize() directly so E2E specs
  // can simulate a ResizeObserver firing on a backgrounded terminal without
  // having to actually mutate window or container geometry (which would also
  // disturb every other panel).
  (window as unknown as Record<string, unknown>).__daintreeSimulateTerminalResize = (
    panelId: string,
    width: number,
    height: number
  ): { cols: number; rows: number } | null => {
    if (!terminalInstanceService.getInstanceForE2E(panelId)) return null;
    return terminalInstanceService.resize(panelId, width, height);
  };

  (window as unknown as Record<string, unknown>).__daintreeTriggerTerminalLink = (
    panelId: string,
    url: string
  ): string => {
    const managed = terminalInstanceService.getInstanceForE2E(panelId);
    if (!managed) return "missing-panel";
    const mac = isMac();
    const syntheticEvent = new MouseEvent("click", {
      metaKey: mac,
      ctrlKey: !mac,
    });
    terminalInstanceService["linkHandler"].openLink(url, panelId, syntheticEvent);
    return "ok";
  };

  // Test-only WebGL leak-regression bridges (#9540). Attached via Object.assign
  // (not a window cast) so they don't add to the no-unsafe-type-assertion lint
  // ratchet. All are harmless in production and reach private state only for the
  // nightly memory-leak suite.
  Object.assign(window, {
    // Introspect WebGL pool state so the regression can assert the "wants" set
    // and active context return to baseline after a terminal close/hibernate.
    __daintreeGetTerminalWebGLState: (
      panelId: string
    ): { wantsSize: number; active: boolean; mode: string; hibernated: boolean } | null => {
      const webGLManager = terminalInstanceService["webGLManager"] as TerminalWebGLManager;
      if (!webGLManager) return null;
      return {
        wantsSize: webGLManager.getWantsSize(),
        active: webGLManager.isActive(panelId),
        mode: webGLManager.getMode(),
        hibernated: terminalInstanceService.isHibernated(panelId),
      };
    },
    // Promote a plain terminal to an agent terminal on a WebGL-eligible
    // (FOCUSED) tier so the WebGL addon actually attaches. Mirrors the
    // production parser-detected promotion path without a real agent process.
    __daintreePromoteTerminalToAgentForE2E: (panelId: string, agentId: string): boolean => {
      if (!terminalInstanceService.getInstanceForE2E(panelId)) return false;
      terminalInstanceService.applyRendererPolicy(panelId, TerminalRefreshTier.FOCUSED);
      terminalInstanceService.applyAgentPromotion(panelId, agentId);
      return (terminalInstanceService["webGLManager"] as TerminalWebGLManager).isActive(panelId);
    },
    // Hibernate a terminal (the path that calls terminal.dispose()) so the leak
    // test can exercise the hibernate teardown without waiting on agent-
    // completion heuristics. Returns the resulting state.
    __daintreeHibernateTerminalForE2E: (panelId: string): boolean => {
      if (!terminalInstanceService.getInstanceForE2E(panelId)) return false;
      terminalInstanceService.hibernate(panelId);
      return terminalInstanceService.isHibernated(panelId);
    },
  });
}

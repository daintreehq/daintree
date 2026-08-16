import { Terminal, IBufferRange } from "@xterm/xterm";
import { isMac } from "@/lib/platform";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import type { AgentState } from "@/types";
import {
  ManagedTerminal,
  RefreshTierProvider,
  AgentStateCallback,
  PostCompleteHook,
  TerminalLink,
  TerminalResyncOptions,
} from "./types";
import { tallyScrollbackRestoreStates } from "./scrollbackRestoreAggregate";
import {
  setupTerminalAddons,
  createImageAddon,
  createFileLinksAddon,
  createImageLinksAddon,
  createWebLinksAddon,
} from "./TerminalAddonManager";
import { TerminalOutputIngestService } from "./TerminalOutputIngestService";
import { TerminalParserHandler } from "./TerminalParserHandler";
import { TerminalUnseenOutputTracker, UnseenOutputSnapshot } from "./TerminalUnseenOutputTracker";
import { TerminalOffscreenManager } from "./TerminalOffscreenManager";
import { TerminalLinkHandler } from "./TerminalLinkHandler";
import { TerminalResizeController, hasStreamingWrites } from "./TerminalResizeController";
import { TerminalRendererPolicy } from "./TerminalRendererPolicy";
import { TerminalWebGLManager } from "./TerminalWebGLManager";
import { TerminalWebGLPolicy } from "./TerminalWebGLPolicy";
import { TerminalRevealController } from "./TerminalRevealController";
import { TerminalAgentStateController } from "./TerminalAgentStateController";
import { TerminalRestoreController } from "./TerminalRestoreController";
import {
  TerminalReflowController,
  attemptRendererUnpause,
  forceXtermReflow,
  forceXtermRendererUnpause,
  resetRendererUnpauseBreaker,
} from "./TerminalReflowController";
import { TerminalReconciliationWatchdog } from "./TerminalReconciliationWatchdog";
import { TerminalWriteController } from "./TerminalWriteController";
import { TerminalSettleWaiterRegistry } from "./TerminalSettleWaiterRegistry";
import { TerminalBurstController } from "./TerminalBurstController";
import { TerminalResizePassScheduler } from "./TerminalResizePassScheduler";
import { reportFileLinkFailure } from "./FileLinksAddon";
import {
  installTerminalBoundListeners,
  type TerminalListenerInstallDeps,
} from "./TerminalListenerInstaller";
import { reduceScrollback, restoreScrollback } from "./TerminalScrollbackController";
import { hasUsableRenderer } from "./xtermRendererProbe";
import { DEFAULT_TERMINAL_FONT_FAMILY, onTerminalFontArrivedLate } from "@/config/terminalFont";
import { isPtyPanel } from "@shared/types/panel";
import { isValidTerminalGeometry, type TerminalGeometry } from "@shared/types/terminal";
import type { TerminalResizeResult } from "@shared/types/pty-host";
import { applyXtermReflowFastpath } from "@shared/utils/xtermReflowFastpath";
import { usePanelStore } from "@/store/panelStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { logDebug, logWarn, logError } from "@/utils/logger";
import { getErrorMessage } from "@/utils/errorContext";
import { PaintFabricCompositor } from "./paintFabric/PaintFabricCompositor";
import type { PaintSurface } from "./paintFabric/PaintSurfaceRegistry";
import { createRoundRobinPlacement } from "./paintFabric/placementPolicies";
import {
  isPaintFabricEnabled,
  getPaintFabricSurfaceCount,
  paintFabricAuxSurfaceId,
  PRIMARY_SURFACE_ID,
} from "./paintFabric/paintFabricConfig";
import { TerminalWorkerIngestController } from "./TerminalWorkerIngestController";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";
import { stripAnsiAndOscCodes } from "@shared/utils/urlUtils";

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

export { isNonKeyboardInput } from "./inputUtils";
// Re-exported so existing consumers (notably tests) that import
// `forceXtermReflow` from this module don't need to update their imports.
export { forceXtermReflow };

function canAutoInitializeTerminalIngest(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.electron?.terminal?.getSharedBuffers === "function"
  );
}

class TerminalInstanceService {
  private instances = new Map<string, ManagedTerminal>();
  // In-flight creations keyed by id: concurrent getOrCreate(id) share ONE build
  // so a single id can never wire two terminalClient.onData subscriptions (see
  // getOrCreate).
  private creating = new Map<string, Promise<ManagedTerminal>>();
  // Ids destroyed WHILE a creation was in flight. createManagedTerminal consumes
  // this after its async addon load and aborts, so a panel torn down mid-build
  // never publishes a stale instance/onData listener for a dead id.
  private cancelledCreations = new Set<string>();
  private dataBuffer = new TerminalOutputIngestService(
    (id, data, chunkCount) => this.writeToTerminal(id, data, chunkCount),
    () => usePanelStore.getState().focusedId,
    // Background drains are held both during an active wheel gesture and while
    // a keystroke echo is in flight — the same "focused feel beats background
    // throughput" contract, applied to the two sustained interactions.
    // Participants (every actively-wheeled terminal — plural, so concurrently
    // scrolled TUIs never hold each other — and the echo-pending terminal)
    // drain inline like the focused pane.
    () =>
      this.burstController.hasActiveWheelGesture() ||
      this.burstController.getEchoPendingHoldId() !== null,
    (id) =>
      this.burstController.isWheelActive(id) || this.burstController.getEchoPendingHoldId() === id
  );
  private suppressedExitUntil = new Map<string, number>();
  private unseenTracker = new TerminalUnseenOutputTracker();
  private scrollbackRestoreListeners = new Set<() => void>();
  private cwdProviders = new Map<string, () => string>();
  private offscreenManager = new TerminalOffscreenManager();
  private linkHandler = new TerminalLinkHandler();
  private cachedSelections = new Map<string, string>();
  private resizeController: TerminalResizeController;
  private rendererPolicy: TerminalRendererPolicy;
  private webGLPolicy: TerminalWebGLPolicy;
  private webGLManager = new TerminalWebGLManager();
  // Coalesces "why am I slow?" diagnostics pushes (#10910): multiple tier/create/
  // destroy events in one turn collapse to a single main-process report.
  private whySlowReportScheduled = false;
  private agentStateController: TerminalAgentStateController;
  private restoreController: TerminalRestoreController;
  private reflowController: TerminalReflowController;
  private reconciliationWatchdog: TerminalReconciliationWatchdog;
  private writeController: TerminalWriteController;
  private settleWaiters: TerminalSettleWaiterRegistry;
  private burstController: TerminalBurstController;
  private resizePassScheduler: TerminalResizePassScheduler;
  private workerIngestController: TerminalWorkerIngestController;
  private revealController: TerminalRevealController;
  private unsubTierChanged: (() => void) | null = null;
  private unsubResizeResult: (() => void) | null = null;

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

    this.settleWaiters = new TerminalSettleWaiterRegistry({
      getInstance: (id) => this.instances.get(id),
      triggerDeferredVisibilityWake: (id) => {
        void this.fullWakeForVisibilityRestore(id).catch((error) => {
          logWarn(`deferred fullWakeForVisibilityRestore failed for ${id}`, {
            error,
          });
        });
      },
    });

    this.restoreController = new TerminalRestoreController({
      getInstance: (id) => this.instances.get(id),
      writeData: (id, data, chunkCount) => this.writeToTerminal(id, data, chunkCount),
    });

    this.burstController = new TerminalBurstController({
      getInstance: (id) => this.instances.get(id),
      applyRendererPolicy: (id, tier) => this.rendererPolicy.applyRendererPolicy(id, tier),
    });

    this.resizePassScheduler = new TerminalResizePassScheduler({
      getInstance: (id) => this.instances.get(id),
      isResizeLocked: (id) => this.resizeController.isResizeLocked(id),
      resize: (id, width, height) => this.resizeController.resize(id, width, height),
    });

    this.workerIngestController = new TerminalWorkerIngestController({
      getInstance: (id) => this.instances.get(id),
      getQueuedBytes: (id) => this.dataBuffer.getQueuedBytes(id),
      resumeFlush: (id) => this.dataBuffer.resumeFlush(id),
      incrementUnseen: (id, isScrolledBack) =>
        this.unseenTracker.incrementUnseen(id, isScrolledBack),
      fetchAndRestore: (id) => this.restoreController.fetchAndRestore(id),
    });

    this.writeController = new TerminalWriteController({
      getInstance: (id) => this.instances.get(id),
      acknowledgePortData: (id, bytes, chunkCount) =>
        terminalClient.acknowledgePortData(id, bytes, chunkCount),
      acknowledgeData: (id, bytes) => terminalClient.acknowledgeData(id, bytes),
      notifyWriteComplete: (id, bytes) => this.dataBuffer.notifyWriteComplete(id, bytes),
      incrementUnseen: (id, isScrolledBack) =>
        this.unseenTracker.incrementUnseen(id, isScrolledBack),
      onWrite: (id) => this.burstController.onPtyWrite(id),
    });

    this.reflowController = new TerminalReflowController({
      getInstances: () => this.instances.values(),
    });

    this.webGLPolicy = new TerminalWebGLPolicy({
      getMode: () => this.webGLManager.getMode(),
      getPinnedId: () => this.webGLManager.getPinnedId(),
      isAltBufferPinned: (id) => this.webGLManager.isAltBufferPinned(id),
    });

    this.rendererPolicy = new TerminalRendererPolicy({
      getInstance: (id) => this.instances.get(id),
      onPostWake: (id) => this.handlePostWake(id),
      onResumeFlush: (id) => this.dataBuffer.resumeFlush(id),
      applyDeferredResize: (id) => this.resizeController.applyDeferredResize(id),
      onTierApplied: (id, tier, managed) => {
        // A backgrounded pane stays fully live in the renderer — it keeps full
        // scrollback, keeps its image/link addons, and is never suspended. The
        // one deliberate carve-out is the WebGL context, released below.
        if (tier === TerminalRefreshTier.BACKGROUND) {
          // Clear the resize dedup cache so the first ResizeObserver
          // observation after the terminal returns to an active tier is
          // processed, even if the pixel width/height match the values
          // recorded before the background transition. Without this reset,
          // a container that resized while hidden (e.g. window resize during
          // bulk worktree activity) can dedup-suppress the corrective resize
          // that re-syncs xterm and the PTY on wake (issue #7741).
          managed.lastWidth = 0;
          managed.lastHeight = 0;
        } else {
          // Tier upgrade path: clear the reduce cooldown so restoreScrollback
          // is unconditional and the next BACKGROUND drop isn't artificially
          // delayed by stale state from a long-completed reduce.
          managed.lastScrollbackReduceAt = undefined;
          restoreScrollback(managed);

          void this.ensureDeferredAddons(id, managed);
        }

        if (this.webGLPolicy.wantsWebGLAtTier(managed, tier)) {
          this.webGLManager.ensureContext(id, managed);
        } else if (managed.webGLHideTimer === undefined && !managed.isVisible) {
          // Standard and agent terminals are treated identically now (#11193):
          // both keep WebGL while visible — releasing causes a one-frame renderer
          // gap, and VISIBLE is an eligible tier for both. Release only happens
          // once a pane is off-screen (an ineligible tier while still visible,
          // e.g. a visible-BACKGROUND handoff, retains the live context until the
          // hide path releases it). No refresh on release: the pane is off-screen
          // here, and repainting an offscreen DOM produces a stale frame that
          // flashes on next show (#6802). Tier demotion is an authoritative
          // signal — cancel any pending hide-dwell and release. The webGLHideTimer
          // guard keeps the dwell window intact for a hidden terminal still
          // streaming at BURST: wantsWebGLAtTier returns false for off-screen
          // panes (#10671), so without it the next write's tier-apply would
          // release on frame 1 instead of after WEBGL_HIDE_DWELL_MS — defeating
          // the hide→show anti-churn dwell. Once the dwell timer fires (or never
          // armed), the guard is undefined and the release proceeds.
          this.cancelWebGLHideTimer(managed);
          this.webGLManager.releaseContext(id);
        }

        // Cursor blink is policy-driven: plain terminals run the blink timer
        // only at FOCUSED/BURST, agent terminals never. Centralised in the
        // service helper so updateOptions/applyAgentPromotion/getOrCreate all
        // reach the same answer.
        this.applyCursorBlinkPolicy(managed);

        // Tier changes shift the counts-by-tier distribution (and can flip WebGL
        // mode via the release path above) — push a fresh diagnostics sample.
        this.scheduleWhySlowReport();

        this.workerIngestController.applyWorkerIngestPolicy(id, tier, managed);
      },
    });

    this.revealController = new TerminalRevealController({
      getInstance: (id) => this.instances.get(id),
      hostHasRenderableDims: (managed) => this.hostHasRenderableDims(managed),
      ensureOpened: (id, managed) => this.ensureOpened(id, managed),
      handlePostWake: (id) => this.handlePostWake(id),
      deferGridChangeForStream: (managed, gridWouldChange) =>
        this.deferGridChangeForStream(managed, gridWouldChange),
      applyRendererPolicy: (id, tier) => this.rendererPolicy.applyRendererPolicy(id, tier),
      applyDeferredResize: (id) => this.resizeController.applyDeferredResize(id),
      lockResize: (id, locked, customTtlMs) =>
        customTtlMs === undefined
          ? this.resizeController.lockResize(id, locked)
          : this.resizeController.lockResize(id, locked, customTtlMs),
      reconcileGeometryFresh: (id) => this.resizeController.reconcileGeometryFresh(id),
      resumeFlush: (id) => this.dataBuffer.resumeFlush(id),
      checkStaleDirecting: (id) => this.agentStateController.checkStaleDirecting(id),
      shouldRestoreWebGL: (managed, opts) => this.webGLPolicy.shouldRestoreWebGL(managed, opts),
      isWebGLActive: (id) => this.webGLManager.isActive(id),
      ensureWebGL: (id, managed) => this.webGLManager.ensureContext(id, managed),
      releaseWebGL: (id) => this.webGLManager.releaseContext(id),
      repairAtlasForReactivation: (id) => this.webGLManager.repairAtlasForReactivation(id),
      cancelWebGLHideTimer: (managed) => this.cancelWebGLHideTimer(managed),
    });

    // Constructed last — its deps reach every other controller. The watchdog
    // self-starts (interval + visibilitychange + pointerdown diagnostic) and
    // is torn down in dispose().
    this.reconciliationWatchdog = new TerminalReconciliationWatchdog({
      getInstances: () => this.instances.entries(),
      setVisible: (id) => this.setVisible(id, true),
      applyRendererPolicy: (id, tier) => this.rendererPolicy.applyRendererPolicy(id, tier),
      reassertActiveBackendTier: (id) => this.rendererPolicy.reassertActiveTier(id),
      getBackendTier: (id) => this.rendererPolicy.getLastBackendTier(id),
      getStalledBytes: (id) => this.dataBuffer.getStalledBytes(id),
      getQueuedBytes: (id) => this.dataBuffer.getQueuedBytes(id),
      resumeFlush: (id) => this.dataBuffer.resumeFlush(id),
      // Wake/resync machinery was removed (terminals stay fully live in the
      // background), so a wake is never in flight or pending — the watchdog's
      // stalled-byte flush guard is therefore never blocked by one.
      hasInFlightWake: () => false,
      hasPendingWake: () => false,
      isResizeTransitioning: (id) =>
        this.resizeController.isResizeLocked(id) ||
        this.resizeController.hasPendingResize(id) ||
        this.resizePassScheduler.isResizePending(id),
      isWebGLActive: (id) => this.webGLManager.isActive(id),
      shouldHaveWebGL: (managed) => this.webGLPolicy.shouldHaveActiveWebGL(managed),
      ensureWebGL: (id, managed) => this.webGLManager.ensureContext(id, managed),
      reconcileRevealGeometry: (id) => this.reconcileRevealGeometry(id),
      isStoreBackgrounded: (id) => usePanelStore.getState().backgroundedTerminals.has(id),
      isStoreHidden: (id) => usePanelStore.getState().panelsById[id]?.isVisible === false,
      repairStoreVisibility: (id) => usePanelStore.getState().updateVisibility(id, true),
    });

    // If JetBrains Mono loads after the startup timeout already opened terminals
    // against the fallback stack, repair every live grid once it arrives (#9776).
    // The service is a page-lifetime singleton, so the unsubscribe is intentionally
    // discarded — the subscription is one-shot and never needs teardown.
    onTerminalFontArrivedLate(() => this.repairFontGrid());
  }

  // Reconcile our renderer-side dedupe baseline when the PTY host rewrites a
  // terminal's tier on its own (window connect/disconnect/project switch).
  // initializeBackendTier updates lastBackendTier without echoing back to the
  // host, so a later applyRendererPolicy correctly re-sends "active" instead of
  // dedupe-dropping it and leaving the pane frozen (issue #9778, the same-tier
  // no-op re-arm trap from #8998). Installed lazily on first terminal creation
  // — the same point onData/onExit are wired — so merely constructing the
  // singleton never reaches into terminalClient (keeps it out of the hot import
  // graph for unrelated component tests).
  private ensureHostTierSubscription(): void {
    if (this.unsubTierChanged) return;
    this.unsubTierChanged = terminalClient.onTierChanged((id, tier) => {
      this.rendererPolicy.initializeBackendTier(id, tier);
    });
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
   * Builds the deps surface consumed by `installTerminalBoundListeners`. The
   * create path (`getOrCreate`) installs the terminal-bound listener set by
   * passing this through, so adding a new terminal-bound listener is a
   * one-edit operation in `TerminalListenerInstaller.ts`.
   */
  private makeListenerInstallDeps(): TerminalListenerInstallDeps {
    return {
      onBufferModeChange: (id, isAltBuffer) => this.handleBufferModeChange(id, isAltBuffer),
      isWebGLActive: (id) => this.webGLManager.isActive(id),
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
      onActiveWheel: (id) => this.burstController.onActiveWheel(id),
      onUserScrollIntent: (id) => this.burstController.onUserScrollIntent(id),
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
   * Returns the resolved absolute path of the currently-hovered link when it's
   * a file or directory link (not a URL / OSC 8 link), else null. Used by the
   * right-click context menu to show a "Reveal in Finder" item only for
   * genuine on-disk paths — revealing works identically for both kinds.
   * Distinct from {@link getHoveredLinkText}, which returns the raw matched
   * text for any link kind.
   */
  getHoveredFilePath(id: string): string | null {
    const link = this.instances.get(id)?.hoveredLink;
    return link?.kind === "file" || link?.kind === "directory" ? (link.absolutePath ?? null) : null;
  }

  /**
   * Which of the two on-disk kinds {@link getHoveredFilePath} matched, or null
   * when no path is hovered. Reveal treats them identically, but the file
   * browser doesn't: a directory is expanded as well as selected, so the menu
   * has to pass the kind through rather than guessing (#11483).
   */
  getHoveredFileKind(id: string): "file" | "directory" | null {
    const link = this.instances.get(id)?.hoveredLink;
    return link?.kind === "file" || link?.kind === "directory" ? link.kind : null;
  }

  /**
   * Opens the currently-hovered link by delegating to its own activate()
   * method. File links route through the actionService (file.view); URL and
   * OSC 8 links route through TerminalLinkHandler (localhost → browser panel
   * when modifier pressed, external open otherwise).
   *
   * Async defensively: today's `FileLink.activate` returns void and owns
   * its own `.then/.catch` (so the leaf-level notify() fires there), but
   * a future `ILink` implementation may return a Promise — a sync
   * try/catch would silently drop that rejection, so we wrap with await
   * to keep the contract future-proof (#9925).
   */
  async openHoveredLink(id: string, event?: MouseEvent): Promise<void> {
    const managed = this.instances.get(id);
    const link = managed?.hoveredLink;
    if (!link) return;
    const mouseEvent = event ?? new MouseEvent("click");
    try {
      await Promise.resolve(link.activate(mouseEvent, link.text));
    } catch (error) {
      reportFileLinkFailure("Failed to activate hovered link", error, link.text);
    }
  }

  /**
   * Builds a synthetic ILink for WebLinksAddon and OSC 8 link sources (which
   * don't expose an ILink natively). activate() routes through the link
   * handler so localhost URLs hit the browser-panel path when needed.
   */
  private makeSyntheticLink(
    text: string,
    range: IBufferRange | null,
    terminalId: string
  ): TerminalLink {
    return {
      kind: "url",
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

  private onUserInput(id: string, data: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    this.rendererPolicy.applyRendererPolicy(id, TerminalRefreshTier.BURST);
    this.burstController.onEchoPendingInput(id);

    // A paused-backpressure pane shows a "Paused" pill; typing should refresh
    // it promptly. Fire a wake() repaint, mirroring the focus path — the held
    // backpressure token auto-resumes on the flow-control path (the live
    // renderer drains and acks bytes → host acknowledge-data → tryResume).
    // Skip backgrounded terminals (the #9906 guard). Read the panel snapshot
    // once so the fields can't diverge. resource-governor pauses are
    // intentionally excluded — only the backpressure family auto-resumes on
    // drain, so a repaint there would not release the hold (#10669).
    const panelState = usePanelStore.getState();
    const panel = panelState.panelsById[id];
    if (
      panel &&
      isPtyPanel(panel) &&
      panel.flowStatus === "paused-backpressure" &&
      !panelState.backgroundedTerminals.has(id)
    ) {
      this.wake(id);
    }

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

  private onEnterPressed(id: string): void {
    this.agentStateController.onEnterPressed(id);
  }

  clearDirectingState(id: string): void {
    this.agentStateController.clearDirectingState(id);
  }

  async prewarmTerminal(
    id: string,
    launchAgentId: string | undefined,
    options: ConstructorParameters<typeof Terminal>[0],
    params: { offscreen?: boolean; widthPx?: number; heightPx?: number } = {}
  ): Promise<ManagedTerminal> {
    const managed = await this.getOrCreate(
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
  private writeToTerminal(id: string, data: string | Uint8Array, chunkCount = 1): void {
    this.writeController.write(id, data, chunkCount);
  }

  setVisible(id: string, isVisible: boolean, expectedGeneration?: number): void {
    this.revealController.setVisible(id, isVisible, expectedGeneration);
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

    // Dead-man fallback that outlives the timer-driven unlock below. The +150
    // margin (vs the +100 it covered before) spans XtermAdapter's ~50ms
    // ResizeObserver debounce plus its rAF: an observer entry queued a frame
    // before the transition settles fires its resize() ~50ms later, which must
    // still land inside the lock window — otherwise it slips through as a
    // post-transition SIGWINCH (#10693).
    const safetyTtl = durationMs + 150;
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
      this.resizeController.lockResize(id, true, durationMs);

      instance.resizeSuppressionTimer = window.setTimeout(() => {
        // Re-fetch: the instance can be disposed/replaced between arming and
        // firing. Working off the live map (not the closed-over ref) also lets
        // the closure drop its `instance` capture for GC.
        const current = this.instances.get(id);
        if (!current) return;
        current.isResizeSuppressed = false;
        current.resizeSuppressionEndTime = undefined;
        current.resizeSuppressionTimer = undefined;
        this.resizeController.lockResize(id, false);
        // Guaranteed post-switch redraw. The reveal repaint and its rAF
        // backstops all fire INSIDE this suppression window, where the renderer
        // can still be mid-settle and a stale `isVisible` can no-op the
        // visibility-guarded reveal path. Now that suppression and the resize
        // lock are gone and the reconciliation watchdog (which skips suppressed
        // terminals) re-engages, run the exact recovery a user gets by clicking
        // "Redraw": resetRenderer has no isVisible guard and its fit() is no
        // longer lock-gated, so it corrects both a stale grid (garbled wrapping)
        // and a paused/garbled renderer.
        //
        // Rule #1 (#10632): the obligation must be PRESERVED whenever the redraw
        // did NOT actually run — not just when the host is detached. On a dwell
        // longer than the suppression window this timer fires while the outgoing
        // view is still non-renderable (detached, occluded zero box,
        // content-visibility:hidden, or a transitional sub-50px box), where
        // resetRenderer self-skips and the one-shot recovery would be SILENTLY
        // SPENT. resetRenderer now reports whether it ran; if it didn't (host
        // not foreground-renderable, OR renderable but below its >=50px floor),
        // hand the obligation to the reconciliation watchdog, which runs the
        // closed-loop repair once DOM geometry proves the pane on-screen. Owned
        // by the current attachGeneration so a later re-attach can supersede it.
        const ran = this.hostHasRenderableDims(current) ? this.resetRenderer(id) : false;
        if (!ran) {
          current.revealPendingRepair = true;
          current.revealPendingGeneration = current.attachGeneration;
        }
      }, durationMs);
    });
  }

  /**
   * One process-wide listener for PTY resize echoes, armed on the first
   * terminal rather than in the constructor: the service is built at module
   * scope, where `window.electron` does not exist yet under Node test
   * environments.
   */
  private ensureResizeResultSubscription(): void {
    if (this.unsubResizeResult) return;
    this.unsubResizeResult = terminalClient.onResizeResult((id, result) => {
      this.recordPtyResizeResult(id, result);
    });
  }

  /**
   * Store the geometry the PTY reports holding. A new PTY incarnation retires
   * the previous one's divergence history — the counter describes one live
   * backend process, not the pane.
   */
  private recordPtyResizeResult(id: string, result: TerminalResizeResult): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    if (managed.ptyGeometryDivergenceGeneration !== result.launchGeneration) {
      managed.ptyGeometryDivergenceGeneration = result.launchGeneration ?? undefined;
      managed.ptyGeometryDivergenceCount = 0;
      managed.ptyGeometryDivergenceSignature = undefined;
    }
    managed.lastPtyResizeResult = result;
  }

  /**
   * Drop the echo when the backend that produced it is gone. The renderer keeps
   * resizing a pane whose PTY has exited (or whose host has crashed) and no new
   * echo can arrive to correct the record, so the watchdog would otherwise
   * compare a dead process's geometry against a live xterm grid and blame the
   * split on a PTY that no longer exists — precisely when the log is the
   * diagnostic surface. Unknown geometry, not stale geometry.
   */
  private clearPtyGeometryEcho(managed: ManagedTerminal): void {
    managed.lastPtyResizeResult = undefined;
    managed.ptyGeometryDivergenceSignature = undefined;
  }

  /**
   * Every live pane loses its geometry echo when the pty-host dies: no PTY
   * survives the crash, and the recovered host re-spawns under fresh launch
   * generations. Called on the crash, not on recovery — the renderer keeps
   * resizing panes for the whole outage, which is the window the stale echo
   * would be misread in.
   */
  handleBackendCrash(): void {
    this.instances.forEach((managed) => this.clearPtyGeometryEcho(managed));
  }

  setTargetSize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id);
    if (!instance) return;

    // Shared ceiling, not a local 500: a restored pane that legitimately
    // exceeds it must not silently keep the previous target and boot the PTY at
    // a geometry xterm never adopts (#11641).
    if (isValidTerminalGeometry({ cols, rows })) {
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

  wake(id: string): boolean {
    return this.revealController.wake(id);
  }

  wakeForFocus(id: string): void {
    this.revealController.wakeForFocus(id);
  }

  fullWakeForVisibilityRestore(id: string): Promise<void> {
    return this.revealController.fullWakeForVisibilityRestore(id);
  }

  repaintForReveal(id: string, opts?: { trustDomVisibility?: boolean }): boolean {
    return this.revealController.repaintForReveal(id, opts);
  }

  reconcileRevealGeometry(id: string): boolean {
    return this.revealController.reconcileRevealGeometry(id);
  }

  revealTerminal(id: string): Promise<boolean> {
    return this.revealController.revealTerminal(id);
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
    if (!managed) return;
    managed.terminal.write(`\x18\x1b]57301;${droppedBytes};backpressure\x07`);
  }

  /**
   * Draw the user-visible yellow data-loss marker. Deferred via
   * `queueMicrotask` because it is reached from inside the OSC 57301 parse
   * callback — calling `terminal.write` synchronously during parsing would be
   * reentrant. Re-checks instance state because the terminal can be destroyed
   * between the OSC write and this microtask.
   */
  private drawDataLossMarker(id: string, droppedBytes: number): void {
    queueMicrotask(() => {
      const managed = this.instances.get(id);
      if (!managed) return;
      const label = droppedBytes > 0 ? `~${droppedBytes} bytes` : "output";
      managed.terminal.write(`\r\n\x1b[33m⚠ Output dropped (${label})\x1b[0m\r\n`);
    });
  }

  async getOrCreate(
    id: string,
    launchAgentId: string | undefined,
    options: ConstructorParameters<typeof Terminal>[0],
    getRefreshTier: RefreshTierProvider = () => TerminalRefreshTier.FOCUSED,
    onInput?: (data: string) => void,
    getCwd?: () => string
  ): Promise<ManagedTerminal> {
    const existing = this.instances.get(id);
    if (existing) {
      this.refreshManagedFromCreateArgs(
        existing,
        launchAgentId,
        options,
        getRefreshTier,
        onInput,
        getCwd
      );
      return existing;
    }

    // In-flight creation guard (the assistant double-render). #10840 made
    // setupTerminalAddons async, so getOrCreate now awaits between the
    // instances.get() guard above and the instances.set() in
    // createManagedTerminal — a window in which a SECOND concurrent
    // getOrCreate(id) for the same id (the overlay's prewarmTerminal racing the
    // XtermAdapter mount, both firing on "+"/new-session once the panel chunk is
    // warm) also sees an empty map, builds its own Terminal, and wires its OWN
    // terminalClient.onData(id) listener. The pty-host then fans every live
    // chunk out to BOTH listeners, which buffer it under the same id — so all
    // output is written TWICE into the one visible xterm (duplicated banner,
    // messages, composer). Share a single creation per id: a concurrent caller
    // awaits the in-flight build and re-applies its own args to the shared
    // instance instead of constructing a second one.
    const inFlight = this.creating.get(id);
    if (inFlight) {
      const managed = await inFlight;
      this.refreshManagedFromCreateArgs(
        managed,
        launchAgentId,
        options,
        getRefreshTier,
        onInput,
        getCwd
      );
      return managed;
    }

    const createPromise = this.createManagedTerminal(
      id,
      launchAgentId,
      options,
      getRefreshTier,
      onInput,
      getCwd
    );
    this.creating.set(id, createPromise);
    try {
      return await createPromise;
    } finally {
      this.creating.delete(id);
    }
  }

  // Re-apply the per-call providers/options a getOrCreate caller supplied to an
  // already-built instance. Used by both the existing-instance fast path and the
  // in-flight-await path so a concurrent caller's getRefreshTier/onInput/cwd/
  // options still take effect on the shared instance.
  private refreshManagedFromCreateArgs(
    managed: ManagedTerminal,
    launchAgentId: string | undefined,
    options: ConstructorParameters<typeof Terminal>[0],
    getRefreshTier: RefreshTierProvider,
    onInput: ((data: string) => void) | undefined,
    getCwd: (() => string) | undefined
  ): void {
    managed.getRefreshTier = getRefreshTier;
    managed.onInput = onInput;
    if (getCwd) {
      this.cwdProviders.set(managed.id, getCwd);
    }
    if (options) {
      this.updateOptions(managed.id, options);
    }
    if (launchAgentId !== undefined) {
      managed.terminal.options.cursorBlink = false;
    }
  }

  private async createManagedTerminal(
    id: string,
    launchAgentId: string | undefined,
    options: ConstructorParameters<typeof Terminal>[0],
    getRefreshTier: RefreshTierProvider,
    onInput: ((data: string) => void) | undefined,
    getCwd: (() => string) | undefined
  ): Promise<ManagedTerminal> {
    const terminalOptions = {
      ...options,
      rescaleOverlappingGlyphs: true,
      linkHandler: this.makeTerminalLinkHandler(id),
    };

    if (launchAgentId !== undefined) {
      terminalOptions.cursorBlink = false;
    }

    const terminal = new Terminal(terminalOptions);
    applyXtermReflowFastpath(terminal);
    this.cwdProviders.set(id, getCwd ?? (() => ""));
    // Only the eager core addons are built here. Image/file-link/web-link addons
    // are deferred to ensureDeferredAddons(), called once the terminal is opened
    // in attach() — keeping their construction off the bulk-create cold path.
    // Awaited so Unicode11 (lazy-loaded, #10840) is active before the PTY data
    // listener is wired below — terminalClient.onData flushes any buffered early
    // output synchronously on registration, so the activation must land first.
    const addons = await setupTerminalAddons(terminal);

    // Destroyed mid-build: destroy(id) ran while this create was suspended on the
    // async addon load, so the id it targeted no longer has a home. Tear down the
    // half-built terminal and abort BEFORE wiring terminalClient.onData or
    // publishing to `instances` — otherwise a torn-down id gets a live listener
    // and a ghost instance the app can't see to clean up. The waiting getOrCreate
    // caller's rejection is handled by prewarmTerminal/XtermAdapter (both
    // catch+log; there is nothing to attach to a removed panel).
    if (this.cancelledCreations.delete(id)) {
      terminal.dispose();
      throw new Error(`Terminal ${id} creation cancelled: destroyed before build completed`);
    }

    const hostElement = document.createElement("div");
    hostElement.style.width = "100%";
    hostElement.style.height = "100%";
    hostElement.style.overflow = "hidden";
    hostElement.style.position = "relative";

    const listeners: Array<() => void> = [];
    const exitSubscribers = new Set<(exitCode: number) => void>();
    const agentStateSubscribers = new Set<AgentStateCallback>();

    // Wire the host→renderer tier reconciliation on first terminal creation.
    this.ensureHostTierSubscription();

    const unsubData = terminalClient.onData(id, (data: string | Uint8Array) => {
      this.burstController.onEchoData(id);
      if (this.dataBuffer.isPolling()) return;
      // Worker-ingest diversion (issue #10960): while a terminal is in (or
      // transitioning through) worker mode, main-thread chunks route into the
      // controller — it acks them immediately and lands them on the mirror
      // through the session's zero-loss buffering, never through the write
      // controller.
      const ingest = this.workerIngestController.getIngest(id);
      if (ingest?.shouldDivert()) {
        ingest.feedDiverted(data);
        return;
      }
      this.dataBuffer.bufferData(id, data);
    });
    listeners.push(unsubData);

    const unsubExit = terminalClient.onExit((termId, exitCode) => {
      if (termId !== id) return;
      const current = this.instances.get(id);
      // Ahead of the suppression gate: the PTY is gone either way, and a
      // suppressed exit (trash/restore churn) is exactly the case where the pane
      // outlives its backend long enough for the stale echo to be compared.
      if (current) {
        this.clearPtyGeometryEcho(current);
      }
      if (this.shouldSuppressExit(id)) {
        return;
      }
      if (current) {
        current.terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
      }
      exitSubscribers.forEach((cb) => cb(exitCode));
    });
    listeners.push(unsubExit);

    const kind = "terminal" as const;

    const managed: ManagedTerminal = {
      id,
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
      restoreWindowToken: 0,
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
    this.ensureResizeResultSubscription();

    const initialTier = getRefreshTier ? getRefreshTier() : TerminalRefreshTier.FOCUSED;
    this.rendererPolicy.applyRendererPolicy(id, initialTier);

    // For terminals starting at BACKGROUND tier, keep lastAppliedTier so a later
    // promotion is seen as an upgrade (this also keeps WebGL released until
    // foreground — the one visibility-gated optimization we retain).
    //
    // EXPERIMENT (hibernation removal, Codex review fix — Finding 3): a
    // cold-created hidden pane stays fully content-live like every other
    // background pane. Two changes vs. the old suppress-then-resync model:
    //   1. Seed the backend tier as ACTIVE/live (not "background"). Nothing
    //      holds bytes anymore (host streams live, ingest parses live), so the
    //      old "drain held bytes on the first BACKGROUND→active transition"
    //      rationale is void; seeding live also avoids arming needsWake.
    //   2. Do NOT dispose the Image / file-link / image-link / web-link addons.
    //      They are content features, rebuilt by ensureDeferredAddons on open
    //      either way; tearing them down here degraded a pane that never went
    //      through a suspend. See docs/HIBERNATION-REMOVAL-EXPERIMENT.md.
    if (initialTier === TerminalRefreshTier.BACKGROUND) {
      managed.lastAppliedTier = TerminalRefreshTier.BACKGROUND;
      this.rendererPolicy.initializeBackendTier(id, "active");
    }

    // The first applyRendererPolicy call is a no-op when the requested tier
    // matches lastAppliedTier (or the live getRefreshTier()), so onTierApplied
    // does not fire and the cursorBlink policy is not enforced. Apply it once
    // here for any non-FOCUSED/BURST initial tier (VISIBLE prewarms in a
    // non-focused split, or BACKGROUND prewarms in a non-focused tab).
    this.applyCursorBlinkPolicy(managed);

    this.settleWaiters.notifyReadinessWaiters(id);

    this.scheduleWhySlowReport();

    return managed;
  }

  get(id: string): ManagedTerminal | null {
    return this.instances.get(id) ?? null;
  }

  /**
   * Coalesce a "why am I slow?" diagnostics push (#10910). Terminal create,
   * destroy, and tier changes each nudge this; the actual report is deferred to a
   * microtask so a burst (e.g. a fleet broadcast opening many panes) sends one
   * sample, not one per pane.
   */
  private scheduleWhySlowReport(): void {
    if (this.whySlowReportScheduled) return;
    this.whySlowReportScheduled = true;
    queueMicrotask(() => {
      this.whySlowReportScheduled = false;
      this.reportWhySlowDiagnostics();
    });
  }

  /**
   * Push this renderer's terminal WebGL mode + counts-by-refresh-tier to the
   * main-process diagnostics cache. Best-effort: never throw into terminal
   * lifecycle, and no-op when the preload binding is unavailable (tests).
   */
  private reportWhySlowDiagnostics(): void {
    try {
      const report = window.electron?.system?.reportTerminalRendererDiagnostics;
      if (typeof report !== "function") return;
      const countsByTier: Record<string, number> = {};
      for (const managed of this.instances.values()) {
        const tier =
          managed.lastAppliedTier ?? managed.getRefreshTier?.() ?? TerminalRefreshTier.BACKGROUND;
        const key = TerminalRefreshTier[tier] ?? String(tier);
        countsByTier[key] = (countsByTier[key] ?? 0) + 1;
      }
      void report({
        webglMode: this.webGLManager.getMode(),
        wantsWebgl: this.webGLManager.getWantsSize(),
        terminalCount: this.instances.size,
        countsByTier,
      }).catch(() => {
        // Diagnostics push is fire-and-forget; a dropped sample is harmless.
      });
    } catch {
      // Never let best-effort diagnostics disrupt terminal lifecycle.
    }
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

  /**
   * Per-surface WebGL pool snapshot for the E2E leak-regression bridges. Lives
   * on the paint-plane surface (rather than a bracket-notation reach into the
   * private `webGLManager`) so a fabric routes the read to the surface that
   * owns the terminal — `wantsSize`/`mode` describe that surface's pool, which
   * is the meaningful scope once each surface has its own 16-context budget.
   */
  getWebGLStateForE2E(id: string): { wantsSize: number; active: boolean; mode: string } {
    return {
      wantsSize: this.webGLManager.getWantsSize(),
      active: this.webGLManager.isActive(id),
      mode: this.webGLManager.getMode(),
    };
  }

  /**
   * E2E-only link activation. Same rationale as {@link getWebGLStateForE2E}:
   * the link handler is per-surface state, so the bridge must route through
   * the paint plane instead of reaching into the primary surface's private
   * field — a terminal owned by another surface has its links there.
   */
  triggerTerminalLinkForE2E(id: string, url: string, event?: MouseEvent): void {
    this.linkHandler.openLink(url, id, event);
  }

  getCachedSelection(id: string): string {
    return this.cachedSelections.get(id) ?? "";
  }

  waitForInstance(id: string, options: { timeoutMs?: number } = {}): Promise<void> {
    return this.settleWaiters.waitForInstance(id, options);
  }

  waitForAttachSettled(id: string, options: { timeoutMs?: number } = {}): Promise<void> {
    return this.settleWaiters.waitForAttachSettled(id, options);
  }

  /**
   * Resolves once a terminal is *fully* settled — both visually attached and
   * past its scrollback-restore lifecycle. Unlike {@link waitForAttachSettled},
   * which only gates on visual attach, this waits for the restore state
   * machine to leave its in-flux states.
   *
   * A restore failure still settles the wait (the terminal is usable, just
   * without restored scrollback); callers that care about success vs. silent
   * failure inspect `lastScrollbackRestoreError` after the wait resolves.
   *
   * Precondition: call this only after restore has had a chance to be
   * scheduled (state moved to `"pending"`). A brand-new terminal whose restore
   * has not yet been queued reads as settled because its state is still
   * `"none"` — there is nothing to wait for from this method's view.
   */
  waitForFullySettled(id: string, options: { timeoutMs?: number } = {}): Promise<void> {
    return this.settleWaiters.waitForFullySettled(id, options);
  }

  /**
   * Batch variant of {@link waitForFullySettled}: resolves once every panel in
   * `ids` is fully settled, governed by a single shared timeout. On timeout the
   * rejection names the still-pending panels. If a panel is destroyed mid-wait
   * its per-panel waiter rejects, which fails the whole batch — this is a
   * startup correctness gate, so a missing panel is a hard failure, not a
   * silent partial success (hence `Promise.all`, not `allSettled`).
   */
  waitForAllFullySettled(ids: string[], options: { timeoutMs?: number } = {}): Promise<void> {
    return this.settleWaiters.waitForAllFullySettled(ids, options);
  }

  /**
   * Scheduler-facing hook: the scrollback restore scheduler calls this after
   * each terminal restore state transition (success, failure, or bail) so
   * fully-settled waiters can re-check the predicate. Public because the
   * scheduler lives in a sibling module and already calls into this singleton.
   */
  notifyRestoreSettledWaiters(id: string): void {
    this.settleWaiters.notifyRestoreSettledWaiters(id);
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

  /**
   * Builds the tier-managed, non-critical addons (Image DCS handlers, file-link
   * and web-link providers) that `setupTerminalAddons` deliberately skips on the
   * bulk-create cold path. Idempotent — each addon is only created when its slot
   * is null, so this is safe to call from both the cold-open path in `attach()`
   * and the BACKGROUND→active tier-upgrade path. Never call it for a BACKGROUND
   * terminal; the tier machinery disposes these addons there on purpose (#9809).
   */
  private async ensureDeferredAddons(id: string, managed: ManagedTerminal): Promise<void> {
    // The file/image/web link providers are synchronous, so build them first and
    // unconditionally — the lazy, async ImageAddon load below must not defer them
    // behind a microtask (they are observable synchronously on tier upgrade).
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
        logWarn("Failed to create FileLinksAddon", { id, error: err });
      }
    }
    // `[image #N]` references are clickable only in the assistant terminal,
    // where the help session owns the figure state (#9830). Gating on the
    // bound help terminal keeps grid terminals that happen to print the token
    // inert, and the provider rebuilds with the rest on tier promotion.
    if (!managed.imageLinksDisposable && useHelpPanelStore.getState().terminalId === id) {
      try {
        managed.imageLinksDisposable = createImageLinksAddon(
          managed.terminal,
          () => useHelpPanelStore.getState().figures.map((f) => f.figureNumber),
          (figureNumber, openLightbox) => {
            useHelpPanelStore.getState().setActiveFigureNumber(figureNumber);
            // Lightbox open on modified-click lands with the figure rail
            // (#9829); the highlight is the interim affordance until then.
            void openLightbox;
          }
        );
      } catch (err) {
        logWarn("Failed to create ImageLinksAddon", { id, error: err });
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
        logWarn("Failed to create WebLinksAddon", { id, error: err });
      }
    }
    // ImageAddon is lazy-loaded (#10840), so creation is async and runs last —
    // after the synchronous link providers above. Two callers can reach this
    // concurrently (the cold-open path in ensureOpened() and the BACKGROUND→
    // active tier-upgrade path), so re-check the slot after the await and dispose
    // the loser to avoid loading two addons onto one terminal.
    // ImageAddon is the one deferred addon that must NOT be built against a
    // terminal without a live renderer (#11776). Its ImageRenderer constructor
    // monkey-patches `_core.open` with a wrapper that unconditionally reads
    // `_core._renderService.setRenderer`, and that wrapper runs even on xterm's
    // silent early-return path. Installed on a never-opened terminal — which
    // `onTierApplied` does on any non-BACKGROUND tier — it converts a single
    // failed open into a permanent, self-re-throwing wedge: every subsequent
    // open() attempt dies in the patch instead of rebuilding the renderer.
    // Deferring it until the terminal actually paints keeps the thrower out of
    // open() entirely; the tier-upgrade path rebuilds it once the pane opens.
    if (!managed.imageAddon && managed.isOpened && hasUsableRenderer(managed.terminal)) {
      // Captured before the await: a rebuild swaps `managed.terminal` while
      // keeping the same ManagedTerminal, so the instances-map check below
      // cannot see it. Without this, an import that resolves after a rebuild
      // would load the old terminal's addon onto the new one.
      const builtFor = managed.terminal;
      try {
        const imageAddon = await createImageAddon(managed.terminal);
        // Dispose the loser rather than leak it if, during the async import, a
        // concurrent caller already populated the slot OR the terminal was
        // destroyed/replaced (its instance is no longer the one in the map, so
        // its own teardown will never dispose this addon), OR this terminal was
        // rebuilt out from under us.
        if (
          managed.imageAddon ||
          this.instances.get(id) !== managed ||
          managed.terminal !== builtFor
        ) {
          imageAddon.dispose();
        } else {
          managed.imageAddon = imageAddon;
        }
      } catch (err) {
        logWarn("Failed to create ImageAddon", { id, error: err });
      }
    }
  }

  /**
   * Open xterm against its host element — the first-paint step that builds the
   * DOM, forces a reflow to measure the cell grid, and inits the renderer.
   * Idempotent (no-op once `isOpened`). Extracted from {@link attach} so the
   * foreground reveal-hydration path can re-open a terminal whose occluded warm
   * wake could not (the host had no measurable layout box behind the anti-flash
   * bridge) using the exact same sequence — never a divergent second open path.
   *
   * The caller owns the precondition that the host is measurable: `attach()`
   * runs from the mount/reparent effect where layout is settled, and
   * {@link fullWakeForVisibilityRestore} gates this behind
   * {@link hostHasRenderableDims}. Opening against a zero-sized host would have
   * xterm measure a 0/NaN cell and build a broken grid.
   */
  private ensureOpened(id: string, managed: ManagedTerminal): void {
    if (managed.isOpened) return;
    // Seed xterm's grid before open() so cold-start restore paints at the
    // saved size instead of flashing 80x24 then snapping (#6983). Routed
    // through the resize controller rather than xterm directly so it honours
    // the serialized-restore gate: a cross-surface rebuild can have a replay
    // already in flight here, and resizing out from under it would both undo
    // the capture-width alignment and make the parked width look live (#11552).
    if (managed.targetCols && managed.targetRows) {
      this.resizeController.resizeTerminal(managed, managed.targetCols, managed.targetRows);
    }
    // terminalOpenStartedAt anchors the first-write delta (#9809).
    managed.terminalOpenStartedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    managed.hasEmittedFirstWriteMark = false;
    markRendererPerformance(PERF_MARKS.TERMINAL_OPEN_START, { terminalId: id });
    // Was try/finally (#11776). A throw out of open() propagated all the way to
    // XtermAdapter's IIFE catch, which aborted the REST of attach — the exit
    // listener and the scrollback restore never registered — and surfaced
    // nowhere but a console line. Classify the failure here instead: the caller
    // gets a terminal that is honestly "not opened", and the recovery path
    // below owns getting it painting again.
    let openError: unknown;
    try {
      managed.terminal.open(managed.hostElement);
    } catch (err) {
      openError = err;
    } finally {
      markRendererPerformance(PERF_MARKS.TERMINAL_OPEN_END, { terminalId: id });
    }

    // A clean return is not proof of success. On an already-poisoned instance
    // xterm's re-entry guard early-returns *silently* (no throw) while
    // `_renderService` stays undefined, so trusting the absence of an
    // exception is exactly how `isOpened` ends up true on a pane that can
    // never paint. Verify the renderer actually exists before claiming it.
    if (openError === undefined && !hasUsableRenderer(managed.terminal)) {
      openError = new Error(
        "xterm.open() returned without building a renderer (terminal is unpaintable)"
      );
    }

    if (openError !== undefined) {
      this.handleFailedOpen(id, managed, openError);
      return;
    }

    managed.isOpened = true;
    this.clearAttachError(id, managed);
    logDebug(`[TIS] Opened terminal ${id}`);
    // Build the deferred Image/link addons now that the terminal is live.
    // EXPERIMENT (hibernation removal, Codex review fix — Finding 3): build them
    // unconditionally, even for a pane opened at BACKGROUND tier. Background
    // panes stay fully content-live; only the WebGL context differs by
    // visibility (gated separately below). Previously this skipped the addons on
    // background, degrading content for hidden panes.
    void this.ensureDeferredAddons(id, managed);
    if (this.webGLPolicy.wantsWebGLAtTier(managed, managed.lastAppliedTier)) {
      this.webGLManager.ensureContext(id, managed);
    }
  }

  /**
   * The xterm `linkHandler` option, keyed by terminal id. Shared by the
   * creation path and the #11776 rebuild so a replacement terminal links
   * exactly like the one it replaces — the handlers close over `id` and read
   * the live instance, never a captured `ManagedTerminal`, so they stay correct
   * across a swap.
   */
  private makeTerminalLinkHandler(id: string) {
    const setHoveredLink = (link: TerminalLink | null) => {
      const current = this.instances.get(id);
      if (!current) return;
      current.hoveredLink = link;
    };

    return {
      activate: (event: MouseEvent, text: string) => this.linkHandler.openLink(text, id, event),
      hover: (_event: MouseEvent, text: string, range: IBufferRange) => {
        setHoveredLink(this.makeSyntheticLink(text, range, id));
      },
      leave: () => setHoveredLink(null),
    };
  }

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
      linkHandler: this.makeTerminalLinkHandler(managed.id),
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
  private handleFailedOpen(id: string, managed: ManagedTerminal, error: unknown): void {
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
    if (this.instances.get(id) !== managed) return;
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
  private clearAttachError(id: string, managed: ManagedTerminal): void {
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
    const managed = this.instances.get(id);
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
      if (this.instances.get(id) !== managed) return false;
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
    if (!this.hostHasRenderableDims(managed)) {
      logDebug(`[TIS] Deferring rebuild of ${id} — host has no renderable box yet`);
      return "deferred";
    }

    // Before anything is torn down: an undrainable buffer means we must not
    // dispose at all (see drainWritesBeforeDispose).
    if (!(await this.drainWritesBeforeDispose(id, managed))) return "deferred";
    // Destroyed while draining.
    if (this.instances.get(id) !== managed) return "failed";

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
      if (this.instances.get(id) !== managed) {
        terminal.dispose();
        return "failed";
      }
      Object.assign(managed, addons);
      managed.terminal = terminal;
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
      () => this.resizeController.applyDeferredResize(id),
      (droppedBytes) => this.drawDataLossMarker(id, droppedBytes)
    );
    installTerminalBoundListeners(terminal, managed, id, this.makeListenerInstallDeps());

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
    this.workerIngestController.rebindTerminal(id, managed);

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

    this.ensureOpened(id, managed);
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

    this.workerIngestController.reseedMirrorGeometry(id, managed);

    this.rendererPolicy.applyRendererPolicy(
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
    this.resizeController.fit(id);

    // Repopulate from the headless mirror. The disposed instance's buffer went
    // with it, and it never painted anything the user saw anyway, so this is
    // the scrollback — not a nicety.
    try {
      await this.restoreController.fetchAndRestore(id);
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
    this.settleWaiters.notifyAttachSettledWaiters(id);

    logDebug(`[TIS] Rebuilt terminal ${id}`);
    return "rebuilt";
  }

  /**
   * Terminal-scoped teardown for {@link rebuildTerminalInstance} — the subset
   * of `destroy()` that belongs to the xterm instance rather than to the pane.
   */
  private teardownTerminalForRebuild(id: string, managed: ManagedTerminal): void {
    this.cancelAttachReveal(managed);
    this.resizeController.clearResizeJob(managed);
    this.resizeController.clearSettledTimer(id);
    this.writeController.forget(id);
    this.cancelWebGLHideTimer(managed);
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
    for (const [label, disposable] of [
      ["image addon", managed.imageAddon],
      ["file links", managed.fileLinksDisposable],
      ["image links", managed.imageLinksDisposable],
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
    managed.webLinksAddon = null;

    // Before dispose: the manager holds pool/lease references to this exact
    // Terminal, and releasing them afterwards would touch a dead object.
    this.webGLManager.onTerminalDestroyed(id);

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

  /**
   * Whether the host element currently has a real, measurable layout box —
   * the precondition for {@link ensureOpened}. A detached/occluded project
   * view (cached `WebContentsView` behind the anti-flash bridge) can report a
   * zero box; only a foreground-presented view is safe to open/measure against.
   */
  private hostHasRenderableDims(managed: ManagedTerminal): boolean {
    const el = managed.hostElement;
    if (!el || !el.isConnected) return false;
    // A visibility:hidden / content-visibility:hidden host keeps a nonzero
    // layout box but must not be opened or measured against — mirror the
    // checkVisibility() gate the resize controller's fit() already uses.
    // Guarded for availability: not every DOM impl exposes checkVisibility.
    if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return false;
    return el.clientWidth > 0 && el.clientHeight > 0;
  }

  attach(id: string, container: HTMLElement): ManagedTerminal | null {
    const managed = this.instances.get(id);
    if (!managed) {
      logDebug(`[TIS.attach] No managed instance for ${id}`);
      return null;
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

    this.ensureOpened(id, managed);
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
          this.webGLPolicy.shouldRestoreWebGL(managed)
        ) {
          this.webGLManager.ensureContext(id, managed);
        }

        if (!managed.terminal.element) {
          managed.hostElement.style.opacity = "";
          this.settleWaiters.notifyAttachSettledWaiters(id);
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
            this.settleWaiters.notifyAttachSettledWaiters(id);
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
              this.settleWaiters.notifyAttachSettledWaiters(id);
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
          this.settleWaiters.notifyAttachSettledWaiters(id);
        });
      });
    } else {
      managed.isAttaching = false;
      this.settleWaiters.notifyAttachSettledWaiters(id);
    }

    return managed;
  }

  getAttachGeneration(id: string): number {
    return this.instances.get(id)?.attachGeneration ?? 0;
  }

  detach(id: string, container: HTMLElement | null): void {
    const managed = this.instances.get(id);
    if (!managed || !container) {
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

    // Seed the warm-attach target dims from the last measured geometry (#10070).
    // Background-tier resizes only update latestCols/latestRows, never
    // targetCols/targetRows, so a terminal that was only ever resized while
    // backgrounded reattaches with no saved targets — the synchronous
    // warm-attach resize (and the cold-seed before open()) is skipped and the
    // grid flashes 80x24. Backfill here, at the lifecycle boundary where we
    // know the terminal is about to be reattached warm, only when targets are
    // unset and the measured size is real.
    if (!managed.targetCols && managed.latestCols > 0) {
      managed.targetCols = managed.latestCols;
      managed.targetRows = managed.latestRows;
    }

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
   * Cancel all pending panel resize work *without* applying it. Used on
   * optimistic close: `flushResize` would force-drain queued output and reflow
   * scrollback synchronously inside the close click, but stale debounce, idle,
   * or settled work must not fire after detach or trash restore.
   */
  cancelPendingResize(id: string): void {
    this.resizeController.cancelPendingResize(id);
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

  private backgroundResizeSession: {
    basis: { width: number; height: number };
    origin: Map<string, { width: number; height: number }>;
  } | null = null;

  /**
   * Window-ratio resize for a backgrounded project view (#10415). A detached
   * WebContentsView keeps its stale viewport until reattach — setBounds()
   * does not propagate while detached and ResizeObservers never fire in a
   * hidden page — so per-panel pixel sizes cannot be re-measured here.
   * Instead each terminal's host size is scaled by the window-bounds ratio,
   * which is exact for 1fr grid tracks and at worst off by ~1 col where
   * fixed chrome doesn't scale. `applyBackgroundResize` moves xterm and the
   * PTY together, so agents wrap at the right width the whole time and the
   * parser never trails the grid the app is drawing for; alt-screen panes are
   * excluded and both grids stay at their pre-background size. By reattach
   * the wake path's `applyDeferredResize` therefore finds cache == current and
   * early-returns; only `reconcileGeometryFresh` on reveal corrects the
   * residual error between the scaled estimate and real layout.
   *
   * Scaling is anchored to a per-background-session snapshot: the basis is
   * the stale viewport (which all `lastWidth`/`lastHeight` measurements were
   * laid out against) and each terminal's origin size is captured the first
   * time it's seen. Every event computes absolute targets from that anchor,
   * so repeated resizes never compound and a terminal skipped in one pass
   * (resize-locked) still lands on the correct size in the next.
   *
   * Gated on `isProjectViewCached()` as well as page visibility (#11443).
   * Caching a project view is `removeChildView` + `setVisible(false)`, and
   * neither flips `document.visibilityState` for a child WebContentsView, so
   * the original visibility-only guard early-returned for every genuinely
   * backgrounded view — the one case this method exists to serve. The reset
   * stays on the "not cached AND visible" branch: a cached view that still
   * reports "visible" must keep its session anchor, not drop it.
   */
  applyBackgroundWindowResize(width: number, height: number): void {
    if (!isProjectViewCached() && document.visibilityState === "visible") {
      // Queued delivery after reactivation — real layout owns geometry again.
      this.backgroundResizeSession = null;
      return;
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return;
    }
    const session = (this.backgroundResizeSession ??= {
      basis: { width: window.innerWidth, height: window.innerHeight },
      origin: new Map(),
    });
    if (session.basis.width <= 0 || session.basis.height <= 0) return;
    const widthRatio = width / session.basis.width;
    const heightRatio = height / session.basis.height;
    for (const [id, managed] of this.instances) {
      if (!managed.isOpened) continue;
      // Never resize a live alt-screen TUI from here (#11443) — see the choke
      // point in `applyBackgroundResize`. Skipping before the origin capture
      // also keeps the anchor keyed to first eligibility, so a pane that leaves
      // the alternate screen mid-session still scales from its pre-background
      // size rather than a partially-applied one.
      if (managed.isAltBuffer) continue;
      let origin = session.origin.get(id);
      if (!origin) {
        if (managed.lastWidth <= 0 || managed.lastHeight <= 0) continue;
        origin = { width: managed.lastWidth, height: managed.lastHeight };
        session.origin.set(id, origin);
      }
      this.resizeController.applyBackgroundResize(
        id,
        origin.width * widthRatio,
        origin.height * heightRatio
      );
    }
  }

  resetBackgroundResizeBasis(): void {
    this.backgroundResizeSession = null;
  }

  /**
   * Coalesced batch resize for a burst of grid open/close events — runs on
   * the next frame once the burst settles. See
   * {@link TerminalResizePassScheduler.scheduleBatchResize}.
   */
  scheduleBatchResize(ids: string[]): void {
    this.resizePassScheduler.scheduleBatchResize(ids);
  }

  /**
   * Chunked, cancellable resize pass across a set of panels — see
   * {@link TerminalResizePassScheduler.runResizePass}.
   */
  runResizePass(ids: string[]): void {
    this.resizePassScheduler.runResizePass(ids);
  }

  /**
   * Abort any in-flight chunked resize pass without starting a new one — see
   * {@link TerminalResizePassScheduler.cancelActiveResizePass}.
   */
  cancelActiveResizePass(): void {
    this.resizePassScheduler.cancelActiveResizePass();
  }

  scrollToBottom(id: string): void {
    const managed = this.instances.get(id);
    if (managed) {
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
    if (!managed) return;

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

  // Hibernation no longer occurs (terminals stay fully live in the
  // background). Retained as a no-op so `useIsHibernated` and other direct
  // callers (e.g. useAccessibilityAnnouncements) keep a stable
  // useSyncExternalStore contract against the always-false `isHibernated`
  // snapshot below — the listener is never notified.
  subscribeHibernation(_id: string, _listener: () => void): () => void {
    return () => {};
  }

  /**
   * Subscribe to batch scrollback-restore state changes. The scheduler
   * (`scrollbackRestoreScheduler`) drives every `scrollbackRestoreState`
   * transition and calls `notifyScrollbackRestoreListeners` after each, so
   * the grid-level `BatchScrollbackRestoreBar` can reflect progress without
   * polling. Listeners are batch-scoped (no per-id keying) — the aggregate
   * counts span every managed terminal. Returns an unsubscribe cleanup.
   */
  subscribeScrollbackRestoreState(listener: () => void): () => void {
    this.scrollbackRestoreListeners.add(listener);
    return () => {
      this.scrollbackRestoreListeners.delete(listener);
    };
  }

  notifyScrollbackRestoreListeners(): void {
    for (const listener of this.scrollbackRestoreListeners) {
      try {
        listener();
      } catch (error) {
        logWarn("Scrollback restore listener error", { error });
      }
    }
  }

  // Three primitive accessors rather than one object snapshot: useSyncExternalStore
  // re-renders whenever getSnapshot returns a new reference, so each subscriber
  // reads a stable `number`. The instance map is small, so re-tallying per
  // accessor is cheap and avoids snapshot-caching invalidation bugs.
  getScrollbackRestorePendingCount(): number {
    return this.tallyScrollbackRestore().pendingCount;
  }

  getScrollbackRestoreInProgressCount(): number {
    return this.tallyScrollbackRestore().inProgressCount;
  }

  getScrollbackRestoreTotalCount(): number {
    return this.tallyScrollbackRestore().totalCount;
  }

  private tallyScrollbackRestore() {
    const states: ManagedTerminal["scrollbackRestoreState"][] = [];
    for (const managed of this.instances.values()) {
      states.push(managed.scrollbackRestoreState);
    }
    return tallyScrollbackRestoreStates(states);
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

    // Alt-screen panes stay current from the live PTY stream, so skip
    // fit()/sendPtyResize/maybeReflow on reveal: for an unchanged window they
    // are same-size host no-ops, and a real reflow of a live alt frame is the
    // out-of-band hazard #10632 / #10805 guard against. Genuine size changes
    // are handled by the ResizeObserver-driven applyResize path.
    if (managed.isAltBuffer) return;

    // Re-measure container dimensions after wake so latestCols/latestRows
    // reflect the current window size rather than pre-hibernation cache.
    // fit() already guards against offscreen/small terminals (returns null).
    //
    // EXCEPT when the fit would CHANGE the grid of a still-streaming pane
    // (#10863's wake-path half — same predicate as fullWakeForVisibilityRestore
    // and reconcileGeometryFresh): fit() re-wraps committed scrollback under a
    // CLI mid-paint — the assistant's boot splash is the canonical victim.
    // Defer to the reconciliation watchdog via the reveal-pending obligation;
    // a no-drift fit falls through (its resize is a no-op and the PTY
    // re-assert is dedupe-safe). Alt-buffer panes never reach here.
    if (this.deferGridChangeForStream(managed, this.proposalDivergesFromGrid(managed))) {
      // Deferred to the watchdog — skip the fit.
    } else {
      const fitResult = this.resizeController.fit(id);
      if (!fitResult) {
        // Fallback: fit() returned null (terminal offscreen, too small, or
        // resize-locked). PTY-only and lock-aware — it never re-wraps xterm or
        // bypasses an in-flight layout transition.
        this.resizeController.forceImmediateResize(id);
      }
    }

    if (this.resizeController.hasPendingResize(id)) {
      managed.lastReflowAt = 0;
      return;
    }

    // Kick the IO unpause path for standard terminals that just woke up —
    // without this, a renderer that was paused pre-hibernation can stay
    // blank until the next write or the 3s heartbeat. Throttle is cleared
    // first so this runs unconditionally.
    managed.lastReflowAt = 0;
    this.maybeReflowTerminal(managed);
  }

  private handleBufferModeChange(id: string, isAltBuffer: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    // Keep alt-buffer TUIs on WebGL through a fleet DOM-mode flip — WebGL has
    // no fractional-cell-height seam, so this is the primary fix for the DOM
    // renderer "zebra" banding on HiDPI displays (#10768). The manager treats
    // an alt-buffer pin like the focus pin: one retained context in DOM mode,
    // a no-op in WebGL mode and when GPU hardware is unavailable.
    if (isAltBuffer) {
      this.webGLManager.pinAltBuffer(id, managed);
    } else {
      this.webGLManager.unpinAltBuffer(id);
    }

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
    if (!managed) return "";

    const buf = managed.terminal.buffer.active;
    if (buf.length === 0) return "";

    // Tail-scan: collect lines from the bottom up, widening the window in
    // doubling rounds until the *stripped* (visible) length reaches maxChars or
    // the buffer is exhausted. Keying the stop condition on stripped length —
    // not raw length — keeps the result identical to the old full-buffer scan
    // even on escape-dense agent output, where stripping can shrink the text
    // well below a fixed raw margin. Typical output settles in one round; the
    // worst case (all escape codes) is bounded by the old full-scan cost.
    const tail: string[] = []; // bottom-up; reversed to forward order before join
    let rawLen = 0;
    let i = buf.length - 1;
    let budget = maxChars * 2;
    for (;;) {
      while (i >= 0 && rawLen < budget) {
        const line = buf.getLine(i);
        i--;
        if (!line) continue;
        const s = line.translateToString(true);
        tail.push(s);
        rawLen += s.length + 1; // +1 for the "\n" separator
      }
      const text = stripAnsiAndOscCodes([...tail].reverse().join("\n"));
      if (text.length >= maxChars) return text.slice(-maxChars);
      if (i < 0) return text; // whole buffer consumed, still under budget
      budget *= 2;
    }
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
    // Track the focused terminal in the WebGL manager: when the count-based
    // mode switch has the fleet on the DOM renderer, the pin keeps exactly
    // one context on the pane the user is reading. Focus is tracked here
    // (not in onTierApplied) because same-tier focus moves dedup away the
    // tier application.
    if (isFocused) {
      this.webGLManager.pinFocus(id, managed);
    }
  }

  isFocused(id: string): boolean {
    return this.instances.get(id)?.isFocused === true;
  }

  focus(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

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

  /**
   * True when the container proposes a grid DIFFERENT from the live xterm grid
   * — i.e. a fit() here would actually re-wrap the buffer, not just re-assert.
   * Shared divergence probe for the out-of-band geometry writers below.
   */
  private proposalDivergesFromGrid(managed: ManagedTerminal): boolean {
    const proposal = managed.fitAddon?.proposeDimensions?.();
    return (
      proposal !== undefined &&
      proposal.cols > 1 &&
      proposal.rows > 1 &&
      (proposal.cols !== managed.terminal.cols || proposal.rows !== managed.terminal.rows)
    );
  }

  /**
   * #10863's out-of-band-geometry guard, shared by every wake/reveal-path
   * geometry writer (fullWakeForVisibilityRestore, handlePostWake,
   * resetRenderer): a fit/deferred-resize that would CHANGE the grid of a
   * still-streaming main-buffer pane re-wraps committed scrollback under the
   * CLI's cursor-relative repaint — the assistant boot corruption. When that
   * hazard is live this arms the reveal-pending obligation (the watchdog's
   * reveal branch runs the fresh atomic reconcile once the stream quiesces)
   * and returns true so the caller skips its geometry step. The
   * ResizeObserver-driven applyResize path is NOT gated here — user-visible
   * layout changes must keep flowing to the PTY.
   *
   * An explicitly-forced `resetRenderer` (#11638) does not consult this at all
   * — it takes {@link forceGeometryResync} instead. The hazard this guards is
   * the AUTOMATIC out-of-band re-wrap; a user who pressed Redraw has already
   * decided the pane is broken.
   */
  private deferGridChangeForStream(managed: ManagedTerminal, gridWouldChange: boolean): boolean {
    if (!gridWouldChange || managed.isAltBuffer || !hasStreamingWrites(managed, Date.now())) {
      return false;
    }
    managed.revealPendingRepair = true;
    managed.revealPendingGeneration = managed.attachGeneration;
    return true;
  }

  /**
   * The explicit-Redraw geometry step (#11638). Runs INSTEAD of the guarded
   * `fit()` below, never in addition to it: `reconcileGeometryFresh` is
   * lock-exempt, measures fresh from the live DOM box, and moves xterm and the
   * PTY together in one synchronous step — `fit()` would re-introduce the
   * resize lock and, for a settled-strategy agent, split the two grids across
   * ~500ms. There is deliberately no `fit()` fallback when this returns false:
   * every reason it can fail (occluded host, sub-50px box, no cell metrics) is
   * a reason `fit()` would fail too.
   */
  private forceGeometryResync(id: string, managed: ManagedTerminal): void {
    if (!this.resizeController.reconcileGeometryFresh(id, { force: true })) {
      // Unmeasurable/transitional box — hand the obligation to the watchdog
      // exactly as the suppression-clear path does, so a pane that becomes
      // measurable later still converges.
      managed.revealPendingRepair = true;
      managed.revealPendingGeneration = managed.attachGeneration;
      return;
    }

    // Deliberately does NOT clear `revealPendingRepair`. That flag is
    // multiplexed: the reveal controller also arms it when an open DEC 2026
    // synchronized-output block forced it to defer the atlas repair / refresh /
    // unpause (TerminalRevealController, #10632), which a geometry step does
    // not discharge. Clearing it here to save the watchdog one near-no-op tick
    // would drop that unrelated obligation on the floor and leave the pane
    // stale until the next click or heartbeat. The redundant tick is cheap;
    // the lost repair is not.

    // Re-arm the geometry circuit breaker only on DEMONSTRATED main-buffer
    // convergence. reconcileGeometryFresh's boolean is measurability, not
    // convergence: an alt-buffer pane returns true without touching geometry,
    // and `resizeTerminal` parks the xterm resize during a serialized restore.
    // Comparing the live grid against the geometry just measured is the only
    // real signal, and it mirrors what the watchdog's converged branch does.
    if (
      !managed.isAltBuffer &&
      managed.terminal.cols === managed.latestCols &&
      managed.terminal.rows === managed.latestRows
    ) {
      managed.geometryRepairAttempts = 0;
      managed.geometryRepairGaveUp = false;
      managed.geometryRepairGeneration = managed.attachGeneration;
    }
  }

  /**
   * Recover a terminal's renderer the way the manual "Redraw" action does.
   * Returns whether the repair ACTUALLY ran: false when it self-skipped on its
   * own guards (gone/hibernated/disconnected/sub-50px box). Callers that must
   * guarantee a redraw (the project-switch suppression-clear, #10632) use the
   * return value to know whether the obligation still needs to be carried — a
   * geometry sub-step that could not converge does NOT flip it, since the
   * renderer repair itself still ran.
   *
   * `options.force` (#11638) marks an explicit user Redraw and takes the
   * ungated atomic geometry path; every automatic caller omits it and keeps
   * #10863's streaming deferral.
   */
  resetRenderer(id: string, options: TerminalResyncOptions = {}): boolean {
    const managed = this.instances.get(id);
    if (!managed) return false;

    try {
      if (!managed.hostElement.isConnected) {
        logDebug(`resetRenderer skipped for ${id}: not connected`);
        return false;
      }
      if (managed.hostElement.clientWidth < 50 || managed.hostElement.clientHeight < 50) {
        logDebug(
          `resetRenderer skipped for ${id}: too small (${managed.hostElement.clientWidth}x${managed.hostElement.clientHeight})`
        );
        return false;
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

      // The geometry step. Two exclusive branches (#11638):
      //
      // force — an explicit user Redraw. Runs the lock-exempt atomic reconcile
      // unconditionally. The stream gate below can never open for a busy agent
      // (Claude Code repaints several times a second, so `lastWriteAt` is never
      // 300ms stale), and the watchdog backstop the gate defers to tests the
      // same predicate — so without this branch the ONLY step that can correct
      // a wrong grid is dead on exactly the panes Redraw exists for.
      //
      // default — every automatic caller (handleBackendRecovery, the
      // project-switch suppression clear, the post-drag reparent). Same #10863
      // guard as handlePostWake: never fit-rewrap a streaming main-buffer pane.
      // The suppression-clear timer that drives this on project switch-back
      // lands exactly in the assistant's cold-resume boot window; the
      // atlas/refresh recovery above already ran, and the armed watchdog
      // obligation converges the grid once the stream quiesces.
      if (options.force) {
        try {
          this.forceGeometryResync(id, managed);
        } catch (error) {
          logError(`resetRenderer forced resync failed for ${id}`, error);
          // Same obligation the unmeasurable-box branch arms: a throw is no
          // more converged than a false, and dropping it here would leave the
          // pane with no path back to a correct grid.
          managed.revealPendingRepair = true;
          managed.revealPendingGeneration = managed.attachGeneration;
        }
      } else if (!this.deferGridChangeForStream(managed, this.proposalDivergesFromGrid(managed))) {
        try {
          this.resizeController.fit(id);
        } catch (error) {
          logError(`resetRenderer fit failed for ${id}`, error);
        }
      }
    } catch (error) {
      logError(`resetRenderer failed for ${id}`, error);
    }

    // Resume a renderer stuck at _isPaused=true so the pane actually redraws.
    // Runs independently of the refresh/fit block so the user-invokable escape
    // hatch works even when fit() throws. Clear the throttle so any follow-up
    // automatic repair (onWriteParsed, heartbeat, focus) fires immediately.
    const termEl = managed.terminal.element;
    if (termEl) {
      try {
        // The layout flush the reveal/wake sequences rely on. It cannot unpause
        // anything on its own (#11800) — the real repair is below.
        forceXtermReflow(termEl);
      } catch (error) {
        logWarn(`forceXtermReflow failed for ${id}`, { error });
      }
      if (options.force) {
        // A PERSON asked for this — the same foreground gate #11638 uses below.
        // Their explicit "this pane is broken" signal re-arms the breaker, so a
        // latch accrued by autonomous sweeps can't make the manual escape hatch
        // a no-op. One user-initiated attempt can't become a retry loop.
        resetRendererUnpauseBreaker(managed);
        forceXtermRendererUnpause(managed.terminal);
      } else {
        // Automatic callers — backend recovery, the project-switch reveal, and
        // the post-drag repair — stay inside the shared cap. Re-arming for them
        // would clear the latch on a timer and hand the periodic sweeps a fresh
        // budget forever, which is the loop this whole change removes.
        attemptRendererUnpause(managed);
      }
      managed.lastReflowAt = 0;
    }
    return true;
  }

  handleBackendRecovery(): void {
    this.instances.forEach((managed, id) => {
      try {
        managed.terminal.write("\x1b[!p");

        this.resetRenderer(id);

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

    Object.entries(options).forEach(([key, value]) => {
      // @ts-expect-error xterm options are indexable
      managed.terminal.options[key] = value;
    });
    // Theme/font/etc. updates flow through `BASE_TERMINAL_OPTIONS` which
    // unconditionally sets cursorBlink:true — re-clamp through the policy
    // helper so a BACKGROUND/VISIBLE plain terminal doesn't silently start
    // its blink timer again on a font or theme change.
    this.applyCursorBlinkPolicy(managed);

    if (textMetricsChanged) {
      managed.lastWidth = 0;
      managed.lastHeight = 0;
      this.resizeController.fit(id);
    }
    if ("theme" in options) {
      managed.terminal.refresh(0, managed.terminal.rows - 1);
    }
  }

  applyGlobalOptions(options: Partial<Terminal["options"]>): void {
    const textMetricKeys = ["fontSize", "fontFamily", "lineHeight", "letterSpacing", "fontWeight"];
    const textMetricsChanged = textMetricKeys.some((key) => key in options);

    this.instances.forEach((managed, id) => {
      Object.entries(options).forEach(([key, value]) => {
        // @ts-expect-error xterm options are indexable
        managed.terminal.options[key] = value;
      });
      // Same rationale as updateOptions: re-clamp cursorBlink so a global
      // theme/font change doesn't silently re-enable the blink timer on
      // backgrounded plain terminals.
      this.applyCursorBlinkPolicy(managed);

      if (textMetricsChanged) {
        managed.lastWidth = 0;
        managed.lastHeight = 0;
        this.resizeController.fit(id);
      }
      if ("theme" in options) {
        managed.terminal.refresh(0, managed.terminal.rows - 1);
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
    // Route through wantsWebGLAtTier so an off-screen promotion (background
    // worktree detected mid-stream) doesn't register a fleet-wide want; the
    // reveal path re-acquires it when the pane comes on-screen (#10671).
    if (managed.isOpened && this.webGLPolicy.wantsWebGLAtTier(managed, managed.lastAppliedTier)) {
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
    // timer can't fire later and call releaseContext on a stale slot. Any
    // visible pane stays WebGL-eligible as a plain terminal now (#11193), so
    // keep (or acquire) its context instead of churning it through a release.
    this.cancelWebGLHideTimer(managed);
    if (managed.isOpened && this.webGLPolicy.wantsWebGLAtTier(managed, managed.lastAppliedTier)) {
      this.webGLManager.ensureContext(id, managed);
    } else {
      this.webGLManager.releaseContext(id);
    }
    this.maybeReflowTerminal(managed);
  }

  // Re-derive the scrollback policy for every live foreground terminal.
  // Called on resource-profile changes after setAgentScrollbackMaxLines so
  // the new agent ceiling applies to terminals that are already open.
  // Background terminals are skipped: their scrollback was deliberately
  // reduced and is restored by the tier-upgrade path.
  restoreScrollbackAllForeground(): void {
    for (const managed of this.instances.values()) {
      const tier = managed.lastAppliedTier ?? managed.getRefreshTier?.();
      if (tier === TerminalRefreshTier.BACKGROUND) continue;
      restoreScrollback(managed);
    }
  }

  addExitListener(id: string, cb: (exitCode: number) => void): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};
    managed.exitSubscribers.add(cb);
    return () => managed.exitSubscribers.delete(cb);
  }

  // Hibernation no longer occurs (terminals stay fully live in the
  // background) — always false. See subscribeHibernation above.
  isHibernated(_id: string): boolean {
    return false;
  }

  // Whether this terminal currently holds a live WebGL context (vs the DOM
  // renderer). Reflects the WebGL manager's pool, which changes asynchronously
  // via the rAF attach/release drains.
  isWebGLActive(id: string): boolean {
    return this.webGLManager.isActive(id);
  }

  destroy(id: string): void {
    // Cancel an in-flight creation for this id: if the panel is torn down while
    // getOrCreate is still awaiting setupTerminalAddons, the instance isn't in
    // `instances` yet (so the guard below would no-op), but the pending build
    // would otherwise resume and publish a stale instance/onData listener for a
    // dead id. createManagedTerminal consumes this flag after its await and
    // aborts. Marked regardless of the `instances` presence check below.
    if (this.creating.has(id)) {
      this.cancelledCreations.add(id);
    }

    const managed = this.instances.get(id);
    if (!managed) return;

    this.settleWaiters.rejectAll(id);

    // The attach banner describes an xterm instance that is about to stop
    // existing (#11776). Its Retry would target a terminal this service no
    // longer has, so drop the signal with the thing it described.
    this.clearAttachError(id, managed);

    this.cancelAttachReveal(managed);
    this.agentStateController.destroy(id);
    this.restoreController.destroy(id);
    this.burstController.destroy(id);
    this.writeController.forget(id);

    managed.scrollbackRestoreState = "none";

    this.instances.delete(id);
    this.scheduleWhySlowReport();
    // Keep the batch aggregate honest when a terminal is torn down mid-restore
    // (e.g. the user closes a pane while it is still pending/in-progress).
    this.notifyScrollbackRestoreListeners();

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
    this.workerIngestController.destroy(id);
    // Renderer-side destroy without a prior kill (project close, LRU
    // eviction of an exited terminal) must still drain the port-ack FIFO
    // before the held queue is wiped (#9910). kill/gracefulKill/trash clear
    // the FIFO themselves, so this is a no-op on those paths.
    terminalClient.discardPortAcks(id);
    this.dataBuffer.resetForTerminal(id);
    this.unseenTracker.destroy(id);

    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
      managed.tierChangeTimer = undefined;
    }
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

    managed.parserHandler?.dispose();

    try {
      managed.fileLinksDisposable?.dispose();
    } catch (error) {
      logWarn("Error disposing file links", { error });
    }
    try {
      managed.imageLinksDisposable?.dispose();
    } catch (error) {
      logWarn("Error disposing image links", { error });
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

    // The host may have been parked in the shared offscreen container by
    // detach()/detachForProjectSwitch() (raw child, not a registered slot) —
    // detach it regardless of the dispose path above (#9909).
    if (managed.hostElement.parentElement) {
      managed.hostElement.parentElement.removeChild(managed.hostElement);
    }

    this.offscreenManager.removeOffscreenSlot(id);
    this.suppressedExitUntil.delete(id);
    this.cwdProviders.delete(id);
    this.cachedSelections.delete(id);
    this.rendererPolicy.clearTierState(id);
  }

  dispose(): void {
    this.stopPolling();
    this.unsubTierChanged?.();
    this.unsubTierChanged = null;
    this.unsubResizeResult?.();
    this.unsubResizeResult = null;
    this.workerIngestController.dispose();
    this.resizePassScheduler.dispose();
    this.reflowController.dispose();
    this.reconciliationWatchdog.dispose();
    this.writeController.dispose();
    this.instances.forEach((_, id) => this.destroy(id));
    this.offscreenManager.dispose();
    this.webGLManager.dispose();
    this.rendererPolicy.dispose();
    this.agentStateController.dispose();
    this.restoreController.dispose();
  }

  async restoreFetchedState(
    id: string,
    serializedState: string | null,
    captureGeometry?: TerminalGeometry
  ): Promise<boolean> {
    return this.restoreController.restoreFetchedState(id, serializedState, captureGeometry);
  }

  async fetchAndRestore(id: string): Promise<boolean> {
    return this.restoreController.fetchAndRestore(id);
  }

  restoreFromSerialized(
    id: string,
    serializedState: string,
    captureGeometry?: TerminalGeometry
  ): boolean {
    return this.restoreController.restoreFromSerialized(id, serializedState, captureGeometry);
  }

  restoreFromSerializedIncremental(
    id: string,
    serializedState: string,
    captureGeometry?: TerminalGeometry
  ): Promise<boolean> {
    return this.restoreController.restoreFromSerializedIncremental(
      id,
      serializedState,
      captureGeometry
    );
  }

  setInputLocked(id: string, locked: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.isInputLocked = locked;
    managed.terminal.options.disableStdin = locked;
  }
}

// The renderer-facing surface of the terminal paint plane: the public members
// of TerminalInstanceService. PaintFabricCompositor implements this exact type,
// so parity between the bare single-surface service and the fabric seam is
// compile-enforced — a new public method here is a type error until the
// compositor declares how it routes (per-terminal, group, fan-out, or sum).
export type TerminalPaintPlane = {
  [K in keyof TerminalInstanceService]: TerminalInstanceService[K];
};

// Construction-site seam for the paint fabric
// (docs/architecture/terminal-paint-fabric.md). Flag off: the bare service,
// unchanged. Flag on: the compositor fronting the primary surface plus any
// configured in-process aux surfaces — behaviorally identical at
// surface-count 1, and the rollback path for every later phase.
const primaryTerminalInstanceService = new TerminalInstanceService();

function createTerminalPaintPlane(): TerminalPaintPlane {
  if (!isPaintFabricEnabled()) return primaryTerminalInstanceService;
  const surfaces: PaintSurface[] = [
    { id: PRIMARY_SURFACE_ID, plane: primaryTerminalInstanceService },
  ];
  const surfaceCount = getPaintFabricSurfaceCount();
  for (let index = 1; index < surfaceCount; index += 1) {
    const aux = new TerminalInstanceService();
    // In-process aux surfaces share the window's renderer thread, glyph atlas,
    // and 16-WebGL-context budget with the primary — they exercise the
    // multi-surface routing semantics, they do not add capacity. Forcing them
    // to the DOM renderer keeps K in-process surfaces from packing the shared
    // context budget K times over; the aggregate governor (webglBudget.ts)
    // takes this job over once surfaces live in sibling WebContentsViews.
    aux.setGPUHardwareAvailable(false);
    surfaces.push({ id: paintFabricAuxSurfaceId(index), plane: aux });
  }
  return new PaintFabricCompositor({
    surfaces,
    choosePlacement: surfaces.length > 1 ? createRoundRobinPlacement() : undefined,
  });
}

export const terminalInstanceService: TerminalPaintPlane = createTerminalPaintPlane();

// Expose terminal introspection/control bridges for E2E tests (the WebGL
// renderer has no DOM text, so specs read the buffer through these). Gated on
// the preload-injected __DAINTREE_E2E_MODE__ flag (set only under
// DAINTREE_E2E_MODE=1 on non-packaged builds), so none of these globals attach
// in production sessions. The flag is injected via contextBridge before this
// module evaluates, so the gate is reliable at import time.
if (typeof window !== "undefined" && window.__DAINTREE_E2E_MODE__ === true) {
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

  // Container CAPACITY (what the fit addon would size the grid to right now)
  // alongside the grid the terminal is ACTUALLY rendering at. The E2E
  // project-switch garble guard compares the two: after a switch-back the grid
  // must match the container, else the buffer is wrapping at the wrong column.
  (window as unknown as Record<string, unknown>).__daintreeProposeTerminalDimensions = (
    panelId: string
  ): { cols: number; rows: number; proposedCols: number; proposedRows: number } | null => {
    const managed = terminalInstanceService.getInstanceForE2E(panelId);
    if (!managed) return null;
    const proposal = managed.fitAddon.proposeDimensions?.();
    return {
      cols: managed.terminal.cols,
      rows: managed.terminal.rows,
      proposedCols: proposal?.cols ?? -1,
      proposedRows: proposal?.rows ?? -1,
    };
  };

  type TerminalScrollSnapshotForE2E = {
    viewportY: number;
    baseY: number;
    isUserScrolledBack: boolean;
    cols: number;
    rows: number;
    // Where the viewport ACTUALLY sits, versus the furthest it can go. The
    // logical fields above cannot see #11709 at all: a rows-only resize leaves
    // them reporting "at bottom" while the scrollable element is still parked
    // rows higher, and it is that stale offset which later drags the buffer
    // back into scrollback. xterm's scrollable element is not a natively
    // scrolling node, so its own state is the only reading that means anything.
    scrollTop: number | null;
    maxScrollTop: number | null;
  };

  type XtermScrollableForE2E = {
    _viewport?: {
      _scrollableElement?: {
        getScrollPosition?: () => { scrollTop?: number };
        getScrollDimensions?: () => { height?: number; scrollHeight?: number };
      };
    };
  };

  const readTerminalScrollSnapshotForE2E = (
    panelId: string
  ): TerminalScrollSnapshotForE2E | null => {
    const managed = terminalInstanceService.getInstanceForE2E(panelId);
    if (!managed) return null;
    const buffer = managed.terminal.buffer.active;
    const finite = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;

    let scrollTop: number | null = null;
    let maxScrollTop: number | null = null;
    try {
      const scrollable = (
        managed.terminal as typeof managed.terminal & { _core?: XtermScrollableForE2E }
      )._core?._viewport?._scrollableElement;
      scrollTop = finite(scrollable?.getScrollPosition?.().scrollTop);
      const dimensions = scrollable?.getScrollDimensions?.();
      const height = finite(dimensions?.height);
      const scrollHeight = finite(dimensions?.scrollHeight);
      maxScrollTop =
        height !== null && scrollHeight !== null ? Math.max(0, scrollHeight - height) : null;
    } catch {
      // Private shape absent — the assertions that need it will see null.
    }

    return {
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      isUserScrolledBack: managed.isUserScrolledBack,
      cols: managed.terminal.cols,
      rows: managed.terminal.rows,
      scrollTop,
      maxScrollTop,
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
    terminalInstanceService.triggerTerminalLinkForE2E(panelId, url, syntheticEvent);
    return "ok";
  };

  // Test-only: hand the live xterm Terminal instance to the interactivity perf
  // probe (e2e/full/terminal/interactivity-perf.spec.ts) so it can hook
  // onData/onWriteParsed/onRender and read the buffer without a bridge per
  // event. Same-realm only — the instance never crosses a serialization
  // boundary. Object.assign keeps it off the type-assertion lint ratchet.
  Object.assign(window, {
    __daintreeGetTerminalForE2E: (panelId: string): Terminal | null =>
      terminalInstanceService.getInstanceForE2E(panelId)?.terminal ?? null,
  });

  // Test-only WebGL leak-regression bridges (#9540). Attached via Object.assign
  // (not a window cast) so they don't add to the no-unsafe-type-assertion lint
  // ratchet. All are harmless in production and reach private state only for the
  // nightly memory-leak suite.
  Object.assign(window, {
    // Introspect WebGL pool state so the regression can assert the "wants" set
    // and active context return to baseline after a terminal close.
    __daintreeGetTerminalWebGLState: (
      panelId: string
    ): { wantsSize: number; active: boolean; mode: string } | null =>
      terminalInstanceService.getWebGLStateForE2E(panelId),
    // Promote a plain terminal to an agent terminal on a WebGL-eligible
    // (FOCUSED) tier so the WebGL addon actually attaches. Mirrors the
    // production parser-detected promotion path without a real agent process.
    __daintreePromoteTerminalToAgentForE2E: (panelId: string, agentId: string): boolean => {
      if (!terminalInstanceService.getInstanceForE2E(panelId)) return false;
      terminalInstanceService.applyRendererPolicy(panelId, TerminalRefreshTier.FOCUSED);
      terminalInstanceService.applyAgentPromotion(panelId, agentId);
      return terminalInstanceService.getWebGLStateForE2E(panelId).active;
    },
  });
}

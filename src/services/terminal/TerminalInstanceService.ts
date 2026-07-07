import { Terminal, IBufferRange } from "@xterm/xterm";
import { isMac } from "@/lib/platform";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import type { AgentState } from "@/types";
import {
  ManagedTerminal,
  RefreshTierProvider,
  AgentStateCallback,
  PostCompleteHook,
  TerminalLink,
  isWebGLEligibleTier,
  WRITE_BURST_DECAY_MS,
  GRID_RESIZE_COALESCE_MS,
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
import { TerminalAgentStateController } from "./TerminalAgentStateController";
import { TerminalRestoreController } from "./TerminalRestoreController";
import { TerminalReflowController, forceXtermReflow } from "./TerminalReflowController";
import { TerminalReconciliationWatchdog } from "./TerminalReconciliationWatchdog";
import { TerminalWriteController } from "./TerminalWriteController";
import { agentLifecycleLedger } from "./lifecycleLedger";
import { reportFileLinkFailure } from "./FileLinksAddon";
import {
  installTerminalBoundListeners,
  type TerminalListenerInstallDeps,
} from "./TerminalListenerInstaller";
import { reduceScrollback, restoreScrollback } from "./TerminalScrollbackController";
import { DEFAULT_TERMINAL_FONT_FAMILY, onTerminalFontArrivedLate } from "@/config/terminalFont";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isPtyPanel } from "@shared/types/panel";
import { usePanelStore } from "@/store/panelStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { logDebug, logWarn, logError } from "@/utils/logger";
import { yieldToScheduler } from "@/lib/schedulerYield";
import { PaintFabricCompositor } from "./paintFabric/PaintFabricCompositor";
import type { PaintSurface } from "./paintFabric/PaintSurfaceRegistry";
import { createRoundRobinPlacement } from "./paintFabric/placementPolicies";
import {
  isPaintFabricEnabled,
  isPaintFabricWorkerIngestEnabled,
  getPaintFabricSurfaceCount,
  paintFabricAuxSurfaceId,
  PRIMARY_SURFACE_ID,
} from "./paintFabric/paintFabricConfig";
import { LiveWorkerIngest } from "./workerParse/LiveWorkerIngest";
import { createParseWorkerTransport } from "./workerParse/createParseWorkerTransport";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
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

// Default timeout for the restore-aware settle waits (`waitForFullySettled`,
// `waitForAllFullySettled`). Aligned to the 30s Tier 1→3 promotion rule
// (CLAUDE.md "Runtime Signals"): a settle that hasn't completed within 30s has
// stalled past the point where an ambient indicator is appropriate, so the
// gate gives up and surfaces the still-pending set rather than blocking
// indefinitely. The wait is notification-driven (scheduler fires on each
// restore state transition); the timer is only the safety fallback, so
// Chromium 148 background-timer throttling in a hidden view at most delays the
// fallback, never the correct completion path.
const TERMINAL_BATCH_SETTLE_TIMEOUT_MS = 30000;

// Terminals resized per task inside `runResizePass`, yielding to the scheduler
// between chunks. xterm.js 6.0 reflows the whole scrollback on a
// column-changing resize (~15-40ms each), so one-per-task keeps every task
// under the ~50ms long-task threshold and lets paint + input run between
// terminals instead of freezing the renderer for the whole batch.
const RESIZE_PASS_CHUNK_SIZE = 1;

// Interactive resource-profile override (symptom B): while actively scrolling a
// full-screen TUI, ask the main process to hold the profile off efficiency.
// DURATION must exceed THROTTLE so re-requests overlap and the hold never lapses
// mid-scroll; both are short so the hold self-expires soon after scrolling stops.
const INTERACTIVE_OVERRIDE_DURATION_MS = 1500;
const INTERACTIVE_OVERRIDE_THROTTLE_MS = 500;
// BURST-tier hold after a wheel scroll before reverting to the computed tier —
// matches the keystroke input-burst decay so a scroll feels just as responsive.
const WHEEL_BURST_DECAY_MS = 1000;

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
  // In-flight creations keyed by id: concurrent getOrCreate(id) share ONE build
  // so a single id can never wire two terminalClient.onData subscriptions (see
  // getOrCreate).
  private creating = new Map<string, Promise<ManagedTerminal>>();
  // Ids destroyed WHILE a creation was in flight. createManagedTerminal consumes
  // this after its async addon load and aborts, so a panel torn down mid-build
  // never publishes a stale instance/onData listener for a dead id.
  private cancelledCreations = new Set<string>();
  // Throttle for the interactive resource-profile override IPC (see onActiveWheel).
  private lastInteractiveOverrideRequestAt = 0;
  // Which terminal received the most recent alt-buffer wheel event, and when —
  // drives the ingest service's background-drain hold during a scroll gesture.
  // Uses the same decay window as the BURST tier so "gesture over" is one
  // consistent notion across the renderer.
  private lastActiveWheelId: string | null = null;
  private lastActiveWheelAt = 0;
  private dataBuffer = new TerminalOutputIngestService(
    (id, data, chunkCount) => this.writeToTerminal(id, data, chunkCount),
    () => usePanelStore.getState().focusedId,
    () =>
      this.lastActiveWheelId !== null && Date.now() - this.lastActiveWheelAt < WHEEL_BURST_DECAY_MS
        ? this.lastActiveWheelId
        : null
  );
  private suppressedExitUntil = new Map<string, number>();
  private unseenTracker = new TerminalUnseenOutputTracker();
  private hibernationListeners = new Map<string, Set<() => void>>();
  private scrollbackRestoreListeners = new Set<() => void>();
  private cwdProviders = new Map<string, () => string>();
  private readinessWaiters = new Map<string, Waiter[]>();
  private attachSettledWaiters = new Map<string, Waiter[]>();
  private fullySettledWaiters = new Map<string, Waiter[]>();
  private offscreenManager = new TerminalOffscreenManager();
  private linkHandler = new TerminalLinkHandler();
  private cachedSelections = new Map<string, string>();
  private resizeController: TerminalResizeController;
  private rendererPolicy: TerminalRendererPolicy;
  private webGLManager = new TerminalWebGLManager();
  // Coalesces "why am I slow?" diagnostics pushes (#10910): multiple tier/create/
  // destroy events in one turn collapse to a single main-process report.
  private whySlowReportScheduled = false;
  private agentStateController: TerminalAgentStateController;
  private restoreController: TerminalRestoreController;
  private reflowController: TerminalReflowController;
  private reconciliationWatchdog: TerminalReconciliationWatchdog;
  private writeController: TerminalWriteController;
  private unsubTierChanged: (() => void) | null = null;
  // Live worker-parse ingest (issue #10960), gated by
  // DAINTREE_PAINT_FABRIC_WORKER_INGEST. One controller per terminal that has
  // ever gone BACKGROUND while the gate is on; disposed with the terminal.
  private workerIngest = new Map<string, LiveWorkerIngest>();
  private unsubWorkerIngestEngaged: (() => void) | null = null;

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
      writeData: (id, data, chunkCount) => this.writeToTerminal(id, data, chunkCount),
    });

    this.writeController = new TerminalWriteController({
      getInstance: (id) => this.instances.get(id),
      acknowledgePortData: (id, bytes, chunkCount) =>
        terminalClient.acknowledgePortData(id, bytes, chunkCount),
      acknowledgeData: (id, bytes) => terminalClient.acknowledgeData(id, bytes),
      notifyWriteComplete: (id, bytes) => this.dataBuffer.notifyWriteComplete(id, bytes),
      incrementUnseen: (id, isScrolledBack) =>
        this.unseenTracker.incrementUnseen(id, isScrolledBack),
      onWrite: (id) => this.onPtyWrite(id),
    });

    this.reflowController = new TerminalReflowController({
      getInstances: () => this.instances.values(),
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

        if (this.wantsWebGLAtTier(managed, tier)) {
          this.webGLManager.ensureContext(id, managed);
        } else if (
          (managed.webGLHideTimer === undefined && !managed.isVisible) ||
          !managed.runtimeAgentId
        ) {
          // Agent terminals keep WebGL while visible — releasing causes a
          // one-frame renderer gap, and VISIBLE is an eligible tier for them
          // anyway. Plain terminals release as soon as they stop being
          // focused (even while visible): the DOM renderer is their
          // status-quo at VISIBLE, and a lingering want per previously
          // focused shell would accumulate toward the mode-switch threshold.
          // Tier demotion is an authoritative signal — cancel any pending
          // hide-dwell and release immediately. The webGLHideTimer guard keeps
          // the dwell window intact for a hidden agent still streaming at BURST:
          // wantsWebGLAtTier now returns false for off-screen panes (#10671), so
          // without it the next write's tier-apply would release on frame 1
          // instead of after WEBGL_HIDE_DWELL_MS — defeating the hide→show
          // anti-churn dwell. Once the dwell timer fires (or never armed), the
          // guard is undefined and the release proceeds.
          this.cancelWebGLHideTimer(managed);
          const hadWebGL = this.webGLManager.isActive(id);
          this.webGLManager.releaseContext(id);
          // Only refresh for a visible terminal — repainting an offscreen
          // DOM produces a stale frame that flashes on next show (#6802).
          if (hadWebGL && managed.isVisible && managed.terminal.rows > 0) {
            managed.terminal.refresh(0, managed.terminal.rows - 1);
          }
        }

        // Cursor blink is policy-driven: plain terminals run the blink timer
        // only at FOCUSED/BURST, agent terminals never. Centralised in the
        // service helper so updateOptions/applyAgentPromotion/getOrCreate all
        // reach the same answer.
        this.applyCursorBlinkPolicy(managed);

        // Tier changes shift the counts-by-tier distribution (and can flip WebGL
        // mode via the release path above) — push a fresh diagnostics sample.
        this.scheduleWhySlowReport();

        this.applyWorkerIngestPolicy(id, tier, managed);
      },
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
      isWebGLActive: (id) => this.webGLManager.isActive(id),
      shouldHaveWebGL: (managed) => this.shouldHaveActiveWebGL(managed),
      ensureWebGL: (id, managed) => this.webGLManager.ensureContext(id, managed),
      forceReflow: (element) => forceXtermReflow(element),
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
      onActiveWheel: (id) => this.onActiveWheel(id),
      onUserScrollIntent: (id) => this.onUserScrollIntent(id),
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
   * a file link (not a URL / OSC 8 link), else null. Used by the right-click
   * context menu to show a "Reveal in Finder" item only for genuine file
   * paths. Distinct from {@link getHoveredLinkText}, which returns the raw
   * matched text for any link kind.
   */
  getHoveredFilePath(id: string): string | null {
    const link = this.instances.get(id)?.hoveredLink;
    return link?.kind === "file" ? (link.absolutePath ?? null) : null;
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

  /**
   * Whether a terminal wants a WebGL context at the given tier. Agent
   * terminals are eligible at every WebGL-eligible tier (FOCUSED/BURST/
   * VISIBLE) — the DOM renderer mangles the block glyphs agent headers use
   * (see isWebGLEligibleTier in types.ts). Plain terminals are eligible only
   * while focused: FOCUSED, or a BURST on the focused pane (input bursts and
   * streaming output must not drop the context mid-use). BURST alone is
   * write-driven for every terminal, so granting it to unfocused plain shells
   * would add a want per streaming build/log pane and trip the count-based
   * mode switch; VISIBLE is excluded for the same budget reason.
   */
  private wantsWebGLAtTier(
    managed: ManagedTerminal,
    tier: TerminalRefreshTier | undefined,
    opts?: { trustDomVisibility?: boolean }
  ): boolean {
    if (!isWebGLEligibleTier(tier)) return false;
    // Visibility gates every case: an off-screen pane never wants WebGL, even
    // an agent streaming at BURST. The want set is fleet-wide per project view,
    // so hidden streaming agents would otherwise accumulate wants and trip the
    // count-based mode switch, dropping the whole visible fleet to DOM
    // (#10671). The reveal path (setVisible(true) → debounced shouldRestoreWebGL
    // → ensureContext) re-acquires the want once the pane is on-screen again —
    // and on a warm WebContentsView resume it passes trustDomVisibility because
    // it has already proven the pane on-screen from DOM truth, so the stale
    // reactive isVisible flag must not veto the want there.
    if (!opts?.trustDomVisibility && !managed.isVisible) return false;
    if (managed.runtimeAgentId) return true;
    return (
      tier === TerminalRefreshTier.FOCUSED ||
      (tier === TerminalRefreshTier.BURST && managed.isFocused)
    );
  }

  /**
   * Eligibility for visibility-driven WebGL restore. Mirrors the gates in
   * onTierApplied (agent identity / focus + tier) plus liveness checks
   * (opened, not attaching, not hibernated). Used by the debounced timer in
   * setVisible() before re-acquiring a context.
   */
  private shouldRestoreWebGL(
    managed: ManagedTerminal,
    opts?: { trustDomVisibility?: boolean }
  ): boolean {
    if (!managed.isOpened) return false;
    // The reveal path proves visibility from DOM ground truth (isConnected +
    // checkVisibility + box) before calling, because the reactive isVisible flag
    // can be stale-false on a warm WebContentsView resume (#10632 item 4). Trust
    // that here so a dropped WebGL context is reattached on reveal instead of
    // leaving the pane on the DOM renderer until the ~3s watchdog (which is
    // itself suppressed for the first ~5s by the project-switch resize lock).
    if (!opts?.trustDomVisibility && !managed.isVisible) return false;
    if (managed.isAttaching) return false;
    if (managed.isHibernated) return false;
    return this.wantsWebGLAtTier(
      managed,
      managed.lastAppliedTier ?? managed.getRefreshTier?.(),
      opts
    );
  }

  /**
   * Watchdog-only WebGL eligibility. Identical to {@link shouldRestoreWebGL} but
   * additionally false for a non-pinned pane in DOM-mode fallback: in DOM mode
   * the manager only ever attaches the single focus-pinned context, so a
   * non-pinned pane's context can never become active. Without this the
   * watchdog's `shouldHaveWebGL && !isWebGLActive` stays permanently true for
   * every non-pinned agent pane and burns a heavy-repair slot every tick (plus a
   * spurious "context missing" warning). The reveal / visibility restore paths
   * deliberately keep using {@link shouldRestoreWebGL} so they still call
   * `ensureContext` and keep the pane in the manager's `wants` set — which is
   * what lets a later focus change pin and attach it immediately.
   */
  private shouldHaveActiveWebGL(managed: ManagedTerminal): boolean {
    if (!this.shouldRestoreWebGL(managed)) return false;
    // In DOM mode the manager only keeps contexts on pinned panes (the focus
    // pin and alt-buffer pins). A non-pinned pane can never have an active
    // context, so the watchdog must not treat its absence as a fault.
    if (
      this.webGLManager.getMode() === "dom" &&
      managed.id !== this.webGLManager.getPinnedId() &&
      !this.webGLManager.isAltBufferPinned(managed.id)
    ) {
      return false;
    }
    return true;
  }

  private onUserInput(id: string, data: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    this.rendererPolicy.applyRendererPolicy(id, TerminalRefreshTier.BURST);

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

  /**
   * Active wheel scroll in a focused full-screen mouse-reporting TUI. Scrolling
   * such a TUI is an app-owned PTY round-trip per line, and a focused-but-idle
   * pane sits at FOCUSED (10fps): without this the first flick repaints slowly
   * until the TUI's own redraw output happens to bump the tier. We (1) lift the
   * renderer to BURST (60fps) for the scroll — reusing the input-burst decay
   * timer, since a scroll wants the same ~1s revert as a keystroke — and (2) ask
   * the main process to hold the resource profile at ≥ balanced, so efficiency
   * mode's stretched port-batch delay (40ms vs 16ms) can't throttle the
   * returned-redraw stream mid-scroll ("gets slow and stays slow", symptom B).
   */
  private onActiveWheel(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    this.lastActiveWheelId = id;
    this.lastActiveWheelAt = Date.now();

    this.rendererPolicy.applyRendererPolicy(id, TerminalRefreshTier.BURST);
    if (managed.inputBurstTimer !== undefined) {
      clearTimeout(managed.inputBurstTimer);
    }
    managed.inputBurstTimer = window.setTimeout(() => {
      const current = this.instances.get(id);
      if (!current) return;
      current.inputBurstTimer = undefined;
      this.rendererPolicy.applyRendererPolicy(id, current.getRefreshTier());
    }, WHEEL_BURST_DECAY_MS);

    this.requestInteractiveProfileOverride();
  }

  /**
   * Ordinary scrollback wheel/key scrolling (not mouse-reporting forwarding).
   * Holds the resource profile off efficiency for the same reason as
   * `onActiveWheel` — a profile downgrade mid-scroll drops the WebGL upper
   * threshold and can force the visible terminal onto the DOM renderer right
   * as the user is scrolling it (#10858). Unlike `onActiveWheel`, plain
   * scrollback is client-side xterm rendering with no PTY round-trip per
   * line, so there's no renderer-tier boost to apply here.
   */
  private onUserScrollIntent(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    this.requestInteractiveProfileOverride();
  }

  /**
   * Fire-and-forget request that the main process keep the resource profile off
   * efficiency while the user is actively scrolling. Throttled hard because a
   * trackpad momentum stream calls this dozens of times/sec; the override window
   * (INTERACTIVE_OVERRIDE_DURATION_MS) is longer than the throttle so the hold
   * never lapses between requests, and self-expires shortly after scrolling stops.
   */
  private requestInteractiveProfileOverride(): void {
    const now = Date.now();
    if (now - this.lastInteractiveOverrideRequestAt < INTERACTIVE_OVERRIDE_THROTTLE_MS) return;
    this.lastInteractiveOverrideRequestAt = now;
    try {
      // safeFireAndForget swallows the ASYNC rejection (channel skew during a
      // reload, future validation), which a bare synchronous try/catch around a
      // Promise-returning IPC call would miss; the try/catch still guards a
      // synchronous throw if `window.electron.system` is absent. Either way the
      // renderer-side BURST boost above already applied — this is non-critical.
      safeFireAndForget(
        window.electron.system.requestInteractiveOverride(INTERACTIVE_OVERRIDE_DURATION_MS),
        { context: "terminal.requestInteractiveProfileOverride" }
      );
    } catch {
      // window.electron.system unavailable — non-critical.
    }
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
    const managed = this.instances.get(id);
    if (!managed) return;

    const panelState = usePanelStore.getState();
    const panel = panelState.panelsById[id];
    const needsRealRestore =
      managed.isHibernated ||
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
    const current = this.instances.get(id);
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
      if (this.hostHasRenderableDims(current)) {
        this.ensureOpened(id, current);
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
    if (this.deferGridChangeForStream(current, gridWouldChange)) {
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
        this.resizeController.lockResize(id, false);
      }
      try {
        this.resizeController.applyDeferredResize(id);
      } finally {
        if (needsLockBypass) {
          this.resizeController.lockResize(id, true, remainingMs);
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
      this.webGLManager.repairAtlasForReactivation(id);
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
    this.handlePostWake(id);
    this.dataBuffer.resumeFlush(id);

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
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return false;
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
    if (!this.hostHasRenderableDims(managed)) return false;
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
    if (!this.webGLManager.isActive(id) && this.shouldRestoreWebGL(managed, opts)) {
      this.webGLManager.ensureContext(id, managed);
    }

    // Drop the stale local glyph model and repaint. repairAtlasForReactivation
    // returns false for DOM-renderer terminals — fall back to a plain refresh so
    // the pane still repaints.
    try {
      if (!this.webGLManager.repairAtlasForReactivation(id)) {
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
    this.agentStateController.checkStaleDirecting(id);

    if (!this.resizeController.reconcileGeometryFresh(id)) return false;

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
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return false;
    if (!this.resizeController.reconcileGeometryFresh(id)) return false;

    try {
      if (!this.webGLManager.repairAtlasForReactivation(id)) {
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
   * - **Hibernated or unopened** — a dwell past the hibernation delay tore the
   *   xterm instance down, and the occluded warm wake could not re-open it
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
    const managed = this.instances.get(id);
    // Gone — nothing to repaint and nothing to retry, so report "settled".
    if (!managed) return true;
    if (managed.isHibernated || !managed.isOpened) {
      // A hibernated/unopened pane needs the full open+wake, but
      // fullWakeForVisibilityRestore only opens once the host has a real layout
      // box. While the foreground view is still settling that box can read zero
      // (or the host is visibility:hidden), so report "not paintable yet" and
      // let the reveal sweep retry on a later frame rather than spending the
      // open attempt against an unmeasurable host.
      if (!this.hostHasRenderableDims(managed)) return false;
      await this.fullWakeForVisibilityRestore(id);
      const after = this.instances.get(id);
      // Gone mid-wake → nothing left to retry. Otherwise it's settled only once
      // the pane actually opened AND the wake wasn't merely DEFERRED:
      // fullWakeForVisibilityRestore sets pendingVisibilityWake and returns early
      // while an attach is in flight (notifyAttachSettledWaiters re-runs it on
      // settle). Report "retry" until the open+wake has truly landed so the
      // sweep's confirm paints aren't spent against a not-yet-revealed pane.
      return (
        !after ||
        (after.isOpened === true &&
          after.isHibernated !== true &&
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
    if (launchAgentId !== undefined && !managed.isHibernated) {
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
    const openLink = (url: string, event?: MouseEvent) => {
      this.linkHandler.openLink(url, id, event);
    };

    const setHoveredLink = (link: TerminalLink | null) => {
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
      if (this.dataBuffer.isPolling()) return;
      // Worker-ingest diversion (issue #10960): while a terminal is in (or
      // transitioning through) worker mode, main-thread chunks route into the
      // controller — it acks them immediately and lands them on the mirror
      // through the session's zero-loss buffering, never through the write
      // controller.
      const ingest = this.workerIngest.get(id);
      if (ingest?.shouldDivert()) {
        ingest.feedDiverted(data);
        return;
      }
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

    this.notifyReadinessWaiters(id);

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

    // Record the first live-attach geometry in the lifecycle ledger (once per
    // launch generation — recordFirstAttach ignores later attaches). Pairs
    // with the 80x24 initial dims stamped at launch so a support bundle can
    // show whether a pane ever converged from boot geometry.
    if (managed) {
      const generation = agentLifecycleLedger.currentGeneration(id);
      if (generation !== undefined) {
        agentLifecycleLedger.recordFirstAttach(
          id,
          generation,
          managed.terminal.cols,
          managed.terminal.rows
        );
      }
    }

    const waiters = this.attachSettledWaiters.get(id);
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve();
      }
      this.attachSettledWaiters.delete(id);
    }

    // Visual attach is one half of "fully settled". If restore already
    // finished while this terminal was mid-attach, attach completing now is
    // the moment it becomes fully settled — drain those waiters too.
    this.notifyFullySettledWaitersIfReady(id);

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

  /**
   * Resolves once a terminal is *fully* settled — both visually attached
   * ({@link isAttachSettled}) and past its scrollback-restore lifecycle. Unlike
   * {@link waitForAttachSettled}, which only gates on visual attach, this waits
   * for the restore state machine to leave its in-flux states.
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
    if (this.isFullySettled(id)) {
      return Promise.resolve();
    }

    const timeoutMs = options.timeoutMs ?? TERMINAL_BATCH_SETTLE_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.removeFullySettledWaiter(id, resolve);
        const state = this.instances.get(id)?.scrollbackRestoreState ?? "missing";
        reject(
          new Error(`Terminal ${id} fully-settle timeout after ${timeoutMs}ms (restore: ${state})`)
        );
      }, timeoutMs);

      const waiters = this.fullySettledWaiters.get(id) || [];
      waiters.push({ resolve, reject, timeout });
      this.fullySettledWaiters.set(id, waiters);
    });
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
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) {
      return Promise.resolve();
    }

    const timeoutMs = options.timeoutMs ?? TERMINAL_BATCH_SETTLE_TIMEOUT_MS;

    return new Promise<void>((resolveBatch, rejectBatch) => {
      let settled = false;
      // Per-panel resolve handles we registered in `fullySettledWaiters`, so
      // the shared timeout can detach them in one pass rather than leaving
      // ghost waiters that fire after the batch has already rejected.
      const registered: Array<{ id: string; resolve: () => void }> = [];

      const detachAll = () => {
        for (const entry of registered) {
          this.removeFullySettledWaiter(entry.id, entry.resolve);
        }
      };

      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        detachAll();
        const pending = uniqueIds.filter((id) => !this.isFullySettled(id));
        rejectBatch(
          new Error(`Terminals not fully settled after ${timeoutMs}ms: ${pending.join(", ")}`)
        );
      }, timeoutMs);

      const perPanel = uniqueIds.map(
        (id) =>
          new Promise<void>((resolve, reject) => {
            if (this.isFullySettled(id)) {
              resolve();
              return;
            }
            registered.push({ id, resolve });
            const waiters = this.fullySettledWaiters.get(id) || [];
            // No per-panel timer — the shared batch timeout above governs the
            // whole set. `timeout: 0` is never a live handle, so the
            // `clearTimeout` calls in the notify/destroy drain paths are no-ops.
            waiters.push({ resolve, reject, timeout: 0 });
            this.fullySettledWaiters.set(id, waiters);
          })
      );

      void Promise.all(perPanel).then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolveBatch();
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          detachAll();
          rejectBatch(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  private isFullySettled(id: string): boolean {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return false;
    if (!this.isAttachSettled(id)) return false;
    // Restore is "settled" once it is no longer in flux — not queued
    // ("pending") and not running ("in-progress"). "done" is a clean restore;
    // "none" is terminal from a waiter's view in every case it occurs:
    // restore was never scheduled (fresh terminal, no scrollback), aborted
    // before starting (project switch — outcome no longer relevant), or failed
    // and reset (lastScrollbackRestoreError set). The failure case still
    // settles: a cosmetic scrollback failure must not strand the wait, and
    // callers distinguish it via lastScrollbackRestoreError.
    return managed.scrollbackRestoreState === "done" || managed.scrollbackRestoreState === "none";
  }

  /**
   * Drains the fully-settled waiters for a terminal if it has reached the
   * settled predicate. Reads the instance fresh (never closes over a captured
   * `managed`) so a stale/replaced instance can't be acted on (#4850).
   */
  private notifyFullySettledWaitersIfReady(id: string): void {
    if (!this.isFullySettled(id)) return;

    const waiters = this.fullySettledWaiters.get(id);
    if (!waiters) return;

    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    this.fullySettledWaiters.delete(id);
  }

  /**
   * Scheduler-facing hook: the scrollback restore scheduler calls this after
   * each terminal restore state transition (success, failure, or bail) so
   * fully-settled waiters can re-check the predicate. Public because the
   * scheduler lives in a sibling module and already calls into this singleton.
   */
  notifyRestoreSettledWaiters(id: string): void {
    this.notifyFullySettledWaitersIfReady(id);
  }

  private removeFullySettledWaiter(id: string, resolve: () => void): void {
    const waiters = this.fullySettledWaiters.get(id);
    if (!waiters) return;

    const index = waiters.findIndex((w) => w.resolve === resolve);
    if (index >= 0) {
      waiters.splice(index, 1);
    }

    if (waiters.length === 0) {
      this.fullySettledWaiters.delete(id);
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
    if (!managed.imageAddon) {
      try {
        const imageAddon = await createImageAddon(managed.terminal);
        // Dispose the loser rather than leak it if, during the async import, a
        // concurrent caller already populated the slot OR the terminal was
        // destroyed/replaced (its instance is no longer the one in the map, so
        // its own teardown will never dispose this addon).
        if (managed.imageAddon || this.instances.get(id) !== managed) {
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
    // saved size instead of flashing 80x24 then snapping (#6983).
    if (managed.targetCols && managed.targetRows) {
      managed.terminal.resize(managed.targetCols, managed.targetRows);
    }
    // terminalOpenStartedAt anchors the first-write delta (#9809).
    managed.terminalOpenStartedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    managed.hasEmittedFirstWriteMark = false;
    markRendererPerformance(PERF_MARKS.TERMINAL_OPEN_START, { terminalId: id });
    try {
      managed.terminal.open(managed.hostElement);
    } finally {
      markRendererPerformance(PERF_MARKS.TERMINAL_OPEN_END, { terminalId: id });
    }
    managed.isOpened = true;
    logDebug(`[TIS] Opened terminal ${id}`);
    // Build the deferred Image/link addons now that the terminal is live.
    // EXPERIMENT (hibernation removal, Codex review fix — Finding 3): build them
    // unconditionally, even for a pane opened at BACKGROUND tier. Background
    // panes stay fully content-live; only the WebGL context differs by
    // visibility (gated separately below). Previously this skipped the addons on
    // background, degrading content for hidden panes.
    void this.ensureDeferredAddons(id, managed);
    if (this.wantsWebGLAtTier(managed, managed.lastAppliedTier)) {
      this.webGLManager.ensureContext(id, managed);
    }
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

  private backgroundResizeSession: {
    basis: { width: number; height: number };
    origin: Map<string, { width: number; height: number }>;
  } | null = null;

  /**
   * PTY-tracking resize for a backgrounded project view (#10415). A detached
   * WebContentsView keeps its stale viewport until reattach — setBounds()
   * does not propagate while detached and ResizeObservers never fire in a
   * hidden page — so per-panel pixel sizes cannot be re-measured here.
   * Instead each terminal's host size is scaled by the window-bounds ratio,
   * which is exact for 1fr grid tracks and at worst off by ~1 col where
   * fixed chrome doesn't scale. The PTY-only resize keeps agents wrapping
   * at the right width the whole time; the wake path
   * (`fullWakeForVisibilityRestore` → `applyDeferredResize`) reconciles
   * xterm and corrects any residual error from real layout on reattach.
   *
   * Scaling is anchored to a per-background-session snapshot: the basis is
   * the stale viewport (which all `lastWidth`/`lastHeight` measurements were
   * laid out against) and each terminal's origin size is captured the first
   * time it's seen. Every event computes absolute targets from that anchor,
   * so repeated resizes never compound and a terminal skipped in one pass
   * (resize-locked) still lands on the correct size in the next.
   */
  applyBackgroundWindowResize(width: number, height: number): void {
    if (document.visibilityState === "visible") {
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
      if (managed.isHibernated) continue;
      if (!managed.isOpened) continue;
      let origin = session.origin.get(id);
      if (!origin) {
        if (managed.lastWidth <= 0 || managed.lastHeight <= 0) continue;
        origin = { width: managed.lastWidth, height: managed.lastHeight };
        session.origin.set(id, origin);
      }
      this.resizeController.resizePtyOnly(
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

  /**
   * Abort any in-flight chunked resize pass without starting a new one. The
   * paint-fabric compositor uses this to give a multi-surface fabric the same
   * pass-supersession semantics the single service has: one logical pass spans
   * every surface, so starting a new pass must cancel stale chunked work on
   * surfaces that have no ids in the new pass (they'd otherwise keep reflowing
   * a survivor set that is already stale).
   */
  cancelActiveResizePass(): void {
    this.resizePassAbort?.abort();
    this.resizePassAbort = undefined;
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

  // Hibernation no longer occurs (terminals stay fully live in the background),
  // so `isHibernated` is permanently false and these listeners never fire. The
  // subscription is retained so `useIsHibernated` keeps a stable
  // useSyncExternalStore contract while reading the always-false snapshot.
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
    //
    // EXCEPT when the fit would CHANGE the grid of a still-streaming pane
    // (#10863's wake-path half — same predicate as fullWakeForVisibilityRestore
    // and reconcileGeometryFresh): fit() re-wraps committed scrollback under a
    // CLI mid-paint — the assistant's boot splash is the canonical victim.
    // Defer to the reconciliation watchdog via the reveal-pending obligation;
    // a no-drift fit falls through (its resize is a no-op and the PTY
    // re-assert is dedupe-safe). Alt-buffer and settled-strategy panes never
    // reach here (early returns above).
    if (this.deferGridChangeForStream(managed, this.proposalDivergesFromGrid(managed))) {
      // Deferred to the watchdog — skip the fit.
    } else {
      const fitResult = this.resizeController.fit(id);
      if (!fitResult) {
        // Fallback: fit() returned null (terminal offscreen or container too
        // small). PTY-only — it never re-wraps the xterm buffer, so it stays
        // safe for a streaming pane too.
        this.resizeController.forceImmediateResize(id);
      }
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
    if (!managed || managed.isHibernated) return "";

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
    if (isFocused && !managed.isHibernated) {
      this.webGLManager.pinFocus(id, managed);
    }
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

  /**
   * Recover a terminal's renderer the way the manual "Redraw" action does.
   * Returns whether the repair ACTUALLY ran: false when it self-skipped on its
   * own guards (gone/hibernated/disconnected/sub-50px box). Callers that must
   * guarantee a redraw (the project-switch suppression-clear, #10632) use the
   * return value to know whether the obligation still needs to be carried.
   */
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
   */
  private deferGridChangeForStream(managed: ManagedTerminal, gridWouldChange: boolean): boolean {
    if (!gridWouldChange || managed.isAltBuffer || !hasStreamingWrites(managed, Date.now())) {
      return false;
    }
    managed.revealPendingRepair = true;
    managed.revealPendingGeneration = managed.attachGeneration;
    return true;
  }

  resetRenderer(id: string): boolean {
    const managed = this.instances.get(id);
    if (!managed || managed.isHibernated) return false;

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

      // Same #10863 guard as handlePostWake: never fit-rewrap a streaming
      // main-buffer pane. The suppression-clear timer that drives this on
      // project switch-back lands exactly in the assistant's cold-resume boot
      // window; the atlas/refresh recovery above already ran, and the armed
      // watchdog obligation converges the grid once the stream quiesces.
      if (!this.deferGridChangeForStream(managed, this.proposalDivergesFromGrid(managed))) {
        try {
          this.resizeController.fit(id);
        } catch (error) {
          logError(`resetRenderer fit failed for ${id}`, error);
        }
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
    return true;
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
    // Route through wantsWebGLAtTier so an off-screen promotion (background
    // worktree detected mid-stream) doesn't register a fleet-wide want; the
    // reveal path re-acquires it when the pane comes on-screen (#10671).
    if (managed.isOpened && this.wantsWebGLAtTier(managed, managed.lastAppliedTier)) {
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
    // timer can't fire later and call releaseContext on a stale slot. A
    // focused pane stays WebGL-eligible as a plain terminal, so keep (or
    // acquire) its context instead of churning it through a release.
    this.cancelWebGLHideTimer(managed);
    if (managed.isOpened && this.wantsWebGLAtTier(managed, managed.lastAppliedTier)) {
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
      if (managed.isHibernated) continue;
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

  isHibernated(id: string): boolean {
    return this.instances.get(id)?.isHibernated === true;
  }

  // Whether this terminal currently holds a live WebGL context (vs the DOM
  // renderer). Reflects the WebGL manager's pool, which changes asynchronously
  // via the rAF attach/release drains.
  isWebGLActive(id: string): boolean {
    return this.webGLManager.isActive(id);
  }

  /**
   * Tier-driven worker-ingest policy (issue #10960): BACKGROUND demotes the
   * terminal's parse into a worker via its dedicated pty-host port; any other
   * tier (FOCUSED/BURST, and VISIBLE — a visible pane repainting at snapshot
   * cadence would be a UX regression) promotes back to the main-thread path
   * through the zero-loss release barrier. No-op unless
   * DAINTREE_PAINT_FABRIC_WORKER_INGEST=1.
   */
  private applyWorkerIngestPolicy(
    id: string,
    tier: TerminalRefreshTier,
    managed: ManagedTerminal
  ): void {
    if (!isPaintFabricWorkerIngestEnabled()) return;
    if (tier === TerminalRefreshTier.BACKGROUND) {
      // Hibernated terminals drop output entirely; an alt-buffer TUI repaints
      // its whole viewport constantly, and snapshot cadence handles that fine —
      // no exclusion needed beyond hibernation.
      if (managed.isHibernated) return;
      let ingest = this.workerIngest.get(id);
      if (!ingest) {
        ingest = this.createWorkerIngest(id, managed);
        this.workerIngest.set(id, ingest);
      }
      ingest.setDesired(true);
    } else {
      this.workerIngest.get(id)?.setDesired(false);
    }
  }

  private createWorkerIngest(id: string, managed: ManagedTerminal): LiveWorkerIngest {
    if (!this.unsubWorkerIngestEngaged) {
      this.unsubWorkerIngestEngaged = terminalClient.onWorkerIngestEngaged((terminalId) => {
        this.workerIngest.get(terminalId)?.handleEngaged();
      });
    }

    const utf8ByteLength = (data: string): number => new TextEncoder().encode(data).byteLength;

    const ingest = new LiveWorkerIngest({
      id,
      requestPort: () => terminalClient.requestWorkerIngestPort(id),
      releasePort: () => terminalClient.releaseWorkerIngestPort(id),
      sendEngage: () => terminalClient.sendWorkerIngestEngage(id),
      sendRelease: (drainId) => terminalClient.sendWorkerIngestRelease(id, drainId),
      createTransport: () => createParseWorkerTransport(),
      mirror: {
        write: (data, callback) => {
          const current = this.instances.get(id);
          if (!current || current.isHibernated) {
            callback?.();
            return;
          }
          // Direct write — snapshot applies and replays are pre-acked, so the
          // write controller's ack bookkeeping must never see them. Unseen
          // tracking still counts each repaint as output activity.
          this.unseenTracker.incrementUnseen(id, current.isUserScrolledBack);
          current.terminal.write(data, callback);
        },
      },
      serializeMirror: () => {
        const current = this.instances.get(id);
        return current?.serializeAddon.serialize() ?? "";
      },
      getGeometry: () => {
        const current = this.instances.get(id);
        return {
          cols: current?.terminal.cols ?? 80,
          rows: current?.terminal.rows ?? 24,
          scrollback: current?.terminal.options.scrollback ?? 1000,
        };
      },
      ackDiverted: (data) => {
        // One host chunk per diverted callback: settle exactly one port-ack
        // FIFO entry (using the host's queued byte count), and the IPC ledger
        // for string chunks (only strings travel the IPC path — mirrors
        // TerminalWriteController's ackBytes rule).
        const bytes = typeof data === "string" ? data.length : data.byteLength;
        terminalClient.acknowledgePortData(id, bytes, 1);
        if (typeof data === "string") {
          terminalClient.acknowledgeData(id, utf8ByteLength(data));
        }
      },
      requestHostRestore: () => {
        safeFireAndForget(this.restoreController.fetchAndRestore(id), {
          context: "worker-ingest fallback restore",
        });
      },
      onDidFallback: (reason) => {
        logWarn("Worker ingest fell back to main-thread parse", { id, reason });
      },
    });

    // Geometry follows the mirror in every mode so demotion re-seeds at the
    // right size (session forwards resizes only while in worker mode).
    const resizeDisposable = managed.terminal.onResize(({ cols, rows }) =>
      ingest.resize(cols, rows)
    );
    managed.listeners.push(() => resizeDisposable.dispose());

    return ingest;
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

    const fullySettledWaiters = this.fullySettledWaiters.get(id);
    if (fullySettledWaiters) {
      for (const waiter of fullySettledWaiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(`Terminal ${id} destroyed before fully settled`));
      }
      this.fullySettledWaiters.delete(id);
    }

    this.cancelAttachReveal(managed);
    this.agentStateController.destroy(id);
    this.restoreController.destroy(id);

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
    // Worker ingest dies with the terminal: dispose terminates the Worker and
    // closes the dedicated port on every teardown path (kill/trash/project
    // close/LRU eviction) — a leaked producer port queues unboundedly (#6283).
    const ingest = this.workerIngest.get(id);
    if (ingest) {
      ingest.dispose();
      this.workerIngest.delete(id);
    }
    // Renderer-side destroy without a prior kill (project close, LRU
    // eviction of an exited terminal) must still drain the port-ack FIFO
    // before the held queue is wiped (#9910). kill/gracefulKill/trash clear
    // the FIFO themselves, so this is a no-op on those paths.
    terminalClient.discardPortAcks(id);
    this.dataBuffer.resetForTerminal(id);
    this.unseenTracker.destroy(id);
    this.hibernationListeners.delete(id);

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
    }

    // Detach the host element regardless of hibernation state: a hibernated
    // terminal's host may have been parked in the shared offscreen container
    // by detach()/detachForProjectSwitch() (raw child, not a registered slot),
    // and the gated branch above doesn't reach it (#9909).
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
    this.unsubWorkerIngestEngaged?.();
    this.unsubWorkerIngestEngaged = null;
    // Abort any in-flight chunked resize pass so its yielded continuation
    // doesn't resume against a torn-down service.
    this.resizePassAbort?.abort();
    this.resizePassAbort = undefined;
    this.reflowController.dispose();
    this.reconciliationWatchdog.dispose();
    this.instances.forEach((_, id) => this.destroy(id));
    this.offscreenManager.dispose();
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
    terminalInstanceService.triggerTerminalLinkForE2E(panelId, url, syntheticEvent);
    return "ok";
  };

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

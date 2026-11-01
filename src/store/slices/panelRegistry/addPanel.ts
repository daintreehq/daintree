import type { TerminalRuntimeStatus } from "@/types";
import type {
  AddPanelCommitOptions,
  AddPanelOptions,
  PanelRegistryStoreApi,
  PanelRegistrySlice,
} from "./types";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import {
  load as loadTerminalService,
  peek as peekTerminalService,
  with as withTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import { TerminalRefreshTier } from "@/types";
import {
  panelKindUsesTerminalUi,
  normalizeDockLocation,
  getPanelKindConfig,
  resolvePanelKindPolicy,
} from "@shared/config/panelKindRegistry";
import { getTerminalAppearanceSnapshot } from "@/hooks/useTerminalAppearance";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { getXtermOptions, calculateTerminalDimensions } from "@/config/xtermConfig";
import { deriveTerminalRuntimeIdentity } from "@/utils/terminalChrome";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelLimitStore, buildPanelLimitSnapshot } from "@/store/panelLimitStore";
import { notify } from "@/lib/notify";
import { notifyRetiredModelDropped } from "@/services/terminal/retiredModelNotice";
import { dropRetiredAgentModel, dropUnselectedAgentModel } from "@shared/types/agentSettings";
import { readSpawnProvenance } from "@shared/utils/scheduledRunProvenance";
import { noteVisibleAgentLaunch } from "@/services/systemMemoryLaunchNotice";
import {
  getDefaultTitle,
  DOCK_TERM_WIDTH,
  DOCK_TERM_HEIGHT,
  DOCK_PREWARM_WIDTH_PX,
  DOCK_PREWARM_HEIGHT_PX,
} from "./helpers";
import { logDebug, logWarn } from "@/utils/logger";
import { markRendererPerformance } from "@/utils/performance";
import { panelMatchesWorktreeScope } from "./worktreeIndex";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import { cancelDriveLeaseHold, clearPanelDriveLeaseMark } from "@/store/driveLeaseWaitStore";
import { computeEnvProvenance } from "@shared/utils/agentLifecycleLedger";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { countPanelLimitUsage, countsTowardPanelLimit } from "./panelCount";
import { reservePanelSlots } from "./panelSlotReservations";
import { isUsableTerminalGeometry } from "@shared/types/terminal";
import {
  commitPtyPanel,
  isHeldForRecovery,
  parkedRestoreTarget,
  showsLostTerminal,
} from "./panelCommit";
import { addNonPtyPanel } from "./nonPtyPanel";
import { startSpawnEnvFetch } from "./spawnEnv";
import { enqueuePtyStartup, terminalStartupQueue } from "./ptyStartup";

// Lazy accessor to break circular dependency: addPanel -> projectStore -> panelPersistence -> addPanel.
// Resolved on first call (after app init), then cached.
let _cachedProjectStore: typeof import("@/store/projectStore").useProjectStore | null = null;
async function resolveProjectStore() {
  if (!_cachedProjectStore) {
    const mod = await import("@/store/projectStore");
    _cachedProjectStore = mod.useProjectStore;
  }
  return _cachedProjectStore;
}

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

// Chrome allowance for the overlay (help panel) grid estimate: horizontal =
// panel border + terminal-host inset; vertical = header + banners + hybrid
// input bar + footer. Rough is fine — the estimate only has to be close
// enough that a CLI painting before the first real fit lands near the final
// wrap width instead of the legacy 80×24 spawn default.
const OVERLAY_CHROME_X_PX = 16;
const OVERLAY_CHROME_Y_PX = 240;

/**
 * Estimated grid for an overlay (help panel) terminal, derived from the
 * persisted panel width and the current viewport. The overlay's XtermAdapter
 * mounts without waiting for spawnStatus, but historically both the prewarmed
 * xterm and the PTY booted at the 80×24 spawn default, so the assistant CLI
 * painted its banner at 80 cols and the first real fit re-wrapped (or, when
 * the fit's PTY resize raced the spawn and was dropped, permanently desynced)
 * the committed output — the duplicated/garbled assistant startup (#10863).
 */
function estimateOverlayGridDims(fontSize: number): { cols: number; rows: number } | null {
  const panelWidth = useHelpPanelStore.getState().width;
  const viewportHeight = window.innerHeight;
  // NaN/∞ would flow into the panel record, the xterm constructor, and the
  // spawn payload — fall back to the legacy defaults instead of estimating.
  if (
    !Number.isFinite(panelWidth) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(fontSize)
  ) {
    return null;
  }
  return calculateTerminalDimensions(
    Math.max(200, panelWidth - OVERLAY_CHROME_X_PX),
    Math.max(240, viewportHeight - OVERLAY_CHROME_Y_PX),
    fontSize
  );
}

export const createAddPanelActions = (set: Set, get: Get): Pick<PanelRegistrySlice, "addPanel"> => {
  const createPanel = async (
    requestedOptions: AddPanelOptions,
    commit: AddPanelCommitOptions | undefined
  ): Promise<string | null> => {
    const requestedKind = requestedOptions.kind ?? "terminal";

    // Handle panels that use custom UI (browser, dev-preview, extensions) separately
    if (!panelKindUsesTerminalUi(requestedKind)) {
      return addNonPtyPanel(set, get, requestedOptions, commit, requestedKind);
    }

    // Every replayed launch (recipe, duplicate, reopen, worktree and project
    // restore) arrives here, so a saved retired model is dropped once, before
    // the panel records it (#15652), as is a model the command doesn't select
    // for an agent that takes one only headless (#15569). A reconnect attaches
    // to a run already going and a recovery hold starts nothing, so neither is
    // changed.
    const startsLaunch =
      !requestedOptions.existingId && requestedOptions.restoreRecovery === undefined;
    const { launch: withoutRetired, droppedModelIds } = startsLaunch
      ? dropRetiredAgentModel(requestedOptions.launchAgentId, requestedOptions)
      : { launch: requestedOptions, droppedModelIds: [] };
    const options = startsLaunch
      ? dropUnselectedAgentModel(requestedOptions.launchAgentId, withoutRetired)
      : withoutRetired;

    // PTY panels: terminal / dev-preview. Agent identity lives on `launchAgentId`.
    const launchAgentId = options.launchAgentId;
    // Determine kind for PTY handling (dev-preview keeps its own kind)
    const kind: "terminal" | "dev-preview" =
      requestedKind === "dev-preview" ? "dev-preview" : "terminal";
    const title = options.title || getDefaultTitle(kind, { launchAgentId });

    // The scrollable panel grid no longer caps panels at the screen-fit count
    // (#8805). Honor the requested location directly; the hardware-adaptive
    // hard ceiling is enforced upstream by `panelLimitStore`.
    // Defense-in-depth: honor a non-dockable requested kind BEFORE the collapse
    // to "terminal"/"dev-preview" above discards it (#11375). `hasPty:true` with
    // `dockable:false` is rejected at the manifest gate and terminal/agent kinds
    // are always dockable, so this only fires for a programmatic dock request of
    // a non-dockable PTY kind — redirect it to the grid. No worktree adoption
    // here (unlike the non-PTY branch): PTY restore paths reconcile worktree
    // separately, and this defensive redirect never fires for a real launch.
    const location = normalizeDockLocation(requestedKind, options.location || "grid");
    const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
    // When activeWorktreeId is null (worktree store not yet hydrated — common during
    // project switch), treat the terminal as being in the active worktree to avoid
    // incorrectly backgrounding it. applyWorktreeTerminalPolicy will reconcile
    // tiers once the worktree is set.
    const isInActiveWorktree =
      activeWorktreeId === null || (options.worktreeId ?? null) === (activeWorktreeId ?? null);
    const shouldBackground =
      location === "dock" ||
      location === "background" ||
      (location === "grid" && !isInActiveWorktree);
    const runtimeStatus: TerminalRuntimeStatus = shouldBackground ? "background" : "running";

    // Capture the owning workspace synchronously before any async work to avoid race
    // conditions if the user switches during async operations (issue #3690).
    // resolveProjectStore() is cached after first call, so subsequent calls resolve immediately.
    //
    // Two ids, deliberately: `capturedProjectId` is a *registered project* (it keys
    // project settings, which a scratch has none of), while `capturedWorkspaceId` is
    // whichever workspace owns this view — project or scratch. The PTY is stamped with
    // the workspace id so `killByProject(scratchId)` reaches scratch terminals on
    // delete (#11079); leaving it unset made ownership fall back to PtyClient's global
    // `activeProjectId`, which is null after a restore into a scratch and last-write-wins
    // across windows.
    const projectStore = await resolveProjectStore();
    const capturedProjectId = projectStore.getState().currentProject?.id;
    const capturedWorkspaceId = capturedProjectId ?? getViewWorkspaceId() ?? undefined;

    const isReconnect = !!options.existingId;
    const isAgent = Boolean(launchAgentId);
    // Reserve the id up front so the panel can be committed to the store before
    // any async work (env fetch, spawn IPC). #5789: commit-then-spawn collapses
    // six rapid agent clicks from serialized spawns into six parallel placeholders.
    const id = options.existingId ?? options.requestedId ?? `${kind}-${crypto.randomUUID()}`;
    // A held pane has no process until the user picks one (#12434): it commits
    // like any other pane and stops there — no startup slot, no ledger launch,
    // no prewarm, no spawn.
    const isRecoveryHold = options.restoreRecovery !== undefined && !isReconnect;
    // Restored as its process's own exit left it (#15941): the pane commits
    // exited and stops there, as a pane does when its PTY ends — no startup
    // slot, no spawn, until the user restarts it. A reconnect to a host record
    // whose process is gone takes the exit too, and spawns nothing anyway.
    const restoredExitCode = isRecoveryHold ? undefined : options.restoredExitCode;
    const restoresExit = restoredExitCode !== undefined;
    const isRestoredExit = restoresExit && !isReconnect;

    // Checked after the last await before the commit: the pane may have been
    // closed, or already launched by another click, while this call waited, and
    // replacing it then would resurrect it or start a second process in it.
    if (options.replacesRestoreRecovery && !isHeldForRecovery(get().panelsById[id])) {
      logWarn("[TerminalStore] Dropped a launch for a pane no longer held for recovery", { id });
      return null;
    }
    const replacesLost = options.replacesLostTerminal;
    if (replacesLost !== undefined && !showsLostTerminal(get().panelsById[id], replacesLost)) {
      logWarn(
        "[TerminalStore] Dropped a relaunch for a pane that moved on from its lost terminal",
        {
          id,
        }
      );
      return null;
    }
    // The reverse: a saved hold replayed after the user already launched that
    // pane would hide a running agent behind a gate. Only another hold may be
    // re-committed over, or a pane whose terminal is gone.
    if (isRecoveryHold && replacesLost === undefined) {
      const existing = get().panelsById[id];
      if (existing !== undefined && !isHeldForRecovery(existing)) {
        logWarn("[TerminalStore] Kept a launched pane over a stale recovery hold", { id });
        return id;
      }
    }

    // For reconnects, use the backend's state directly - don't default to "working".
    // For new spawns, start with "working" in UI to show spinner immediately during boot.
    const agentState = isReconnect
      ? options.agentState
      : isRecoveryHold
        ? undefined
        : (options.agentState ?? (isAgent ? "working" : undefined));
    // Reason restored from the backend snapshot survives only while the
    // resolved state is still "waiting" — mirrors the main-process rule that
    // clears it on any other state.
    const waitingReason = agentState === "waiting" ? options.waitingReason : undefined;
    const lastStateChange = isReconnect
      ? options.lastStateChange
      : (options.lastStateChange ?? (agentState !== undefined ? Date.now() : undefined));

    // Stale-restore guard: a reconnect/hydration replay must never overwrite a
    // LIVE fresh launch that already owns this id. The ledger distinguishes the
    // two owners of an existing panel: an earlier restore pass stamped
    // `restoredAt` (double hydration — merging the same snapshot again is
    // idempotent and allowed), while a fresh launch did not (its metadata —
    // launchAgentId, model, preset, env — is newer than the snapshot and the
    // merge below would clobber it). Generation 0 = "persisted snapshot,
    // predates every launch this session", so the rejection lands in the
    // anomaly ring for diagnostics.
    // A replayed snapshot finds the pane as that exit left it, or moved on:
    // restarting, running again, or exited since with another code. Only the
    // former is committed again; a newer launch that exited with the same code
    // is caught by the ledger guard below.
    if (isRestoredExit) {
      const existing = get().panelsById[id];
      if (
        existing !== undefined &&
        !(
          isPtyPanel(existing) &&
          !existing.isRestarting &&
          existing.runtimeStatus === "exited" &&
          existing.exitCode === restoredExitCode
        )
      ) {
        logWarn("[TerminalStore] Kept a pane that moved on over a restored exit", { id });
        return id;
      }
    }
    if (isReconnect || isRestoredExit) {
      const preexisting = get().panelsById[id];
      const ledgerEntry = preexisting ? agentLifecycleLedger.getEntry(id) : undefined;
      if (
        preexisting &&
        ledgerEntry &&
        ledgerEntry.closedAt === undefined &&
        ledgerEntry.restoredAt === undefined
      ) {
        agentLifecycleLedger.recordRestoreApplied(id, 0);
        logWarn("[TerminalStore] Rejected stale restore over a live launch", { id });
        return id;
      }
    }

    // PTY-backed plugin-contributed kinds are rare today, but stamp pluginId
    // if the registry has an entry so the panel survives plugin removal.
    const ptyKindConfig = getPanelKindConfig(kind);
    // A PTY-backed plugin kind collapses to "terminal" above; keep the kind it
    // was opened as, so its plugin can still be found for this panel (#13213).
    const pluginPanelKindId =
      requestedKind !== kind && getPanelKindConfig(requestedKind)?.extensionId !== undefined
        ? requestedKind
        : undefined;
    const ptyPluginId = ptyKindConfig?.extensionId ?? options.pluginId;
    const ptyExtensionStateVersion =
      options.extensionStateVersion ??
      (options.extensionState !== undefined ? ptyKindConfig?.stateVersion : undefined);
    // Reconnects don't go through a fresh spawn — mark them "ready" directly,
    // as is a pane restored exited, whose spawn ran long ago. A held pane has
    // no spawn at all; `restoreRecovery` drives its rendering.
    const spawnStatus: "spawning" | "ready" | undefined =
      isReconnect || isRestoredExit ? "ready" : isRecoveryHold ? undefined : "spawning";

    // Overlay terminals boot at ~their real grid instead of the 80×24 spawn
    // default so the assistant CLI never paints its startup banner at a width
    // the first fit then re-wraps (#10863). Grid/dock keep the legacy default:
    // their XtermAdapter attaches only after spawnStatus flips "ready", so the
    // fit's PTY resize always lands on a live PTY.
    const overlayDims =
      location === "overlay" && !isReconnect
        ? estimateOverlayGridDims(getTerminalAppearanceSnapshot().fontSize)
        : null;

    // The grid this pane is BORN on. Hydration supplies the persisted size for
    // a restored pane so it never exists at 80×24 — a restore into a
    // non-selected worktree is prewarmed and never fitted, so the default would
    // stand for as long as the user stays away while the surviving PTY streams
    // into it (#11718). Overlay keeps precedence: its estimate is the grid its
    // XtermAdapter is about to fit to, and the two never co-occur (an overlay
    // is never a restore). Re-validated here because `addPanel` is also reached
    // from plugins and MCP.
    const restoredDims = isUsableTerminalGeometry(options.initialTerminalGeometry)
      ? options.initialTerminalGeometry
      : null;
    const constructionDims = overlayDims ?? restoredDims;

    // Single active-grid launches mount their visible xterm immediately
    // (TerminalPane skips the spawnStatus gate), overlapping xterm.open()
    // and the first fit with the env fetch + spawn IPC below. Decided at
    // commit time — the flag must be in the first committed panel record
    // because TerminalPane reads it on first render. Burst spawns (queue
    // busy) keep the gate so panels realize with bounded concurrency (#5789).
    const eagerAttach =
      !isReconnect &&
      !isRecoveryHold &&
      !isRestoredExit &&
      location === "grid" &&
      isInActiveWorktree &&
      terminalStartupQueue.isIdle;
    // Every PTY panel that spawns reaches the enqueue below (prewarm and
    // dock-wake failures are caught), so each reserve pairs with one enqueue.
    if (!isReconnect && !isRecoveryHold && !isRestoredExit) terminalStartupQueue.reserve();

    const terminal = {
      id,
      kind,
      launchAgentId,
      title,
      // Pin the title when the caller owns it (e.g. an assistant-named agent
      // launch). `titleMode: "custom"` makes the identity reducer skip its
      // agent-detected/exited title rewrites. Conditional spread avoids
      // stamping `undefined`, which would read as an explicit "default".
      ...(options.titleMode && { titleMode: options.titleMode }),
      worktreeId: options.worktreeId,
      cwd: options.cwd ?? "",
      cols: constructionDims?.cols ?? 80,
      rows: constructionDims?.rows ?? 24,
      agentState,
      waitingReason,
      lastStateChange,
      location,
      ...(location === "background" && {
        backgroundRestoreLocation: parkedRestoreTarget(get(), id, options),
      }),
      command: options.command,
      // Initialize grid terminals as visible to avoid initial under-throttling
      // IntersectionObserver will update this once mounted
      isVisible: location === "grid" ? true : false,
      runtimeStatus: isRecoveryHold ? undefined : restoresExit ? "exited" : runtimeStatus,
      ...(restoresExit && { exitCode: restoredExitCode }),
      isInputLocked: options.isInputLocked,
      exitBehavior: options.exitBehavior,
      agentSessionId: options.agentSessionId,
      agentLaunchFlags: options.agentLaunchFlags,
      callerLaunchFlags: options.callerLaunchFlags,
      requiredPluginTools: options.requiredPluginTools,
      agentModelId: options.agentModelId,
      everDetectedAgent: options.everDetectedAgent,
      agentIncarnation: options.agentIncarnation,
      detectedAgentId: options.detectedAgentId,
      detectedProcessId: options.detectedProcessId,
      runtimeIdentity:
        deriveTerminalRuntimeIdentity({
          detectedAgentId: options.detectedAgentId,
          detectedProcessId: options.detectedProcessId,
        }) ??
        (launchAgentId
          ? deriveTerminalRuntimeIdentity({
              detectedAgentId: launchAgentId,
            })
          : undefined) ??
        undefined,
      agentPresetId: options.agentPresetId,
      agentPresetColor: options.agentPresetColor,
      originalPresetId: options.originalPresetId ?? options.agentPresetId,
      // Caller-resolved launch env captured so a restored session replays the
      // SAME provider environment it launched with (#10922). This is the
      // launcher's merged env (agent global + preset/recipe + caller layers); the
      // ambient global/project env is fetched when the panel is added (the
      // prefetch below, overlapping prewarm and any queue wait) and layered
      // UNDER this, so only the launch-resolved layer is frozen here.
      ...(options.env && { env: options.env }),
      isUsingFallback: options.isUsingFallback,
      fallbackChainIndex: options.fallbackChainIndex,
      sessionLostOnRestore: options.sessionLostOnRestore,
      ...(options.conversationCwd && { conversationCwd: options.conversationCwd }),
      // `hasPty: false` is what keeps fleet broadcast, interrupt and the other
      // live-process consumers off a pane that has nothing to write to.
      ...(isRecoveryHold && { restoreRecovery: options.restoreRecovery, hasPty: false }),
      ...(options.restoreProvenance && { restoreProvenance: options.restoreProvenance }),
      ...(options.lastAgentObservation && { lastAgentObservation: options.lastAgentObservation }),
      ...(options.launchedByPluginId && { launchedByPluginId: options.launchedByPluginId }),
      ...(options.holdOnRestart === true && { holdOnRestart: true as const }),
      ...(options.scratchpad && { scratchpad: options.scratchpad }),
      ...(options.firstPrompt && { firstPrompt: options.firstPrompt }),
      extensionState: options.extensionState,
      extensionStateVersion: ptyExtensionStateVersion,
      pluginId: ptyPluginId,
      ...(pluginPanelKindId !== undefined && { pluginPanelKindId }),
      // Kept as a pair (#15977): a run reference never rides another source.
      ...readSpawnProvenance(options.spawnedBy, options.scheduledRun),
      focusPolicy: options.focusPolicy,
      excludeFromPersistence: options.excludeFromPersistence,
      removeOnExit: options.removeOnExit,
      startedAt: isRecoveryHold ? undefined : Date.now(),
      spawnStatus,
      ...(eagerAttach && { eagerAttach: true }),
      // Preserve the saved `lastActiveAt` from the snapshot so the
      // post-hydration focus picker in `useAppHydration` can pick
      // the active worktree's most-recently-focused panel (#9933).
      // Validated upstream in `statePatcher.ts:buildArgsFor*` via
      // `sanitizeLastActiveAt`; conditional spread avoids stamping
      // `undefined` on freshly-created panels.
      ...(options.lastActiveAt !== undefined && { lastActiveAt: options.lastActiveAt }),
    } as PanelInstance;

    commitPtyPanel(set, {
      id,
      terminal,
      options,
      requestedKind,
      location,
      isReconnect,
      replacesLost,
      commit,
    });

    if (isRecoveryHold) return id;

    markRendererPerformance("agentlaunch.committed", { id });

    if (launchAgentId && droppedModelIds.length > 0) {
      notifyRetiredModelDropped(launchAgentId, droppedModelIds, {
        panelId: id,
        worktreeId: options.worktreeId,
      });
    }

    // Mint the panel's launch generation atomically with the commit above (no
    // await between id reservation and here). Every async completion below —
    // env fetch, spawn IPC, attach settle — re-validates against it so a
    // completion that outlives this incarnation (panel closed, id reused by a
    // restart or a stale hydration replay) can never write into a successor.
    const launchGeneration = agentLifecycleLedger.recordLaunch(id, {
      launchAgentId,
      cwd: options.cwd,
      projectId: capturedWorkspaceId,
      worktreeId: options.worktreeId,
      worktreeSource:
        options.worktreeId !== undefined ? (options.worktreeIdSource ?? "explicit") : undefined,
      agentModelId: options.agentModelId,
      agentPresetId: options.agentPresetId,
      originalPresetId: options.originalPresetId ?? options.agentPresetId,
      agentLaunchFlags: options.agentLaunchFlags,
      env: computeEnvProvenance(options.env),
      initialCols: constructionDims?.cols ?? 80,
      initialRows: constructionDims?.rows ?? 24,
      spawnedBy: options.spawnedBy,
      resumedFromSessionId: options.agentSessionId,
    });
    // A launch of this id supersedes any earlier one still waiting for control.
    cancelDriveLeaseHold(id);
    clearPanelDriveLeaseMark(id);
    if (isReconnect || isRestoredExit) {
      // Mark this generation as restore-born so the stale-restore guard above
      // can tell an idempotent re-merge from a clobbering one.
      agentLifecycleLedger.recordRestoreApplied(id, launchGeneration);
    }

    // Start the ambient env fetch now so its IPC round-trips overlap the
    // prewarm below and any queue wait, instead of serializing ahead of the
    // spawn IPC inside the startup task. Same merge semantics as before —
    // global env under project env under the caller's launch env. The
    // promise never rejects (every branch resolves a fallback), so an
    // early-returning startup task cannot leave an unhandled rejection.
    const spawnEnvPromise = startSpawnEnvFetch(
      options,
      isReconnect || isRestoredExit,
      capturedProjectId
    );

    // Prewarm renderer-side xterm immediately so we never drop startup output/ANSI while hidden.
    // earlyDataBuffer in terminalClient buffers any data that arrives before the
    // xterm data callback is registered, so prewarming with the pre-assigned id
    // before spawn completes is safe (see #5789 research notes).
    try {
      const appearance = getTerminalAppearanceSnapshot();
      const { fontSize, fontFamily, performanceMode } = appearance;

      // Project-level scrollback override for non-agent terminals
      const projectScrollback = isAgent ? undefined : appearance.projectScrollback;

      const effectiveScrollback = performanceMode
        ? PERFORMANCE_MODE_SCROLLBACK
        : getScrollbackForType(isAgent, projectScrollback ?? appearance.scrollbackLines);

      const terminalOptions = getXtermOptions({
        fontSize,
        fontFamily,
        scrollback: effectiveScrollback,
        performanceMode,
        theme: appearance.effectiveTheme,
        screenReaderMode: appearance.screenReaderMode,
      });
      // Overlay panes are BORN at their estimated grid (xterm constructor
      // cols/rows) so pre-attach CLI output wraps near the final width — a
      // prewarmed-but-unattached xterm otherwise sits at the 80×24 default
      // until the help panel's XtermAdapter mounts (#10863). Restored panes get
      // their persisted grid the same way, for the same reason (#11718).
      const prewarmOptions = constructionDims
        ? { ...terminalOptions, cols: constructionDims.cols, rows: constructionDims.rows }
        : terminalOptions;
      // Synchronous when the service is already up, so the prewarm claims the
      // instance before anything else can mount it.
      const loadedService = peekTerminalService();
      const terminalService = loadedService ?? (await loadTerminalService());
      // Removing the panel while the service loaded found no instance to
      // destroy; prewarming now would build an orphaned xterm for it.
      const supersededDuringLoad =
        loadedService === null &&
        (get().panelsById[id] === undefined ||
          !agentLifecycleLedger.isCurrent(id, launchGeneration));

      if (!supersededDuringLoad) {
        // Prewarm ALL terminal types to ensure the managed instance and data
        // listeners exist before the backend PTY can emit output. Do not attach
        // to an offscreen or visible DOM node here. Visible xterm.open() is
        // gated by spawnStatus below so burst-created panels realize one at a
        // time instead of all mounting xterm/WebGL during the same grid layout.
        const currentActiveWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
        const isDockOrInactive =
          location === "dock" ||
          location === "background" ||
          (currentActiveWorktreeId !== null &&
            (options.worktreeId ?? null) !== (currentActiveWorktreeId ?? null));

        if (!isAgent) {
          // Awaited so the managed instance and its PTY data listener exist before
          // the queued spawn runs — prewarmTerminal is async now that the lazy
          // Unicode11 addon is loaded during terminal construction (#10840).
          await terminalService.prewarmTerminal(id, launchAgentId, prewarmOptions, {
            offscreen: false,
            widthPx: location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH,
            heightPx: location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT,
          });
        } else {
          // Agent terminals also need prewarm for proper tier management.
          // This ensures they can receive wake signals when their worktree activates.
          const widthPx = location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH;
          const heightPx = location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT;

          // Awaited so the instance exists before the sendPtyResize below targets
          // it — prewarmTerminal is async now that the lazy Unicode11 addon is
          // loaded during terminal construction (#10840).
          await terminalService.prewarmTerminal(id, launchAgentId, prewarmOptions, {
            offscreen: false,
            widthPx,
            heightPx,
          });

          // Only send explicit resize for active grid spawns. Background/dock
          // terminals can boot at the spawn default and will be resized on reveal.
          // Cell metrics come from calculateTerminalDimensions so the lineHeight
          // assumption stays in sync with xtermConfig. An overlay panel that
          // reaches this branch (no active worktree) must use its own estimate —
          // the DOCK_TERM-derived dims would re-poison the grid the overlay
          // spawn path just fixed (#10863), and for a settled-strategy agent
          // this call arms a 500ms timer that can land AFTER the spawn. When the
          // estimate is unavailable (non-finite inputs), skip entirely and let
          // the spawn-time dims own overlay geometry. A restored pane skips it
          // too: its PTY is already on the persisted grid we just constructed at,
          // and this estimate is a fixed DOCK_TERM-derived guess, not a
          // measurement — sending it would move a healthy PTY off that grid
          // (#11718).
          if (!isDockOrInactive && !restoredDims && (location !== "overlay" || overlayDims)) {
            const { cols, rows } =
              overlayDims ?? calculateTerminalDimensions(widthPx, heightPx, fontSize);
            terminalService.sendPtyResize(id, cols, rows);
          }
        }
      }
    } catch (error) {
      logWarn("[TerminalStore] Failed to prewarm terminal", { id, error });
    }
    markRendererPerformance("agentlaunch.prewarmed", { id });

    // Determine if terminal should start backgrounded:
    // 1. Dock terminals are always backgrounded (offscreen)
    // 2. Grid terminals in inactive worktrees should also be backgrounded
    //    since they won't mount until the worktree becomes active
    if (shouldBackground) {
      // Terminal is either in dock or in an inactive worktree.
      // Apply BACKGROUND policy to prevent renderer updates for unmounted terminals.
      withTerminalService(
        (service) => service.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND),
        id
      );
    }

    // The store's value, not the creation option: a lock toggled while the
    // service loaded must not be reverted here.
    const lockTarget = get().panelsById[id];
    peekTerminalService()?.setInputLocked(
      id,
      lockTarget && isPtyPanel(lockTarget) ? !!lockTarget.isInputLocked : !!options.isInputLocked
    );

    // Wake the renderer instance and clear attention indicators when a panel is
    // created as the active dock panel — the state activation was already
    // committed atomically in the set() above (see #6590); this only handles
    // the renderer-side side effects that `openDockTerminal` would normally
    // perform. Wrapped to mirror the prewarm block: a renderer service
    // failure should not strand the panel in `spawning` with the spawn
    // promise never started.
    // Mirror both opt-outs from the popover gate above so this side-effect
    // path doesn't fire when the popover was deliberately suppressed.
    // Resolve from `requestedKind` to honor PTY extension kind policies.
    const ptyDockPolicy = resolvePanelKindPolicy(requestedKind);
    if (
      options.activateDockOnCreate &&
      location === "dock" &&
      options.focusPolicy !== "preserve" &&
      ptyDockPolicy.dockPopoverOnSpawn
    ) {
      try {
        peekTerminalService()?.wake(id);
        if (agentState === "waiting") {
          window.electron?.notification?.acknowledgeWaiting(id);
        } else if (agentState === "working") {
          window.electron?.notification?.acknowledgeWorkingPulse(id);
        }
      } catch (error) {
        logWarn("[TerminalStore] Failed to wake/acknowledge active dock panel", { id, error });
      }
    }

    if (isReconnect) {
      // Reconnect path does not spawn; the panel is already "ready".
      logDebug("[TerminalStore] Reconnecting to existing terminal", { id });
      return id;
    }
    if (isRestoredExit) return id;

    // A fresh agent the user will see, during an open memory episode, raises the
    // episode's figures above the grid once (#14309). Never waited on: it is a
    // reading beside the launch, not a gate in front of it. Visibility is read
    // now, not from the selection captured before the awaits above.
    if (launchAgentId && options.restore !== true && !isRecoveryHold) {
      const launched = get().panelsById[id];
      if (
        launched &&
        (launched.location === "grid" || launched.location === "dock") &&
        panelMatchesWorktreeScope(
          launched.worktreeId,
          getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null,
          launched.location
        )
      ) {
        noteVisibleAgentLaunch();
      }
    }

    enqueuePtyStartup(set, get, {
      id,
      launchGeneration,
      options,
      kind,
      launchAgentId,
      pluginPanelKindId,
      location,
      isInActiveWorktree,
      capturedWorkspaceId,
      lastStateChange,
      constructionDims,
      spawnEnvPromise,
    });

    return id;
  };

  return {
    addPanel: async (options, commit) => {
      // Panel limit enforcement: only the hard ceiling blocks a single-panel add.
      // The confirm band (>= confirmationLimit) is intentionally non-blocking —
      // adding a panel is reversible (one-click close), so the step-throttled
      // `TerminalCountWarning` banner (shown from `softWarningLimit` upward, with
      // no upper bound) is the right calibration, not a focus-stealing modal. The
      // blocking confirm survives only for batch spawns (`preflightSpawnBatchLimit`),
      // where the blast radius of many panels at once warrants it. See #10547.
      // Launching a pane held for recovery replaces it rather than adding one, so
      // it must not be refused by a limit the held pane already counts toward.
      const replacesHeldPane =
        options.replacesRestoreRecovery === true &&
        options.requestedId !== undefined &&
        isHeldForRecovery(get().panelsById[options.requestedId]);
      if (!options.bypassLimits && !replacesHeldPane) {
        const { softWarningLimit, confirmationLimit, hardLimit } = usePanelLimitStore.getState();
        const snapshot = buildPanelLimitSnapshot(countPanelLimitUsage(get()), {
          softWarningLimit,
          confirmationLimit,
          hardLimit,
        });

        if (snapshot.tier === "hard") {
          logWarn("[TerminalStore] Refused a panel at the hard panel limit", {
            kind: options.kind ?? "terminal",
            count: snapshot.count,
            hardLimit,
          });
          commit?.onLimitRefused?.(snapshot);
          notify({
            type: "warning",
            priority: "high",
            title: "Panel limit reached",
            message: `Maximum of ${hardLimit} panels reached. Close some panels before adding new ones.`,
            duration: 5000,
            context: { worktreeId: options.worktreeId ?? undefined },
          });
          return null;
        }
      }

      // The check above and the commit are separated by awaits, so hold the
      // slot it admitted until the add returns, claimed under the id the panel
      // will take: an overlapping gate or add sees it as taken either way
      // (#15607). Only an add the limit was checked for holds one.
      if (options.bypassLimits || replacesHeldPane || !countsTowardPanelLimit(options)) {
        return createPanel(options, commit);
      }
      const requestedKind = options.kind ?? "terminal";
      const idKind = panelKindUsesTerminalUi(requestedKind)
        ? requestedKind === "dev-preview"
          ? "dev-preview"
          : "terminal"
        : requestedKind;
      const id = options.existingId ?? options.requestedId ?? `${idKind}-${crypto.randomUUID()}`;
      const slot = reservePanelSlots(1);
      slot.claim(id);
      try {
        return await createPanel(
          options.existingId === undefined && options.requestedId === undefined
            ? { ...options, requestedId: id }
            : options,
          commit
        );
      } finally {
        slot.release();
      }
    },
  };
};

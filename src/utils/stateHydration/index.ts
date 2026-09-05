import { appClient, terminalClient, worktreeClient, projectClient, systemClient } from "@/clients";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import {
  suppressMruRecording,
  createDeletedWorktreeRecord,
  getDeletedWorktreeTerminalIds,
  useWorktreeSelectionStore,
} from "@/store/worktreeStore";
import { useLayoutConfigStore } from "@/store";
import type {
  AgentState,
  PanelKind,
  PanelSnapshot,
  TerminalReconnectError,
  TabGroup,
} from "@/types";
import type { WaitingReason } from "@shared/types/agent";
import type { SessionLostReason } from "@shared/types/panel";
import type { BackendTerminalInfo, TerminalReconnectResult } from "@shared/types/ipc/terminal";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isGitBackedProject } from "@shared/types";
import { isSmokeTestTerminalId } from "@shared/utils/smokeTestTerminals";
import { inferKind } from "./statePatcher";
import { RECONNECT_TIMEOUT_MS } from "./reconnectManager";
import type { ActionFrecencyEntry, ActionUsageEntry } from "@shared/types/actions";
import { panelPersistence } from "@/store/persistence/panelPersistence";
import { draftInputPersistence } from "@/store/persistence/draftInputPersistence";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { logDebug, logInfo, logWarn, logError } from "@/utils/logger";
import { PERF_MARKS } from "@shared/perf/marks";
import {
  markRendererPerformance,
  withRendererSpan,
  startRendererSpan,
  isRendererPerfCaptureEnabled,
  RENDERER_T0,
} from "@/utils/performance";
import { isDaintreeEnvEnabled } from "@/utils/env";
import { useSafeModeStore } from "@/store/safeModeStore";
import { useDistributionStore } from "@/store/distributionStore";
import { useResourceProfileStore } from "@/store/resourceProfileStore";
import type { AgentPreset } from "@/config/agents";
import type { HydrationBatchToken } from "@/store/slices/panelRegistry/types";
import { normalizeAndApplyScrollback } from "./scrollbackConfig";
import { ensureHydrationBootstrap } from "./bootstrapGuard";
import { dispatchRecoveryNotifications } from "./recoveryNotifications";
import { scheduleScrollbackRestore } from "./scrollbackRestoreScheduler";
import { restorePanelsPhase } from "./panelRestorePhase";

const CLIPBOARD_DIR_NAME = "daintree-clipboard";
const VERBOSE_HYDRATION_LOGGING = isDaintreeEnvEnabled("DAINTREE_VERBOSE");

/**
 * Pick the worktree to activate when the saved selection no longer exists.
 *
 * Always prefers the main worktree so a stale/removed saved selection never
 * lands on a leftover temporary PR worktree whose name happens to sort first
 * (#9512). Only when there is no main worktree does it fall back to the
 * alphabetically-first one. Returns `undefined` for an empty list.
 */
export function selectFallbackWorktree<
  T extends { id: string; name: string; isMainWorktree?: boolean },
>(worktrees: readonly T[]): T | undefined {
  if (worktrees.length === 0) return undefined;
  return (
    worktrees.find((wt) => wt.isMainWorktree === true) ??
    [...worktrees].sort((a, b) => a.name.localeCompare(b.name))[0]
  );
}

function logHydrationInfo(message: string, context?: Record<string, unknown>): void {
  if (!VERBOSE_HYDRATION_LOGGING) return;
  logInfo(message, context);
}

export interface HydrationOptions {
  addPanel: (options: {
    kind?: PanelKind;
    launchAgentId?: string;
    title?: string;
    cwd: string;
    worktreeId?: string;
    location?: "grid" | "dock";
    command?: string;
    agentState?: AgentState;
    waitingReason?: WaitingReason;
    lastStateChange?: number;
    existingId?: string; // Pass to reconnect to existing backend process
    requestedId?: string; // Pass to spawn with a stable ID
    skipCommandExecution?: boolean; // Store command but don't execute on spawn
    isInputLocked?: boolean; // Restore input lock state
    browserUrl?: string; // URL for browser panes
    browserHistory?: import("@shared/types/browser").BrowserHistory;
    browserZoom?: number;
    devCommand?: string; // Dev command override for dev-preview panels
    devServerStatus?: "stopped" | "starting" | "installing" | "running" | "error";
    devServerUrl?: string | null;
    devServerError?: { type: string; message: string } | null;
    devServerTerminalId?: string | null;
    browserConsoleOpen?: boolean;
    devPreviewConsoleOpen?: boolean;
    exitBehavior?: import("@shared/types/panel").PanelExitBehavior;
    agentSessionId?: string;
    agentLaunchFlags?: string[];
    agentModelId?: string;
    agentPresetId?: string;
    agentPresetColor?: string;
    originalPresetId?: string;
    isUsingFallback?: boolean;
    fallbackChainIndex?: number;
    sessionLostOnRestore?: SessionLostReason;
    env?: Record<string, string>;
    extensionState?: Record<string, unknown>;
    pluginId?: string;
    restore?: boolean;
    bypassLimits?: boolean;
  }) => Promise<string>;
  setActiveWorktree: (id: string | null) => void;
  loadRecipes: (projectId: string) => Promise<void>;
  openDiagnosticsDock: (tab?: "problems" | "logs" | "events") => void;
  setFocusMode?: (
    focusMode: boolean,
    focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean }
  ) => void;
  setReconnectError?: (id: string, error: TerminalReconnectError) => void;
  hydrateTabGroups?: (tabGroups: TabGroup[], options?: { skipPersist?: boolean }) => void;
  hydrateMru?: (list: string[]) => void;
  hydrateActionMru?: (list: ActionUsageEntry[] | ActionFrecencyEntry[] | string[]) => void;
  hydrateActionPrefs?: (prefs: { pinnedIds?: string[]; hiddenIds?: string[] }) => void;
  restoreTerminalOrder?: (orderedIds: string[]) => void;
  /**
   * Optional hydration-batch hooks. When both are provided, each restore phase is
   * wrapped in a begin/flush pair so the N `addPanel` mutations within the phase
   * collapse into a single store commit. Leaving them undefined keeps the legacy
   * per-panel commit behavior (tests and callers that don't care about render
   * reduction don't need to pass these).
   */
  beginHydrationBatch?: () => HydrationBatchToken;
  flushHydrationBatch?: (token: HydrationBatchToken) => void;
  /**
   * Pre-fetched hydration payload from the boot path, eliminating a redundant
   * ~50-150ms `appClient.hydrate()` IPC round-trip. Falls back to the IPC pull
   * model when omitted.
   */
  prefetchedHydrateResult?: import("@shared/types/ipc/app").HydrateResult;
}

export async function hydrateAppState(options: HydrationOptions): Promise<void> {
  const {
    addPanel,
    setActiveWorktree,
    loadRecipes,
    openDiagnosticsDock,
    beginHydrationBatch,
    flushHydrationBatch,
    prefetchedHydrateResult,
  } = options;
  const hydrationStartedAt = Date.now();

  /**
   * Wrap a restore phase in a hydration batch so every `addPanel` call inside `run`
   * collapses into a single store commit when the phase completes. If the caller
   * didn't wire the batch hooks (e.g. tests), fall through to the legacy per-panel
   * commit behavior.
   */
  const withHydrationBatch = async (run: () => Promise<void>): Promise<void> => {
    if (!beginHydrationBatch || !flushHydrationBatch) {
      await run();
      return;
    }
    const token = beginHydrationBatch();
    try {
      await run();
    } finally {
      flushHydrationBatch(token);
    }
  };
  let panelRestoreStartedAt: number | null = null;
  let panelRestoreCount = 0;
  let tabGroupRestoreCount = 0;

  markRendererPerformance(PERF_MARKS.HYDRATE_START);

  suppressMruRecording(true);
  try {
    await withRendererSpan(PERF_MARKS.HYDRATE_BOOTSTRAP, () => ensureHydrationBootstrap());

    // Use the pre-fetched hydration payload when available, eliminating a
    // ~50-150ms IPC round-trip. Fall back to the IPC pull model otherwise.
    const hydrateResult = prefetchedHydrateResult
      ? prefetchedHydrateResult
      : await withRendererSpan(PERF_MARKS.HYDRATE_APP_CLIENT, () => appClient.hydrate());
    // The system temp dir now rides along in the batched hydrate payload, so the
    // standalone `system:get-tmp-dir` call only fires as a fallback when the
    // field is absent (older main process, or the safe-boot {ok:false} payload).
    const tmpDir = hydrateResult.systemTmpDir ?? (await systemClient.getTmpDir().catch(() => ""));
    const {
      appState,
      terminalConfig,
      project: currentProject,
      agentSettings,
      gpuWebGLHardware,
    } = hydrateResult;
    const clipboardDirectory = tmpDir ? `${tmpDir}/${CLIPBOARD_DIR_NAME}` : undefined;

    useProjectStore.setState((state) => {
      // The full project list rides along in newer hydrate payloads (#10390).
      // Seed it (plus the bootstrap flag the Toolbar mount effect checks) so
      // the IPC-pull fallback path gets the same dedup as the boot path,
      // which seeds earlier via ensureHydrationBootstrap.
      const baseProjects = hydrateResult.projects ?? state.projects;
      const bootstrapped = state.isBootstrapped || hydrateResult.projects !== undefined;
      if (!currentProject) {
        return { projects: baseProjects, currentProject: null, isBootstrapped: bootstrapped };
      }
      const projects = baseProjects.some((project) => project.id === currentProject.id)
        ? baseProjects.map((project) =>
            project.id === currentProject.id ? currentProject : project
          )
        : [...baseProjects, currentProject];
      return { projects, currentProject, isBootstrapped: bootstrapped };
    });

    // The active scratch persists in main but doesn't ride the hydrate payload,
    // so without this the toolbar and sidebar show "Open project" after a relaunch
    // into a scratch. Fire-and-forget: nothing on the boot path blocks on it.
    void useScratchStore
      .getState()
      .loadScratches()
      .catch(() => {
        // The switcher reloads scratches whenever it opens; a boot miss self-heals.
      });

    terminalInstanceService.setGPUHardwareAvailable(gpuWebGLHardware ?? true);

    useDistributionStore.getState().setIsWindowsStore(Boolean(hydrateResult.isWindowsStore));

    if (hydrateResult.safeMode) {
      useSafeModeStore.getState().setSafeMode(true, {
        crashCount: hydrateResult.crashCount,
        skippedPanelCount: hydrateResult.skippedPanelCount,
        lastCrashAt: hydrateResult.lastCrashAt,
        quarantinedPanels: hydrateResult.quarantinedPanels,
      });
    } else {
      // Clear stale state when the main process has exited safe mode
      // (e.g. stability timer fired or user restarted normally).
      useSafeModeStore.getState().setSafeMode(false);
    }

    dispatchRecoveryNotifications(hydrateResult);

    normalizeAndApplyScrollback(terminalConfig, logHydrationInfo);

    if (!appState) {
      logWarn("App state returned undefined during hydration, using defaults");
      return;
    }

    // Discover running terminals from the backend
    // Terminals stay running across project switches - we just reconnect to them
    const currentProjectId = currentProject?.id;
    // Owner of the persisted layout and of every live PTY in this view. In a
    // scratch view `currentProject` is null, so keying the restore off it left
    // the grid unrestored and the still-running PTYs orphaned in the pty-host
    // (#11484). Layout and terminal reconnect use this; anything that genuinely
    // needs a git repository (in-repo presets, recipes) keeps using the project.
    const currentWorkspaceId = hydrateResult.workspaceId ?? currentProjectId;
    const projectRoot = currentProject?.path;
    // Whether this view's workspace can have git worktrees at all. A scratch has
    // no project row behind it, and a folder opened without git has one that is
    // explicitly not git-backed (#11405) — neither can ever enumerate a worktree.
    // Every use of the saved `appState.activeWorktreeId` below is gated on this:
    // that value is one app-global field shared by every workspace, so in a
    // worktree-less view it names whichever worktree the last git-backed project
    // left behind.
    //
    // The project row alone cannot answer this. `isGitBackedProject` reads a
    // missing discriminator as git-backed, and the column is NULL both for a
    // real repository (a successful probe deliberately stores NULL) and for a
    // folder that was never classified — including every row predating migration
    // 0008, which added the column with no backfill. A folder with no `.git`
    // behind such a row passed this check and adopted the foreign worktree
    // anyway (#11650), which is exactly what the guard was written to prevent.
    // So the row only supplies the fast, synchronous *negative* cases below; the
    // authoritative answer comes from the workspace host, which probes the
    // folder itself and is therefore also right about a project registered as a
    // repository whose `.git` has since been deleted (#11649).
    const statusPromise = worktreeClient.getAllWithStatus().catch((error) => {
      logWarn("Failed to prefetch worktrees during hydration", { error });
      return null;
    });

    const worktreesPromise = statusPromise.then((status) => status?.worktrees ?? null);

    // Resolved rather than synchronous, because the host is the only party that
    // can distinguish "no repository" from "not reported yet". `restorePanelsPhase`
    // folds it into one derived active id up front — see the note there for why
    // that costs the usual restore nothing.
    //
    // Unknown stays permissive. A host that never became ready, a failed fetch
    // and a host predating the field all answer `gitBacked: null`, and reading
    // any of those as "no worktrees" would strip a real repository's saved
    // selection during the boot race #11234 exists for.
    const workspaceHasWorktreesPromise: Promise<boolean> =
      currentProject == null || !isGitBackedProject(currentProject)
        ? Promise.resolve(false)
        : statusPromise.then((status) => status?.gitBacked !== false);

    // Each of these rides along in the batched hydrate payload when the main
    // process is new enough; the standalone IPC calls only fire as a fallback
    // when the field is absent (older main process, or the safe-boot
    // {ok:false} payload). Mirrors the systemTmpDir fallback above.
    const tabGroupsPromise =
      currentWorkspaceId && options.hydrateTabGroups
        ? hydrateResult.tabGroups !== undefined
          ? Promise.resolve(hydrateResult.tabGroups)
          : projectClient
              .getTabGroups(currentWorkspaceId)
              .then((tabGroups) => tabGroups ?? [])
              .catch((error) => {
                logWarn("Failed to prefetch tab groups", { error });
                return null;
              })
        : null;

    type TerminalSizeMap = Record<string, { cols: number; rows: number }>;
    const emptyTerminalSizes: TerminalSizeMap = {};
    const terminalSizesPromise: Promise<TerminalSizeMap> = currentWorkspaceId
      ? hydrateResult.terminalSizes !== undefined
        ? Promise.resolve(hydrateResult.terminalSizes)
        : projectClient
            .getTerminalSizes(currentWorkspaceId)
            .then((sizes) => sizes ?? emptyTerminalSizes)
            .catch((error) => {
              logWarn("Failed to prefetch terminal sizes", { error });
              return emptyTerminalSizes;
            })
      : Promise.resolve(emptyTerminalSizes);

    const emptyDraftInputs: Record<string, string> = {};
    const draftInputsPromise: Promise<Record<string, string>> = currentWorkspaceId
      ? hydrateResult.draftInputs !== undefined
        ? Promise.resolve(hydrateResult.draftInputs)
        : projectClient
            .getDraftInputs(currentWorkspaceId)
            .then((drafts) => drafts ?? emptyDraftInputs)
            .catch((error) => {
              logWarn("Failed to prefetch draft inputs", { error });
              return emptyDraftInputs;
            })
      : Promise.resolve(emptyDraftInputs);

    const emptyProjectPresets: Record<string, AgentPreset[]> = {};
    const projectPresetsPromise: Promise<Record<string, AgentPreset[]>> = currentProjectId
      ? hydrateResult.projectPresets !== undefined
        ? Promise.resolve(hydrateResult.projectPresets)
        : typeof projectClient.getInRepoPresets === "function"
          ? projectClient.getInRepoPresets(currentProjectId).catch((error) => {
              logWarn("Failed to prefetch project presets during hydration", { error });
              return emptyProjectPresets;
            })
          : Promise.resolve(emptyProjectPresets)
      : Promise.resolve(emptyProjectPresets);

    const recipeLoadPromise = currentProjectId
      ? loadRecipes(currentProjectId).catch((error) => {
          logWarn("Failed to load recipes", { error });
        })
      : null;

    // Start the backend-terminal lookup alongside the other prefetch promises so
    // its IPC round-trip overlaps with draft-input restore and the rest of the
    // synchronous hydration work. The result is consumed inside the panel-restore
    // block below; any rejection is logged inline and converted to `[]` so saved
    // panel restore still proceeds without live backend data — otherwise a failed
    // query would skip restore and the first post-boot save would wipe the saved
    // session (#9928).
    //
    // Perf span is split into startRendererSpan + manual finishGetForProject so
    // the `:end` mark fires when the awaited result is consumed below, not when
    // the in-flight promise settles in the background.
    const finishGetForProjectSpan = currentWorkspaceId
      ? startRendererSpan(PERF_MARKS.HYDRATE_GET_TERMINALS)
      : null;
    const getForProjectPromise: Promise<BackendTerminalInfo[]> = currentWorkspaceId
      ? terminalClient.getForProject(currentWorkspaceId).catch((error: unknown) => {
          logWarn("Failed to query backend terminals; continuing with saved panel restore", {
            error,
          });
          return [];
        })
      : Promise.resolve([]);

    // Restore hybrid input bar draft inputs BEFORE terminal panels are created,
    // so HybridInputBar components pick up drafts from the store at mount time.
    if (currentWorkspaceId) {
      try {
        const draftInputs = await draftInputsPromise;
        // Seed the close-flush baseline from the authoritative on-disk record
        // (even when empty) BEFORE restoring into the store, so a later clear of
        // a hydrated draft yields a removal tombstone instead of resurrecting on
        // next load (#11352).
        draftInputPersistence.primeProject(currentWorkspaceId, draftInputs);
        if (Object.keys(draftInputs).length > 0) {
          useTerminalInputStore
            .getState()
            .restoreProjectDraftInputs(currentWorkspaceId, draftInputs);
        }
      } catch (error) {
        logWarn("Failed to restore draft inputs", { error });
      }
    }

    if (currentWorkspaceId) {
      // Saved→restored panel id remap produced by restorePanelsPhase; consumed
      // by the tab-group hydration block below. Declared here (not in the
      // restore try) so it survives into that block even if panel restore
      // throws, in which case it stays empty and tab groups hydrate unremapped
      // exactly as before (#10440).
      let savedIdToRestoredId = new Map<string, string>();
      try {
        const backendTerminals = await getForProjectPromise;
        finishGetForProjectSpan?.();

        logHydrationInfo(
          `Found ${backendTerminals.length} running terminals for project ${currentWorkspaceId}`
        );

        if (isDaintreeEnvEnabled("DAINTREE_VERBOSE")) {
          logDebug(`Project: ${currentWorkspaceId.slice(0, 8)}`);
          logDebug("Backend terminals", {
            terminals: backendTerminals.map((t) => ({
              id: t.id.slice(0, 8),
              kind: t.kind,
              agentId: t.launchAgentId,
              projectId: t.projectId?.slice(0, 8),
            })),
          });
        }

        // Build a map of backend terminals by ID for quick lookup
        const backendTerminalMap = new Map(backendTerminals.map((t) => [t.id, t]));

        // Prefetch reconnect probes for saved PTY panels that getForProject
        // missed, in one bulk IPC, before the serialized spawn queue would
        // otherwise fire them one-by-one (#10390). Spawn realization stays
        // serialized inside restorePanelsPhase — only the probe lookup moves
        // from "fire IPC inside the queue" to "read from this prefetch map".
        // Timeout/failure resolves to undefined so panel restore falls back to
        // the original per-panel probe path.
        const reconnectPrefetchIds = (appState.terminals ?? [])
          .filter((saved) => {
            // A corrupt saved id would make the strict bulk handler reject the
            // whole batch; keep it out so one bad panel can't disable the
            // prefetch for the rest (it still gets its per-panel fallback).
            if (!saved || typeof saved.id !== "string" || !saved.id.trim()) return false;
            if (isSmokeTestTerminalId(saved.id)) return false;
            if (backendTerminalMap.has(saved.id)) return false;
            const kind = inferKind(saved, currentWorkspaceId);
            return kind !== "assistant" && panelKindHasPty(kind);
          })
          .map((saved) => saved.id);
        const reconnectPrefetchPromise: Promise<
          Record<string, TerminalReconnectResult> | undefined
        > =
          reconnectPrefetchIds.length > 0 && typeof terminalClient.reconnectBulk === "function"
            ? Promise.race([
                terminalClient.reconnectBulk(reconnectPrefetchIds),
                new Promise<undefined>((resolve) =>
                  setTimeout(() => resolve(undefined), RECONNECT_TIMEOUT_MS)
                ),
              ]).catch((error: unknown) => {
                logWarn("Bulk reconnect prefetch failed; falling back to per-panel probes", {
                  error,
                });
                return undefined;
              })
            : Promise.resolve(undefined);

        // Fetch terminal sizes for restoration
        const terminalSizes = await terminalSizesPromise;

        // Passed through raw and withheld inside `restorePanelsPhase` instead of
        // being zeroed here: whether this workspace may adopt it is only known
        // once the host answers, and every consumer there already awaits that
        // fetch. Withheld rather than merely left unselected, because restore
        // re-homes worktree-less and stale-worktree panels onto it — letting it
        // through would stamp another workspace's worktree onto this one's
        // panels.
        const activeWorktreeId = appState.activeWorktreeId ?? null;
        const projectPresetsByAgent = await projectPresetsPromise;

        // Seed the persistence cache so the first save after launch can
        // preserve kind-specific fields for unregistered kinds (e.g., an
        // extension that hasn't re-registered yet). Without this priming,
        // a first save cycle would drop those fields — see issue #5201.
        // appState.terminals is TerminalState[] (IPC wire type, more
        // lenient); the on-disk data was written by panelToSnapshot so is
        // structurally PanelSnapshot[].
        if (currentWorkspaceId && appState.terminals && appState.terminals.length > 0) {
          panelPersistence.primeProject(
            currentWorkspaceId,
            appState.terminals as unknown as PanelSnapshot[]
          );
        }

        if (appState.terminals && appState.terminals.length > 0) {
          panelRestoreStartedAt = Date.now();
          panelRestoreCount = appState.terminals.length;
          markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_PANELS_START, {
            panelCount: panelRestoreCount,
          });
          logHydrationInfo(`Restoring ${appState.terminals.length} saved panel(s)`);
        }

        const prefetchedReconnectResults = await reconnectPrefetchPromise;

        // The per-project MRU head is the terminal the user last had on screen.
        // It is persisted as `terminal:<id>`; strip the prefix to recover the
        // saved panel id so restorePanelsPhase can jump it to the front of the
        // restore queue (#10527). A non-terminal head (browser/dev-preview MRU
        // entry) yields undefined, degrading to the existing ordering.
        const MRU_TERMINAL_PREFIX = "terminal:";
        const mruHead = appState.mruList?.[0];
        const visiblePanelId =
          typeof mruHead === "string" && mruHead.startsWith(MRU_TERMINAL_PREFIX)
            ? mruHead.slice(MRU_TERMINAL_PREFIX.length)
            : undefined;

        const restoreResult = await restorePanelsPhase(appState.terminals, {
          addPanel,
          withHydrationBatch,
          backendTerminalMap,
          prefetchedReconnectResults,
          terminalSizes,
          activeWorktreeId,
          workspaceHasWorktreesPromise,
          projectRoot: projectRoot || "",
          projectId: currentWorkspaceId,
          agentSettings,
          clipboardDirectory,
          projectPresetsByAgent,
          worktreesPromise,
          restoreTerminalOrder: options.restoreTerminalOrder,
          safeMode: hydrateResult.safeMode,
          visiblePanelId,
          // May still read the "balanced" default if the useResourceProfile
          // hook's getResourceProfile() IPC hasn't resolved yet on a cold
          // first hydration (#10528). Acceptable: it only affects background/
          // orphan stagger sizing, errs toward more-aggressive, and self-
          // corrects on the next project switch.
          resourceProfile: useResourceProfileStore.getState().profile,
          logHydrationInfo,
        });
        const { restoreTasks } = restoreResult;
        // Capture the saved→restored panel id remap so the tab-group block
        // below (outside this try) can keep group membership intact when a
        // panel respawned with a fresh id (#10440).
        savedIdToRestoredId = restoreResult.savedIdToRestoredId;

        // Rebuild the deleted-worktree rows for panels whose PTY outlived its
        // worktree (#11911). The rows are in-memory and die with the project
        // view, so every path that rebuilds a view — cold start, reload, LRU
        // recreation, or first open of a project whose worktrees were removed
        // while it was closed — arrives with the survivors homeless. Without a
        // row they render nowhere, `cleanupOrphanedTerminals` below deletes
        // them, and the cleanup sweep that is supposed to retire them never
        // sees them at all.
        //
        // Recorded AFTER the panels are restored so `addDeletedWorktree`'s
        // membership lookup finds them; a row with nothing in it is pruned on
        // the sweep's next tick.
        for (const ghostedId of restoreResult.ghostedWorktreeIds) {
          // The phase reports an id as soon as it resolves a panel onto it,
          // before the `addPanel` that places it can reject. A row with nothing
          // in it is not self-correcting — the sweep arms it, dispatches an
          // empty trash and marks it fired — so confirm the membership that
          // justifies the row actually exists before recording one.
          if (getDeletedWorktreeTerminalIds(ghostedId).length === 0) continue;
          const selectionStore = useWorktreeSelectionStore.getState();
          // A deleted id can never be restored after a restart, so it must not
          // survive as the durable restore target — no-ops unless it is one.
          selectionStore.clearRestoreTarget(ghostedId);
          selectionStore.addDeletedWorktree(createDeletedWorktreeRecord(ghostedId));
        }

        // Schedule scrollback restores at background priority — no blocking IPC
        // fetch on the critical path. The overlay can dismiss immediately and
        // scrollback fills in asynchronously.
        if (restoreTasks.length > 0) {
          markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_SNAPSHOTS_CRITICAL, {
            criticalCount: restoreTasks.length,
          });
          scheduleScrollbackRestore(restoreTasks, () => true);
        }

        if (panelRestoreStartedAt !== null) {
          markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_PANELS_END, {
            panelCount: panelRestoreCount,
            durationMs: Date.now() - panelRestoreStartedAt,
            criticalSnapshotCount: restoreTasks.length,
          });
        }
      } catch (error) {
        logWarn("Failed to restore panels during hydration", { error });
      }

      // Restore tab groups after terminals are restored
      if (options.hydrateTabGroups) {
        try {
          const tabGroups = tabGroupsPromise ? await tabGroupsPromise : [];

          if (tabGroups === null) {
            options.hydrateTabGroups([], { skipPersist: true });
            tabGroupRestoreCount = 0;
            markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_TAB_GROUPS_END, {
              tabGroupCount: tabGroupRestoreCount,
              fallback: "prefetch-error-clear",
            });
          } else {
            // Always call hydrateTabGroups, even with empty array, to clear stale groups
            if (tabGroups.length > 0) {
              logHydrationInfo(`Restoring ${tabGroups.length} tab group(s)`);
            } else {
              logHydrationInfo("Clearing stale tab groups (no groups for project)");
            }
            tabGroupRestoreCount = tabGroups.length;
            // Remap persisted panel ids onto the ids panels actually restored
            // under before handing off to hydrateTabGroups. A panel whose PTY
            // reconnect timed out respawns with a fresh id, so its persisted
            // tab-group entry points at a now-dead saved id; without this remap
            // hydrateTabGroups filters that id out, the group shrinks to one
            // member, and it is discarded and persisted away — permanently
            // destroying the grouping (#10440). The map is sparse and empty
            // whenever every panel kept its saved id, so the fast path leaves
            // the original array untouched.
            const remappedTabGroups =
              savedIdToRestoredId.size > 0
                ? tabGroups.map((group) =>
                    // Leave malformed groups untouched so hydrateTabGroups' own
                    // sanitizer handles them exactly as before — mapping over a
                    // non-array panelIds here would throw and the catch below
                    // would wipe every group for the session.
                    Array.isArray(group.panelIds)
                      ? {
                          ...group,
                          activeTabId:
                            savedIdToRestoredId.get(group.activeTabId) ?? group.activeTabId,
                          panelIds: group.panelIds.map((id) => savedIdToRestoredId.get(id) ?? id),
                        }
                      : group
                  )
                : tabGroups;
            // Seed the tab-group persistence baseline from the on-disk state
            // (pre-remap ids mirror what's actually persisted) so the first
            // save can emit correct removals and Main can merge concurrent
            // writes from sibling windows instead of resurrecting deleted
            // groups (#11350). Mirrors the terminal `primeProject` above.
            if (currentWorkspaceId) {
              panelPersistence.primeTabGroups(
                currentWorkspaceId,
                tabGroups.filter((g) => g && Array.isArray(g.panelIds) && g.panelIds.length > 1)
              );
            }
            options.hydrateTabGroups(remappedTabGroups);
            markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_TAB_GROUPS_END, {
              tabGroupCount: tabGroupRestoreCount,
            });
          }
        } catch (error) {
          logWarn("Failed to restore tab groups", { error });
          // Clear tab groups on error to prevent stale state, but skip persist to avoid wiping storage
          options.hydrateTabGroups([], { skipPersist: true });
          tabGroupRestoreCount = 0;
          markRendererPerformance(PERF_MARKS.HYDRATE_RESTORE_TAB_GROUPS_END, {
            tabGroupCount: tabGroupRestoreCount,
            fallback: "error-clear",
          });
        }
      }
    }

    // Worktree fetch starts earlier to overlap with terminal restoration.
    const worktrees = await worktreesPromise;
    const workspaceHasWorktrees = await workspaceHasWorktreesPromise;
    const savedActiveId = appState.activeWorktreeId;
    // An empty list means "unknown", not "none" — see `getKnownWorktreeIds` in
    // panelRestorePhase for why a cold boot can answer [] while the workspace
    // host is still registering.
    const worktreesAreKnown = worktrees !== null && worktrees.length > 0;
    // Restore re-homes a stranded panel onto the saved active worktree, so a
    // saved selection that is itself gone re-homes onto a dead id. Cleanup
    // would then kill that panel's PTY before the fallback below repairs the
    // selection. Skipping cleanup for one boot lets the repaired selection
    // persist, and the next boot re-homes onto a live worktree.
    const activeWorktreeIsLive =
      !savedActiveId || (worktrees?.some((wt) => wt.id === savedActiveId) ?? false);

    // Runs after terminals are restored so it sees the full list. Destructive —
    // removePanel kills the PTY — so it only runs on a coherent worktree
    // picture: restore keeps a saved worktreeId when the list is unknown
    // (#11234), and cleanup would read that survivor as a deleted worktree and
    // kill a live agent terminal, the exact outcome #11232 ruled out. Panels on
    // a CONFIRMED-deleted worktree now keep their id too, and are exempted by
    // the deleted-worktree row recorded for them above (#11911).
    if (worktreesAreKnown && activeWorktreeIsLive) {
      try {
        const { cleanupOrphanedTerminals } = await import("@/store/createWorktreeStore");
        cleanupOrphanedTerminals();
      } catch (error) {
        logWarn("Failed to cleanup orphaned terminals", { error });
      }
    }

    // A worktree-less workspace has nothing to select, now or ever, so its
    // selection stays null. The empty-list branch below reads an empty list as
    // "the host hasn't reported yet" (#11234) — true while a project's host is
    // still registering, never for a scratch, and never once the host has said
    // the folder has no repository — so without this gate the view adopts
    // whichever worktree the last git-backed project left behind. Nothing then
    // resolves it: the grid renders that foreign worktree's bucket while new
    // panels land in the worktree-less one (invisible panels with live PTYs),
    // and every worktree-resolving action refuses with "Worktree not found".
    // Skipping the call — rather than clearing
    // with `setActiveWorktree(null)` — also leaves the shared persisted restore
    // point intact for the projects that own it.
    if (!workspaceHasWorktrees) {
      if (savedActiveId) {
        logHydrationInfo(
          `Workspace has no worktrees; leaving active worktree unset (ignoring saved ${savedActiveId})`
        );
      }
    } else if (!worktreesAreKnown) {
      // An unknown worktree set keeps the saved selection rather than dropping it
      // on the floor (#11234).
      if (savedActiveId) {
        setActiveWorktree(savedActiveId);
      }
    } else {
      // Check if the saved active worktree still exists
      const worktreeExists = savedActiveId && worktrees.some((wt) => wt.id === savedActiveId);

      if (worktreeExists) {
        // Restore the saved active worktree
        setActiveWorktree(savedActiveId);
      } else {
        // Fallback when the saved selection no longer exists — prefers the main
        // worktree so we never land on a leftover temporary PR worktree (#9512).
        const fallbackWorktree = selectFallbackWorktree(worktrees)!;
        logHydrationInfo(
          `Active worktree ${savedActiveId ?? "(none)"} not found, falling back to: ${fallbackWorktree.name}`
        );
        setActiveWorktree(fallbackWorktree.id);
      }
    }

    // Recipe load starts earlier to overlap with hydration work.
    // Recipes are non-critical for first paint; fire-and-forget on both initial load and project switch.
    if (recipeLoadPromise) {
      void recipeLoadPromise;
    }

    if (appState.developerMode?.enabled && appState.developerMode.autoOpenDiagnostics) {
      const tab = appState.developerMode.focusEventsTab ? "events" : undefined;
      openDiagnosticsDock(tab);
    }

    // Migration: read from new key, fallback to old key for backward compatibility
    const layoutConfig =
      appState.panelGridConfig ??
      (appState as unknown as { terminalGridConfig?: typeof appState.panelGridConfig })
        .terminalGridConfig;
    if (layoutConfig) {
      useLayoutConfigStore.getState().setLayoutConfig(layoutConfig);
    }

    // Restore focus mode from per-project state (hydrate returns per-project focus mode)
    if (options.setFocusMode && appState.focusMode !== undefined) {
      options.setFocusMode(appState.focusMode, appState.focusPanelState);
    }

    // Restore MRU list
    if (options.hydrateMru && Array.isArray(appState.mruList)) {
      options.hydrateMru(appState.mruList);
    }

    // Restore action MRU list
    if (options.hydrateActionMru && Array.isArray(appState.actionMruList)) {
      options.hydrateActionMru(appState.actionMruList);
    }

    // Restore pinned/hidden action prefs (Favorites + hidden Recently used)
    if (options.hydrateActionPrefs) {
      const pinnedIds = Array.isArray(appState.actionPinnedIds)
        ? appState.actionPinnedIds
        : undefined;
      const hiddenIds = Array.isArray(appState.actionHiddenIds)
        ? appState.actionHiddenIds
        : undefined;
      if (pinnedIds || hiddenIds) {
        options.hydrateActionPrefs({ pinnedIds, hiddenIds });
      }
    }
  } catch (error) {
    logError("Failed to hydrate app state", error);
    throw error;
  } finally {
    suppressMruRecording(false);
    markRendererPerformance(PERF_MARKS.HYDRATE_COMPLETE, {
      durationMs: Date.now() - hydrationStartedAt,
      panelCount: panelRestoreCount,
      tabGroupCount: tabGroupRestoreCount,
    });

    if (isRendererPerfCaptureEnabled() && window.electron?.perf) {
      const marks = window.__DAINTREE_PERF_MARKS__ ?? [];
      window.electron.perf.flushMarks({
        marks,
        rendererTimeOrigin: performance.timeOrigin,
        rendererT0: RENDERER_T0,
      });
      window.__DAINTREE_PERF_MARKS__ = [];
    }
  }
}

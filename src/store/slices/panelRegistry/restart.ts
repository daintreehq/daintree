import type { PanelLocation } from "@/types";
import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import {
  terminalClient,
  agentSettingsClient,
  projectClient,
  systemClient,
  globalEnvClient,
} from "@/clients";
import {
  generateAgentCommand,
  buildAgentLaunchFlags,
  buildResumeCommand,
  buildResumeLatestCommand,
  buildLaunchCommandFromFlags,
  stripAssignedSessionIdArgs,
  stripConversationSelectorFlags,
  supportsSessionIdAssignment,
  reconcileBypassFlags,
  reconcileDecorationFlags,
  reconcileInlineModeFlag,
  resolveKeepDecorations,
  resolveEffectiveBypass,
  resolveEffectiveInlineMode,
} from "@shared/types";
import {
  agentClipboardDirectory,
  dropRetiredAgentModel,
  dropUnselectedAgentModel,
  supportsCrossDirectoryResume,
} from "@shared/types/agentSettings";
import { notifyRetiredModelDropped } from "@/services/terminal/retiredModelNotice";
import { resolveInheritedPanelCwd } from "@/services/terminal/panelDuplicationService";
import type { AgentSettingsEntry } from "@shared/types/agentSettings";
import type { AgentState } from "@/types";
import {
  load as loadTerminalService,
  peek as peekTerminalService,
  with as withTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import { TerminalRefreshTier } from "@/types";
import { validateTerminalConfig } from "@/utils/terminalValidation";
import {
  getAgentConfig,
  getMergedPreset,
  sanitizeAgentEnv,
  type AgentPreset,
} from "@/config/agents";
import { getAgentDisplayTitle } from "@shared/config/agentRegistry";
import { agentPresetTitle } from "@shared/utils/agentLaunchPlan";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { panelKindHasPty, panelKindIsDockable } from "@shared/config/panelKindRegistry";
import {
  isPtyPanel,
  type PanelInstance,
  type PanelTitleMode,
  type PtyPanelData,
} from "@shared/types/panel";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import { computeEnvProvenance } from "@shared/utils/agentLifecycleLedger";
import { extractSystemPromptArgs } from "@shared/utils/agentSystemPrompt";
import {
  appendCallerLaunchFlagsToCommand,
  splitCallerLaunchFlags,
} from "@shared/utils/callerLaunchFlags";
import { markTerminalRestarting, unmarkTerminalRestarting } from "@/store/restartExitSuppression";
import { saveNormalized } from "./persistence";
import { buildAgentLaunchContext } from "./agentLaunchContext";
import { optimizeForDock } from "./layout";
import {
  deriveRuntimeStatus,
  reconcileWorktreeAfterSpawn,
  recordExplicitWorktreeAttribution,
  syncWorktreeAttributionToHost,
} from "./helpers";
import { cancelReconnectErrorDebounce } from "./browser";
import { isSpawnUnconfirmed } from "./unconfirmedSpawn";
import { logDebug, logWarn, logError } from "@/utils/logger";
import {
  buildAgentLaunchFlagsForRuntimeSettings,
  mergePresetArgsIntoLaunchFlags,
  resolveAgentRuntimeSettings,
  type AgentRuntimeSettingsResolution,
} from "@/utils/agentRuntimeSettings";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isClientAppError } from "@/utils/clientAppError";
import { requiredPluginToolsSpawnError } from "@/utils/requiredPluginToolsSpawnError";
import type { SpawnError } from "@shared/types/pty-host";
import { transferBetweenWorktreeIndex } from "./worktreeIndex";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { useMemoryPressureWaitStore } from "@/store/memoryPressureWaitStore";
import { isHeldForDriveLease } from "@/store/driveLeaseWaitStore";
import {
  getCurrentLaunchCliDetail,
  resolveAgentLaunchBaseCommand,
} from "@/utils/agentLaunchCommand";
import { isRemoteWindow, resolveHostTmpDir } from "@/hooks/useHostPlatform";

// Lazy accessor to break circular dependency: restart -> projectStore -> panelPersistence -> core.
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

/**
 * The panel's title as of the spawn call rather than as of the capture several
 * awaits earlier. Renaming stays enabled while a terminal restarts, so a rename
 * landing mid-restart would otherwise be overwritten by the respawn, and the
 * pty-host cache rewrite cannot save it — the kill already dropped that entry
 * (#11830). Falls back to the captured panel if this one has since gone.
 */
function titleAtSpawn(
  get: Get,
  id: string,
  captured: { title: string; titleMode?: PanelTitleMode }
): { title: string; titleMode?: PanelTitleMode } {
  const panel = get().panelsById[id];
  const source = panel && isPtyPanel(panel) ? panel : captured;
  return { title: source.title, titleMode: source.titleMode };
}

/**
 * `live`, or the title the saved-launch cleanup gave the pane in its place when
 * it took out a model the restart can't select and reset the generated title
 * naming it (#15569). Only while the pane still shows the title the cleanup
 * read: a rename since then belongs to whoever made it. Returns `live` itself
 * when nothing changes.
 */
function withCleanedModelTitle<T extends { title: string; titleMode?: PanelTitleMode }>(
  live: T,
  saved: { title: string; titleMode?: PanelTitleMode },
  cleaned: { title: string }
): T | { title: string; titleMode?: PanelTitleMode } {
  if (cleaned.title === saved.title) return live;
  if (live.title !== saved.title || live.titleMode !== saved.titleMode) return live;
  return { title: cleaned.title, titleMode: live.titleMode };
}

/**
 * Where a respawn of the pane starts (#14954). A live move refiles a pane
 * without touching its process, so `cwd` can still name the worktree it left;
 * a new process belongs in the one it is filed under, by Duplicate's rule
 * (#11854). The filing is read now rather than from the capture, for the same
 * reason the spawn's worktree is: the respawn awaits, and a move landing
 * meanwhile names where it should start.
 */
function filedLaunchCwd(get: Get, id: string, captured: PtyPanelData): string {
  const live = get().panelsById[id];
  return resolveInheritedPanelCwd({
    cwd: captured.cwd,
    worktreeId: live ? live.worktreeId : captured.worktreeId,
  });
}

interface LoadedAgentRuntimeSettings {
  entry: AgentSettingsEntry;
  settings: AgentRuntimeSettingsResolution;
  tmpDir: string;
  /** Global skip-permissions override at restart time (#10432). */
  globalSkipPermissions: boolean;
  /** Global "use alt-screen mode by default" override at restart time (#10876). */
  globalUseAltScreen: boolean;
}

function mergeSpawnEnv(
  globalEnv: Record<string, string>,
  projectEnv: Record<string, string>,
  runtimeEnv: Record<string, string> | undefined
): Record<string, string> | undefined {
  const hasAny =
    Object.keys(globalEnv).length > 0 ||
    Object.keys(projectEnv).length > 0 ||
    Boolean(runtimeEnv && Object.keys(runtimeEnv).length > 0);
  return hasAny ? { ...globalEnv, ...projectEnv, ...(runtimeEnv ?? {}) } : undefined;
}

async function fetchGlobalEnv(): Promise<Record<string, string>> {
  return globalEnvClient.get().catch((error: unknown) => {
    logWarn("[TerminalStore] Failed to fetch global environment variables", { error });
    return {} as Record<string, string>;
  });
}

async function buildRestartEnv(
  projectId: string | undefined,
  runtimeEnv: Record<string, string> | undefined,
  context: string
): Promise<Record<string, string> | undefined> {
  const [globalEnv, projectEnv] = await Promise.all([
    fetchGlobalEnv(),
    projectId
      ? projectClient
          .getSettings(projectId)
          .then((settings) => settings?.environmentVariables ?? ({} as Record<string, string>))
          .catch((error: unknown) => {
            logWarn(`[TerminalStore] Failed to fetch project env for ${context}`, { error });
            return {} as Record<string, string>;
          })
      : Promise.resolve({} as Record<string, string>),
  ]);
  return mergeSpawnEnv(globalEnv, projectEnv, runtimeEnv);
}

/**
 * Something new runs in the shell an agent left behind: another agent, a
 * recognised process, or any busy foreground job (`background` is what a busy
 * plain shell reports). A forced resume would tear it down (#13226).
 */
function shellMovedOn(panel: PtyPanelData): boolean {
  return (
    panel.detectedAgentId !== undefined ||
    panel.detectedProcessId !== undefined ||
    panel.activityType === "background"
  );
}

// Helper to update a single terminal field in the normalized store
function updateTerminal(
  state: PanelRegistrySlice,
  id: string,
  updater: (t: PanelRegistrySlice["panelsById"][string]) => PanelRegistrySlice["panelsById"][string]
): { panelsById: Record<string, PanelRegistrySlice["panelsById"][string]> } | typeof state {
  const terminal = state.panelsById[id];
  if (!terminal) return state;
  return { panelsById: { ...state.panelsById, [id]: updater(terminal) } };
}

/** {@link updateTerminal}, then persisted, for writes a reload must not undo. */
/**
 * A relaunch main refused for missing plugin tools (#14096): shown as the
 * spawn banner with its choices, and the agent marked exited, since no process
 * started that could ever report it stopped.
 */
function refusedForPluginTools(t: PtyPanelData, spawnError: SpawnError): PtyPanelData {
  return {
    ...t,
    spawnStatus: "failed",
    spawnError,
    runtimeStatus: "error",
    ...(t.launchAgentId ? { agentState: "exited" as const, lastStateChange: Date.now() } : {}),
  };
}

function updateAndSaveTerminal(
  set: Set,
  id: string,
  updater: (t: PanelRegistrySlice["panelsById"][string]) => PanelRegistrySlice["panelsById"][string]
): void {
  set((state) => {
    const next = updateTerminal(state, id, updater);
    if (next !== state) saveNormalized(next.panelsById, state.panelIds);
    return next;
  });
}

/**
 * A restart whose new PTY is up. "exited" survives deriveRuntimeStatus, so it
 * is dropped here, once the spawn has succeeded: a respawn that failed stays
 * reading as dead.
 */
function respawned(
  t: PanelRegistrySlice["panelsById"][string]
): PanelRegistrySlice["panelsById"][string] {
  if (!isPtyPanel(t)) return t;
  if (t.runtimeStatus !== "exited") return { ...t, isRestarting: false };
  return {
    ...t,
    isRestarting: false,
    runtimeStatus: deriveRuntimeStatus(t.isVisible, t.flowStatus, undefined),
  };
}

/**
 * Keep a pane's conversation findable when its directory changes under it
 * (#12434). Only for agents that resume across directories — the others can't
 * reopen a conversation anywhere but where it began, so there is nothing to
 * point back at — unless the pane is held with that conversation in hand
 * (#13509): its Resume then has to run where the conversation began.
 */
function conversationOriginPatch(
  panel: PanelInstance,
  nextCwd: string,
  holdsConversation = false
): { conversationCwd?: string } {
  if (!isPtyPanel(panel) || panel.cwd === nextCwd) return {};
  if (!holdsConversation && !supportsCrossDirectoryResume(panel.launchAgentId)) return {};
  const origin = panel.conversationCwd || panel.cwd;
  return { conversationCwd: origin && origin !== nextCwd ? origin : undefined };
}

export const createRestartActions = (
  set: Set,
  get: Get
): Pick<
  PanelRegistrySlice,
  | "restartTerminal"
  | "clearTerminalError"
  | "updateTerminalCwd"
  | "confirmRestoreRecoveryDestination"
  | "moveTerminalToWorktree"
  | "moveToNewWorktree"
  | "setWorktreeMoveNotice"
  | "updateFlowStatus"
  | "setRuntimeStatus"
  | "setInputLocked"
  | "toggleInputLocked"
  | "setHoldOnRestart"
  | "activateFallbackPreset"
  | "restartTerminalOnPreset"
  | "dismissSessionLost"
  | "dismissAllSessionLost"
> => ({
  // Dismissing the banner acknowledges the lost session, which is exactly what
  // `sessionLostOnRestore` tracks — so consume the signal rather than shadowing
  // it with a second "was it dismissed" flag. Keeping the acknowledgement in the
  // store is the fix for #11589: a worktree switch unmounts the pane, so
  // component state could never survive it. Same reasoning as the restart path
  // below, which has always cleared this signal on acknowledgement (#9802).
  dismissSessionLost: (id) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal || !isPtyPanel(terminal)) return state;
      // Already acknowledged (or never flagged) — keep the same state object so
      // a repeat dismissal doesn't wake every subscriber.
      if (!terminal.sessionLostOnRestore) return state;
      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, sessionLostOnRestore: undefined },
        },
      };
    });
  },

  // One atomic pass over the carrier so N flagged panes produce a single store
  // notification. Iterates `panelsById` directly, not `panelIds`: a hydration
  // batch publishes the carrier before appending ids (#9655), and this action
  // exists precisely for the post-restart moment when many panels are flagged.
  // Deliberately unscoped by worktree — leaving flagged panels behind a
  // worktree switch is the bug this issue is about.
  dismissAllSessionLost: () => {
    set((state) => {
      let next: Record<string, PanelInstance> | undefined;
      for (const [panelId, panel] of Object.entries(state.panelsById)) {
        if (!isPtyPanel(panel) || !panel.sessionLostOnRestore) continue;
        next ??= { ...state.panelsById };
        next[panelId] = { ...panel, sessionLostOnRestore: undefined };
      }
      // Nothing flagged — return the same state object so no subscriber wakes.
      if (!next) return state;
      return { panelsById: next };
    });
  },

  restartTerminal: async (id, options) => {
    const allowResumeLatest = options?.allowResumeLatest !== false;
    const terminal = get().panelsById[id];
    const forcedResumeSessionId = options?.resumeSessionId;

    if (!terminal) {
      logWarn("[TerminalStore] Cannot restart: terminal not found", { id });
      return;
    }

    // Non-PTY panels don't have PTY processes to restart
    if (!panelKindHasPty(terminal.kind ?? "terminal")) {
      logWarn("[TerminalStore] Cannot restart non-PTY panel", { id });
      return;
    }

    if (!isPtyPanel(terminal)) return;

    // A pane held for recovery has no process to restart, and a restart would
    // pick its conversation by itself — the choice the hold exists to leave to
    // the user (#12434). The pane's own actions launch it.
    if (terminal.restoreRecovery) {
      logWarn("[TerminalStore] Cannot restart a pane held for recovery", { id });
      return;
    }

    // Nor one held for memory pressure (#13530): nothing has started yet, and
    // its gate is where it starts now or carries on waiting.
    if (useMemoryPressureWaitStore.getState().heldPanelIds[id] === true) {
      logWarn("[TerminalStore] Cannot restart a pane held for memory pressure", { id });
      return;
    }

    // Nor one waiting for control of its project (#13913): its launch starts
    // once this view drives, and a restart alongside it would spawn twice.
    if (isHeldForDriveLease(id)) {
      logWarn("[TerminalStore] Cannot restart a pane waiting for control", { id });
      return;
    }

    // Nor one whose launch lost its answer with the link (#13915): the host may
    // be running it, and the check that settles the pane is still out.
    if (isSpawnUnconfirmed(id)) {
      logWarn("[TerminalStore] Cannot restart a pane still checking its launch with the host", {
        id,
      });
      return;
    }

    // Guard against concurrent restart attempts
    if (terminal.isRestarting) {
      logWarn("[TerminalStore] Terminal is already restarting, ignoring", { id });
      return;
    }

    // Refused before anything is reset, so a pane the user has carried on in
    // keeps its live state untouched; re-checked once more before the kill.
    if (forcedResumeSessionId && terminal.launchAgentId && shellMovedOn(terminal)) {
      logWarn("[TerminalStore] Forced resume refused: the pane moved on", { id });
      return;
    }

    // Mark as restarting SYNCHRONOUSLY first to prevent exit event race condition.
    // This is checked in the onExit handler before the store state.
    markTerminalRestarting(id);

    // Drop any pending reconnect-error debounce so a stale write can't fire
    // after we've cleared the error inline below.
    cancelReconnectErrorDebounce(id);

    // Evict any buffered flow-status/held-duration patch so a pending RAF flush
    // can't resurrect the previous process's "paused" pill after the clear
    // below (#9899). onExit skips this for restarts (markTerminalRestarting),
    // so the restart path must do it itself. Dynamic-import panelStatusBuffer
    // to avoid a static slice→panelStore cycle (the cold-graph init gate in
    // worktreeStore.circularInit.test.ts); the await lands after the
    // synchronous markTerminalRestarting, so the exit-race guard is unaffected.
    const { cancelTerminalFlowState } = await import("@/store/panelStatusBuffer");
    cancelTerminalFlowState(id);

    // Also set the store flag for UI and other consumers
    // Track whether we're restarting from a failed spawn so we can clear
    // spawnStatus (allowing XtermAdapter to mount) and restore it on failure.
    const ptyPanel = get().panelsById[id] as import("@shared/types/panel").PtyPanelData | undefined; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrow to PtyPanelData for spawnStatus access
    const wasFailed = ptyPanel?.spawnStatus === "failed";
    set((state) =>
      updateTerminal(state, id, (t) => {
        const ptyPanel = t as import("@shared/types/panel").PtyPanelData; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- guarded by isPtyPanel check above
        return {
          ...t,
          restartError: undefined,
          reconnectError: undefined,
          spawnError: undefined,
          scrollbackRestoreError: undefined,
          // attachError is deliberately NOT cleared here: this reset runs
          // before the restart is validated, so clearing it would hide the
          // banner while the old unpaintable terminal is still on screen
          // (#11776). The service clears it when a terminal actually opens, and
          // destroy() clears it when one is torn down — both strictly after the
          // point of no return.
          // A restart spins up a fresh PTY process; flow state from the previous
          // process must not survive into it or the paused pill would linger
          // (#9899). The host only re-emits flow status on a pause/resume
          // transition, so without this the stale value persists indefinitely.
          // Re-derive runtimeStatus too — dock pills and tab labels read it, and
          // it would otherwise keep folding the now-cleared paused flow status.
          flowStatus: undefined,
          flowStatusTimestamp: undefined,
          heldDurationMs: undefined,
          runtimeStatus: deriveRuntimeStatus(ptyPanel.isVisible, undefined, ptyPanel.runtimeStatus),
          isRestarting: true,
          // The user is explicitly starting a fresh session, so the
          // session-lost restore signal has been acknowledged — clear it so the
          // banner doesn't linger across the restart (issue #9802).
          sessionLostOnRestore: undefined,
          ...(wasFailed ? { spawnStatus: undefined } : {}),
        };
      })
    );

    // The folder stays put when the caller just chose it, and for an explicit
    // resume of an agent that can only reopen a conversation where it began
    // (#13509). Anything else starts where the pane is filed (#14954).
    const keepsCwd =
      options?.keepCwd === true ||
      (!!forcedResumeSessionId &&
        !!terminal.launchAgentId &&
        !supportsCrossDirectoryResume(terminal.launchAgentId));
    const plannedCwd = keepsCwd ? terminal.cwd : resolveInheritedPanelCwd(terminal);

    // Validate configuration before attempting restart, against the folder it
    // will start in: a pane whose old worktree has gone can still start in the
    // one it is filed under.
    let validation;
    try {
      validation = await validateTerminalConfig(
        plannedCwd === terminal.cwd ? terminal : { ...terminal, cwd: plannedCwd }
      );
    } catch (error) {
      // Validation itself failed (e.g., IPC error)
      const restartError = {
        message: "Failed to validate terminal configuration",
        timestamp: Date.now(),
        recoverable: false,
        context: {
          failedCwd: plannedCwd,
          validationError: formatErrorMessage(error, "Failed to validate terminal configuration"),
        },
      };

      unmarkTerminalRestarting(id);
      set((state) =>
        updateTerminal(state, id, (t) => ({ ...t, isRestarting: false, restartError }))
      );
      logError("[TerminalStore] Validation error for terminal", error, { id });
      return;
    }

    if (!validation.valid) {
      // Set error state instead of attempting doomed restart
      const primaryError = validation.errors.find((e) => !e.recoverable) || validation.errors[0];

      const restartError = {
        message: validation.errors.map((e) => e.message).join("; "),
        code: primaryError?.code,
        timestamp: Date.now(),
        recoverable: validation.errors.every((e) => e.recoverable),
        context: {
          failedCwd: plannedCwd,
          errors: validation.errors,
        },
      };

      unmarkTerminalRestarting(id);
      set((state) =>
        updateTerminal(state, id, (t) => ({
          ...t,
          isRestarting: false,
          restartError,
          ...(wasFailed ? { spawnStatus: "failed" as const } : {}),
        }))
      );
      logWarn("[TerminalStore] Restart validation failed for terminal", { id, restartError });
      return;
    }

    // Re-read terminal from state in case it was modified during async validation
    const _currentTerminalRaw = get().panelsById[id];
    if (!_currentTerminalRaw || !isPtyPanel(_currentTerminalRaw)) {
      unmarkTerminalRestarting(id);
      set((state) => updateTerminal(state, id, (t) => ({ ...t, isRestarting: false })));
      logWarn("[TerminalStore] Terminal no longer exists or was trashed", { id });
      return;
    }
    // A pane saved with a retired model fails on every start (#15652), and a
    // restart never selects a model for an agent that takes one only on a new
    // headless run (#15569). Each command below (fresh, resume, the saved one
    // as a fallback) and the state the restart persists read these cleaned
    // fields, so none can replay it.
    const { launch: withoutRetired, droppedModelIds: droppedFromSaved } = dropRetiredAgentModel(
      _currentTerminalRaw.launchAgentId,
      _currentTerminalRaw
    );
    const currentTerminal = dropUnselectedAgentModel(
      _currentTerminalRaw.launchAgentId,
      withoutRetired,
      { replay: true }
    );
    const droppedModelIds = new Set(droppedFromSaved);

    if (currentTerminal.location === "trash") {
      // Terminal was removed or trashed while we were validating
      unmarkTerminalRestarting(id);
      set((state) => updateTerminal(state, id, (t) => ({ ...t, isRestarting: false })));
      logWarn("[TerminalStore] Terminal no longer exists or was trashed", { id });
      return;
    }

    const targetLocation = currentTerminal.location;

    // For agent terminals, regenerate command from current settings
    // For other terminals, use the saved command
    let commandToRun = currentTerminal.command;
    let usedResumeLatest = false;
    const effectiveAgentId = currentTerminal.launchAgentId;
    // Gate on launch intent (`effectiveAgentId`, derived from the sealed
    // `launchAgentId`) plus two demotion
    // signals:
    //   - `exitCode !== undefined` — the PTY has truly exited (onExit path).
    //   - `agentState === "exited"` — the FSM saw the detected agent quit
    //     to shell; this state is preserved across demoted restarts so
    //     subsequent restarts stay demoted (issue #5764).
    // `panelStoreListeners.onAgentExited` must NOT clear `agentId` — if it
    // did, a cold-launched agent that `/quit`s into its shell would lose its
    // launch identity and relaunch decisions would misclassify. #5807
    // A failed-to-start agent spawn now carries `agentState === "exited"` so MCP
    // read paths surface the crash (#10816), but it never actually ran and must
    // relaunch as the agent rather than demote to a shell. `wasFailed`
    // (captured above before spawnStatus is cleared for the restart) means
    // "never started". Gate it on a surviving `command`: a failed *agent* launch
    // keeps its agent command, whereas a demoted shell (an agent that quit to
    // its shell) has `command` cleared — without this, a demoted shell whose
    // restart then fails to spawn would wrongly re-promote to an agent (#5764).
    const failedAgentLaunch = wasFailed && currentTerminal.command !== undefined;
    // An explicit resume names the conversation to reopen, so the pane relaunches
    // as its agent whatever it is running now (#13226).
    const forcedResume = !!effectiveAgentId && !!forcedResumeSessionId;
    const isAgent =
      forcedResume ||
      (!!effectiveAgentId &&
        (currentTerminal.agentState !== "exited" || failedAgentLaunch) &&
        currentTerminal.exitCode === undefined);
    const isDemotedAgent = !!effectiveAgentId && !isAgent;
    let loadedRuntimeSettings: LoadedAgentRuntimeSettings | undefined;
    let runtimeSettingsLoaded = false;
    // The caller's verbatim flags (#13046) sit out every rebuild and reconcile
    // below and are re-appended last, once the settings-derived part is final.
    const { base: storedBaseFlags, caller: storedCallerFlags } = splitCallerLaunchFlags(
      currentTerminal.agentLaunchFlags,
      currentTerminal.callerLaunchFlags
    );
    // A restart that moves the pane picks its conversation itself, so a
    // caller's own selector (`--continue`, `resume --last`) can't ride along
    // and reopen whichever conversation the new folder has last (#14954).
    let callerLaunchFlags =
      plannedCwd !== terminal.cwd
        ? stripConversationSelectorFlags(storedCallerFlags, effectiveAgentId)
        : storedCallerFlags;
    let nextAgentLaunchFlags =
      currentTerminal.agentLaunchFlags === undefined ? undefined : storedBaseFlags;
    let nextAgentPresetId = currentTerminal.agentPresetId;
    let nextAgentPresetColor = currentTerminal.agentPresetColor;
    let nextOriginalPresetId = currentTerminal.originalPresetId;
    // The resume-vs-fresh command choice is deferred until after the kill:
    // the graceful shutdown during the kill is what captures the live session
    // id, so choosing beforehand would always miss it. These carry the
    // precomputed pieces across the teardown — all are re-synced inside the
    // `isAgent` block below before the post-kill selection reads them.
    let resumeFlags = nextAgentLaunchFlags;
    let consumedSessionId: string | undefined;
    let freshCommand = commandToRun;
    let freshLaunchFlags = nextAgentLaunchFlags;
    let resolvedAgentBaseCommand: string | undefined;

    const loadAgentRuntimeSettings = async (): Promise<LoadedAgentRuntimeSettings | undefined> => {
      if (!effectiveAgentId || runtimeSettingsLoaded) return loadedRuntimeSettings;
      runtimeSettingsLoaded = true;
      try {
        const [agentSettings, tmpDir] = await Promise.all([
          agentSettingsClient.get(),
          resolveHostTmpDir(() => systemClient.getTmpDir()).catch(() => ""),
        ]);
        const entry = (agentSettings?.agents?.[effectiveAgentId] ?? {}) as AgentSettingsEntry;
        const ccrPresets = useCcrPresetsStore.getState().ccrPresetsByAgent[effectiveAgentId];
        const projectPresets = useProjectPresetsStore.getState().presetsByAgent[effectiveAgentId];
        const settings = resolveAgentRuntimeSettings({
          agentId: effectiveAgentId,
          presetId: currentTerminal.agentPresetId,
          entry,
          ccrPresets,
          projectPresets,
        });
        loadedRuntimeSettings = {
          entry,
          settings,
          tmpDir,
          globalSkipPermissions: agentSettings?.globalSkipPermissions ?? false,
          globalUseAltScreen: agentSettings?.globalUseAltScreen ?? false,
        };
        if (settings.presetWasStale) {
          nextAgentPresetId = undefined;
          nextAgentPresetColor = undefined;
          nextOriginalPresetId = undefined;
        } else if (settings.preset) {
          nextAgentPresetColor = settings.preset.color ?? currentTerminal.agentPresetColor;
        }
        return loadedRuntimeSettings;
      } catch (error) {
        logWarn("[TerminalStore] Failed to load agent runtime settings for restart", { error });
        return undefined;
      }
    };

    const runtimeForEnv = effectiveAgentId ? await loadAgentRuntimeSettings() : undefined;
    if (runtimeForEnv?.settings.presetWasStale && effectiveAgentId) {
      nextAgentLaunchFlags = buildAgentLaunchFlagsForRuntimeSettings(
        runtimeForEnv.settings.effectiveEntry,
        effectiveAgentId,
        undefined,
        {
          modelId: currentTerminal.agentModelId,
          // Only the preset went stale; the caller's standing instruction still
          // applies and has no settings to be rebuilt from (#12431).
          systemPromptArgs: extractSystemPromptArgs(storedBaseFlags, effectiveAgentId),
          globalSkipPermissions: runtimeForEnv.globalSkipPermissions,
          globalUseAltScreen: runtimeForEnv.globalUseAltScreen,
        }
      );
    }

    if (isAgent && effectiveAgentId) {
      const presetForLaunchFlags = runtimeForEnv?.settings.preset;
      if (presetForLaunchFlags) {
        nextAgentLaunchFlags = mergePresetArgsIntoLaunchFlags(
          nextAgentLaunchFlags,
          presetForLaunchFlags
        );
      }
      // Reconcile the persisted bypass (#10432) and inline (#10876) flags against
      // the current effective settings before any resume/from-flags command is
      // built (the "resume trap"): a snapshot captured while the global
      // skip-permissions or alt-screen switch was in a different state must not
      // survive once it's flipped. `nextAgentLaunchFlags` (stored + from-flags
      // rebuild) reconciles only captured flags; `resumeFlags` additionally
      // injects the tokens into an empty snapshot so a session launched before
      // either feature honours the current resolution.
      resumeFlags = nextAgentLaunchFlags;
      if (runtimeForEnv) {
        const effectiveBypass = resolveEffectiveBypass(
          runtimeForEnv.settings.effectiveEntry,
          effectiveAgentId,
          runtimeForEnv.globalSkipPermissions
        );
        const effectiveInline = resolveEffectiveInlineMode(
          runtimeForEnv.settings.effectiveEntry,
          effectiveAgentId,
          runtimeForEnv.globalUseAltScreen
        );
        const dangerousArgs = runtimeForEnv.settings.effectiveEntry.dangerousArgs;
        const reconcileFlags = (base: string[]): string[] =>
          reconcileDecorationFlags(
            reconcileInlineModeFlag(
              reconcileBypassFlags(base, effectiveAgentId, effectiveBypass, dangerousArgs),
              effectiveAgentId,
              effectiveInline
            ),
            effectiveAgentId,
            resolveKeepDecorations(runtimeForEnv.settings.effectiveEntry)
          );
        // A caller-only snapshot is still a captured configuration: its empty
        // settings-derived part gets the tokens the fresh command replays too.
        if ((nextAgentLaunchFlags?.length ?? 0) > 0 || callerLaunchFlags.length > 0) {
          nextAgentLaunchFlags = reconcileFlags(nextAgentLaunchFlags ?? []);
          resumeFlags = nextAgentLaunchFlags;
        } else {
          const injectedFromEmpty = reconcileFlags([]);
          if (injectedFromEmpty.length > 0) resumeFlags = injectedFromEmpty;
        }
      }
      if (callerLaunchFlags.length > 0) {
        nextAgentLaunchFlags = [...(nextAgentLaunchFlags ?? []), ...callerLaunchFlags];
        resumeFlags = [...(resumeFlags ?? []), ...callerLaunchFlags];
      }
      // Only the fresh-launch command (the no-resume outcome) can be derived
      // up front, while the settings IPCs are already loaded. Whether it
      // actually spawns is decided post-kill, once the graceful shutdown has
      // had its chance to capture the live session id.
      freshCommand = commandToRun;
      freshLaunchFlags = nextAgentLaunchFlags;
      {
        const persistedFlags = freshLaunchFlags;
        let hasPersistedFlags = Boolean(persistedFlags && persistedFlags.length > 0);
        const agentConfig = getAgentConfig(effectiveAgentId);
        const registryBaseCommand = agentConfig?.command || effectiveAgentId;
        const baseCommand = resolveAgentLaunchBaseCommand(
          registryBaseCommand,
          await getCurrentLaunchCliDetail(effectiveAgentId)
        );
        if (baseCommand !== registryBaseCommand) resolvedAgentBaseCommand = baseCommand;
        const runtimeSettings = runtimeForEnv ?? (await loadAgentRuntimeSettings());
        if (!hasPersistedFlags && runtimeSettings) {
          freshLaunchFlags = buildAgentLaunchFlagsForRuntimeSettings(
            runtimeSettings.settings.effectiveEntry,
            effectiveAgentId,
            runtimeSettings.settings.preset,
            {
              modelId: currentTerminal.agentModelId,
              globalSkipPermissions: runtimeSettings.globalSkipPermissions,
              globalUseAltScreen: runtimeSettings.globalUseAltScreen,
            }
          );
          hasPersistedFlags = freshLaunchFlags.length > 0;
        }

        if (hasPersistedFlags && effectiveAgentId !== "gemini") {
          // Sync fast path: non-Gemini agents have no runtime-dynamic flag
          // injection, so the persisted flags are the complete command.
          freshCommand = buildLaunchCommandFromFlags(
            baseCommand,
            effectiveAgentId,
            freshLaunchFlags as string[]
          );
        } else {
          // Async path: either Gemini (needs clipboard directory re-injection)
          // or no persisted flags (needs settings-derived fallback).
          try {
            const runtimeSettings = runtimeForEnv ?? (await loadAgentRuntimeSettings());
            const tmpDir = runtimeSettings?.tmpDir ?? "";
            const clipboardDirectory = tmpDir
              ? agentClipboardDirectory(tmpDir, isRemoteWindow())
              : undefined;
            if (hasPersistedFlags) {
              const entry = runtimeSettings?.entry;
              const shareClipboardDirectory = entry?.shareClipboardDirectory as boolean | undefined;
              freshCommand = buildLaunchCommandFromFlags(
                baseCommand,
                effectiveAgentId,
                freshLaunchFlags as string[],
                { clipboardDirectory, shareClipboardDirectory }
              );
            } else if (runtimeSettings) {
              freshCommand = generateAgentCommand(
                baseCommand,
                runtimeSettings.settings.effectiveEntry,
                effectiveAgentId,
                {
                  clipboardDirectory,
                  modelId: currentTerminal.agentModelId,
                  presetArgs: runtimeSettings.settings.preset?.args,
                  globalSkipPermissions: runtimeSettings.globalSkipPermissions,
                  globalUseAltScreen: runtimeSettings.globalUseAltScreen,
                }
              );
            }
          } catch (error) {
            logWarn(
              "[TerminalStore] Failed to load agent settings for restart, using saved command",
              {
                error,
              }
            );
          }
        }
      }
    }

    // A forced resume reopens a conversation in a shell its agent left behind.
    // Anything now running there — a command the user typed, another agent —
    // means they carried on in the meantime, and tearing it down for the old
    // conversation would discard their work (#13226). Checked last, after every
    // settings await, as the final gate before the shell is killed.
    if (forcedResume) {
      const live = get().panelsById[id];
      if (!live || !isPtyPanel(live) || live.location === "trash" || shellMovedOn(live)) {
        unmarkTerminalRestarting(id);
        set((state) => updateTerminal(state, id, (t) => ({ ...t, isRestarting: false })));
        logWarn("[TerminalStore] Forced resume abandoned: the pane moved on", { id });
        return;
      }
    }

    let launchCwd = currentTerminal.cwd;
    try {
      // CAPTURE LIVE DIMENSIONS before destroying the frontend
      const managedInstance = peekTerminalService()?.get(id);
      let spawnCols = currentTerminal.cols || 80;
      let spawnRows = currentTerminal.rows || 24;
      if (managedInstance?.terminal) {
        spawnCols = managedInstance.terminal.cols || spawnCols;
        spawnRows = managedInstance.terminal.rows || spawnRows;
      }

      // Lock input on the live instance while the restart is in flight, so
      // keystrokes can't leak into the kill/spawn window. Bypass the store
      // action to avoid persisting `isInputLocked: true` to disk for a
      // transient state.
      peekTerminalService()?.setInputLocked(id, true);

      // AGGRESSIVE TEARDOWN: Destroy frontend FIRST to prevent race condition
      peekTerminalService()?.destroy(id);

      withTerminalService((service) => service.suppressNextExit(id, 10000), id);

      // Capture project ID before async work to avoid race conditions (issue #3690).
      // The respawn keeps the panel's workspace ownership (project or scratch) so a
      // restarted scratch terminal is still killed with its scratch (#11079); project
      // settings stay keyed on the registered project id.
      const projectStore = await resolveProjectStore();
      const capturedProjectId = projectStore.getState().currentProject?.id;
      const capturedWorkspaceId = capturedProjectId ?? getViewWorkspaceId() ?? undefined;

      // Agent terminals kill via gracefulKill: Main already routes every
      // agent kill through the graceful-shutdown quit-and-capture flow, but
      // only the gracefulKill channel returns the captured session id — the
      // bare kill channel discards it. Parallelized with the env-fetch IPCs
      // (#9164): they have no ordering dependency, so awaiting them serially
      // adds a needless round-trip to the restart hot path.
      const [capturedSessionId, restartEnv] = await Promise.all([
        (async (): Promise<string | null> => {
          // A forced resume of a pane whose agent already quit has nothing live
          // to quit and capture; the shell it left behind just goes.
          if (isAgent && !(forcedResume && currentTerminal.agentState === "exited")) {
            try {
              const captured = await terminalClient.gracefulKill(id, { forRestart: true });
              // A failed spawn usually left nothing on the host, but one whose
              // answer was lost may be running there (#13915), so it is quit and
              // captured like any agent. When nothing was captured, the bare kill
              // below still runs PtyManager's missing-terminal cleanup
              // (session-file delete), which the graceful channel skips on a
              // registry miss.
              if (captured !== null || !wasFailed) return captured;
            } catch (error) {
              logWarn("[TerminalStore] gracefulKill failed during restart; falling back to kill", {
                id,
                error,
              });
            }
          }
          await terminalClient.kill(id, { forRestart: true }).catch((error: unknown) => {
            logWarn("[TerminalStore] kill failed during restart; continuing", { id, error });
          });
          return null;
        })(),
        buildRestartEnv(capturedProjectId, runtimeForEnv?.settings.env, "restart"),
      ]);

      // Settled here, with no await before the command choice and the state
      // write that follow, so the command is chosen for the folder it runs in.
      // A move landing after the write is an ordinary live move (#11853),
      // judged against the folder the pane now records.
      launchCwd = keepsCwd ? currentTerminal.cwd : filedLaunchCwd(get, id, currentTerminal);
      const relocated = launchCwd !== currentTerminal.cwd;

      // Choose the spawn command now that the live session id (if any) is in
      // hand: an exact resume of THIS pane's session wins; the agent's
      // resume-latest fallback covers a missed capture (#8787); otherwise the
      // fresh-launch command derived above. Resume-latest alone is what used
      // to restart panes into the wrong conversation: it resolves to the most
      // recently active session in scope (`codex resume --last`,
      // `claude --continue`), which with several terminals of the same agent
      // is often another pane's session.
      if (isAgent && effectiveAgentId) {
        // Captured beats stored: a stored id dates from a resume launch and
        // goes stale the moment the CLI rotates session ids mid-run. Two
        // gates on the capture:
        //   - identity: the graceful shutdown quits whatever agent is LIVE
        //     (detected), so a pane whose detected identity diverged from its
        //     launch identity (e.g. a Claude pane hosting a hand-started
        //     Codex) would otherwise build `claude --resume <codex-id>`.
        //   - fresh intent: `allowResumeLatest: false` (the update-cwd flow)
        //     discards the capture too — the directory under the panel has
        //     changed, and resuming a session scoped to the old one would mask
        //     that. A stored id still resumes in that case (pre-existing
        //     contract the update-cwd flow relies on).
        const captureTrusted =
          allowResumeLatest &&
          (currentTerminal.detectedAgentId === undefined ||
            currentTerminal.detectedAgentId === effectiveAgentId);
        // A conversation reopens in another folder only for an agent that
        // resumes across directories. The rest start over where the pane now
        // runs; the restart journaled the conversation they leave, so it still
        // reopens where it began (#14954).
        const resumesHere = !relocated || supportsCrossDirectoryResume(effectiveAgentId);
        const sessionId = resumesHere
          ? (forcedResumeSessionId ??
            (captureTrusted ? capturedSessionId : null) ??
            currentTerminal.agentSessionId)
          : undefined;
        if (sessionId) {
          // An exact candidate never degrades to resume-latest: if its
          // command can't be built, the safe outcome is a fresh launch, not
          // "most recent session in scope".
          const resumeCmd = resolvedAgentBaseCommand
            ? buildResumeCommand(effectiveAgentId, sessionId, resumeFlags, resolvedAgentBaseCommand)
            : buildResumeCommand(effectiveAgentId, sessionId, resumeFlags);
          if (resumeCmd) {
            commandToRun = resumeCmd;
            consumedSessionId = sessionId;
          }
        } else if (allowResumeLatest && !currentTerminal.conversationCwd && !relocated) {
          // Resume-latest reads the launch directory, and a pane whose
          // conversation began somewhere else would reopen nothing — or another
          // pane's conversation — from here (#12434), as would one about to
          // start somewhere else (#14954).
          const resumeLatestCmd = resolvedAgentBaseCommand
            ? buildResumeLatestCommand(effectiveAgentId, resumeFlags, resolvedAgentBaseCommand)
            : buildResumeLatestCommand(effectiveAgentId, resumeFlags);
          if (resumeLatestCmd) {
            commandToRun = resumeLatestCmd;
            usedResumeLatest = true;
          }
        }
        if (!consumedSessionId && !usedResumeLatest) {
          // Genuinely starting over. `freshCommand` can still be the pane's
          // original launch command, which for an assigning agent carries the
          // id this pane already used — replaying it would be rejected by the
          // CLI and the restart would fail outright (#11782). Strip it and let
          // this launch be what it is: a new conversation with no id yet.
          commandToRun = freshCommand
            ? stripAssignedSessionIdArgs(freshCommand, effectiveAgentId)
            : freshCommand;
          nextAgentLaunchFlags = freshLaunchFlags;
        }
      }

      // The preset and settings are merged in after the saved fields were
      // cleaned, and either can name a retired model of its own, so the launch
      // as assembled is cleaned too: what runs is what the notice reports.
      if (isAgent && effectiveAgentId) {
        const assembled = dropRetiredAgentModel(effectiveAgentId, {
          command: commandToRun,
          agentLaunchFlags: nextAgentLaunchFlags,
          callerLaunchFlags,
        });
        commandToRun = assembled.launch.command;
        nextAgentLaunchFlags = assembled.launch.agentLaunchFlags;
        callerLaunchFlags = assembled.launch.callerLaunchFlags ?? [];
        for (const modelId of assembled.droppedModelIds) droppedModelIds.add(modelId);
      }

      const spawnCommand = commandToRun;
      // The record of what the run was first asked (#14592) stays only while
      // that run goes on: a resume of the pane's own conversation (a forced
      // resume may name another one), or a start-over that replays the stored
      // launch command, which carries a launch prompt (never a sent one). A new
      // conversation, or the bare shell a demoted pane restarts as, was never
      // handed it.
      const startsOver = !consumedSessionId && !usedResumeLatest;
      const keepsFirstPrompt =
        isAgent &&
        (startsOver
          ? currentTerminal.firstPrompt?.via === "launch" &&
            freshCommand !== undefined &&
            freshCommand === currentTerminal.command
          : usedResumeLatest ||
            !forcedResume ||
            consumedSessionId === currentTerminal.agentSessionId);
      // Resume commands are transient: keep the original command as the
      // durable stored command so a later restart doesn't replay a consumed
      // session id or re-run resume-latest instead of launching fresh. The
      // assigning flag is transient for the same reason and is dropped here
      // too, so no copy of it survives in panel state (#11782).
      // An absent command stays absent: coercing it to "" would flip the
      // strict `command !== undefined` gate on `failedAgentLaunch` above.
      // A demoted pane has no stored command left, so a forced resume keeps the
      // fresh launch command the next restart would rebuild anyway.
      const durableSource =
        consumedSessionId || usedResumeLatest
          ? (currentTerminal.command ?? (forcedResume ? freshCommand : undefined))
          : spawnCommand;
      let durableCommand = durableSource;
      if (durableSource) {
        const durable = dropRetiredAgentModel(effectiveAgentId, {
          command: stripAssignedSessionIdArgs(durableSource, effectiveAgentId),
        });
        durableCommand = durable.launch.command;
        for (const modelId of durable.droppedModelIds) droppedModelIds.add(modelId);
      }
      // An assigned id stays valid across a resume — the CLI reuses it rather
      // than minting a new one — so carrying it through the restart keeps the
      // pane's conversation addressable without waiting on a teardown scrape.
      // Agents that mint their own id keep the previous behaviour of clearing
      // it and re-capturing at the next teardown.
      // A forced resume names its conversation outright, so the pane holds it
      // exactly as a resume-palette launch does.
      const nextSessionId =
        isAgent &&
        (supportsSessionIdAssignment(currentTerminal.launchAgentId) ||
          (forcedResume && consumedSessionId === forcedResumeSessionId))
          ? consumedSessionId
          : undefined;

      // A resumed conversation stays filed where it began, which a relaunch in
      // the pane's worktree can leave behind.
      const conversationHome = currentTerminal.conversationCwd || currentTerminal.cwd;
      const resumedConversationCwd =
        conversationHome && conversationHome !== launchCwd ? conversationHome : undefined;

      // Update terminal in store: increment restartKey, reset agent state, update location
      set((state) => {
        const t = state.panelsById[id];
        if (!t || !isPtyPanel(t)) return state;
        const updated = {
          ...t,
          ...withCleanedModelTitle(
            { title: t.title, titleMode: t.titleMode },
            _currentTerminalRaw,
            currentTerminal
          ),
          location: targetLocation,
          cwd: launchCwd,
          restartKey: (t.restartKey ?? 0) + 1,
          // Demoted panels keep `agentState: "exited"` so the guard above
          // stays true across repeated restarts (issue #5764).
          agentState: isAgent
            ? ("working" as const)
            : isDemotedAgent
              ? ("exited" as const)
              : undefined,
          lastStateChange: isAgent ? Date.now() : undefined,
          stateChangeTrigger: undefined,
          stateChangeConfidence: undefined,
          // Clear the stored agent command on demotion so a subsequent
          // restart falls through to the default shell.
          command: isDemotedAgent ? undefined : durableCommand,
          agentLaunchFlags: isAgent ? nextAgentLaunchFlags : t.agentLaunchFlags,
          agentModelId: isAgent ? currentTerminal.agentModelId : t.agentModelId,
          // Only the ownership the split trusted: a tail it rejected must not
          // later claim settings-derived tokens that happen to end the list.
          callerLaunchFlags: isAgent
            ? callerLaunchFlags.length > 0
              ? callerLaunchFlags
              : undefined
            : t.callerLaunchFlags,
          agentPresetId: nextAgentPresetId,
          agentPresetColor: nextAgentPresetColor,
          originalPresetId: nextOriginalPresetId,
          agentSessionId: nextSessionId,
          // A fresh conversation begins where this pane runs.
          conversationCwd: consumedSessionId ? resumedConversationCwd : undefined,
          firstPrompt: keepsFirstPrompt ? t.firstPrompt : undefined,
          isRestarting: true,
          restartError: undefined,
          // Answered only once the replacement is actually spawning, so a
          // restart that fails validation leaves the offer to try again.
          agentResumeOffer: undefined,
          exitCode: undefined,
          sessionPreservingExit: undefined,
          // Drop the prior session's parsed check result (#10682) — a fresh
          // run hasn't produced one yet, and a stale pass/fail would mislead.
          lastCheckResult: undefined,
          // Same for its handback (#12488): the restarted session was never asked.
          lastHandback: undefined,
          // The new process is the user's restart, not anything restore rebuilt
          // (#14017). The plugin hold stays: it is a standing choice.
          restoreProvenance: undefined,
          // A new PTY starts the session count over, matching the fresh record
          // the host builds for it (#12535). Carrying the old one forward would
          // leave this surface disagreeing with the host about a session
          // neither of them is holding any more.
          agentIncarnation: undefined,
          startedAt: Date.now(),
        };
        const newById = { ...state.panelsById, [id]: updated };
        saveNormalized(newById, state.panelIds);
        return { panelsById: newById };
      });
      // Told as soon as the change is saved: a spawn that then fails leaves the
      // pane on the default with nothing retired left to report on the retry.
      if (isAgent && effectiveAgentId && droppedModelIds.size > 0) {
        notifyRetiredModelDropped(effectiveAgentId, [...droppedModelIds], {
          panelId: id,
          worktreeId: currentTerminal.worktreeId,
        });
      }

      const terminalService = peekTerminalService() ?? (await loadTerminalService());
      await terminalService.waitForInstance(id, { timeoutMs: 5000 });

      // Re-apply the input lock on the freshly created xterm instance:
      // xterm 6.0 does not inherit `disableStdin` across instance recreation.
      peekTerminalService()?.setInputLocked(id, true);

      // Read at spawn time, not from the panel captured before the kill: a
      // cross-worktree move landing during the restart would otherwise respawn
      // the run under the worktree it left, and the ledger would record the
      // same stale filing. Falls back to the captured panel only when the live
      // one is gone entirely — a live panel with no worktree keeps none, never
      // an inherited id (#12060).
      const livePanelAtSpawn = get().panelsById[id];
      const spawnWorktreeId = livePanelAtSpawn
        ? livePanelAtSpawn.worktreeId
        : currentTerminal.worktreeId;

      // A restart is a new incarnation of the same panel id — advance the
      // renderer ledger so post-restart attach/detection/close events record
      // against the respawned generation, not the killed one.
      agentLifecycleLedger.recordLaunch(id, {
        launchAgentId: isAgent ? currentTerminal.launchAgentId : undefined,
        cwd: launchCwd,
        projectId: capturedWorkspaceId,
        worktreeId: spawnWorktreeId,
        worktreeSource: spawnWorktreeId !== undefined ? "explicit" : undefined,
        agentModelId: isAgent ? currentTerminal.agentModelId : undefined,
        agentPresetId: nextAgentPresetId,
        originalPresetId: nextOriginalPresetId ?? nextAgentPresetId,
        agentLaunchFlags: isAgent ? nextAgentLaunchFlags : undefined,
        env: computeEnvProvenance(restartEnv),
        initialCols: spawnCols,
        initialRows: spawnRows,
      });

      const restartTitle = titleAtSpawn(get, id, currentTerminal);
      await terminalClient.spawn({
        id,
        projectId: capturedWorkspaceId,
        cwd: launchCwd,
        cols: spawnCols,
        rows: spawnRows,
        // Demoted panels spawn as plain terminals — launchAgentId cleared so the
        // IPC handler does not treat them as agent spawns (issue #5764).
        kind: "terminal",
        launchAgentId: isAgent ? currentTerminal.launchAgentId : undefined,
        pluginPanelKindId: currentTerminal.pluginPanelKindId,
        // Keep the ownership rung across restart so the backend's own
        // default-title rewrites stay gated for pinned/user titles.
        ...restartTitle,
        command: isAgent ? spawnCommand : undefined,
        restore: false,
        // A forced resume reopens a conversation filed under the profile the
        // pane launched with — a redirected CODEX_HOME — so its captured launch
        // layer rides on top, exactly as a restore replays it (#10922).
        env:
          forcedResume && currentTerminal.env
            ? { ...restartEnv, ...currentTerminal.env }
            : restartEnv,
        agentLaunchFlags: isAgent ? nextAgentLaunchFlags : undefined,
        agentModelId: isAgent ? currentTerminal.agentModelId : undefined,
        // The pane is still the scheduled run's after a restart (#15977).
        scheduledRun: isAgent ? currentTerminal.scheduledRun : undefined,
        // Without this the pty-host record loses its worktree for the rest of
        // the run's life and the fleet palette files it under "No worktree"
        // while the sidebar still has it right (#12060).
        worktreeId: spawnWorktreeId,
        // Lands on the terminal record as the PTY is created, so the restarted
        // pane is addressable immediately rather than only if a later teardown
        // manages to observe an id (#11782).
        agentSessionId: nextSessionId,
        agentPresetId: nextAgentPresetId,
        agentPresetColor: nextAgentPresetColor,
        originalAgentPresetId: nextOriginalPresetId ?? nextAgentPresetId,
        // The record the run keeps (#15521): main offers its sends only when
        // it starts with none.
        ...(keepsFirstPrompt && currentTerminal.firstPrompt && { hasFirstPrompt: true }),
        // Held to the same plugin tools on every relaunch, unless the user
        // chose to start this one without them (#14096).
        requiredPluginTools: isAgent ? currentTerminal.requiredPluginTools : undefined,
        allowMissingPluginTools: options?.allowMissingPluginTools === true ? true : undefined,
        // A restart mints the pane a fresh MCP bearer, so it needs its launch
        // context again or its session falls back to live selection (#12486).
        actionContext: buildAgentLaunchContext({
          launchAgentId: isAgent ? currentTerminal.launchAgentId : undefined,
          terminalId: id,
          title: restartTitle.title,
          worktreeId: spawnWorktreeId,
        }),
      });

      // Main awaits admission, settings and filesystem work before it reaches
      // `PtyClient.spawn`, and that call overwrites the replay cache with the
      // payload it was handed — so a move landing after we read the panel and
      // before the record existed would be lost for good without this.
      reconcileWorktreeAfterSpawn(id, spawnWorktreeId, get().panelsById[id]);

      // The new PTY was spawned from a grid read before the await; a resize
      // sent in between reached no PTY, so re-assert rather than trust it.
      peekTerminalService()?.invalidatePtyGrid(id);
      if (targetLocation === "dock") {
        optimizeForDock(id);
      } else {
        peekTerminalService()?.fit(id);
      }

      // Release the transient input lock now that the new PTY is live.
      peekTerminalService()?.setInputLocked(id, false);

      unmarkTerminalRestarting(id);
      set((state) => updateTerminal(state, id, respawned));
    } catch (error) {
      // Decoding an encoded AppError from main strips its wire prefix in place,
      // so the phase checks below read the plain message and the person reads
      // its userMessage.
      const appError = isClientAppError(error) ? error : null;
      const errorMessage = formatErrorMessage(error, "Failed to restart terminal");
      const errorCode = (error as { code?: string })?.code;

      let phase = "unknown";
      if (errorMessage.includes("frontend readiness timeout")) {
        phase = "frontend-readiness";
      } else if (errorMessage.includes("spawn")) {
        phase = "pty-spawn";
      } else if (errorMessage.includes("kill")) {
        phase = "pty-kill";
      } else if (errorMessage.includes("destroy")) {
        phase = "frontend-destroy";
      }

      // A refusal for missing plugin tools is the same blocker the first launch
      // hit, so it shows the spawn banner with its choices again, not a
      // generic restart failure.
      const toolsError = requiredPluginToolsSpawnError(error);
      if (toolsError !== null) {
        peekTerminalService()?.setInputLocked(id, false);
        unmarkTerminalRestarting(id);
        // Persisted, and the agent marked exited as a refused first launch is:
        // nothing started, so nothing will ever report it stopped.
        updateAndSaveTerminal(set, id, (t) =>
          isPtyPanel(t)
            ? refusedForPluginTools(
                {
                  ...t,
                  isRestarting: false,
                  restartError: undefined,
                  ...(consumedSessionId ? { agentSessionId: consumedSessionId } : {}),
                },
                toolsError
              )
            : t
        );
        return;
      }

      const restartError = {
        message: appError?.userMessage ?? errorMessage,
        code: errorCode,
        timestamp: Date.now(),
        recoverable: errorCode === "ENOENT" || phase === "frontend-readiness",
        // Never the command: an agent's carries its launch prompt (#14592).
        context: {
          failedCwd: launchCwd,
          phase,
          isAgent,
          agentId: effectiveAgentId,
        },
      };

      // Always release the transient input lock so a failed restart can't
      // leave the (possibly recreated) instance permanently locked.
      peekTerminalService()?.setInputLocked(id, false);

      unmarkTerminalRestarting(id);
      set((state) =>
        updateTerminal(state, id, (t) => ({
          ...t,
          isRestarting: false,
          restartError,
          // Restore session ID so user can retry resume
          ...(consumedSessionId ? { agentSessionId: consumedSessionId } : {}),
          ...(wasFailed ? { spawnStatus: "failed" as const } : {}),
        }))
      );

      logError("[TerminalStore] Failed to restart terminal", error, {
        id,
        phase,
        cwd: launchCwd,
        isAgent,
        agentId: effectiveAgentId,
      });
    }
  },

  clearTerminalError: (id) => {
    set((state) =>
      updateTerminal(state, id, (t) => ({
        ...t,
        restartError: undefined,
        scrollbackRestoreError: undefined,
        attachError: undefined,
      }))
    );
  },

  updateTerminalCwd: (id, cwd) => {
    set((state) => {
      const t = state.panelsById[id];
      if (!t) return state;
      const newById = {
        ...state.panelsById,
        [id]: {
          ...t,
          cwd,
          ...conversationOriginPatch(t, cwd),
          restartError: undefined,
          spawnError: undefined,
        },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  confirmRestoreRecoveryDestination: (id, cwd) => {
    set((state) => {
      const t = state.panelsById[id];
      if (!t || !isPtyPanel(t) || !t.restoreRecovery) return state;
      if (!t.restoreRecovery.awaitingDestination && (cwd === undefined || cwd === t.cwd)) {
        return state;
      }
      const { reason, sessionId, hostEnd } = t.restoreRecovery;
      const recovery = {
        reason,
        ...(sessionId !== undefined && { sessionId }),
        ...(hostEnd !== undefined && { hostEnd }),
      };
      const nextCwd = cwd ?? t.cwd;
      const newById = {
        ...state.panelsById,
        [id]: {
          ...t,
          cwd: nextCwd,
          ...conversationOriginPatch(t, nextCwd, sessionId !== undefined),
          restoreRecovery: recovery,
        },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  moveTerminalToWorktree: (id, worktreeId) => {
    const terminal = get().panelsById[id];
    if (!terminal) {
      logWarn("[TerminalStore] Cannot move terminal: not found", { id });
      return;
    }

    if (terminal.worktreeId === worktreeId) {
      return;
    }

    // Check if terminal belongs to a group
    const group = get().getPanelGroup(id);
    if (group) {
      // Move entire group to maintain worktree invariant
      logDebug("[TabGroup] Panel is in group, moving entire group to worktree", {
        panelId: id,
        groupId: group.id,
        worktreeId,
      });
      const success = get().moveTabGroupToWorktree(group.id, worktreeId);
      if (!success) {
        logWarn("[TabGroup] Failed to move group to worktree (capacity exceeded)", {
          groupId: group.id,
          worktreeId,
        });
      }
      return;
    }

    // Terminal is not in a group - move it individually
    let movedToLocation: PanelLocation | null = null;

    // A user-initiated move is explicit worktree attribution — recorded so
    // later cwd-based inference can never silently overwrite it. Still
    // "explicit" even when the user knowingly kept the process where it is
    // (#11840): the filing was deliberate, and letting inference re-home the
    // panel back to its launch root would undo that choice silently. The
    // divergence it creates is corrected by the recorded opt-out and its HEAD
    // backstop, which are visible, rather than by an invisible re-attribution.
    recordExplicitWorktreeAttribution(id, worktreeId);

    set((state) => {
      const t = state.panelsById[id];
      if (!t) return state;
      // A panel parked in the dock stays there, as a grouped move already does
      // (`moveTabGroupToWorktree`); a kind the dock can't host falls back to the
      // grid (#14966). Anything else lands in the destination's grid, which
      // scrolls if it now exceeds the screen-fit count (#8805).
      const newLocation: PanelLocation =
        t.location === "dock" && panelKindIsDockable(t.kind ?? "terminal") ? "dock" : "grid";
      movedToLocation = newLocation;
      const ptyT = isPtyPanel(t) ? t : undefined;
      const newById = {
        ...state.panelsById,
        [id]: {
          ...t,
          worktreeId,
          // Filing the panel under a worktree is an explicit placement; a pending
          // boot-time dock restore must not pull it back (#13907).
          pendingDockWorktreeId: undefined,
          location: newLocation,
          isVisible: newLocation === "grid" ? true : false,
          runtimeStatus: deriveRuntimeStatus(
            newLocation === "grid",
            ptyT?.flowStatus,
            ptyT?.runtimeStatus
          ),
        } as typeof t,
      };
      const newIndex = transferBetweenWorktreeIndex(
        state.panelIdsByWorktreeId,
        t.worktreeId,
        worktreeId,
        id
      );
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById, panelIdsByWorktreeId: newIndex };
    });

    if (!movedToLocation) return;

    // After the commit, so the reducer stays free of side effects — the same
    // shape `updateTitle` uses for its own pty-host mirror. Grouped panels
    // never reach here; `moveTabGroupToWorktree` syncs each member itself.
    if (panelKindHasPty(terminal.kind ?? "terminal")) {
      syncWorktreeAttributionToHost(id, worktreeId);
    }

    if (movedToLocation === "dock") {
      optimizeForDock(id);
      return;
    }

    withTerminalService(
      (service) => service.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE),
      id
    );
  },

  // No transfer, no capture, no restart: creating the worktree and filing the
  // panel under it is the whole gesture (#11853). Routed through the same
  // choke point as every other cross-worktree move so the create path cannot
  // drift from the drag paths — that is also what raises the pane's banner.
  moveToNewWorktree: (id) => {
    const terminal = get().panelsById[id];
    if (!terminal || terminal.location === "trash") return;
    if (!isPtyPanel(terminal)) return;
    // A restart captures its spawn cwd before awaiting teardown, so a move
    // landing inside that window would file the panel under a worktree the
    // in-flight process is not going to start in.
    if (terminal.isRestarting) return;

    void Promise.all([
      import("@/store/worktreeStore"),
      import("@/services/terminal/crossWorktreeMove"),
    ])
      .then(([{ useWorktreeSelectionStore }, { moveTerminalToWorktreeAndFollowRescue }]) => {
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          onCreated: (worktreeId) => {
            // Revalidated, not trusted: the dialog stays open for as long as
            // the user takes, and moving a panel that was trashed meanwhile
            // would file it back onto the grid.
            const current = get().panelsById[id];
            if (!current || current.location === "trash" || !isPtyPanel(current)) return;
            if (current.isRestarting) return;
            // Isolated from the dialog's own creation transaction: `onCreated`
            // runs inside it, so a throw here would surface as "Couldn't create
            // worktree" for a worktree that was created successfully.
            try {
              moveTerminalToWorktreeAndFollowRescue(id, worktreeId);
            } catch (error) {
              logError("[TerminalStore] Failed to move the panel to the new worktree", error);
            }
          },
        });
      })
      .catch((err) => {
        logError("[TerminalStore] Failed to open the create-worktree dialog", err);
      });
  },

  updateFlowStatus: (id, status, timestamp) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (!isPtyPanel(terminal)) return state;

      const prevTs = terminal.flowStatusTimestamp;
      if (prevTs !== undefined && timestamp < prevTs) return state;

      if (terminal.flowStatus === status && terminal.flowStatusTimestamp === timestamp) {
        return state;
      }

      const runtimeStatus = deriveRuntimeStatus(terminal.isVisible, status, terminal.runtimeStatus);

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, flowStatus: status, flowStatusTimestamp: timestamp, runtimeStatus },
        },
      };
    });
  },

  setRuntimeStatus: (id, status) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (!isPtyPanel(terminal)) return state;
      if (terminal.runtimeStatus === status) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, runtimeStatus: status },
        },
      };
    });
  },

  // Never `saveNormalized`, unlike the consent record this replaces: the notice
  // is a prompt to act on now, so it must not come back after a quit. Living in
  // `panelsById` is still what makes it survive the unmount a worktree switch
  // causes — the same split `sessionLostOnRestore` makes (#11589).
  setWorktreeMoveNotice: (id, notice) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal || !isPtyPanel(terminal)) return state;
      // Clearing an already-clear notice, or re-raising the same destination in
      // the same delivery state, keeps the same state object so repeat writes
      // don't wake subscribers. `deliveryFailed` has to be part of that
      // comparison: marking an existing notice as failed changes nothing else
      // about it, so a destination-only check would silently drop the write
      // (#11867). Normalized because absent and `false` mean the same thing.
      const current = terminal.worktreeMoveNotice;
      if (
        current?.destinationWorktreeId === notice?.destinationWorktreeId &&
        (current?.deliveryFailed ?? false) === (notice?.deliveryFailed ?? false)
      ) {
        return state;
      }
      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, worktreeMoveNotice: notice },
        },
      };
    });
  },

  setInputLocked: (id, locked) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (!isPtyPanel(terminal)) return state;
      if (terminal.isInputLocked === locked) return state;

      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, isInputLocked: locked },
      };
      saveNormalized(newById, state.panelIds);
      if (panelKindHasPty(terminal.kind ?? "terminal")) {
        peekTerminalService()?.setInputLocked(id, locked);
      }
      return { panelsById: newById };
    });
  },

  toggleInputLocked: (id) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (!isPtyPanel(terminal)) return state;

      const locked = !terminal.isInputLocked;
      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, isInputLocked: locked },
      };
      saveNormalized(newById, state.panelIds);
      if (panelKindHasPty(terminal.kind ?? "terminal")) {
        peekTerminalService()?.setInputLocked(id, locked);
      }
      return { panelsById: newById };
    });
  },

  setHoldOnRestart: (id, hold) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal || !isPtyPanel(terminal)) return state;
      if ((terminal.holdOnRestart === true) === hold) return state;

      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, holdOnRestart: hold ? (true as const) : undefined },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  activateFallbackPreset: (id, nextPresetId, originalPresetId) =>
    respawnAgentOnPreset(set, get, id, nextPresetId, { kind: "fallback", originalPresetId }),

  restartTerminalOnPreset: (id, presetId) =>
    respawnAgentOnPreset(set, get, id, presetId, { kind: "switch" }),
});

/**
 * The title a pane takes when it moves to `nextPreset`. Only a title that is
 * still what a launch on the preset it left would carry follows the move
 * (#13746): that preset's stamp, or the bare agent name of a preset-free
 * launch. A rename or a caller-supplied name stays exactly as it is.
 */
export function presetSwitchTitle(
  current: { title: string; titleMode?: PanelTitleMode },
  context: {
    agentId: string;
    modelId?: string;
    leftPresets: ReadonlyArray<Pick<AgentPreset, "name" | "displayTitle"> | undefined>;
    nextPreset: Pick<AgentPreset, "name" | "displayTitle">;
  }
): { title: string; titleMode?: PanelTitleMode } {
  if (current.titleMode === "user") return current;
  const baseTitle = getAgentDisplayTitle(context.agentId, context.modelId);
  const stamped =
    current.titleMode === "custom"
      ? context.leftPresets.some(
          (preset) => preset && agentPresetTitle(baseTitle, preset) === current.title
        )
      : current.title === baseTitle;
  if (!stamped) return current;
  const nextTitle = agentPresetTitle(baseTitle, context.nextPreset);
  return nextTitle ? { title: nextTitle, titleMode: "custom" } : current;
}

type PresetRespawnMode = { kind: "fallback"; originalPresetId: string } | { kind: "switch" };

async function respawnAgentOnPreset(
  set: Set,
  get: Get,
  id: string,
  nextPresetId: string,
  mode: PresetRespawnMode
): Promise<{ success: boolean; error?: string }> {
  const livePanel = get().panelsById[id];
  if (!livePanel) {
    return { success: false, error: "terminal not found" };
  }
  if (!isPtyPanel(livePanel)) {
    return { success: false, error: "panel is not a PTY panel" };
  }
  // The new preset's launch is built from these fields, so a retired model
  // saved on the pane doesn't follow it onto the new preset (#15652), nor
  // does a model the agent takes only on a new headless run (#15569).
  const { launch: withoutRetired, droppedModelIds: droppedFromSaved } = dropRetiredAgentModel(
    livePanel.launchAgentId,
    livePanel
  );
  const terminal = dropUnselectedAgentModel(livePanel.launchAgentId, withoutRetired, {
    replay: true,
  });
  if (terminal.isRestarting) {
    return { success: false, error: "already restarting" };
  }

  const effectiveAgentId = terminal.launchAgentId;
  if (!effectiveAgentId) {
    return { success: false, error: "panel is not an agent" };
  }
  // Held for recovery (#12434): nothing ran, so nothing failed over.
  if (terminal.restoreRecovery) {
    return { success: false, error: "panel is held for recovery" };
  }

  markTerminalRestarting(id);
  set((state) =>
    updateTerminal(state, id, (t) => ({
      ...t,
      restartError: undefined,
      spawnError: undefined,
      isRestarting: true,
    }))
  );

  // Snapshot pre-mutation preset fields for rollback on spawn failure.
  // Without this, a failed respawn leaves the panel permanently stamped as
  // "using fallback N" while no process is running, corrupting any retry
  // that reads fallbackChainIndex.
  // Taken from the pane as saved: a respawn that fails before its own commit
  // changed nothing, retired model included, so it puts nothing back cleaned.
  const priorSnapshot = {
    command: livePanel.command,
    agentPresetId: terminal.agentPresetId,
    agentPresetColor: terminal.agentPresetColor,
    originalPresetId: terminal.originalPresetId,
    isUsingFallback: terminal.isUsingFallback,
    fallbackChainIndex: terminal.fallbackChainIndex,
    agentLaunchFlags: livePanel.agentLaunchFlags,
    callerLaunchFlags: livePanel.callerLaunchFlags,
    agentModelId: livePanel.agentModelId,
    conversationCwd: terminal.conversationCwd,
    env: terminal.env,
  };
  // Set only when a switch retitled the pane, so a failure can put back the
  // stamp it replaced — unless the user renamed it in the meantime.
  let switchedTitle: { title: string; titleMode?: PanelTitleMode } | undefined;
  let launchCwd = terminal.cwd;

  try {
    const [agentSettings, tmpDir] = await Promise.all([
      agentSettingsClient.get(),
      resolveHostTmpDir(() => systemClient.getTmpDir()).catch(() => ""),
    ]);
    const entry = agentSettings?.agents?.[effectiveAgentId] ?? {};
    const ccrPresets = useCcrPresetsStore.getState().ccrPresetsByAgent[effectiveAgentId];
    const projectPresets = useProjectPresetsStore.getState().presetsByAgent[effectiveAgentId];
    const runtimeSettings = resolveAgentRuntimeSettings({
      agentId: effectiveAgentId,
      presetId: nextPresetId,
      entry,
      ccrPresets,
      projectPresets,
    });
    const nextPreset = runtimeSettings.preset;
    if (!nextPreset) {
      throw new Error(`preset "${nextPresetId}" not found`);
    }
    // A switch makes the chosen preset the pane's own: the chain it was
    // walking, and the tooltip that says so, belong to the preset it left.
    // A hop keeps walking the original's chain.
    const nextOriginalPresetId = mode.kind === "fallback" ? mode.originalPresetId : nextPreset.id;

    const effectiveEntry = runtimeSettings.effectiveEntry;

    let clipboardDirectory: string | undefined;
    if (effectiveAgentId === "gemini" && effectiveEntry.shareClipboardDirectory !== false) {
      clipboardDirectory = tmpDir ? agentClipboardDirectory(tmpDir, isRemoteWindow()) : undefined;
    }

    const agentConfig = getAgentConfig(effectiveAgentId);
    const baseCommand = resolveAgentLaunchBaseCommand(
      agentConfig?.command || effectiveAgentId,
      await getCurrentLaunchCliDetail(effectiveAgentId)
    );
    const globalSkipPermissions = agentSettings?.globalSkipPermissions ?? false;
    const globalUseAltScreen = agentSettings?.globalUseAltScreen ?? false;
    // A failover swaps the provider, not the caller's standing instruction
    // or its own verbatim flags (#13046).
    const { base: storedBaseFlags, caller: storedCallerFlags } = splitCallerLaunchFlags(
      terminal.agentLaunchFlags,
      terminal.callerLaunchFlags
    );
    // A switch promises a new conversation, and so does a hop that moves the
    // pane into its worktree (#14954), so a caller's own resume selector
    // (`--continue`, `resume --last`) can't ride along into the new home.
    const keptCallerFlags =
      mode.kind === "switch" || filedLaunchCwd(get, id, terminal) !== terminal.cwd
        ? stripConversationSelectorFlags(storedCallerFlags, effectiveAgentId)
        : storedCallerFlags;
    const systemPromptArgs = extractSystemPromptArgs(storedBaseFlags, effectiveAgentId);
    // The new preset's own args or the settings can name a retired model too,
    // so the launch as assembled is cleaned, not just what the pane saved.
    const assembled = dropRetiredAgentModel(effectiveAgentId, {
      command: appendCallerLaunchFlagsToCommand(
        generateAgentCommand(baseCommand, effectiveEntry, effectiveAgentId, {
          clipboardDirectory,
          modelId: terminal.agentModelId,
          systemPromptArgs,
          presetArgs: nextPreset.args,
          globalSkipPermissions,
          globalUseAltScreen,
        }),
        keptCallerFlags
      ),
      agentLaunchFlags: [
        ...buildAgentLaunchFlags(effectiveEntry, effectiveAgentId, {
          modelId: terminal.agentModelId,
          systemPromptArgs,
          presetArgs: nextPreset.args,
          globalSkipPermissions,
          globalUseAltScreen,
        }),
        ...keptCallerFlags,
      ],
      callerLaunchFlags: keptCallerFlags,
    });
    const commandToRun = assembled.launch.command ?? baseCommand;
    const nextLaunchFlags = assembled.launch.agentLaunchFlags ?? [];
    const callerLaunchFlags = assembled.launch.callerLaunchFlags ?? [];
    const droppedModelIds = [...new Set([...droppedFromSaved, ...assembled.droppedModelIds])];

    // Capture live terminal dimensions before teardown
    const managedInstance = peekTerminalService()?.get(id);
    let spawnCols = terminal.cols || 80;
    let spawnRows = terminal.rows || 24;
    if (managedInstance?.terminal) {
      spawnCols = managedInstance.terminal.cols || spawnCols;
      spawnRows = managedInstance.terminal.rows || spawnRows;
    }

    peekTerminalService()?.destroy(id);
    withTerminalService((service) => service.suppressNextExit(id, 10000), id);
    try {
      await terminalClient.kill(id, { forRestart: true });
    } catch (error) {
      logWarn("[TerminalStore] kill failed during preset respawn; continuing", {
        id,
        error,
      });
    }

    const nextChainIndex = (terminal.fallbackChainIndex ?? 0) + 1;
    // Always a new conversation, so nothing ties it to the folder it left.
    launchCwd = filedLaunchCwd(get, id, terminal);

    set((state) => {
      const t = state.panelsById[id];
      if (!t || !isPtyPanel(t)) return state;
      const updated = {
        ...t,
        cwd: launchCwd,
        restartKey: (t.restartKey ?? 0) + 1,
        agentState: "working" as AgentState,
        lastStateChange: Date.now(),
        stateChangeTrigger: undefined,
        stateChangeConfidence: undefined,
        // A relaunch on another preset, not the process restore rebuilt (#14017).
        restoreProvenance: undefined,
        command: commandToRun,
        agentPresetId: nextPreset.id,
        agentPresetColor: nextPreset.color,
        originalPresetId: nextOriginalPresetId,
        isUsingFallback: mode.kind === "fallback" ? true : undefined,
        fallbackChainIndex: mode.kind === "fallback" ? nextChainIndex : undefined,
        // The launch layer a cold restore replays ahead of the preset's own
        // env (#10922). Left as it was, a relaunch would bring the pane back
        // on the preset it just moved off.
        env: sanitizeAgentEnv(runtimeSettings.env),
        agentLaunchFlags: nextLaunchFlags,
        agentModelId: terminal.agentModelId,
        callerLaunchFlags: callerLaunchFlags.length > 0 ? callerLaunchFlags : undefined,
        agentSessionId: undefined,
        // The fallback starts a new conversation where the pane runs, and is
        // never handed the prompt the last one launched with (#14592).
        conversationCwd: undefined,
        firstPrompt: undefined,
        isRestarting: true,
        restartError: undefined,
        exitCode: undefined,
        sessionPreservingExit: undefined,
        // Drop the prior session's parsed check result (#10682) — a fresh
        // run hasn't produced one yet, and a stale pass/fail would mislead.
        lastCheckResult: undefined,
        // Same for its handback (#12488): the restarted session was never asked.
        lastHandback: undefined,
        // A new PTY starts the session count over, matching the fresh record
        // the host builds for it (#12535). Carrying the old one forward would
        // leave this surface disagreeing with the host about a session
        // neither of them is holding any more.
        agentIncarnation: undefined,
        startedAt: Date.now(),
      };
      const newById = { ...state.panelsById, [id]: updated };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
    if (droppedModelIds.length > 0) {
      // Saved and reported from here, so a spawn that now fails rolls back to
      // the cleaned launch rather than bringing the retired model back.
      Object.assign(priorSnapshot, {
        command: terminal.command,
        agentLaunchFlags: terminal.agentLaunchFlags,
        callerLaunchFlags: terminal.callerLaunchFlags,
        agentModelId: terminal.agentModelId,
      });
      notifyRetiredModelDropped(effectiveAgentId, droppedModelIds, {
        panelId: id,
        worktreeId: terminal.worktreeId,
      });
    }

    const terminalService = peekTerminalService() ?? (await loadTerminalService());
    await terminalService.waitForInstance(id, { timeoutMs: 5000 });

    const projectStore = await resolveProjectStore();
    const capturedProjectId = projectStore.getState().currentProject?.id;
    const capturedWorkspaceId = capturedProjectId ?? getViewWorkspaceId() ?? undefined;

    const restartEnv = await buildRestartEnv(capturedProjectId, runtimeSettings.env, "fallback");

    // Live at spawn time for the same reason as the restart path above: the
    // hop awaits, and a move that lands mid-hop must not be undone by it.
    const liveFallbackPanel = get().panelsById[id];
    const fallbackWorktreeId = liveFallbackPanel
      ? liveFallbackPanel.worktreeId
      : terminal.worktreeId;

    // A fallback hop respawns the id — new renderer ledger incarnation, with
    // the hopped preset recorded as the active one.
    agentLifecycleLedger.recordLaunch(id, {
      launchAgentId: terminal.launchAgentId,
      cwd: launchCwd,
      projectId: capturedWorkspaceId,
      worktreeId: fallbackWorktreeId,
      worktreeSource: fallbackWorktreeId !== undefined ? "explicit" : undefined,
      agentModelId: terminal.agentModelId,
      agentPresetId: nextPreset.id,
      originalPresetId: nextOriginalPresetId,
      agentLaunchFlags: nextLaunchFlags,
      env: computeEnvProvenance(restartEnv),
      initialCols: spawnCols,
      initialRows: spawnRows,
    });

    const liveTitle = titleAtSpawn(get, id, terminal);
    const currentTitle = withCleanedModelTitle(liveTitle, livePanel, terminal);
    const fallbackTitle =
      mode.kind === "switch"
        ? presetSwitchTitle(currentTitle, {
            agentId: effectiveAgentId,
            modelId: terminal.agentModelId,
            leftPresets: [terminal.agentPresetId, terminal.originalPresetId].map((presetId) =>
              presetId
                ? getMergedPreset(
                    effectiveAgentId,
                    presetId,
                    entry.customPresets,
                    ccrPresets,
                    projectPresets
                  )
                : undefined
            ),
            nextPreset,
          })
        : currentTitle;
    if (fallbackTitle !== liveTitle) {
      switchedTitle = fallbackTitle;
      updateAndSaveTerminal(set, id, (t) => ({
        ...t,
        title: fallbackTitle.title,
        titleMode: fallbackTitle.titleMode,
      }));
    }
    await terminalClient.spawn({
      id,
      projectId: capturedWorkspaceId,
      cwd: launchCwd,
      cols: spawnCols,
      rows: spawnRows,
      kind: "terminal",
      launchAgentId: terminal.launchAgentId,
      pluginPanelKindId: terminal.pluginPanelKindId,
      // Carried with the title, never without it: a title that arrives
      // unaccompanied re-stamps as "default" and the next detection sweep
      // overwrites the user's rename (#10794).
      ...fallbackTitle,
      command: commandToRun,
      restore: false,
      env: restartEnv,
      agentLaunchFlags: nextLaunchFlags,
      agentModelId: terminal.agentModelId,
      scheduledRun: terminal.scheduledRun,
      // Carried for the same reason as the restart path: a fallback hop that
      // drops it strands the run in the palette's "No worktree" bucket for
      // the rest of its life (#12060).
      worktreeId: fallbackWorktreeId,
      agentPresetId: nextPreset.id,
      agentPresetColor: nextPreset.color,
      originalAgentPresetId: nextOriginalPresetId,
      requiredPluginTools: terminal.requiredPluginTools,
      actionContext: buildAgentLaunchContext({
        launchAgentId: terminal.launchAgentId,
        terminalId: id,
        title: fallbackTitle.title,
        worktreeId: fallbackWorktreeId,
      }),
    });

    reconcileWorktreeAfterSpawn(id, fallbackWorktreeId, get().panelsById[id]);

    // The new PTY was spawned from a grid read before the await; a resize
    // sent in between reached no PTY, so re-assert rather than trust it.
    peekTerminalService()?.invalidatePtyGrid(id);
    if (terminal.location === "dock") {
      optimizeForDock(id);
    } else {
      peekTerminalService()?.fit(id);
    }

    unmarkTerminalRestarting(id);
    set((state) => updateTerminal(state, id, respawned));
    return { success: true };
  } catch (error) {
    const appError = isClientAppError(error) ? error : null;
    const errorMessage =
      appError?.userMessage ?? formatErrorMessage(error, "Failed to restart terminal");
    // The same refusal a first launch gets, with its choices, on the preset
    // the pane rolls back to.
    const toolsError = requiredPluginToolsSpawnError(error);
    unmarkTerminalRestarting(id);
    // Persisted: the respawn already saved the destination, and a reload
    // must not bring the pane back on a preset it never started on.
    updateAndSaveTerminal(set, id, (t) => {
      const rolledBack = {
        ...t,
        isRestarting: false,
        // Restore pre-mutation fields so fallbackChainIndex and presetId
        // accurately reflect "we are NOT running the next preset". Without
        // rollback, any subsequent fallback trigger would jump past this
        // preset even though the PTY never started.
        ...priorSnapshot,
        // Only the stamp this switch wrote: a rename since then, even one that
        // happens to spell the same title, now belongs to the user.
        ...(switchedTitle &&
        t.title === switchedTitle.title &&
        t.titleMode === switchedTitle.titleMode
          ? { title: livePanel.title, titleMode: livePanel.titleMode }
          : {}),
      };
      if (toolsError !== null && isPtyPanel(rolledBack)) {
        return refusedForPluginTools({ ...rolledBack, restartError: undefined }, toolsError);
      }
      return {
        ...rolledBack,
        restartError: {
          message: errorMessage,
          timestamp: Date.now(),
          recoverable: false,
          context: {
            failedCwd: launchCwd,
            phase: mode.kind === "fallback" ? "fallback-activation" : "preset-switch",
            nextPresetId,
          },
        },
      };
    });
    logError(
      mode.kind === "fallback"
        ? "[TerminalStore] Failed to activate fallback preset"
        : "[TerminalStore] Failed to restart terminal on preset",
      error,
      {
        id,
        nextPresetId,
      }
    );
    return { success: false, error: errorMessage };
  }
}

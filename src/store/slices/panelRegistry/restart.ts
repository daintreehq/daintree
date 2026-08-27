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
  supportsSessionIdAssignment,
  reconcileBypassFlags,
  reconcileInlineModeFlag,
  resolveEffectiveBypass,
  resolveEffectiveInlineMode,
} from "@shared/types";
import type { AgentSettingsEntry } from "@shared/types/agentSettings";
import type { AgentState } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { validateTerminalConfig } from "@/utils/terminalValidation";
import { getAgentConfig } from "@/config/agents";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isPtyPanel, type PanelInstance, type PanelTitleMode } from "@shared/types/panel";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import { computeEnvProvenance } from "@shared/utils/agentLifecycleLedger";
import { markTerminalRestarting, unmarkTerminalRestarting } from "@/store/restartExitSuppression";
import { saveNormalized } from "./persistence";
import { optimizeForDock } from "./layout";
import {
  deriveRuntimeStatus,
  recordExplicitWorktreeAttribution,
  syncWorktreeAttributionToHost,
} from "./helpers";
import { cancelReconnectErrorDebounce } from "./browser";
import { logDebug, logWarn, logError } from "@/utils/logger";
import {
  buildAgentLaunchFlagsForRuntimeSettings,
  mergePresetArgsIntoLaunchFlags,
  resolveAgentRuntimeSettings,
  type AgentRuntimeSettingsResolution,
} from "@/utils/agentRuntimeSettings";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { transferBetweenWorktreeIndex } from "./worktreeIndex";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import {
  getCurrentLaunchCliDetail,
  resolveAgentLaunchBaseCommand,
} from "@/utils/agentLaunchCommand";

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

export const createRestartActions = (
  set: Set,
  get: Get
): Pick<
  PanelRegistrySlice,
  | "restartTerminal"
  | "clearTerminalError"
  | "updateTerminalCwd"
  | "moveTerminalToWorktree"
  | "moveToNewWorktree"
  | "setWorktreeMoveNotice"
  | "updateFlowStatus"
  | "setRuntimeStatus"
  | "setInputLocked"
  | "toggleInputLocked"
  | "activateFallbackPreset"
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

    // Guard against concurrent restart attempts
    if (terminal.isRestarting) {
      logWarn("[TerminalStore] Terminal is already restarting, ignoring", { id });
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

    // Validate configuration before attempting restart
    let validation;
    try {
      validation = await validateTerminalConfig(terminal);
    } catch (error) {
      // Validation itself failed (e.g., IPC error)
      const restartError = {
        message: "Failed to validate terminal configuration",
        timestamp: Date.now(),
        recoverable: false,
        context: {
          failedCwd: terminal.cwd,
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
          failedCwd: terminal.cwd,
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
    const currentTerminal = _currentTerminalRaw;

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
    const isAgent =
      !!effectiveAgentId &&
      (currentTerminal.agentState !== "exited" || failedAgentLaunch) &&
      currentTerminal.exitCode === undefined;
    const isDemotedAgent = !!effectiveAgentId && !isAgent;
    let loadedRuntimeSettings: LoadedAgentRuntimeSettings | undefined;
    let runtimeSettingsLoaded = false;
    let nextAgentLaunchFlags = currentTerminal.agentLaunchFlags;
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
          systemClient.getTmpDir().catch(() => ""),
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
          globalSkipPermissions: runtimeForEnv.globalSkipPermissions,
          globalUseAltScreen: runtimeForEnv.globalUseAltScreen,
        }
      );
    }

    if (isAgent && effectiveAgentId) {
      const presetForLaunchFlags = runtimeForEnv?.settings.preset;
      if (presetForLaunchFlags) {
        nextAgentLaunchFlags = mergePresetArgsIntoLaunchFlags(
          currentTerminal.agentLaunchFlags,
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
          reconcileInlineModeFlag(
            reconcileBypassFlags(base, effectiveAgentId, effectiveBypass, dangerousArgs),
            effectiveAgentId,
            effectiveInline
          );
        if (nextAgentLaunchFlags && nextAgentLaunchFlags.length > 0) {
          nextAgentLaunchFlags = reconcileFlags(nextAgentLaunchFlags);
          resumeFlags = nextAgentLaunchFlags;
        } else {
          const injectedFromEmpty = reconcileFlags([]);
          if (injectedFromEmpty.length > 0) resumeFlags = injectedFromEmpty;
        }
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
            const clipboardDirectory = tmpDir ? `${tmpDir}/daintree-clipboard` : undefined;
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
                  presetArgs: runtimeSettings.settings.preset?.args?.join(" "),
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

    try {
      // CAPTURE LIVE DIMENSIONS before destroying the frontend
      const managedInstance = terminalInstanceService.get(id);
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
      terminalInstanceService.setInputLocked(id, true);

      // AGGRESSIVE TEARDOWN: Destroy frontend FIRST to prevent race condition
      terminalInstanceService.destroy(id);

      terminalInstanceService.suppressNextExit(id, 10000);

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
          // A failed spawn (`wasFailed`) has no live process to quit — bare
          // kill keeps PtyManager's missing-terminal cleanup (session-file
          // delete), which the graceful channel skips on a registry miss.
          if (isAgent && !wasFailed) {
            try {
              return await terminalClient.gracefulKill(id);
            } catch (error) {
              logWarn("[TerminalStore] gracefulKill failed during restart; falling back to kill", {
                id,
                error,
              });
            }
          }
          await terminalClient.kill(id).catch((error: unknown) => {
            logWarn("[TerminalStore] kill failed during restart; continuing", { id, error });
          });
          return null;
        })(),
        buildRestartEnv(capturedProjectId, runtimeForEnv?.settings.env, "restart"),
      ]);

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
        const sessionId =
          (captureTrusted ? capturedSessionId : null) ?? currentTerminal.agentSessionId;
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
        } else if (allowResumeLatest) {
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

      const spawnCommand = commandToRun;
      // Resume commands are transient: keep the original command as the
      // durable stored command so a later restart doesn't replay a consumed
      // session id or re-run resume-latest instead of launching fresh. The
      // assigning flag is transient for the same reason and is dropped here
      // too, so no copy of it survives in panel state (#11782).
      // An absent command stays absent: coercing it to "" would flip the
      // strict `command !== undefined` gate on `failedAgentLaunch` above.
      const durableSource =
        consumedSessionId || usedResumeLatest ? currentTerminal.command : spawnCommand;
      const durableCommand = durableSource
        ? stripAssignedSessionIdArgs(durableSource, effectiveAgentId)
        : durableSource;
      // An assigned id stays valid across a resume — the CLI reuses it rather
      // than minting a new one — so carrying it through the restart keeps the
      // pane's conversation addressable without waiting on a teardown scrape.
      // Agents that mint their own id keep the previous behaviour of clearing
      // it and re-capturing at the next teardown.
      const nextSessionId =
        isAgent && supportsSessionIdAssignment(currentTerminal.launchAgentId)
          ? consumedSessionId
          : undefined;

      // Update terminal in store: increment restartKey, reset agent state, update location
      set((state) => {
        const t = state.panelsById[id];
        if (!t || !isPtyPanel(t)) return state;
        const updated = {
          ...t,
          location: targetLocation,
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
          agentPresetId: nextAgentPresetId,
          agentPresetColor: nextAgentPresetColor,
          originalPresetId: nextOriginalPresetId,
          agentSessionId: nextSessionId,
          isRestarting: true,
          restartError: undefined,
          exitCode: undefined,
          // Drop the prior session's parsed check result (#10682) — a fresh
          // run hasn't produced one yet, and a stale pass/fail would mislead.
          lastCheckResult: undefined,
          startedAt: Date.now(),
        };
        const newById = { ...state.panelsById, [id]: updated };
        saveNormalized(newById, state.panelIds);
        return { panelsById: newById };
      });

      await terminalInstanceService.waitForInstance(id, { timeoutMs: 5000 });

      // Re-apply the input lock on the freshly created xterm instance:
      // xterm 6.0 does not inherit `disableStdin` across instance recreation.
      terminalInstanceService.setInputLocked(id, true);

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
        cwd: currentTerminal.cwd,
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

      await terminalClient.spawn({
        id,
        projectId: capturedWorkspaceId,
        cwd: currentTerminal.cwd,
        cols: spawnCols,
        rows: spawnRows,
        // Demoted panels spawn as plain terminals — launchAgentId cleared so the
        // IPC handler does not treat them as agent spawns (issue #5764).
        kind: "terminal",
        launchAgentId: isAgent ? currentTerminal.launchAgentId : undefined,
        // Keep the ownership rung across restart so the backend's own
        // default-title rewrites stay gated for pinned/user titles.
        ...titleAtSpawn(get, id, currentTerminal),
        command: isAgent ? spawnCommand : undefined,
        restore: false,
        env: restartEnv,
        agentLaunchFlags: isAgent ? nextAgentLaunchFlags : undefined,
        agentModelId: isAgent ? currentTerminal.agentModelId : undefined,
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
      });

      if (targetLocation === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.fit(id);
      }

      // Release the transient input lock now that the new PTY is live.
      terminalInstanceService.setInputLocked(id, false);

      unmarkTerminalRestarting(id);
      set((state) => updateTerminal(state, id, (t) => ({ ...t, isRestarting: false })));
    } catch (error) {
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

      const restartError = {
        message: errorMessage,
        code: errorCode,
        timestamp: Date.now(),
        recoverable: errorCode === "ENOENT" || phase === "frontend-readiness",
        context: {
          failedCwd: currentTerminal.cwd,
          command: commandToRun,
          phase,
          isAgent,
          agentId: effectiveAgentId,
        },
      };

      // Always release the transient input lock so a failed restart can't
      // leave the (possibly recreated) instance permanently locked.
      terminalInstanceService.setInputLocked(id, false);

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
        cwd: currentTerminal.cwd,
        command: commandToRun,
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
        [id]: { ...t, cwd, restartError: undefined, spawnError: undefined },
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
      // Scrollable grid (#8805): restoring a panel always lands it in the
      // destination worktree's grid; the grid scrolls if it now exceeds the
      // screen-fit count.
      const newLocation: PanelLocation = "grid";
      movedToLocation = newLocation;

      const t = state.panelsById[id];
      if (!t) return state;
      const ptyT = isPtyPanel(t) ? t : undefined;
      const newById = {
        ...state.panelsById,
        [id]: {
          ...t,
          worktreeId,
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

    terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
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
        terminalInstanceService.setInputLocked(id, locked);
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
        terminalInstanceService.setInputLocked(id, locked);
      }
      return { panelsById: newById };
    });
  },

  activateFallbackPreset: async (id, nextPresetId, originalPresetId) => {
    const terminal = get().panelsById[id];
    if (!terminal) {
      return { success: false, error: "terminal not found" };
    }
    if (!isPtyPanel(terminal)) {
      return { success: false, error: "panel is not a PTY panel" };
    }
    if (terminal.isRestarting) {
      return { success: false, error: "already restarting" };
    }

    const effectiveAgentId = terminal.launchAgentId;
    if (!effectiveAgentId) {
      return { success: false, error: "panel is not an agent" };
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
    const priorSnapshot = {
      command: terminal.command,
      agentPresetId: terminal.agentPresetId,
      agentPresetColor: terminal.agentPresetColor,
      originalPresetId: terminal.originalPresetId,
      isUsingFallback: terminal.isUsingFallback,
      fallbackChainIndex: terminal.fallbackChainIndex,
      agentLaunchFlags: terminal.agentLaunchFlags,
    };

    try {
      const [agentSettings, tmpDir] = await Promise.all([
        agentSettingsClient.get(),
        systemClient.getTmpDir().catch(() => ""),
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
        throw new Error(`fallback preset "${nextPresetId}" not found`);
      }

      const effectiveEntry = runtimeSettings.effectiveEntry;

      let clipboardDirectory: string | undefined;
      if (effectiveAgentId === "gemini" && effectiveEntry.shareClipboardDirectory !== false) {
        clipboardDirectory = tmpDir ? `${tmpDir}/daintree-clipboard` : undefined;
      }

      const agentConfig = getAgentConfig(effectiveAgentId);
      const baseCommand = resolveAgentLaunchBaseCommand(
        agentConfig?.command || effectiveAgentId,
        await getCurrentLaunchCliDetail(effectiveAgentId)
      );
      const globalSkipPermissions = agentSettings?.globalSkipPermissions ?? false;
      const globalUseAltScreen = agentSettings?.globalUseAltScreen ?? false;
      const commandToRun = generateAgentCommand(baseCommand, effectiveEntry, effectiveAgentId, {
        clipboardDirectory,
        modelId: terminal.agentModelId,
        presetArgs: nextPreset.args?.join(" "),
        globalSkipPermissions,
        globalUseAltScreen,
      });
      const nextLaunchFlags = buildAgentLaunchFlags(effectiveEntry, effectiveAgentId, {
        modelId: terminal.agentModelId,
        presetArgs: nextPreset.args,
        globalSkipPermissions,
        globalUseAltScreen,
      });

      // Capture live terminal dimensions before teardown
      const managedInstance = terminalInstanceService.get(id);
      let spawnCols = terminal.cols || 80;
      let spawnRows = terminal.rows || 24;
      if (managedInstance?.terminal) {
        spawnCols = managedInstance.terminal.cols || spawnCols;
        spawnRows = managedInstance.terminal.rows || spawnRows;
      }

      terminalInstanceService.destroy(id);
      terminalInstanceService.suppressNextExit(id, 10000);
      try {
        await terminalClient.kill(id);
      } catch (error) {
        logWarn("[TerminalStore] kill failed during fallback activation; continuing", {
          id,
          error,
        });
      }

      const nextChainIndex = (terminal.fallbackChainIndex ?? 0) + 1;

      set((state) => {
        const t = state.panelsById[id];
        if (!t || !isPtyPanel(t)) return state;
        const updated = {
          ...t,
          restartKey: (t.restartKey ?? 0) + 1,
          agentState: "working" as AgentState,
          lastStateChange: Date.now(),
          stateChangeTrigger: undefined,
          stateChangeConfidence: undefined,
          command: commandToRun,
          agentPresetId: nextPreset.id,
          agentPresetColor: nextPreset.color,
          originalPresetId: originalPresetId,
          isUsingFallback: true,
          fallbackChainIndex: nextChainIndex,
          agentLaunchFlags: nextLaunchFlags,
          agentSessionId: undefined,
          isRestarting: true,
          restartError: undefined,
          exitCode: undefined,
          // Drop the prior session's parsed check result (#10682) — a fresh
          // run hasn't produced one yet, and a stale pass/fail would mislead.
          lastCheckResult: undefined,
          startedAt: Date.now(),
        };
        const newById = { ...state.panelsById, [id]: updated };
        saveNormalized(newById, state.panelIds);
        return { panelsById: newById };
      });

      await terminalInstanceService.waitForInstance(id, { timeoutMs: 5000 });

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
        cwd: terminal.cwd,
        projectId: capturedWorkspaceId,
        worktreeId: fallbackWorktreeId,
        worktreeSource: fallbackWorktreeId !== undefined ? "explicit" : undefined,
        agentModelId: terminal.agentModelId,
        agentPresetId: nextPreset.id,
        originalPresetId: originalPresetId,
        agentLaunchFlags: nextLaunchFlags,
        env: computeEnvProvenance(restartEnv),
        initialCols: spawnCols,
        initialRows: spawnRows,
      });

      await terminalClient.spawn({
        id,
        projectId: capturedWorkspaceId,
        cwd: terminal.cwd,
        cols: spawnCols,
        rows: spawnRows,
        kind: "terminal",
        launchAgentId: terminal.launchAgentId,
        // Carried with the title, never without it: a title that arrives
        // unaccompanied re-stamps as "default" and the next detection sweep
        // overwrites the user's rename (#10794).
        ...titleAtSpawn(get, id, terminal),
        command: commandToRun,
        restore: false,
        env: restartEnv,
        agentLaunchFlags: nextLaunchFlags,
        agentModelId: terminal.agentModelId,
        // Carried for the same reason as the restart path: a fallback hop that
        // drops it strands the run in the palette's "No worktree" bucket for
        // the rest of its life (#12060).
        worktreeId: fallbackWorktreeId,
        agentPresetId: nextPreset.id,
        agentPresetColor: nextPreset.color,
        originalAgentPresetId: originalPresetId,
      });

      if (terminal.location === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.fit(id);
      }

      unmarkTerminalRestarting(id);
      set((state) => updateTerminal(state, id, (t) => ({ ...t, isRestarting: false })));
      return { success: true };
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to restart terminal");
      unmarkTerminalRestarting(id);
      set((state) =>
        updateTerminal(state, id, (t) => ({
          ...t,
          isRestarting: false,
          // Restore pre-mutation fields so fallbackChainIndex and presetId
          // accurately reflect "we are NOT running the next preset". Without
          // rollback, any subsequent fallback trigger would jump past this
          // preset even though the PTY never started.
          ...priorSnapshot,
          restartError: {
            message: errorMessage,
            timestamp: Date.now(),
            recoverable: false,
            context: {
              failedCwd: terminal.cwd,
              phase: "fallback-activation",
              nextPresetId,
            },
          },
        }))
      );
      logError("[TerminalStore] Failed to activate fallback preset", error, {
        id,
        nextPresetId,
      });
      return { success: false, error: errorMessage };
    }
  },
});

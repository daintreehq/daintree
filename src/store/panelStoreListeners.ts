import type {
  AgentStateChangePayload,
  TerminalActivityPayload,
  TerminalStatusPayload,
} from "@shared/types";
import type { CrashType } from "@shared/types/pty-host";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "./worktreeStore";
import { useResourceMonitoringStore } from "./resourceMonitoringStore";
import { flushPanelPersistence } from "./slices";
import { isAgentTerminal } from "@/utils/terminalType";
import { logInfo, logWarn, logError } from "@/utils/logger";
import { SCROLLBACK_BACKGROUND } from "@shared/config/scrollback";
import { clearAllRestartGuards, isTerminalRestarting } from "./restartExitSuppression";
import { usePanelStore, type PanelGridState } from "./panelStore";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { getMergedPresets } from "@/config/agents";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useNotificationStore } from "@/store/notificationStore";
import { isBuiltInAgentId } from "@shared/config/agentIds";

function normalizeCrashType(value: unknown): CrashType | null {
  const validTypes: CrashType[] = [
    "OUT_OF_MEMORY",
    "ASSERTION_FAILURE",
    "SIGNAL_TERMINATED",
    "UNKNOWN_CRASH",
    "CLEAN_EXIT",
  ];
  return validTypes.includes(value as CrashType) ? (value as CrashType) : null;
}

let store: DisposableStore | null = null;
// Managed dynamically inside backendCrashed / backendReady callbacks — set and
// cleared mid-flight, so it cannot be registered with `store` at setup time.
let recoveryTimer: NodeJS.Timeout | null = null;

/**
 * Per-terminal reentrancy guard for fallback activations. A single slow exit
 * can produce duplicate `agent:fallback-triggered` events if respawn races
 * with cleanup — we ignore re-entries for the same terminalId until the
 * activation resolves.
 */
const fallbackInFlight = new Set<string>();

const activityBuffer = new Map<string, TerminalActivityPayload>();
let activityRafId: number | null = null;

function flushActivityBuffer(): void {
  activityRafId = null;
  if (activityBuffer.size === 0) return;
  const panelStore = usePanelStore.getState();
  for (const data of activityBuffer.values()) {
    panelStore.updateActivity(
      data.terminalId,
      data.headline,
      data.status,
      data.type,
      data.timestamp,
      data.lastCommand
    );
  }
  activityBuffer.clear();
}

function cancelActivityBuffer(): void {
  if (activityRafId !== null) {
    cancelAnimationFrame(activityRafId);
    activityRafId = null;
  }
  activityBuffer.clear();
}

export function cleanupTerminalStoreListeners() {
  clearAllRestartGuards();
  cancelActivityBuffer();
  store?.dispose();
  store = null;
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  fallbackInFlight.clear();
}

async function handleFallbackTriggered(data: {
  terminalId: string;
  agentId: string;
  fromPresetId: string;
  originalPresetId?: string;
  reason: "connection" | "auth";
}): Promise<void> {
  const { terminalId, agentId, fromPresetId, reason } = data;
  if (fallbackInFlight.has(terminalId)) return;

  const panel = usePanelStore.getState().panelsById[terminalId];
  if (!panel) return;
  if (panel.isRestarting) return;

  // Drop stale duplicate events: if the panel has already advanced past the
  // preset this event refers to, the exit was from a now-replaced process
  // and advancing the chain again would skip a preset.
  if (panel.agentPresetId !== fromPresetId) return;

  const originalPresetId = panel.originalPresetId ?? data.originalPresetId ?? fromPresetId;

  // Resolve the original preset's fallbacks[] chain from the agent settings store
  // (renderer-local mirror of user settings; no IPC needed here).
  const agentSettings = useAgentSettingsStore.getState().settings;
  const entry = agentSettings?.agents?.[agentId] ?? {};
  const ccrPresets = useCcrPresetsStore.getState().ccrPresetsByAgent[agentId];
  const mergedPresets = getMergedPresets(agentId, entry.customPresets, ccrPresets);
  const originalPreset = mergedPresets.find((p) => p.id === originalPresetId);

  const chain = originalPreset?.fallbacks ?? [];
  const currentIndex = panel.fallbackChainIndex ?? 0;
  const nextPresetId = chain[currentIndex];

  // Always lookup a fresh preset name, using the panel title as last resort.
  const fromPreset = mergedPresets.find((p) => p.id === fromPresetId);
  const fromName = fromPreset?.name ?? fromPresetId;

  if (!nextPresetId) {
    // Chain exhausted: surface a single error notification. No respawn.
    const isExhausted = chain.length > 0;
    useNotificationStore.getState().addNotification({
      type: "error",
      priority: "high",
      title: isExhausted ? "Fallback chain exhausted" : `${fromName} unavailable`,
      message: isExhausted
        ? `All fallback presets tried. Terminal will stay exited.`
        : `${fromName} provider is unreachable. Configure fallbacks in Settings to auto-recover.`,
    });
    return;
  }

  const nextPreset = mergedPresets.find((p) => p.id === nextPresetId);
  if (!nextPreset) {
    useNotificationStore.getState().addNotification({
      type: "error",
      priority: "high",
      title: "Fallback preset missing",
      message: `Preset "${nextPresetId}" is no longer configured. Skipping.`,
    });
    return;
  }

  fallbackInFlight.add(terminalId);
  try {
    logInfo("[TerminalStore] Activating fallback preset", {
      terminalId,
      agentId,
      fromPresetId,
      toPresetId: nextPresetId,
      reason,
    });

    const result = await usePanelStore
      .getState()
      .activateFallbackPreset(terminalId, nextPresetId, originalPresetId);

    if (result.success) {
      useNotificationStore.getState().addNotification({
        type: "info",
        priority: "low",
        title: "Switched to fallback preset",
        message:
          reason === "auth"
            ? `${fromName} authentication failed — now running "${nextPreset.name}".`
            : `${fromName} unreachable — now running "${nextPreset.name}".`,
      });
    } else {
      useNotificationStore.getState().addNotification({
        type: "error",
        priority: "high",
        title: "Fallback activation failed",
        message: `Could not switch to "${nextPreset.name}": ${result.error ?? "unknown error"}`,
      });
    }
  } finally {
    fallbackInFlight.delete(terminalId);
  }
}

export function setupTerminalStoreListeners() {
  if (typeof window === "undefined") return () => {};

  // Idempotent: return early if already set up to prevent overlapping registration.
  if (store !== null) {
    return cleanupTerminalStoreListeners;
  }

  const disposables = new DisposableStore();
  store = disposables;

  disposables.add(
    toDisposable(
      terminalRegistryController.onAgentStateChanged((data: AgentStateChangePayload) => {
        const {
          terminalId,
          state,
          timestamp,
          trigger,
          confidence,
          waitingReason,
          sessionCost,
          sessionTokens,
        } = data;

        if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
          logWarn("Invalid timestamp in agent state event", { data });
          return;
        }

        if (!terminalId) {
          logWarn("Missing terminalId in agent state event", { data });
          return;
        }

        const clampedConfidence = Math.max(0, Math.min(1, confidence || 0));

        const terminal = usePanelStore.getState().panelsById[terminalId];

        if (!terminal) {
          return;
        }

        if (terminal.isRestarting) {
          return;
        }

        if (terminal.lastStateChange && timestamp < terminal.lastStateChange) {
          return;
        }

        terminalInstanceService.setAgentState(terminalId, state);

        if (terminal.agentState === "directing" && state === "waiting") {
          return;
        }

        usePanelStore
          .getState()
          .updateAgentState(
            terminalId,
            state,
            undefined,
            timestamp,
            trigger,
            clampedConfidence,
            waitingReason,
            sessionCost,
            sessionTokens
          );

        if (state === "waiting" || state === "idle") {
          usePanelStore.getState().processQueue(terminalId);
        }
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onAgentDetected((data) => {
        const { terminalId, processIconId, agentType } = data;
        if (!terminalId) return;
        // When a runtime agent is detected, mirror the backend sticky flag so the exit
        // preservation guard in the renderer survives even if the snapshot IPC is
        // reordered relative to the exit event.
        const nextEverDetectedAgent = agentType ? true : undefined;
        const nextDetectedAgentId = isBuiltInAgentId(agentType) ? agentType : undefined;
        if (!processIconId && !nextEverDetectedAgent && !nextDetectedAgentId) return;

        // Snapshot the persisted agentId before mutation so we can detect
        // runtime promotion of a plain terminal (no agentId) that just started
        // hosting a built-in agent. Cold-spawned agent panels (agentId set at
        // spawn) already use the agent scrollback policy and do not need repair.
        const priorAgentId = usePanelStore.getState().panelsById[terminalId]?.agentId;

        usePanelStore.setState((state) => {
          const terminal = state.panelsById[terminalId];
          if (!terminal) return state;

          const needsIconUpdate =
            processIconId !== undefined && terminal.detectedProcessId !== processIconId;
          const needsStickyUpdate =
            nextEverDetectedAgent === true && terminal.everDetectedAgent !== true;
          const needsAgentIdUpdate =
            nextDetectedAgentId !== undefined && terminal.detectedAgentId !== nextDetectedAgentId;

          if (!needsIconUpdate && !needsStickyUpdate && !needsAgentIdUpdate) return state;

          return {
            panelsById: {
              ...state.panelsById,
              [terminalId]: {
                ...terminal,
                ...(needsIconUpdate && { detectedProcessId: processIconId }),
                ...(needsStickyUpdate && { everDetectedAgent: true }),
                ...(needsAgentIdUpdate && { detectedAgentId: nextDetectedAgentId }),
              },
            },
          };
        });

        // Runtime promotion: a panel spawned without an agentId cannot get the
        // agent env/pool repaired in-process, but the live xterm scrollback
        // grows to the agent policy so recent output isn't clipped.
        if (priorAgentId === undefined && nextDetectedAgentId !== undefined) {
          terminalInstanceService.applyAgentPromotion(terminalId, nextDetectedAgentId);
        }
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onAgentExited((data) => {
        const { terminalId } = data;
        if (!terminalId) return;

        // `agent:exited` is a subcommand/demotion signal — the shell PTY is
        // still alive. Clear only the LIVE detection fields. `agentId` is
        // sealed launch intent (#5803) and must never be cleared here:
        // restart decisions read it to decide whether to relaunch as agent
        // vs plain shell, and clearing it would corrupt that decision on a
        // cold-launched agent terminal whose user typed `/quit`. #5807
        usePanelStore.setState((state) => {
          const terminal = state.panelsById[terminalId];
          if (!terminal) return state;
          const clearProcess = terminal.detectedProcessId !== undefined;
          const clearDetectedAgent = terminal.detectedAgentId !== undefined;
          if (!clearProcess && !clearDetectedAgent) return state;

          return {
            panelsById: {
              ...state.panelsById,
              [terminalId]: {
                ...terminal,
                ...(clearProcess && { detectedProcessId: undefined }),
                ...(clearDetectedAgent && { detectedAgentId: undefined }),
              },
            },
          };
        });
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onFallbackTriggered((data) => {
        void handleFallbackTriggered(data).catch((err) => {
          logError("[TerminalStore] Unhandled error in fallback listener", err, {
            terminalId: data.terminalId,
          });
          fallbackInFlight.delete(data.terminalId);
        });
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onActivity((data: TerminalActivityPayload) => {
        activityBuffer.set(data.terminalId, data);
        if (activityRafId === null) {
          activityRafId = requestAnimationFrame(flushActivityBuffer);
        }
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onTrashed((data: { id: string; expiresAt: number }) => {
        const { id, expiresAt } = data;
        const state = usePanelStore.getState();
        const terminal = state.panelsById[id];
        const originalLocation: "dock" | "grid" = terminal?.location === "dock" ? "dock" : "grid";
        state.markAsTrashed(id, expiresAt, originalLocation);

        const updates: Partial<PanelGridState> = {};
        if (state.focusedId === id) {
          const activeWt = useWorktreeSelectionStore.getState().activeWorktreeId ?? undefined;
          const gridTerminals = state.panelIds
            .map((tid) => state.panelsById[tid])
            .filter(
              (t) =>
                t &&
                t.id !== id &&
                t.location === "grid" &&
                (t.worktreeId ?? undefined) === activeWt
            );
          updates.focusedId = gridTerminals[0]?.id ?? null;
        }
        if (state.maximizedId === id) {
          updates.maximizedId = null;
        }
        if (Object.keys(updates).length > 0) {
          usePanelStore.setState(updates);
        }
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onRestored((data: { id: string }) => {
        const { id } = data;
        usePanelStore.getState().markAsRestored(id);
        usePanelStore.setState({ focusedId: id });
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onExit((id, exitCode) => {
        // Check synchronous restart guard FIRST - this handles the race condition where
        // the store's isRestarting flag hasn't propagated yet during bulk restarts
        if (isTerminalRestarting(id)) {
          return;
        }

        const state = usePanelStore.getState();
        const terminal = state.panelsById[id];

        if (!terminal) return;

        // Also check store flag for safety (handles edge cases)
        if (terminal.isRestarting) {
          return;
        }

        // Clean up resource metrics for exited terminal
        useResourceMonitoringStore.getState().removePanel(id);

        // Store exit code on the terminal before applying exit behavior
        usePanelStore.setState((s) => {
          const existing = s.panelsById[id];
          if (!existing) return s;
          return {
            panelsById: {
              ...s.panelsById,
              [id]: { ...existing, exitCode },
            },
          };
        });

        state.setRuntimeStatus(id, "exited");

        // If already trashed, this is TTL expiry cleanup - permanently remove
        if (terminal.location === "trash") {
          state.removePanel(id);
          return;
        }

        // Non-zero exit codes always preserve terminal for debugging, regardless of exitBehavior
        // This ensures failures are visible for review
        if (exitCode !== 0) {
          return;
        }

        // Respect explicit exitBehavior if set (only honored on successful exit)
        if (terminal.exitBehavior === "remove") {
          state.removePanel(id);
          return;
        }

        if (terminal.exitBehavior === "trash") {
          state.trashPanel(id);
          return;
        }

        if (terminal.exitBehavior === "keep" || terminal.exitBehavior === "restart") {
          // "keep": preserve terminal for review
          // "restart": preserve terminal; TerminalPane triggers the restart via its exit effect
          // Note: non-zero exits are already preserved above, so this only matters for exit code 0
          return;
        }

        // exitBehavior undefined - use default behavior based on terminal type
        // Preserve dev-preview panels so users can inspect stopped/error states
        if (terminal.kind === "dev-preview") {
          return;
        }

        // Preserve successfully completed agent terminals to enable reboot and output review.
        // Also preserve plain terminals that ran an agent mid-session (runtime detection);
        // everDetectedAgent is sticky in the PTY host so it survives past the inner agent exit.
        if (
          isAgentTerminal(terminal.kind ?? terminal.type, terminal.agentId) ||
          terminal.everDetectedAgent === true
        ) {
          return;
        }

        // Auto-trash non-agent terminals on exit (preserves history for review, consistent with manual close)
        state.trashPanel(id);
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onStatus((data: TerminalStatusPayload) => {
        const { id, status, timestamp } = data;
        usePanelStore.getState().updateFlowStatus(id, status, timestamp);
        if (status === "suspended" || status === "paused-backpressure") {
          terminalInstanceService.wake(id);
        }
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onBackendCrashed((details) => {
        logError("Backend crashed", undefined, { details });

        // Cancel any pending recovery timer
        if (recoveryTimer) {
          clearTimeout(recoveryTimer);
          recoveryTimer = null;
        }

        usePanelStore.setState({
          backendStatus: "disconnected",
          lastCrashType: normalizeCrashType(details?.crashType),
        });
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onBackendReady(() => {
        logInfo("Backend recovered, resetting renderers...");

        // Cancel any pending recovery timer from previous crash
        if (recoveryTimer) {
          clearTimeout(recoveryTimer);
          recoveryTimer = null;
        }

        usePanelStore.setState({ backendStatus: "recovering" });

        // Reset all xterm instances to fix white text
        terminalInstanceService.handleBackendRecovery();

        // Mark as connected after a short delay to show recovery state
        recoveryTimer = setTimeout(() => {
          recoveryTimer = null;
          usePanelStore.setState({ backendStatus: "connected", lastCrashType: null });
        }, 500);
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onSpawnResult((id, result) => {
        if (!result.success) {
          if (result.error) {
            logError(`Spawn failed for terminal ${id}`, undefined, { error: result.error });
            usePanelStore.getState().setSpawnError(id, result.error);
          } else {
            // Spawn failed but no error details provided - set generic error
            logError(`Spawn failed for terminal ${id} with no error details`);
            usePanelStore.getState().setSpawnError(id, {
              code: "UNKNOWN",
              message: "Failed to start terminal process",
            });
          }
        } else {
          // Spawn succeeded - clear any previous spawn error
          const terminal = usePanelStore.getState().panelsById[id];
          if (terminal?.spawnError) {
            usePanelStore.getState().clearSpawnError(id);
          }
        }
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onReduceScrollback(({ terminalIds, targetLines }) => {
        for (const id of terminalIds) {
          terminalInstanceService.reduceScrollback(id, targetLines);
        }
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onRestoreScrollback(({ terminalIds }) => {
        for (const id of terminalIds) {
          terminalInstanceService.restoreScrollback(id);
        }
      })
    )
  );

  // Resource metrics listener
  disposables.add(
    toDisposable(
      window.electron.terminal.onResourceMetrics((data) => {
        const rmStore = useResourceMonitoringStore.getState();
        if (rmStore.enabled) {
          rmStore.updateMetrics(data.metrics);
        }
      })
    )
  );

  // Memory pressure: reduce scrollback on all background terminals
  disposables.add(
    toDisposable(
      window.electron.terminal.onReclaimMemory(() => {
        terminalInstanceService.reduceScrollbackAllBackground(SCROLLBACK_BACKGROUND);
      })
    )
  );

  // Flush pending terminal persistence on window close to prevent data loss
  const beforeUnloadHandler = () => {
    flushPanelPersistence();
  };
  window.addEventListener("beforeunload", beforeUnloadHandler);
  disposables.add(
    toDisposable(() => window.removeEventListener("beforeunload", beforeUnloadHandler))
  );

  return cleanupTerminalStoreListeners;
}

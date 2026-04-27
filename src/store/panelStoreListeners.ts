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
import {
  deriveTerminalRuntimeIdentity,
  terminalRuntimeIdentitiesEqual,
} from "@/utils/terminalChrome";
import { logInfo, logWarn, logError } from "@/utils/logger";
import { SCROLLBACK_BACKGROUND } from "@shared/config/scrollback";
import { clearAllRestartGuards, isTerminalRestarting } from "./restartExitSuppression";
import { usePanelStore, type PanelGridState } from "./panelStore";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { getMergedPresets } from "@/config/agents";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useNotificationStore } from "@/store/notificationStore";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { getDefaultTitle } from "./slices/panelRegistry/helpers";

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

// Circular log of identity events for live diagnostics. Open devtools and
// call `__daintreeIdentityEvents()` to inspect the last N detected/exited
// events per terminal. Off by default outside dev tools inspection — the log
// is append-only, capped, and has no effect on store behavior.
const IDENTITY_LOG_CAP = 200;
interface IdentityEventEntry {
  at: number;
  kind: "detected" | "exited";
  terminalId: string;
  agentType?: string;
  processIconId?: string;
}
const _identityLog: IdentityEventEntry[] = [];

function recordIdentityEvent(
  kind: "detected" | "exited",
  terminalId: string,
  detail: { agentType?: string; processIconId?: string }
): void {
  const entry: IdentityEventEntry = {
    at: Date.now(),
    kind,
    terminalId,
    agentType: detail.agentType,
    processIconId: detail.processIconId,
  };
  _identityLog.push(entry);
  if (_identityLog.length > IDENTITY_LOG_CAP) _identityLog.shift();

  // Every detection/exit event lands in the browser devtools console so a
  // user reporting "chrome didn't update" can dump the live trail without
  // needing to open the main-process log. Prefix stays searchable.
  if (typeof console !== "undefined") {
    console.log(
      `[IdentityDebug] ${kind} term=${terminalId.slice(-8)} agent=${detail.agentType ?? "<none>"} icon=${detail.processIconId ?? "<none>"}`
    );
  }

  if (typeof window !== "undefined") {
    const w = window as unknown as {
      __daintreeIdentityEvents?: () => IdentityEventEntry[];
      __daintreeIdentityState?: () => Array<{
        terminalId: string;
        title: string;
        launchAgentId?: string;
        detectedAgentId?: string;
        everDetectedAgent?: boolean;
        detectedProcessId?: string;
        runtimeIdentity?: unknown;
        agentState?: string;
      }>;
    };
    if (!w.__daintreeIdentityEvents) {
      w.__daintreeIdentityEvents = () => _identityLog.slice();
    }
    if (!w.__daintreeIdentityState) {
      w.__daintreeIdentityState = () => {
        const panels = usePanelStore.getState().panelsById;
        return Object.values(panels).map((p) => {
          const terminal = p as {
            id: string;
            title: string;
            launchAgentId?: string;
            detectedAgentId?: string;
            everDetectedAgent?: boolean;
            detectedProcessId?: string;
            runtimeIdentity?: unknown;
            agentState?: string;
          };
          return {
            terminalId: terminal.id,
            title: terminal.title,
            launchAgentId: terminal.launchAgentId,
            detectedAgentId: terminal.detectedAgentId,
            everDetectedAgent: terminal.everDetectedAgent,
            detectedProcessId: terminal.detectedProcessId,
            runtimeIdentity: terminal.runtimeIdentity,
            agentState: terminal.agentState,
          };
        });
      };
    }
  }
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
  const projectPresets = useProjectPresetsStore.getState().presetsByAgent[agentId];
  const mergedPresets = getMergedPresets(agentId, entry.customPresets, ccrPresets, projectPresets);
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
        const timestamp = data.timestamp ?? Date.now();
        recordIdentityEvent("detected", terminalId, { agentType, processIconId });
        const nextEverDetectedAgent = agentType ? true : undefined;
        const nextDetectedAgentId = isBuiltInAgentId(agentType) ? agentType : undefined;
        const nextDetectedProcessId = processIconId ?? nextDetectedAgentId;
        if (!nextDetectedProcessId && !nextEverDetectedAgent && !nextDetectedAgentId) {
          console.log(
            `[IdentityDebug] detected IGNORED term=${terminalId.slice(-8)} reason=no-icon-and-no-agent`
          );
          return;
        }

        usePanelStore.setState((state) => {
          const terminal = state.panelsById[terminalId];
          if (!terminal) {
            console.log(
              `[IdentityDebug] detected IGNORED term=${terminalId.slice(-8)} reason=panel-not-found`
            );
            return state;
          }

          const needsIconUpdate =
            nextDetectedProcessId !== undefined &&
            terminal.detectedProcessId !== nextDetectedProcessId;
          const needsStickyUpdate =
            nextEverDetectedAgent === true && terminal.everDetectedAgent !== true;
          const needsAgentIdUpdate =
            nextDetectedAgentId !== undefined && terminal.detectedAgentId !== nextDetectedAgentId;
          const nextRuntimeIdentity = deriveTerminalRuntimeIdentity({
            detectedAgentId: nextDetectedAgentId,
            detectedProcessId: nextDetectedProcessId,
          });
          const needsRuntimeIdentityUpdate = !terminalRuntimeIdentitiesEqual(
            terminal.runtimeIdentity,
            nextRuntimeIdentity
          );
          const shouldSeedAgentState =
            nextDetectedAgentId !== undefined &&
            (terminal.agentState === undefined || terminal.agentState === "exited");
          // Compute the new default title from the resolved chrome identity.
          const titleMode = terminal.titleMode ?? "default";
          const computedTitle = needsAgentIdUpdate
            ? getDefaultTitle(terminal.kind, {
                detectedAgentId: nextDetectedAgentId,
                launchAgentId: terminal.launchAgentId,
                everDetectedAgent: terminal.everDetectedAgent,
              })
            : undefined;
          const needsTitleUpdate =
            titleMode === "default" &&
            computedTitle !== undefined &&
            computedTitle.length > 0 &&
            terminal.title !== computedTitle;

          if (
            !needsIconUpdate &&
            !needsStickyUpdate &&
            !needsAgentIdUpdate &&
            !needsRuntimeIdentityUpdate &&
            !shouldSeedAgentState &&
            !needsTitleUpdate
          ) {
            console.log(
              `[IdentityDebug] detected NOOP term=${terminalId.slice(-8)} ` +
                `already detectedAgentId=${terminal.detectedAgentId ?? "<none>"} ` +
                `detectedProcessId=${terminal.detectedProcessId ?? "<none>"} ` +
                `everDetected=${terminal.everDetectedAgent ?? false}`
            );
            return state;
          }

          console.log(
            `[IdentityDebug] detected APPLY term=${terminalId.slice(-8)} ` +
              `prev.detectedAgentId=${terminal.detectedAgentId ?? "<none>"} → ${nextDetectedAgentId ?? "<none>"} ` +
              `prev.detectedProcessId=${terminal.detectedProcessId ?? "<none>"} → ${nextDetectedProcessId ?? "<none>"} ` +
              `prev.runtimeIdentity=${terminal.runtimeIdentity?.kind ?? "<none>"}:${terminal.runtimeIdentity?.id ?? "<none>"} → ` +
              `${nextRuntimeIdentity?.kind ?? "<none>"}:${nextRuntimeIdentity?.id ?? "<none>"} ` +
              `launchAgentId=${terminal.launchAgentId ?? "<none>"}`
          );

          // Runtime detection still applies the in-process agent policies
          // (scrollback/activity handlers). Launch affinity can brand the
          // shell before this event, but detection confirms which live agent
          // owns the PTY instance.
          if (
            nextDetectedAgentId &&
            (needsAgentIdUpdate || needsRuntimeIdentityUpdate || shouldSeedAgentState)
          ) {
            terminalInstanceService.applyAgentPromotion(terminalId, nextDetectedAgentId);
          }

          return {
            panelsById: {
              ...state.panelsById,
              [terminalId]: {
                ...terminal,
                ...(needsIconUpdate && { detectedProcessId: nextDetectedProcessId }),
                ...(needsStickyUpdate && { everDetectedAgent: true }),
                ...(needsAgentIdUpdate && { detectedAgentId: nextDetectedAgentId }),
                ...(needsRuntimeIdentityUpdate && {
                  runtimeIdentity: nextRuntimeIdentity ?? undefined,
                }),
                ...(shouldSeedAgentState && {
                  agentState: "idle" as const,
                  lastStateChange: timestamp,
                }),
                ...(needsTitleUpdate && { title: computedTitle }),
              },
            },
          };
        });
      })
    )
  );

  disposables.add(
    toDisposable(
      terminalRegistryController.onAgentExited((data) => {
        const { terminalId } = data;
        if (!terminalId) return;
        recordIdentityEvent("exited", terminalId, {
          agentType: (data as { agentType?: string }).agentType,
        });
        terminalInstanceService.clearAgentPromotion(terminalId);

        // `agent:exited` clears live-detection fields for both subcommand
        // demotion and preserved PTY exit. `launchAgentId` is immutable and is
        // not touched here; `agentState: "exited"` is the durable strong-exit
        // signal that makes deriveTerminalChrome release launch affinity.
        usePanelStore.setState((state) => {
          const terminal = state.panelsById[terminalId];
          if (!terminal) {
            console.log(
              `[IdentityDebug] exited IGNORED term=${terminalId.slice(-8)} reason=panel-not-found`
            );
            return state;
          }
          const clearProcess = terminal.detectedProcessId !== undefined;
          const clearDetectedAgent = terminal.detectedAgentId !== undefined;
          const clearRuntimeIdentity = terminal.runtimeIdentity !== undefined;
          const shouldMarkAgentExited =
            clearDetectedAgent ||
            Boolean((data as { agentType?: string }).agentType) ||
            data.exitKind === "subcommand" ||
            data.exitKind === "terminal";
          const needsAgentStateExited = shouldMarkAgentExited && terminal.agentState !== "exited";
          // After demotion, detectedAgentId is cleared and agentState becomes
          // exited, so deriveTerminalChrome ignores durable launch affinity and
          // the title reverts to "Terminal".
          const titleMode = terminal.titleMode ?? "default";
          const computedTitle = shouldMarkAgentExited
            ? getDefaultTitle(terminal.kind, {
                detectedAgentId: undefined,
                launchAgentId: terminal.launchAgentId,
                everDetectedAgent: true,
                agentState: "exited",
              })
            : undefined;
          const needsTitleUpdate =
            titleMode === "default" &&
            computedTitle !== undefined &&
            terminal.title !== computedTitle;
          if (
            !clearProcess &&
            !clearDetectedAgent &&
            !clearRuntimeIdentity &&
            !needsAgentStateExited &&
            !needsTitleUpdate
          ) {
            console.log(`[IdentityDebug] exited NOOP term=${terminalId.slice(-8)} already cleared`);
            return state;
          }

          console.log(
            `[IdentityDebug] exited APPLY term=${terminalId.slice(-8)} ` +
              `prev.detectedAgentId=${terminal.detectedAgentId ?? "<none>"} → <none> ` +
              `prev.detectedProcessId=${terminal.detectedProcessId ?? "<none>"} → <none>`
          );

          return {
            panelsById: {
              ...state.panelsById,
              [terminalId]: {
                ...terminal,
                ...(clearProcess && { detectedProcessId: undefined }),
                ...(clearDetectedAgent && { detectedAgentId: undefined }),
                ...(clearRuntimeIdentity && { runtimeIdentity: undefined }),
                ...(needsAgentStateExited && {
                  agentState: "exited" as const,
                  lastStateChange: data.timestamp ?? Date.now(),
                }),
                ...(needsTitleUpdate && { title: computedTitle }),
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
          updates.previousFocusedId = null;
        } else if (state.previousFocusedId === id) {
          updates.previousFocusedId = null;
        }
        if (state.maximizedId === id) {
          updates.maximizedId = null;
        }
        if (state.activeDockTerminalId === id) {
          updates.activeDockTerminalId = null;
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
        const previousFocusedId = usePanelStore.getState().focusedId;
        usePanelStore.setState({
          focusedId: id,
          activeDockTerminalId: null,
          ...(previousFocusedId !== id && { previousFocusedId }),
        });
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
        if (isAgentTerminal(terminal) || terminal.everDetectedAgent === true) {
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

// This module registers IPC listeners via `setupTerminalStoreListeners` at app
// bootstrap (see `src/hooks/app/usePanelStoreBootstrap.ts`). Without an HMR
// accept boundary, any edit here — or to any of its imports — cascades into a
// full page reload because Vite can't prove the replacement is safe. Self-
// accepting is safe because the listener registry (`store`) is module-level
// and we drop it on dispose; the React effect in `usePanelStoreBootstrap`
// then re-invokes `setupTerminalStoreListeners` on its next run.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cleanupTerminalStoreListeners();
  });
  import.meta.hot.accept();
}

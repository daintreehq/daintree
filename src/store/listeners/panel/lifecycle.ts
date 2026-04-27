import type { TerminalStatusPayload } from "@shared/types";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { isAgentTerminal } from "@/utils/terminalType";
import { logInfo, logError } from "@/utils/logger";
import { isTerminalRestarting } from "@/store/restartExitSuppression";
import { usePanelStore, type PanelGridState } from "@/store/panelStore";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { getMergedPresets } from "@/config/agents";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useNotificationStore } from "@/store/notificationStore";

/**
 * Per-terminal reentrancy guard for fallback activations. A single slow exit
 * can produce duplicate `agent:fallback-triggered` events if respawn races
 * with cleanup — we ignore re-entries for the same terminalId until the
 * activation resolves.
 */
const fallbackInFlight = new Set<string>();

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
      duration: 12000,
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
      duration: 12000,
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
        duration: 4000,
      });
    } else {
      useNotificationStore.getState().addNotification({
        type: "error",
        priority: "high",
        title: "Fallback activation failed",
        message: `Could not switch to "${nextPreset.name}": ${result.error ?? "unknown error"}`,
        duration: 12000,
      });
    }
  } finally {
    fallbackInFlight.delete(terminalId);
  }
}

export function setupLifecycleListeners(): DisposableStore {
  const d = new DisposableStore();

  d.add(toDisposable(() => fallbackInFlight.clear()));

  d.add(
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

  d.add(
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

  d.add(
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

  d.add(
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

  d.add(
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

  d.add(
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

  d.add(
    toDisposable(
      terminalRegistryController.onReduceScrollback(({ terminalIds, targetLines }) => {
        for (const id of terminalIds) {
          terminalInstanceService.reduceScrollback(id, targetLines);
        }
      })
    )
  );

  d.add(
    toDisposable(
      terminalRegistryController.onRestoreScrollback(({ terminalIds }) => {
        for (const id of terminalIds) {
          terminalInstanceService.restoreScrollback(id);
        }
      })
    )
  );

  return d;
}

import type { TerminalStatusPayload } from "@shared/types";
import type { TerminalReliabilityMetricPayload } from "@shared/types/pty-host";
import { isPtyPanel } from "@shared/types/panel";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { isAgentTerminal } from "@/utils/terminalType";
import { logInfo, logError } from "@/utils/logger";
import { isTerminalRestarting } from "@/store/restartExitSuppression";
import { usePanelStore, type PanelGridState } from "@/store/panelStore";
import {
  enqueueFlowStatusUpdate,
  enqueueHeldDurationUpdate,
  clearHeldDuration,
  cancelTerminalFlowState,
} from "@/store/panelStatusBuffer";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { getMergedPresets } from "@/config/agents";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";

/**
 * Per-terminal reentrancy guard for fallback activations. A single slow exit
 * can produce duplicate `agent:fallback-triggered` events if respawn races
 * with cleanup — we ignore re-entries for the same terminalId until the
 * activation resolves.
 */
const fallbackInFlight = new Set<string>();

export async function handleFallbackTriggered(data: {
  terminalId: string;
  agentId: string;
  fromPresetId: string;
  originalPresetId?: string;
  reason: "connection" | "auth";
}): Promise<void> {
  const { terminalId, agentId, fromPresetId, reason } = data;
  if (fallbackInFlight.has(terminalId)) return;

  const _panelRaw = usePanelStore.getState().panelsById[terminalId];
  if (!_panelRaw || !isPtyPanel(_panelRaw)) return;
  const panel = _panelRaw;
  if (panel.isRestarting) return;

  // Drop stale duplicate events: if the panel has already advanced past the
  // preset this event refers to, the exit was from a now-replaced process
  // and advancing the chain again would skip a preset.
  if (panel.agentPresetId !== fromPresetId) return;

  fallbackInFlight.add(terminalId);

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

  const fromPreset = mergedPresets.find((p) => p.id === fromPresetId);
  const fromName = fromPreset?.name ?? fromPresetId;

  // Pair the fallback error/success notifications so a later "switched to
  // fallback preset" success archives the prior error from the inbox instead
  // of leaving a stale "unavailable" row behind.
  const fallbackSupersedeKey = `terminal.${terminalId}.fallback`;

  if (!nextPresetId) {
    // Chain exhausted: surface a single error notification. No respawn.
    const isExhausted = chain.length > 0;
    notify({
      type: "error",
      priority: "high",
      title: isExhausted ? "Fallback chain exhausted" : `${fromName} unavailable`,
      message: isExhausted
        ? `All fallback presets were tried. Configure fallback presets or restart the terminal manually.`
        : `${fromName} provider is unreachable. Configure fallbacks in Settings to auto-recover.`,
      duration: 12000,
      supersedeKey: fallbackSupersedeKey,
      action: {
        label: "Open agent settings",
        actionId: "app.settings.openTab",
        actionArgs: { tab: "agents" },
        onClick: () => {
          void actionService.dispatch(
            "app.settings.openTab",
            { tab: "agents" },
            { source: "user" }
          );
        },
      },
    });
    fallbackInFlight.delete(terminalId);
    return;
  }

  const nextPreset = mergedPresets.find((p) => p.id === nextPresetId);
  if (!nextPreset) {
    notify({
      type: "error",
      priority: "high",
      title: "Fallback preset missing",
      message: `Preset "${nextPresetId}" is no longer configured. Check fallback settings or restart the terminal.`,
      duration: 12000,
      supersedeKey: fallbackSupersedeKey,
      action: {
        label: "Open agent settings",
        actionId: "app.settings.openTab",
        actionArgs: { tab: "agents" },
        onClick: () => {
          void actionService.dispatch(
            "app.settings.openTab",
            { tab: "agents" },
            { source: "user" }
          );
        },
      },
    });
    fallbackInFlight.delete(terminalId);
    return;
  }

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
      notify({
        type: "info",
        // "high" so the user sees the toast — direct addNotification with
        // priority:"low" used to show one; notify() routes "low" to inbox-only.
        priority: "high",
        title: "Switched to fallback preset",
        message:
          reason === "auth"
            ? `${fromName} authentication failed — now running "${nextPreset.name}".`
            : `${fromName} unreachable — now running "${nextPreset.name}".`,
        supersedeKey: fallbackSupersedeKey,
      });
    } else {
      notify({
        type: "error",
        priority: "high",
        title: "Fallback activation failed",
        message: `Could not switch to "${nextPreset.name}": ${result.error ?? "unknown error"}`,
        duration: 12000,
        supersedeKey: fallbackSupersedeKey,
        context: { eventKind: "agent", panelId: terminalId },
        action: {
          label: "Send diagnostics",
          actionId: "diagnostics.openReview",
          actionArgs: { scope: { source: "terminal.fallbackActivationFailed" } },
          onClick: () => {
            void actionService.dispatch(
              "diagnostics.openReview",
              { scope: { source: "terminal.fallbackActivationFailed" } },
              { source: "user" }
            );
          },
        },
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
          // Backend-driven trash (e.g. PTY-host TTL) arrives here, not via
          // the `trashPanel`/`trashPanelGroup` wrappers, so this listener
          // owns the trio-clear on its own. Drop target and snapshot too —
          // a dangling `maximizeTarget` would mislabel the next
          // `TerminalContextMenu` render and stall the post-restore
          // `toggleMaximize` (#9935).
          updates.maximizedId = null;
          updates.maximizeTarget = null;
          updates.preMaximizeLayout = null;
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
        const {
          focusedId: previousFocusedId,
          activeDockTerminalId,
          panelsById,
        } = usePanelStore.getState();
        // Only clear the open dock popover when the restored terminal IS the
        // one displayed in it AND it did not land back in the dock. A terminal
        // restored INTO the dock must keep the popover open so focus and the
        // visible panel agree (#9938); a restore that lands elsewhere must not
        // silently dismiss an unrelated dock session the user is typing into
        // (#8368).
        const clearsActiveDock = activeDockTerminalId === id && panelsById[id]?.location !== "dock";
        usePanelStore.setState({
          focusedId: id,
          ...(clearsActiveDock && { activeDockTerminalId: null }),
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
        const _terminalRaw = state.panelsById[id];

        if (!_terminalRaw || !isPtyPanel(_terminalRaw)) return;
        const terminal = _terminalRaw;

        // Also check store flag for safety (handles edge cases)
        if (terminal.isRestarting) {
          return;
        }

        // Clean up resource metrics for exited terminal
        useResourceMonitoringStore.getState().removePanel(id);

        // Drop any buffered flow-status/held-duration patches for this terminal
        // before committing the clear below, so a pending RAF flush can't
        // resurrect a stale "paused" pill on the just-exited panel (#9899).
        cancelTerminalFlowState(id);

        // Store exit code and clear the flow state on the terminal before
        // applying exit behavior. Flow status must not outlive the PTY process
        // that owned the pause — clear it atomically with the exit-code write so
        // the paused pill and derived runtime status reset on exit (#9899).
        usePanelStore.setState((s) => {
          const existing = s.panelsById[id];
          if (!existing) return s;
          return {
            panelsById: {
              ...s.panelsById,
              [id]: {
                ...existing,
                exitCode,
                flowStatus: undefined,
                flowStatusTimestamp: undefined,
                heldDurationMs: undefined,
              },
            },
          };
        });

        state.setRuntimeStatus(id, "exited");

        // If already trashed, this is TTL expiry cleanup - permanently remove
        if (terminal.location === "trash") {
          state.removePanel(id);
          return;
        }

        // Remove-on-exit panels (e.g. the help-panel assistant) are bound to a
        // transient UI surface — on any exit, remove rather than preserve
        // so they don't linger in the dock as "exited" agents.
        if (terminal.removeOnExit === true) {
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
        const { id, status, timestamp, droppedBytes } = data;
        // data-loss is a transient pulse, not a durable flow state. Inject a
        // visible discontinuity marker into the xterm buffer and return —
        // never persist via updateFlowStatus or the runtime status would
        // freeze on "data-loss" forever.
        if (status === "data-loss") {
          terminalInstanceService.injectDataLossMarker(id, droppedBytes ?? 0);
          return;
        }
        // FUTURE_SAB: `suspended` and `paused-user` are excluded from
        // `PersistableFlowStatus` (see #9900 / `shared/types/panel.ts`).
        // `suspended` is only emitted by the disabled SAB transport path
        // (`BackpressureManager.suspendVisualStream`,
        // `electron/pty-host/backpressure.ts:277`); `paused-user` has no
        // producer. Drop both at the listener boundary so the buffer
        // (typed `PersistableFlowStatus`) is never asked to persist a
        // skeleton value. When the SAB transport is revived, remove this
        // guard, restore the suspended wake branch below, and re-widen
        // the formatter/component prop types — see the // FUTURE_SAB:
        // markers in `useAccessibilityAnnouncements.ts` and
        // `TerminalHeaderContent.tsx`.
        if (status === "suspended" || status === "paused-user") {
          return;
        }
        enqueueFlowStatusUpdate(id, status, timestamp);
        // FUTURE_SAB: the suspended wake branch was removed in #9900.
        // The producer (`suspendVisualStream`) is unreachable in production,
        // so waking on its emission would only ever fire in adversarial
        // tests. If the SAB transport is revived and `suspended` becomes
        // a real status again, re-add `|| status === "suspended"` here
        // and remove the early-return guard above.
        // EXPERIMENT (hibernation removal, Codex review fix — Finding 2): do NOT
        // auto-force-resume on `paused-backpressure`. `terminalClient.forceResume`
        // routes to the host `force-resume` handler →
        // `PtyPauseCoordinator.forceReleaseAll()`, which drops EVERY hold
        // (resource-governor, system-sleep) — far too broad for an automatic
        // path. A backpressure pause is released by flow control itself: as the
        // live renderer drains and acks bytes, the host's `acknowledge-data`
        // handler runs `ipcQueueManager.tryResume` / the port-queue resume, which
        // release only the backpressure-family token (`ipc-queue` /
        // `port-queue-*`) once the queue falls below its low watermark (see
        // electron/pty-host/ipcQueue.ts, portQueue.ts). Background panes now
        // stream live (Finding 1), so they keep draining and self-resume; a
        // frozen/LRU-evicted view stays paused only until it returns and drains —
        // the documented experiment scope. The user-initiated force-resume action
        // remains the deliberate all-token escape hatch. See
        // docs/HIBERNATION-REMOVAL-EXPERIMENT.md.
      })
    )
  );

  d.add(
    toDisposable(
      terminalRegistryController.onReliabilityMetric(
        (payload: TerminalReliabilityMetricPayload) => {
          // `pause-end` and `suspend` are the canonical resume signals —
          // clear the held-duration gauge for the terminal so a stale
          // value doesn't outlive the actual pause. `pause-duration-gauge`
          // is the skip-when-empty gauge that drives the held-duration
          // tooltip body. Other metric types (queue-depth-gauge,
          // data-loss-count, ipc-cap-drop, pending-bytes-gauge,
          // throughput-rate) are host-side telemetry sinks — observable
          // via the host log stream and ignored here. In particular,
          // `ipc-cap-drop` (a chunk dropped at the IPC queue's hard cap)
          // must NOT clear the gauge: the terminal is still paused when
          // the drop fires (#9902).
          //
          // FUTURE_SAB: the `suspend` arm is the symmetric companion of the
          // `suspended` `flowStatus` dropped in the onStatus boundary above.
          // `suspendVisualStream` emits BOTH the `suspended` status and the
          // `suspend` reliability metric (see `electron/pty-host/backpressure.ts:309+`).
          // The flow-status half is now dropped at the listener boundary
          // (#9900) but the metric half is still routed through
          // `clearHeldDuration`. In production the SAB transport path is
          // disabled so neither half can fire; the asymmetry is a forward-
          // looking breadcrumb for the migration author. When the SAB
          // transport is revived, EITHER drop the `suspend` metric arm
          // alongside the `suspended` status, OR gate it on the same
          // source/buffer the flow-status boundary uses, so the held-
          // duration gauge and the pill stay in lockstep.
          if (payload.metricType === "pause-end" || payload.metricType === "suspend") {
            const terminal = usePanelStore.getState().panelsById[payload.terminalId];
            if (terminal && isPtyPanel(terminal)) {
              // Always enqueue the clear — the buffer's null-wins
              // semantics correctly handle the cross-frame race where a
              // non-null `pause-duration-gauge` patch was enqueued but
              // hasn't been flushed yet. Skipping the enqueue based on
              // the committed (post-flush) `heldDurationMs` would let
              // the buffered non-null value resurrect after the
              // terminal resumed. The fold's same-value skip makes a
              // redundant enqueue cheap when nothing is buffered.
              clearHeldDuration(payload.terminalId);
            }
            return;
          }
          if (payload.metricType !== "pause-duration-gauge") return;
          const entries = payload.perTerminalHeld;

          // Snapshot the panel map once per tick so we can both update
          // terminals present in the gauge AND clear terminals absent from
          // it (a terminal that was paused on the last tick but is no
          // longer in the gauge has resumed — clear its stale value).
          const panelsById = usePanelStore.getState().panelsById;
          const seenIds = new Set<string>();
          if (entries) {
            for (const entry of entries) {
              const terminal = panelsById[entry.terminalId];
              if (!terminal || !isPtyPanel(terminal)) continue;
              seenIds.add(entry.terminalId);
              enqueueHeldDurationUpdate(entry.terminalId, entry.heldDurationMs);
            }
          }
          for (const id of Object.keys(panelsById)) {
            if (seenIds.has(id)) continue;
            const terminal = panelsById[id];
            if (!terminal || !isPtyPanel(terminal)) continue;
            if (terminal.heldDurationMs === undefined) continue;
            clearHeldDuration(id);
          }
        }
      )
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
          const _spawnTerminal = usePanelStore.getState().panelsById[id];
          if (_spawnTerminal && isPtyPanel(_spawnTerminal) && _spawnTerminal.spawnError) {
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

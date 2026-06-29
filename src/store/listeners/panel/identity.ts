import type { AgentStateChangePayload } from "@shared/types";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { isPtyPanel } from "@shared/types/panel";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { logWarn } from "@/utils/logger";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { usePanelStore } from "@/store/panelStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { reduceAgentDetected, reduceAgentExited } from "./identityReducer";
import { logIdentityDebugDev, recordIdentityEventDev } from "./identityDiagnostics";

// Per-terminal baseline of `changedFileCount` captured the first time an
// agent enters "working" in a session. Compared against the count at
// "completed" to gate the review-inbox notification — no notification fires
// when the working tree did not change. Module-level (not on PtyPanelData):
// the snapshot is ephemeral, must not persist across restarts, and is only
// read by this listener.
const _changedFileBaseline = new Map<string, number>();

// Per-worktree last-notified timestamp for the completed-with-changes inbox
// entry. `notify()`'s built-in `coalesce` only applies to toasts, so for
// `priority: "low"` (inbox-only) it has no effect — we dedupe at the call
// site instead so six parallel agents finishing on the same worktree
// collapse to a single inbox entry.
const _lastReviewInboxAt = new Map<string, number>();

const REVIEW_INBOX_COALESCE_MS = 5000;

export function _resetChangedFileBaseline(): void {
  _changedFileBaseline.clear();
  _lastReviewInboxAt.clear();
}

function readChangedFileCount(worktreeId: string | undefined): number | null {
  if (!worktreeId) return null;
  const store = getCurrentViewStoreOrNull();
  if (!store) return null;
  const snapshot = store.getState().worktrees.get(worktreeId);
  return snapshot?.worktreeChanges?.changedFileCount ?? 0;
}

export function setupIdentityListeners(): DisposableStore {
  const d = new DisposableStore();

  d.add(
    toDisposable(
      terminalRegistryController.onAgentStateChanged((data: AgentStateChangePayload) => {
        const {
          terminalId,
          state,
          previousState,
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

        const _terminalRaw = usePanelStore.getState().panelsById[terminalId];

        if (!_terminalRaw || !isPtyPanel(_terminalRaw)) {
          return;
        }

        const terminal = _terminalRaw;

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

        // Carry the parsed check result (issue #10682) onto the panel so
        // `terminal.getStatus` can surface it over MCP. Only present on settling
        // transitions where a new recognized check summary was detected.
        if (data.lastCheckResult) {
          const checkResult = data.lastCheckResult;
          usePanelStore.setState((s) => {
            const panel = s.panelsById[terminalId];
            if (!panel || !isPtyPanel(panel)) return s;
            return {
              panelsById: {
                ...s.panelsById,
                [terminalId]: { ...panel, lastCheckResult: checkResult },
              },
            };
          });
        }

        // Snapshot baseline `changedFileCount` the first time an agent enters
        // "working" in a session. Subsequent working↔waiting cycles keep the
        // initial baseline so the comparison at completion reflects the full
        // session, not just the latest stretch.
        if (state === "working" && !_changedFileBaseline.has(terminalId) && isPtyPanel(terminal)) {
          const baseline = readChangedFileCount(terminal.worktreeId);
          if (baseline !== null) {
            _changedFileBaseline.set(terminalId, baseline);
          }
        }

        if (state === "completed" && previousState !== "completed" && isPtyPanel(terminal)) {
          const worktreeId = terminal.worktreeId;
          const current = readChangedFileCount(worktreeId);
          const baseline = _changedFileBaseline.get(terminalId);
          _changedFileBaseline.delete(terminalId);

          // Require a captured baseline. An agent that jumps idle → completed
          // without a `working` event has no "started" timestamp to compare
          // against, so pre-existing dirty files would otherwise look like
          // new agent work.
          if (worktreeId && current !== null && baseline !== undefined && current > baseline) {
            const lastAt = _lastReviewInboxAt.get(worktreeId) ?? 0;
            if (timestamp - lastAt >= REVIEW_INBOX_COALESCE_MS) {
              _lastReviewInboxAt.set(worktreeId, timestamp);
              notify({
                type: "info",
                priority: "low",
                title: "Agent finished with changes",
                message: "Open the review hub to see what changed.",
                context: { worktreeId, eventKind: "completed" },
                action: {
                  label: "Open review hub",
                  actionId: "worktree.openReviewHub",
                  actionArgs: { worktreeId },
                  onClick: () => {
                    void actionService.dispatch(
                      "worktree.openReviewHub",
                      { worktreeId },
                      { source: "user" }
                    );
                  },
                },
              });
            }
          }
        }

        if (state === "exited") {
          _changedFileBaseline.delete(terminalId);
        }
      })
    )
  );

  // Prune the per-terminal/per-worktree maps when panels disappear. The
  // `agent:exited`/`completed` deletes above cover graceful teardown, but a
  // force-kill mid-"working" removes the panel without an exit event, leaking
  // its `_changedFileBaseline` entry; `_lastReviewInboxAt` had no eviction at
  // all. `panelIds` is the canonical liveness signal — drop any tracked id no
  // longer present, and any worktree with no remaining PTY panel (#10842).
  //
  // Keyed on `panelIds` only: a `moveTerminalToWorktree` that rewrites a
  // panel's `worktreeId` without changing `panelIds` won't fire this, so a
  // stale `_lastReviewInboxAt[oldWorktreeId]` lingers until the next `panelIds`
  // change. Bounded (worktree ids are finite/reused, not add-only) and benign
  // — at worst one 5s-window inbox dedupe is missed after a rare move.
  d.add(
    toDisposable(
      usePanelStore.subscribe(
        (s) => s.panelIds,
        (panelIds) => {
          if (_changedFileBaseline.size === 0 && _lastReviewInboxAt.size === 0) return;
          const liveIds = new Set(panelIds);
          for (const terminalId of _changedFileBaseline.keys()) {
            if (!liveIds.has(terminalId)) _changedFileBaseline.delete(terminalId);
          }
          if (_lastReviewInboxAt.size === 0) return;
          const { panelsById } = usePanelStore.getState();
          const liveWorktreeIds = new Set(
            panelIds.flatMap((id) => {
              const panel = panelsById[id];
              return panel && isPtyPanel(panel) && panel.worktreeId ? [panel.worktreeId] : [];
            })
          );
          for (const worktreeId of _lastReviewInboxAt.keys()) {
            if (!liveWorktreeIds.has(worktreeId)) _lastReviewInboxAt.delete(worktreeId);
          }
        }
      )
    )
  );

  d.add(
    toDisposable(
      terminalRegistryController.onAgentDetected((data) => {
        const { terminalId, processIconId, agentType } = data;
        if (!terminalId) return;
        const timestamp = data.timestamp ?? Date.now();
        recordIdentityEventDev("detected", terminalId, { agentType, processIconId });

        const nextEverDetectedAgent = agentType ? true : undefined;
        const nextDetectedAgentId = isBuiltInAgentId(agentType) ? agentType : undefined;
        const nextDetectedProcessId = processIconId ?? nextDetectedAgentId;
        if (!nextDetectedProcessId && !nextEverDetectedAgent && !nextDetectedAgentId) {
          logIdentityDebugDev(
            `[IdentityDebug] detected IGNORED term=${terminalId.slice(-8)} reason=no-icon-and-no-agent`
          );
          return;
        }

        usePanelStore.setState((state) => {
          const terminal = state.panelsById[terminalId];
          if (!terminal || !isPtyPanel(terminal)) {
            logIdentityDebugDev(
              `[IdentityDebug] detected IGNORED term=${terminalId.slice(-8)} reason=panel-not-found`
            );
            return state;
          }

          const result = reduceAgentDetected(terminal, {
            nextDetectedAgentId,
            nextDetectedProcessId,
            nextEverDetectedAgent,
            timestamp,
          });

          if (result === null) {
            logIdentityDebugDev(
              `[IdentityDebug] detected NOOP term=${terminalId.slice(-8)} ` +
                `already detectedAgentId=${terminal.detectedAgentId ?? "<none>"} ` +
                `detectedProcessId=${terminal.detectedProcessId ?? "<none>"} ` +
                `everDetected=${terminal.everDetectedAgent ?? false}`
            );
            return state;
          }

          if (import.meta.env.DEV) {
            const nextRuntime = result.patch.runtimeIdentity;
            // DEV-only DevTools diagnostic; mirrors the trail surfaced via
            // `__daintreeIdentityEvents()` so it stays out of the IPC logger.
            // eslint-disable-next-line no-console
            console.log(
              `[IdentityDebug] detected APPLY term=${terminalId.slice(-8)} ` +
                `prev.detectedAgentId=${terminal.detectedAgentId ?? "<none>"} → ${nextDetectedAgentId ?? "<none>"} ` +
                `prev.detectedProcessId=${terminal.detectedProcessId ?? "<none>"} → ${nextDetectedProcessId ?? "<none>"} ` +
                `prev.runtimeIdentity=${terminal.runtimeIdentity?.kind ?? "<none>"}:${terminal.runtimeIdentity?.id ?? "<none>"} → ` +
                `${nextRuntime?.kind ?? "<none>"}:${nextRuntime?.id ?? "<none>"} ` +
                `launchAgentId=${terminal.launchAgentId ?? "<none>"}`
            );
          }

          if (result.shouldPromoteAgentId) {
            terminalInstanceService.applyAgentPromotion(terminalId, result.shouldPromoteAgentId);
          }

          return {
            panelsById: {
              ...state.panelsById,
              [terminalId]: { ...terminal, ...result.patch },
            },
          };
        });
      })
    )
  );

  d.add(
    toDisposable(
      terminalRegistryController.onAgentExited((data) => {
        const { terminalId } = data;
        if (!terminalId) return;
        recordIdentityEventDev("exited", terminalId, {
          agentType: (data as { agentType?: string }).agentType,
        });
        terminalInstanceService.clearAgentPromotion(terminalId);

        // `agent:exited` clears live-detection fields for both subcommand
        // demotion and preserved PTY exit. `launchAgentId` is immutable and is
        // not touched here; `agentState: "exited"` is the durable strong-exit
        // signal that makes deriveTerminalChrome release launch affinity.
        usePanelStore.setState((state) => {
          const terminal = state.panelsById[terminalId];
          if (!terminal || !isPtyPanel(terminal)) {
            logIdentityDebugDev(
              `[IdentityDebug] exited IGNORED term=${terminalId.slice(-8)} reason=panel-not-found`
            );
            return state;
          }

          const patch = reduceAgentExited(terminal, {
            hasAgentType: Boolean((data as { agentType?: string }).agentType),
            exitKind: data.exitKind,
            timestamp: data.timestamp ?? Date.now(),
          });

          if (patch === null) {
            logIdentityDebugDev(
              `[IdentityDebug] exited NOOP term=${terminalId.slice(-8)} already cleared`
            );
            return state;
          }

          logIdentityDebugDev(
            `[IdentityDebug] exited APPLY term=${terminalId.slice(-8)} ` +
              `prev.detectedAgentId=${terminal.detectedAgentId ?? "<none>"} → <none> ` +
              `prev.detectedProcessId=${terminal.detectedProcessId ?? "<none>"} → <none>`
          );

          return {
            panelsById: {
              ...state.panelsById,
              [terminalId]: { ...terminal, ...patch },
            },
          };
        });
      })
    )
  );

  return d;
}

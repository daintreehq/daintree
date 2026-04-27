import type { AgentStateChangePayload } from "@shared/types";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { isPtyPanel } from "@shared/types/panel";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { logWarn } from "@/utils/logger";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { usePanelStore } from "@/store/panelStore";
import { reduceAgentDetected, reduceAgentExited } from "./identityReducer";
import { logIdentityDebugDev, recordIdentityEventDev } from "./identityDiagnostics";

export function setupIdentityListeners(): DisposableStore {
  const d = new DisposableStore();

  d.add(
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

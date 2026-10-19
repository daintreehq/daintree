import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import {
  assessInterruptCandidate,
  type TerminalInterruptAssessment,
} from "@shared/utils/terminalInterrupt";
import { getBuiltInRuntimeAgentId } from "@/utils/terminalType";

export type {
  TerminalInterruptAssessment,
  TerminalInterruptRefusal,
  TerminalInterruptSupport,
  TerminalInterruptTarget,
} from "@shared/utils/terminalInterrupt";

/**
 * The interrupt assessment (#12338) for a panel in this view's store.
 *
 * Pure: no store reads, no writes. The caller supplies the panel.
 */
export function assessTerminalInterrupt(
  panel: PanelInstance | undefined,
  terminalId: string
): TerminalInterruptAssessment {
  if (!panel || !isPtyPanel(panel)) return assessInterruptCandidate(undefined, terminalId);
  return assessInterruptCandidate(
    {
      isPty: true,
      trashed: panel.location === "trash",
      hasPty: panel.hasPty,
      exited: panel.runtimeStatus === "exited" || panel.runtimeStatus === "error",
      isRestarting: panel.isRestarting,
      hasRestartError: panel.restartError !== undefined,
      isInputLocked: panel.isInputLocked,
      agentId: getBuiltInRuntimeAgentId(panel),
      agentState: panel.agentState,
      waitingReason: panel.waitingReason,
    },
    terminalId
  );
}

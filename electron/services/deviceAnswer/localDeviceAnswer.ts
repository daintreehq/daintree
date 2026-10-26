import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { getFleetSnapshotServiceRef, getPtyClient } from "../../window/serviceRefs.js";
import { peekDriveLeaseService } from "../DriveLeaseService.js";
import { projectStore } from "../ProjectStore.js";
import { scratchStore } from "../ScratchStore.js";
import { planListedChoice } from "../../../shared/utils/terminalChoice.js";
import { answerRefused, answerRunByLabel } from "../terminalAnswer.js";
import { redactSecrets } from "../redactSecrets.js";
import { isRunStillWaiting, listWaitingRuns, type WaitingRunView } from "./deviceAnswerRuns.js";

/**
 * Who a device's answer stands as in this machine's drive lease. It is only
 * ever asked whether it drives; it never takes the lease.
 */
export type DeviceLeaseStanding = Pick<ClientEndpoint, "endpointId" | "clientId" | "linkSessionId">;

function drivesRun(standing: DeviceLeaseStanding, runId: string): boolean {
  const lease = peekDriveLeaseService();
  if (!lease) return true;
  const projectId = getPtyClient()?.getTerminalProjectId(runId) ?? null;
  if (projectId === null) return true;
  return lease.isDriving(projectId, standing);
}

const DRIVEN_ELSEWHERE = "This project is being driven from another screen. Nothing was pressed.";

/** This machine's waiting runs, as a paired device is shown them. */
export function listLocalWaitingRuns(): Promise<WaitingRunView[]> {
  return listWaitingRuns({
    fleet: () => getFleetSnapshotServiceRef()?.getLastBroadcast() ?? null,
    pty: () => getPtyClient(),
    projectName: (workspaceId) =>
      projectStore.getProjectById(workspaceId)?.name ??
      scratchStore.getScratchById(workspaceId)?.name ??
      null,
  });
}

/**
 * Press the option labelled `label` in one of this machine's runs, for a
 * device standing as `standing`. The same rules hold whether the device is
 * paired here or with a Shell attached to this host.
 */
export async function answerLocalRun(request: {
  standing: DeviceLeaseStanding;
  runId: string;
  spawnedAt: number;
  label: string;
  stillAllowed: () => string | null;
}): Promise<void> {
  const { standing, runId, spawnedAt, label, stillAllowed } = request;
  const pty = getPtyClient();
  if (!pty) throw answerRefused("Daintree's terminals aren't running. Nothing was pressed.");
  const fleet = getFleetSnapshotServiceRef()?.getLastBroadcast() ?? null;
  if (!isRunStillWaiting(fleet, runId, spawnedAt)) {
    throw answerRefused("That agent isn't waiting any more. Nothing was pressed.");
  }
  if (!drivesRun(standing, runId)) throw answerRefused(DRIVEN_ELSEWHERE);
  await answerRunByLabel({
    pty,
    runId,
    spawnedAt,
    label,
    // Only an option of the list on screen now, never text near a composer,
    // matched as the device was sent it and pressed from the list as drawn.
    plan: (screen, wanted) => planListedChoice(screen, wanted, redactSecrets),
    stillAllowed: () => {
      const refusal = stillAllowed();
      if (refusal !== null) return refusal;
      // Control can move to another screen between keys.
      if (!drivesRun(standing, runId)) {
        return "Another screen took control of that project. Nothing more was pressed.";
      }
      return null;
    },
  });
}

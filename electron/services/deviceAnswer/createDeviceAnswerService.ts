import { CHANNELS } from "../../ipc/channels.js";
import { LOCAL_CLIENT_ID } from "../../ipc/endpoint.js";
import { store } from "../../store.js";
import { getAllAppWebContents } from "../../window/webContentsRegistry.js";
import { getFleetSnapshotServiceRef, getPtyClient } from "../../window/serviceRefs.js";
import type { DeviceAnswerEvent } from "../../../shared/types/ipc/deviceAnswer.js";
import { peekDriveLeaseService } from "../DriveLeaseService.js";
import { projectStore } from "../ProjectStore.js";
import { scratchStore } from "../ScratchStore.js";
import { planListedChoice } from "../../../shared/utils/terminalChoice.js";
import { answerRefused, answerRunByLabel } from "../terminalAnswer.js";
import { DeviceAnswerService, type DevicePrincipal } from "./DeviceAnswerService.js";
import { sanitizeDeviceAnswerSettings } from "./deviceAnswerSettings.js";
import { isRunStillWaiting, listWaitingRuns } from "./deviceAnswerRuns.js";

/**
 * A paired device stands in the drive lease as this machine's own windows
 * do: it drives a project wherever they do, and never one a remote Shell
 * holds. It never takes the lease.
 */
function deviceDrivesRun(device: DevicePrincipal, runId: string): boolean {
  const lease = peekDriveLeaseService();
  if (!lease) return true;
  const projectId = getPtyClient()?.getTerminalProjectId(runId) ?? null;
  if (projectId === null) return true;
  return lease.isDriving(projectId, {
    endpointId: `device:${device.id}`,
    clientId: LOCAL_CLIENT_ID,
  });
}

const DRIVEN_ELSEWHERE = "This project is being driven from another screen. Nothing was pressed.";

/** Settings belong to this machine's own windows, never to a remote Shell. */
function broadcastLocal(event: DeviceAnswerEvent): void {
  for (const wc of getAllAppWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      wc.send(CHANNELS.DEVICE_ANSWER_EVENT, event);
    } catch {
      // A view mid-teardown.
    }
  }
}

export function createDeviceAnswerService(): DeviceAnswerService {
  return new DeviceAnswerService({
    readSettings: () => sanitizeDeviceAnswerSettings(store.get("deviceAnswer")),
    writeSettings: (settings) => store.set("deviceAnswer", settings),
    listWaiting: () =>
      listWaitingRuns({
        fleet: () => getFleetSnapshotServiceRef()?.getLastBroadcast() ?? null,
        pty: () => getPtyClient(),
        projectName: (workspaceId) =>
          projectStore.getProjectById(workspaceId)?.name ??
          scratchStore.getScratchById(workspaceId)?.name ??
          null,
      }),
    answer: async ({ device, runId, spawnedAt, label, stillAllowed }) => {
      const pty = getPtyClient();
      if (!pty) throw answerRefused("Daintree's terminals aren't running. Nothing was pressed.");
      const fleet = getFleetSnapshotServiceRef()?.getLastBroadcast() ?? null;
      if (!isRunStillWaiting(fleet, runId, spawnedAt)) {
        throw answerRefused("That agent isn't waiting any more. Nothing was pressed.");
      }
      if (!deviceDrivesRun(device, runId)) throw answerRefused(DRIVEN_ELSEWHERE);
      await answerRunByLabel({
        pty,
        runId,
        spawnedAt,
        label,
        // Only an option of the list on screen now, never text near a composer.
        plan: planListedChoice,
        stillAllowed: () => {
          const refusal = stillAllowed();
          if (refusal !== null) return refusal;
          // Control can move to another screen between keys.
          if (!deviceDrivesRun(device, runId)) {
            return "Another screen took control of that project. Nothing more was pressed.";
          }
          return null;
        },
      });
    },
    onStatusChanged: (status) => broadcastLocal({ type: "status-changed", status }),
  });
}

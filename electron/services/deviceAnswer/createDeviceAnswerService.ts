import { hostname } from "node:os";
import { CHANNELS } from "../../ipc/channels.js";
import { LOCAL_CLIENT_ID } from "../../ipc/endpoint.js";
import { getRemoteService } from "../../remote/runtime.js";
import { store } from "../../store.js";
import { getAllAppWebContents } from "../../window/webContentsRegistry.js";
import type { DeviceAnswerEvent } from "../../../shared/types/ipc/deviceAnswer.js";
import { LOCAL_HOST_ID, isLocalHostId } from "../../../shared/types/remoteHosts.js";
import { answerRefused } from "../terminalAnswer.js";
import { DeviceAnswerService } from "./DeviceAnswerService.js";
import { sanitizeDeviceAnswerSettings } from "./deviceAnswerSettings.js";
import type { DeviceWaitingList, DeviceWaitingRun } from "./deviceAnswerRuns.js";
import { answerLocalRun, listLocalWaitingRuns } from "./localDeviceAnswer.js";

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

function thisMachineName(): string {
  try {
    return hostname() || "This computer";
  } catch {
    return "This computer";
  }
}

/** Longest waiting first, whichever machine it waits on. */
function bySince(a: DeviceWaitingRun, b: DeviceWaitingRun): number {
  return (a.since ?? Infinity) - (b.since ?? Infinity);
}

async function listWaiting(options: { hosts: boolean }): Promise<DeviceWaitingList> {
  const remote = options.hosts ? getRemoteService("deviceAnswerHosts") : undefined;
  const [local, hosts] = await Promise.all([
    listLocalWaitingRuns(),
    // Hosts that can't be read never hide this machine's own runs.
    remote
      ? Promise.resolve()
          .then(() => remote.listWaiting())
          .catch((error: unknown) => {
            console.warn(
              "[DeviceAnswer] Couldn't list connected hosts:",
              (error as Error)?.message
            );
            return [];
          })
      : [],
  ]);
  const name = thisMachineName();
  const runs: DeviceWaitingRun[] = [
    ...local.map((run) => ({ ...run, hostId: LOCAL_HOST_ID, host: name })),
    ...hosts.flatMap(({ hostId, host, runs: hostRuns }) =>
      hostRuns.map((run) => ({ ...run, hostId, host }))
    ),
  ];
  return {
    runs: runs.sort(bySince),
    hosts: hosts.map(({ hostId, host, status }) => ({ hostId, host, status })),
  };
}

export function createDeviceAnswerService(): DeviceAnswerService {
  return new DeviceAnswerService({
    readSettings: () => sanitizeDeviceAnswerSettings(store.get("deviceAnswer")),
    writeSettings: (settings) => store.set("deviceAnswer", settings),
    listWaiting,
    answer: async ({ device, hostId, runId, spawnedAt, label, stillAllowed }) => {
      if (isLocalHostId(hostId)) {
        // A device paired here stands in the drive lease as this machine's own
        // windows do: it drives a project wherever they do, and never one a
        // remote Shell holds.
        await answerLocalRun({
          standing: { endpointId: `device:${device.id}`, clientId: LOCAL_CLIENT_ID },
          runId,
          spawnedAt,
          label,
          stillAllowed,
        });
        return;
      }
      const hosts = getRemoteService("deviceAnswerHosts");
      if (!hosts) throw answerRefused("Remote hosts aren't running here. Nothing was pressed.");
      // Asked once, before the host is: from there the host's own lease and
      // the link decide each key, so removing the device mid-answer stops only
      // the answers it hasn't sent yet.
      const refusal = stillAllowed();
      if (refusal !== null) throw answerRefused(refusal);
      await hosts.answer({ hostId, runId, spawnedAt, label });
    },
    hostName: (hostId) => getRemoteService("deviceAnswerHosts")?.hostName(hostId) ?? null,
    onStatusChanged: (status) => broadcastLocal({ type: "status-changed", status }),
  });
}

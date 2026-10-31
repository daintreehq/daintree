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
import { machineDisplayName } from "../../utils/machineName.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";

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

let machineName: string | null = null;

/** The name other machines know this one by; read once, since a Mac's takes a subprocess. */
function thisMachineName(): string {
  if (machineName === null) {
    try {
      machineName = machineDisplayName() || "This computer";
    } catch {
      machineName = "This computer";
    }
  }
  return machineName;
}

function agentName(agentId: string | null): string | null {
  return agentId ? (getEffectiveAgentConfig(agentId)?.name ?? null) : null;
}

/** Longest waiting first, whichever machine it waits on. */
function bySince(a: DeviceWaitingRun, b: DeviceWaitingRun): number {
  return (a.since ?? Infinity) - (b.since ?? Infinity);
}

async function listWaiting(options: { hosts: boolean }): Promise<DeviceWaitingList> {
  const remote = options.hosts ? getRemoteService("deviceAnswerHosts") : undefined;
  let hostsUnlisted = false;
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
            hostsUnlisted = true;
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
  ].map((run) => ({ ...run, agentName: agentName(run.agentId) }));
  return {
    computer: name,
    runs: runs.sort(bySince),
    hosts: hosts.map(({ hostId, host, status }) => ({ hostId, host, status })),
    ...(hostsUnlisted ? { hostsUnlisted } : {}),
  };
}

export function createDeviceAnswerService(): DeviceAnswerService {
  return new DeviceAnswerService({
    readSettings: () => sanitizeDeviceAnswerSettings(store.get("deviceAnswer")),
    writeSettings: (settings) => store.set("deviceAnswer", settings),
    listWaiting,
    answer: async ({ device, hostId, runId, spawnedAt, label, questionId, stillAllowed }) => {
      if (isLocalHostId(hostId)) {
        // A device paired here stands in the drive lease as this machine's own
        // windows do: it drives a project wherever they do, and never one a
        // remote Shell holds.
        await answerLocalRun({
          standing: { endpointId: `device:${device.id}`, clientId: LOCAL_CLIENT_ID },
          runId,
          spawnedAt,
          label,
          questionId,
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
      // The host checks the question itself: only it can read the screen.
      await hosts.answer({ hostId, runId, spawnedAt, label, questionId });
    },
    hostName: (hostId) => getRemoteService("deviceAnswerHosts")?.hostName(hostId) ?? null,
    onStatusChanged: (status) => broadcastLocal({ type: "status-changed", status }),
  });
}

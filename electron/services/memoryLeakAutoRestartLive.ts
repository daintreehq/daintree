import { resolveMemoryLeakPolicy } from "../../shared/config/memoryLeakPolicy.js";
import type { TerminalResourceBatchPayload } from "../../shared/types/pty-host.js";
import { CHANNELS } from "../ipc/channels.js";
import { store } from "../store.js";
import { getDriveLeaseService } from "./DriveLeaseService.js";
import {
  getActiveMemoryLeakAutoRestart,
  MemoryLeakAutoRestartService,
  setActiveMemoryLeakAutoRestart,
  type MemoryLeakRestartTarget,
} from "./MemoryLeakAutoRestartService.js";
import type { PtyClient } from "./PtyClient.js";
import { getLifecycleLedger } from "./pty/lifecycleLedger.js";

/** The host's memory-leak policy as its saved terminal settings read now. */
export function readMemoryLeakPolicy(): { enabled: boolean; thresholdMb: number } {
  return resolveMemoryLeakPolicy(store.get("terminalConfig") ?? {});
}

/**
 * The view a project's restart is handed to: its driver, or while nobody holds
 * the lease, the view the lease would go to. A driver that is away is waited
 * for rather than acted around.
 */
function pickTarget(projectId: string): MemoryLeakRestartTarget {
  const leases = getDriveLeaseService();
  const drive = leases.getDriveTarget(projectId);
  if (drive.kind === "reserved") return { kind: "wait" };
  const endpoint = drive.kind === "live" ? drive.endpoint : leases.nextHolderEndpoint(projectId);
  if (!endpoint || endpoint.isClosed()) return { kind: "host" };
  return {
    kind: "view",
    deliver: (payload) =>
      endpoint.send({
        type: "event",
        channel: CHANNELS.EVENTS_PUSH,
        args: [{ name: "terminal:memory-leak-restart-requested", payload }],
      }),
  };
}

/**
 * Start the host's memory-leak auto-restart beside the process-wide PtyClient,
 * and switch on the resource sampling it reads: a windowless host has no view
 * to switch it on.
 */
export function startMemoryLeakAutoRestart(ptyClient: PtyClient): void {
  if (getActiveMemoryLeakAutoRestart()) return;
  if (store.get("terminalConfig")?.resourceMonitoringEnabled === true) {
    ptyClient.setResourceMonitoring(true);
  }
  const service = new MemoryLeakAutoRestartService({
    onMetrics: (listener) => {
      const handler = (metrics: TerminalResourceBatchPayload) => listener(metrics);
      ptyClient.on("resource-metrics", handler);
      return () => ptyClient.off("resource-metrics", handler);
    },
    onExit: (listener) => {
      const handler = (terminalId: string) => listener(terminalId);
      ptyClient.on("exit", handler);
      return () => ptyClient.off("exit", handler);
    },
    readPolicy: readMemoryLeakPolicy,
    generationOf: (terminalId) => getLifecycleLedger().currentGeneration(terminalId),
    readTerminal: (terminalId) => ptyClient.getTerminalAsync(terminalId),
    pickTarget,
    restartOnHost: async (projectId, terminalId) => {
      const { restartTerminalWithoutViewLive } = await import("./viewless/index.js");
      return restartTerminalWithoutViewLive(projectId, terminalId);
    },
    now: () => Date.now(),
  });
  setActiveMemoryLeakAutoRestart(service);
}

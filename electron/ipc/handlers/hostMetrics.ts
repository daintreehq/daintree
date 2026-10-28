import { defineIpcNamespace, op } from "../define.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { HOST_METRICS_METHOD_CHANNELS } from "./hostMetrics.preload.js";
import type {
  HostFleetSubmitPayload,
  HostFleetTargetList,
  HostLinkActivityResult,
  HostMetricsSnapshot,
  HostProcessInventoryResult,
  HostWorktreeEntry,
} from "../../../shared/types/ipc/hostMetrics.js";

export const hostMetricsNamespace = defineIpcNamespace({
  name: "hostMetrics",
  ops: {
    getSnapshots: op(
      HOST_METRICS_METHOD_CHANNELS.getSnapshots,
      async (): Promise<HostMetricsSnapshot[]> =>
        getRemoteService("hostMetrics")?.getSnapshots() ?? []
    ),
    listFleetTargets: op(
      HOST_METRICS_METHOD_CHANNELS.listFleetTargets,
      async (payload: { hostId: string }): Promise<HostFleetTargetList> =>
        requireRemoteService("hostMetrics").listFleetTargets(payload)
    ),
    submitFleet: op(
      HOST_METRICS_METHOD_CHANNELS.submitFleet,
      async (payload: HostFleetSubmitPayload): Promise<void> =>
        requireRemoteService("hostMetrics").submitFleet(payload)
    ),
    listWorktrees: op(
      HOST_METRICS_METHOD_CHANNELS.listWorktrees,
      async (payload: { hostId: string }): Promise<HostWorktreeEntry[]> =>
        requireRemoteService("hostMetrics").listWorktrees(payload)
    ),
    linkActivity: op(
      HOST_METRICS_METHOD_CHANNELS.linkActivity,
      async (payload: { hostId: string }): Promise<HostLinkActivityResult> =>
        requireRemoteService("hostMetrics").linkActivity(payload)
    ),
    processInventory: op(
      HOST_METRICS_METHOD_CHANNELS.processInventory,
      async (payload: { hostId: string }): Promise<HostProcessInventoryResult> =>
        requireRemoteService("hostMetrics").processInventory(payload)
    ),
  },
});

export function registerHostMetricsHandlers(): () => void {
  return hostMetricsNamespace.register();
}

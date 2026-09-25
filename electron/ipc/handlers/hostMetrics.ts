import { defineIpcNamespace, op } from "../define.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { HOST_METRICS_METHOD_CHANNELS } from "./hostMetrics.preload.js";
import type { HostMetricsSnapshot } from "../../../shared/types/ipc/hostMetrics.js";

export const hostMetricsNamespace = defineIpcNamespace({
  name: "hostMetrics",
  ops: {
    getSnapshots: op(
      HOST_METRICS_METHOD_CHANNELS.getSnapshots,
      async (): Promise<HostMetricsSnapshot[]> =>
        pendingRemoteHostsHandler(HOST_METRICS_METHOD_CHANNELS.getSnapshots)
    ),
  },
});

export function registerHostMetricsHandlers(): () => void {
  return hostMetricsNamespace.register();
}

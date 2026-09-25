import type { WebContents } from "electron";
import type {
  HostAttentionEvent,
  HostMetricsEvent,
} from "../../../shared/types/ipc/hostMetrics.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getAllAppWebContents } from "../../window/webContentsRegistry.js";
import { getWindowRegistry } from "../../window/windowRef.js";
import { setHostWorkingAgentsSource } from "../client/initClient.js";
import { registerRemoteService } from "../runtime.js";
import { HostMetricsClient, type HostMetricsClientOptions } from "./client.js";
import { listLocalFleetTargets, listLocalWorktrees, submitLocalFleet } from "./hostOps.js";
import { getLocalSummaryLoop } from "./localLoop.js";

declare module "../runtime.js" {
  interface RemoteServices {
    hostMetrics: HostMetricsClient;
  }
}

function sendTo(wc: WebContents, event: HostMetricsEvent): boolean {
  if (wc.isDestroyed()) return false;
  try {
    wc.send(CHANNELS.HOST_METRICS_EVENT, event);
    return true;
  } catch {
    return false;
  }
}

/**
 * One view presents an attention event: the focused window's, else any
 * window's, and never one already showing that host (its own notifications
 * reach it the usual way).
 */
function deliverToOneView(
  event: HostAttentionEvent,
  hostForView: (webContentsId: number) => HostId | null
): boolean {
  const windows = getWindowRegistry()?.all() ?? [];
  const ordered = [...windows].sort(
    (a, b) => Number(b.browserWindow.isFocused()) - Number(a.browserWindow.isFocused())
  );
  for (const ctx of ordered) {
    if (ctx.browserWindow.isDestroyed()) continue;
    const wc = ctx.services.projectViewManager?.getActiveView()?.webContents;
    if (!wc || wc.isDestroyed()) continue;
    if (hostForView(wc.id) === event.hostId) {
      // The focused window already shows that host, whose own notifications reach it.
      if (ctx.browserWindow.isFocused()) return true;
      continue;
    }
    if (sendTo(wc, event)) return true;
  }
  return false;
}

export interface InstallHostMetricsClientOptions {
  manager: HostMetricsClientOptions["manager"];
  registry: HostMetricsClientOptions["registry"];
  hostForView(webContentsId: number): HostId | null;
}

/** Start the Shell side: summary links to every known host, the rings, and the IPC service. */
export function installHostMetricsClient(options: InstallHostMetricsClientOptions): () => void {
  const client = new HostMetricsClient({
    manager: options.manager,
    registry: options.registry,
    localLoop: getLocalSummaryLoop(),
    emit(event) {
      for (const wc of getAllAppWebContents()) sendTo(wc, event);
    },
    deliverAttention: (event) => deliverToOneView(event, options.hostForView),
    local: {
      listFleetTargets: listLocalFleetTargets,
      submitFleet: submitLocalFleet,
      listWorktrees: listLocalWorktrees,
    },
  });
  client.start();
  const unregister = registerRemoteService("hostMetrics", client);
  setHostWorkingAgentsSource((hostId) => client.workingAgents(hostId));
  return () => {
    setHostWorkingAgentsSource(null);
    unregister();
    client.dispose();
  };
}

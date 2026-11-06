import type { WebContents } from "electron";
import type {
  HostAttentionEvent,
  HostMetricsEvent,
} from "../../../shared/types/ipc/hostMetrics.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { createLogger } from "../../utils/logger.js";
import { getAllAppWebContents } from "../../window/webContentsRegistry.js";
import { getWindowRegistry } from "../../window/windowRef.js";
import { store } from "../../store.js";
import { setHostAgentsSource } from "../client/initClient.js";
import { showHostAttentionBanner } from "../hybrid/notifications.js";
import { registerRemoteService } from "../runtime.js";
import { HostMetricsClient, type HostMetricsClientOptions } from "./client.js";
import { waitingPolicy } from "./hostMetricsHost.js";
import {
  listLocalFleetTargets,
  listLocalWorktrees,
  onLocalProjectsChanged,
  onLocalWorktreesMaybeChanged,
  submitLocalFleet,
} from "./hostOps.js";
import { getLocalSummaryLoop } from "./localLoop.js";

declare module "../runtime.js" {
  interface RemoteServices {
    hostMetrics: HostMetricsClient;
  }
}

const logger = createLogger("main:hostMetrics");

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

/**
 * Whether this screen is paged with a banner for an attention event: no
 * window here has focus, and none shows that host, whose own notifications
 * reach it. This machine's quiet hours keep it to the inbox.
 */
function pagesNatively(
  event: HostAttentionEvent,
  hostForView: (webContentsId: number) => HostId | null
): boolean {
  if (event.quiet) return false;
  for (const ctx of getWindowRegistry()?.all() ?? []) {
    if (ctx.browserWindow.isDestroyed()) continue;
    if (ctx.browserWindow.isFocused()) return false;
    const wc = ctx.services.projectViewManager?.getActiveView()?.webContents;
    if (wc && !wc.isDestroyed() && hostForView(wc.id) === event.hostId) return false;
  }
  return true;
}

/** A notice about one of a host's agents, as a click on its banner opens it. */
export interface HostNotice {
  hostId: HostId;
  projectId: string | null;
  terminalId: string;
}

export interface InstallHostMetricsClientOptions {
  manager: HostMetricsClientOptions["manager"];
  registry: HostMetricsClientOptions["registry"];
  hostForView(webContentsId: number): HostId | null;
  /** Open the notice's host in `windowId`, or a new window when null. */
  openHostForNotice(windowId: number | null, notice: HostNotice): Promise<unknown>;
}

/** Start the Shell side: summary links to every known host, the rings, and the IPC service. */
export function installHostMetricsClient(options: InstallHostMetricsClientOptions): () => void {
  let live = true;
  const open = (notice: HostNotice): void => {
    // A banner can outlive this Shell side, or the host it was about.
    if (!live || !options.registry.get(notice.hostId)) return;
    const target =
      getWindowRegistry()
        ?.focusOrder()
        .find((ctx) => !ctx.browserWindow.isDestroyed()) ?? null;
    options.openHostForNotice(target?.windowId ?? null, notice).catch((error: unknown) => {
      // A failed switch says so on the window's own switch screen.
      logger.warn("Couldn't open a host from its notice", { error });
    });
  };
  const deliverAttention = (event: HostAttentionEvent): boolean => {
    if (!live) return false;
    if (!pagesNatively(event, options.hostForView)) {
      return deliverToOneView(event, options.hostForView);
    }
    const { hostId, projectId, terminalId } = event;
    showHostAttentionBanner(event, () => open({ hostId, projectId, terminalId }));
    // The inbox still keeps it, as a local agent's wait is kept beside its banner.
    deliverToOneView({ ...event, pagedNatively: true }, options.hostForView);
    return true;
  };
  const client = new HostMetricsClient({
    manager: options.manager,
    registry: options.registry,
    localLoop: getLocalSummaryLoop(),
    emit(event) {
      for (const wc of getAllAppWebContents()) sendTo(wc, event);
    },
    deliverAttention,
    // Judged by this machine's settings, as its own agents' waits are (#14701).
    waitingPolicy: () => waitingPolicy(store.get("notificationSettings"), new Date()),
    local: {
      listFleetTargets: listLocalFleetTargets,
      submitFleet: submitLocalFleet,
      listWorktrees: listLocalWorktrees,
      processInventory: async () => {
        const [{ readLocalProcessInventory }, { getPtyClient }] = await Promise.all([
          import("../../services/localProcessInventory.js"),
          import("../../window/serviceRefs.js"),
        ]);
        return readLocalProcessInventory(getPtyClient);
      },
      onWorktreesMaybeChanged: onLocalWorktreesMaybeChanged,
      onProjectsChanged: onLocalProjectsChanged,
    },
  });
  client.start();
  const unregister = registerRemoteService("hostMetrics", client);
  setHostAgentsSource((hostId) => client.observedAgents(hostId));
  return () => {
    live = false;
    setHostAgentsSource(null);
    unregister();
    client.dispose();
  };
}

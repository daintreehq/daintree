import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { setHostFiguresFollowed } from "../../services/hostFiguresDemand.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";
import { HOST_METRICS_METHOD_CHANNELS } from "./hostMetrics.preload.js";
import type {
  HostFleetSubmitPayload,
  HostFleetTargetList,
  HostLinkActivityResult,
  HostMetricsSnapshot,
  HostProcessInventoryResult,
  HostWorktreeEntry,
} from "../../../shared/types/ipc/hostMetrics.js";

const setFollowingSchema = z.object({ following: z.boolean() }).strict();

/** Each following view's watch for going away without saying so, by WebContents id. */
const followers = new Map<number, () => void>();

function stopFollowing(webContentsId: number): void {
  const unwatch = followers.get(webContentsId);
  if (!unwatch) return;
  followers.delete(webContentsId);
  unwatch();
  setHostFiguresFollowed(webContentsId, false);
}

/**
 * A view whose document is replaced (a reload, an error page), that crashes or
 * that closes never sends its release, so its demand goes with it here. Only a
 * navigation that commits counts: one the app's `will-navigate` guard cancels
 * leaves the document, and what it follows, in place.
 */
function startFollowing(ctx: IpcContext): void {
  const sender = ctx.event?.sender;
  // Figures are this machine's; only its own views follow them.
  if (!sender || followers.has(sender.id)) return;
  const id = sender.id;
  const onGone = () => stopFollowing(id);
  const onFailedLoad = (
    _event: unknown,
    _code: number,
    _description: string,
    _url: string,
    isMainFrame: boolean
  ) => {
    if (isMainFrame) stopFollowing(id);
  };
  sender.on("did-navigate", onGone);
  sender.on("did-fail-provisional-load", onFailedLoad);
  sender.on("render-process-gone", onGone);
  const unwatchDestroyed = onWebContentsDestroyed(sender, onGone);
  followers.set(id, () => {
    sender.removeListener("did-navigate", onGone);
    sender.removeListener("did-fail-provisional-load", onFailedLoad);
    sender.removeListener("render-process-gone", onGone);
    unwatchDestroyed();
  });
  setHostFiguresFollowed(id, true);
}

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
    /** Whether this view shows host figures now, so this machine samples itself only while one does. */
    setFollowing: opValidated(
      HOST_METRICS_METHOD_CHANNELS.setFollowing,
      setFollowingSchema,
      async (ctx: IpcContext, payload: { following: boolean }): Promise<void> => {
        if (payload.following) startFollowing(ctx);
        else if (ctx.event?.sender) stopFollowing(ctx.event.sender.id);
      },
      { withContext: true }
    ),
  },
});

export function registerHostMetricsHandlers(): () => void {
  const unregister = hostMetricsNamespace.register();
  return () => {
    unregister();
    for (const webContentsId of [...followers.keys()]) stopFollowing(webContentsId);
  };
}

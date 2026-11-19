import path from "node:path";
import type { HostDescriptor, HostId } from "../../../shared/types/remoteHosts.js";
import type { MainProcessToastPayload } from "../../../shared/types/ipc/maps.js";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToVisibleRenderersOrAll } from "../../ipc/utils.js";
import { getWorkspaceClientRef } from "../../window/serviceRefs.js";
import type { LinkSession } from "../link/session.js";
import { getRemoteService } from "../runtime.js";
import { watchIdleResourcePause, type IdleResourcePauseOptions } from "./idleResourcePause.js";

/** Pauses an owned resource host's environment once that host goes idle, where that's on here (#17925). */
export function installIdleResourcePause(options: {
  registry: IdleResourcePauseOptions["registry"];
  sessionFor(hostId: HostId): LinkSession | null;
}): () => void {
  const metrics = getRemoteService("hostMetrics");
  if (!metrics) return () => {};
  return watchIdleResourcePause({
    registry: options.registry,
    metrics,
    sessionFor: options.sessionFor,
    prepare: async (worktreeId) =>
      (await getWorkspaceClientRef()?.prepareIdlePause(worktreeId)) ?? {
        ok: false,
        reason: "The workspace client isn't running",
      },
    onFailed: (host: HostDescriptor, error: string) => {
      const worktree = path.basename(host.ownerWorktreeId ?? "") || "A worktree";
      const toast: MainProcessToastPayload = {
        type: "error",
        title: "Pause failed",
        message: `${worktree}'s environment didn't pause after ${host.name} went idle. ${error}`,
        action: { label: "Copy details", ipcChannel: CHANNELS.CLIPBOARD_WRITE_TEXT, data: error },
      };
      broadcastToVisibleRenderersOrAll(CHANNELS.NOTIFICATION_SHOW_TOAST, toast);
    },
  });
}

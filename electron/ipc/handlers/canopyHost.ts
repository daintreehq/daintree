import { defineIpcNamespace, op } from "../define.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { CANOPY_HOST_METHOD_CHANNELS } from "./canopyHost.preload.js";
import type { CanopyHostChannel, CanopyHostResult } from "../../../shared/types/ipc/canopyHost.js";

export const canopyHostNamespace = defineIpcNamespace({
  name: "canopyHost",
  ops: {
    /**
     * One Canopy call on a host the view names, not the one it is bound to:
     * This Mac, or another connected host. The view's own host is refused here;
     * its calls take the ordinary `canopy:*` route.
     */
    invoke: op(
      CANOPY_HOST_METHOD_CHANNELS.invoke,
      async (
        ctx,
        hostId: string,
        channel: CanopyHostChannel,
        args: unknown[]
      ): Promise<CanopyHostResult> =>
        requireRemoteService("canopyHosts").invoke(
          ctx.webContentsId,
          hostId,
          channel,
          args
        ) as Promise<CanopyHostResult>,
      { withContext: true }
    ),
    /** The view's panel stopped reading the host. */
    release: op(
      CANOPY_HOST_METHOD_CHANNELS.release,
      async (ctx, hostId: string): Promise<void> => {
        getRemoteService("canopyHosts")?.release(ctx.webContentsId, hostId);
      },
      { withContext: true }
    ),
  },
});

export function registerCanopyHostHandlers(): () => void {
  return canopyHostNamespace.register();
}

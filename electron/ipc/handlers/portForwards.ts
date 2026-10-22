import { defineIpcNamespace, op } from "../define.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { PORT_FORWARDS_METHOD_CHANNELS } from "./portForwards.preload.js";
import type {
  ForwardPortPayload,
  HostListeningPort,
  PortForward,
  ReleasePortForwardsPayload,
} from "../../../shared/types/ipc/portForwards.js";

export const portForwardsNamespace = defineIpcNamespace({
  name: "portForwards",
  ops: {
    list: op(
      PORT_FORWARDS_METHOD_CHANNELS.list,
      async (): Promise<PortForward[]> => getRemoteService("portForwards")?.list() ?? []
    ),
    // The calling view comes from the IPC layer: a panel's forward is held for that view's panel.
    forward: op(
      PORT_FORWARDS_METHOD_CHANNELS.forward,
      async (ctx, payload: ForwardPortPayload): Promise<PortForward> =>
        requireRemoteService("portForwards").forward(payload, {
          webContentsId: ctx.webContentsId,
        }),
      { withContext: true }
    ),
    release: op(
      PORT_FORWARDS_METHOD_CHANNELS.release,
      async (ctx, payload: ReleasePortForwardsPayload): Promise<void> => {
        // A panel closing with Remote Hosts off has nothing to let go of.
        getRemoteService("portForwards")?.release(payload, { webContentsId: ctx.webContentsId });
      },
      { withContext: true }
    ),
    stop: op(
      PORT_FORWARDS_METHOD_CHANNELS.stop,
      async (payload: { forwardId: string }): Promise<void> =>
        requireRemoteService("portForwards").stop(payload?.forwardId)
    ),
    listHostPorts: op(
      PORT_FORWARDS_METHOD_CHANNELS.listHostPorts,
      async (payload: { hostId: string }): Promise<HostListeningPort[]> =>
        requireRemoteService("portForwards").listHostPorts(payload?.hostId)
    ),
  },
});

export function registerPortForwardsHandlers(): () => void {
  return portForwardsNamespace.register();
}

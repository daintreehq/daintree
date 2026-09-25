import { defineIpcNamespace, op } from "../define.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { PORT_FORWARDS_METHOD_CHANNELS } from "./portForwards.preload.js";
import type {
  ForwardPortPayload,
  HostListeningPort,
  PortForward,
} from "../../../shared/types/ipc/portForwards.js";

export const portForwardsNamespace = defineIpcNamespace({
  name: "portForwards",
  ops: {
    list: op(
      PORT_FORWARDS_METHOD_CHANNELS.list,
      async (): Promise<PortForward[]> => getRemoteService("portForwards")?.list() ?? []
    ),
    forward: op(
      PORT_FORWARDS_METHOD_CHANNELS.forward,
      async (payload: ForwardPortPayload): Promise<PortForward> =>
        requireRemoteService("portForwards").forward(payload)
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

import { defineIpcNamespace, op } from "../define.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { PORT_FORWARDS_METHOD_CHANNELS } from "./portForwards.preload.js";
import type {
  ForwardPortPayload,
  HostListeningPort,
  PortForward,
} from "../../../shared/types/ipc/portForwards.js";

export const portForwardsNamespace = defineIpcNamespace({
  name: "portForwards",
  ops: {
    list: op(PORT_FORWARDS_METHOD_CHANNELS.list, async (): Promise<PortForward[]> =>
      pendingRemoteHostsHandler(PORT_FORWARDS_METHOD_CHANNELS.list)
    ),
    forward: op(
      PORT_FORWARDS_METHOD_CHANNELS.forward,
      async (_payload: ForwardPortPayload): Promise<PortForward> =>
        pendingRemoteHostsHandler(PORT_FORWARDS_METHOD_CHANNELS.forward)
    ),
    stop: op(
      PORT_FORWARDS_METHOD_CHANNELS.stop,
      async (_payload: { forwardId: string }): Promise<void> =>
        pendingRemoteHostsHandler(PORT_FORWARDS_METHOD_CHANNELS.stop)
    ),
    listHostPorts: op(
      PORT_FORWARDS_METHOD_CHANNELS.listHostPorts,
      async (_payload: { hostId: string }): Promise<HostListeningPort[]> =>
        pendingRemoteHostsHandler(PORT_FORWARDS_METHOD_CHANNELS.listHostPorts)
    ),
  },
});

export function registerPortForwardsHandlers(): () => void {
  return portForwardsNamespace.register();
}

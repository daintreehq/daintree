import type { HostId } from "../../../shared/types/remoteHosts.js";
import type { HostRegistry } from "../client/HostRegistry.js";
import type { RemoteHostManager } from "../client/RemoteHostManager.js";
import type { LinkSession } from "../link/session.js";
import { registerRemoteService } from "../runtime.js";
import { DeviceAnswerHostsClient } from "./client.js";

declare module "../runtime.js" {
  interface RemoteServices {
    deviceAnswerHosts: DeviceAnswerHostsClient;
  }
}

export interface DeviceAnswerHostsClientInstallDeps {
  registry: Pick<HostRegistry, "list">;
  manager: Pick<RemoteHostManager, "touch" | "hold">;
  sessionFor(hostId: HostId): LinkSession | null;
}

/** Shell side: the connected hosts a device paired here lists and answers through. */
export function installDeviceAnswerHostsClient(
  deps: DeviceAnswerHostsClientInstallDeps
): () => void {
  return registerRemoteService(
    "deviceAnswerHosts",
    new DeviceAnswerHostsClient({
      hosts: () => deps.registry.list().map((host) => ({ hostId: host.id, name: host.name })),
      sessionFor: deps.sessionFor,
      touch: (hostId) => deps.manager.touch(hostId),
      hold: (hostId) => deps.manager.hold(hostId),
    })
  );
}

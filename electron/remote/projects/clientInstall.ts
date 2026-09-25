import type { HostId } from "../../../shared/types/remoteHosts.js";
import { getProjectAcrossHostsService } from "../../services/projectAcrossHosts/index.js";
import { AppError } from "../../utils/errorTypes.js";
import type { RemoteHostsClient } from "../client/RemoteHostsClient.js";
import type { LinkSession } from "../link/session.js";
import { registerRemoteService } from "../runtime.js";
import { HostSwitchService } from "./HostSwitchService.js";

declare module "../runtime.js" {
  interface RemoteServices {
    hostSwitchService: HostSwitchService;
  }
}

const CONNECT_TIMEOUT_MS = 20_000;

export interface HostSwitchClientDeps {
  client: Pick<RemoteHostsClient, "connectAndWait" | "getWindowHost" | "list">;
  /** The host's current open session, or null while it has none. */
  sessionFor(hostId: HostId): LinkSession | null;
}

function unreachable(hostId: HostId, readiness: string): AppError {
  if (readiness === "version-mismatch") {
    return new AppError({
      code: "HOST_VERSION_MISMATCH",
      message: `Host ${hostId} runs a different build`,
      userMessage: "This host runs a different Daintree build. Update it to connect.",
    });
  }
  return new AppError({
    code: "HOST_DISCONNECTED",
    message: `Host ${hostId} did not connect (${readiness})`,
    userMessage: "Couldn't reach this host. Check that it is on and try again.",
  });
}

/** Build the Shell's switch service on top of the remote-hosts client. */
export function createHostSwitchService(deps: HostSwitchClientDeps): HostSwitchService {
  const resolveSession = async (hostId: HostId): Promise<LinkSession> => {
    const current = deps.sessionFor(hostId);
    if (current?.isOpen) return current;
    const readiness = await deps.client.connectAndWait(hostId, CONNECT_TIMEOUT_MS);
    const session = readiness === "ready" ? deps.sessionFor(hostId) : null;
    if (!session?.isOpen) throw unreachable(hostId, readiness);
    return session;
  };
  return new HostSwitchService({
    local: getProjectAcrossHostsService(),
    resolveSession,
    hostOfSender: (ctx) => deps.client.getWindowHost(ctx).hostId,
    isKnownHost: (hostId) => deps.client.list().some((entry) => entry.descriptor.id === hostId),
    whenReconnected: async (hostId, timeoutMs) =>
      (await deps.client.connectAndWait(hostId, timeoutMs)) === "ready" &&
      deps.sessionFor(hostId)?.isOpen === true,
  });
}

/** Register the switch service the `hostSwitch` IPC namespace reaches through the runtime. */
export function installHostSwitchService(deps: HostSwitchClientDeps): () => void {
  return registerRemoteService("hostSwitchService", createHostSwitchService(deps));
}

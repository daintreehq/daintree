import type { HostAgentForwardingCheck } from "../../../shared/types/ipc/remoteHosts.js";
import {
  sshTargetOf,
  type HostDescriptor,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { createLogger } from "../../utils/logger.js";
import type { LinkSession } from "../link/session.js";
import {
  agentSocketFor,
  parseIdentityAgent,
  readSshConfig,
  type SshConfigReader,
} from "./identityAgent.js";
import { AgentForwardMethod, AgentInspectResultSchema } from "./linkMethods.js";
import { connectAgentSocket, ShellAgentRelay } from "./shellRelay.js";

const logger = createLogger("main:AgentForwardingClient");

declare module "../runtime.js" {
  interface RemoteServices {
    agentForwardingClient: AgentForwardingClient;
  }
}

/** How long a switch change a busy link refused waits before it is sent again. */
export const CONFIGURE_RETRY_MS = 5_000;
/** One `ssh -G` read serves the connections a burst of git commands opens. */
const AGENT_SOCKET_CACHE_MS = 30_000;
const INSPECT_TIMEOUT_MS = 15_000;
const AGENT_PROBE_TIMEOUT_MS = 2_000;

export interface AgentForwardingClientDeps {
  manager: {
    onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  };
  /**
   * Whether a window here is bound to the host now, by its live binding: a
   * link with none (kept for notifications, or a view of it only cached)
   * signs nothing.
   */
  windowShowing(hostId: HostId): boolean;
  registry: {
    get(hostId: HostId): HostDescriptor | null;
    onChange(listener: () => void): () => void;
  };
  sessionFor(hostId: HostId): LinkSession | null;
  readSshConfig?: SshConfigReader;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface AgentForwardingClient {
  /** What Settings shows beside the switch; the host part only while it is connected. */
  check(hostId: HostId): Promise<HostAgentForwardingCheck>;
  dispose(): void;
}

interface Delivery {
  hostId: HostId;
  relay: ShellAgentRelay;
  /** The switch as last sent on this link; null until it is. */
  sent: boolean | null;
  retry: ReturnType<typeof setTimeout> | null;
}

function isTransient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "RATE_LIMITED" || code === "OUTCOME_UNKNOWN";
}

/**
 * Shell side of agent forwarding (#17432): every link to a host says whether
 * this machine's switch for it is on, again whenever it changes, and answers
 * the host's agent requests with this computer's agent while it is. The
 * switch is read here on every request, so the host's copy of it only
 * decides which terminals are handed the socket.
 */
export function installAgentForwardingClient(
  deps: AgentForwardingClientDeps
): AgentForwardingClient {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const readConfig = deps.readSshConfig ?? readSshConfig;
  const deliveries = new Map<LinkSession, Delivery>();
  const sockets = new Map<string, { at: number; path: Promise<string | null> }>();
  let disposed = false;

  const enabledFor = (hostId: HostId): boolean =>
    platform !== "win32" && deps.registry.get(hostId)?.forwardSshAgent === true;

  /** The agent this computer's ssh uses for the host, as its own ForwardAgent would forward it. */
  const agentSocket = (hostId: HostId): Promise<string | null> => {
    const descriptor = deps.registry.get(hostId);
    const target = descriptor ? sshTargetOf(descriptor.connection) : null;
    if (!target) return Promise.resolve(agentSocketFor(null, env));
    const now = Date.now();
    const cached = sockets.get(target);
    if (cached && now - cached.at < AGENT_SOCKET_CACHE_MS) return cached.path;
    // A config ssh couldn't read may name another agent for this host, or
    // none: never fall back to the default one in its place.
    const resolved = readConfig(target).then(
      (dump) => agentSocketFor(parseIdentityAgent(dump), env),
      () => null
    );
    sockets.set(target, { at: now, path: resolved });
    return resolved;
  };

  const deliver = (session: LinkSession, delivery: Delivery): void => {
    if (!session.isOpen || disposed) return;
    const enabled = enabledFor(delivery.hostId);
    if (delivery.sent === enabled) return;
    delivery.sent = enabled;
    // Off takes effect here first: nothing waits on the host's answer.
    if (!enabled) delivery.relay.closeAll();
    session.call(AgentForwardMethod.CONFIGURE, { enabled }).catch((error: unknown) => {
      // A host from before this never hands out the socket; a closed link is
      // told again when it reopens; a newer change is already on its way.
      if (!isTransient(error) || deliveries.get(session) !== delivery) return;
      if (delivery.sent !== enabled) return;
      delivery.sent = null;
      delivery.retry ??= setTimeout(() => {
        delivery.retry = null;
        deliver(session, delivery);
      }, CONFIGURE_RETRY_MS);
    });
  };

  const forget = (session: LinkSession): void => {
    const delivery = deliveries.get(session);
    if (!delivery) return;
    if (delivery.retry) clearTimeout(delivery.retry);
    delivery.relay.dispose();
    deliveries.delete(session);
  };

  const offOpened = deps.manager.onSessionOpened((hostId, session) => {
    if (disposed || !session.isOpen || deliveries.has(session)) return;
    const relay = new ShellAgentRelay(session, {
      // The host's word that this Shell drives can't be checked from here,
      // but a window of this Shell on it can.
      isEnabled: () => enabledFor(hostId) && deps.windowShowing(hostId),
      agentSocket: () => agentSocket(hostId),
    });
    const delivery: Delivery = { hostId, relay, sent: null, retry: null };
    deliveries.set(session, delivery);
    session.onClose(() => forget(session));
    deliver(session, delivery);
  });

  const offRegistry = deps.registry.onChange(() => {
    // A re-pointed host may resolve to another agent.
    sockets.clear();
    for (const [session, delivery] of deliveries) deliver(session, delivery);
  });

  /** A socket file an agent left behind when it crashed answers nothing. */
  const answers = async (socketPath: string | null): Promise<boolean> => {
    if (!socketPath) return false;
    try {
      (await connectAgentSocket(socketPath, AGENT_PROBE_TIMEOUT_MS)).destroy();
      return true;
    } catch {
      return false;
    }
  };

  return {
    async check(hostId) {
      if (!deps.registry.get(hostId)) {
        throw new AppError({ code: "NOT_FOUND", message: `No host with id ${hostId}` });
      }
      const localAgent = await answers(await agentSocket(hostId));
      const session = deps.sessionFor(hostId);
      if (!session?.isOpen) return { localAgent };
      try {
        const raw = await session.call(AgentForwardMethod.INSPECT, null, {
          timeoutMs: INSPECT_TIMEOUT_MS,
        });
        const parsed = AgentInspectResultSchema.safeParse(raw);
        return parsed.success
          ? { localAgent, hostIdentityAgent: parsed.data.identityAgent }
          : { localAgent };
      } catch (error) {
        logger.debug("Couldn't read a host's ssh config", { hostId, error });
        return { localAgent };
      }
    },
    dispose() {
      disposed = true;
      offOpened();
      offRegistry();
      for (const session of [...deliveries.keys()]) forget(session);
      sockets.clear();
    },
  };
}

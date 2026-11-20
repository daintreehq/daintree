import type { HostId } from "../../../shared/types/remoteHosts.js";
import type { LinkSession } from "../link/session.js";
import { MetricsLinkMethod, type AgentUsageDemand } from "./linkMethods.js";

export interface AgentUsageDemandSource {
  read(): boolean;
  /** Told after the switch changed. */
  onChanged(listener: () => void): () => void;
}

/** How long a demand a busy link refused waits before it is sent again. */
export const AGENT_USAGE_DEMAND_RETRY_MS = 5_000;

/** A full send queue, or a host that didn't answer in time: worth sending again. */
function isTransient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "RATE_LIMITED" || code === "OUTCOME_UNKNOWN";
}

interface Delivery {
  /** What was last sent on this session; null until something is. */
  sent: boolean | null;
  retry: ReturnType<typeof setTimeout> | null;
}

/**
 * Shell side (#17981): tell every host this machine has a session open to
 * whether it tracks agent usage, as each session opens and whenever that
 * changes. A host reads usage for this Shell only once the send on open says
 * so, whatever the HELLO said. Nothing here dials a host or keeps one linked.
 */
export function installAgentUsageDemandPush(
  manager: {
    onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  },
  source: AgentUsageDemandSource
): () => void {
  const sessions = new Map<LinkSession, Delivery>();
  let disposed = false;

  const deliver = (session: LinkSession, delivery: Delivery): void => {
    if (disposed || !session.isOpen) return;
    const enabled = source.read();
    if (delivery.sent === enabled) return;
    delivery.sent = enabled;
    const demand: AgentUsageDemand = { enabled };
    session.call(MetricsLinkMethod.AGENT_USAGE_DEMAND, demand).catch((error: unknown) => {
      // A host from before this keeps sending usage, which this Shell then
      // doesn't show; a closed link says it again in its next HELLO; a newer
      // value is already on its way.
      if (!isTransient(error) || sessions.get(session) !== delivery || delivery.sent !== enabled) {
        return;
      }
      delivery.sent = null;
      delivery.retry ??= setTimeout(() => {
        delivery.retry = null;
        deliver(session, delivery);
      }, AGENT_USAGE_DEMAND_RETRY_MS);
    });
  };

  const forget = (session: LinkSession): void => {
    const delivery = sessions.get(session);
    if (!delivery) return;
    if (delivery.retry) clearTimeout(delivery.retry);
    sessions.delete(session);
  };

  const offOpened = manager.onSessionOpened((_hostId, session) => {
    if (!session.isOpen || sessions.has(session)) return;
    const delivery: Delivery = { sent: null, retry: null };
    sessions.set(session, delivery);
    session.onClose(() => forget(session));
    deliver(session, delivery);
  });

  const offChanged = source.onChanged(() => {
    for (const [session, delivery] of sessions) deliver(session, delivery);
  });

  return () => {
    disposed = true;
    offOpened();
    offChanged();
    for (const session of [...sessions.keys()]) forget(session);
  };
}

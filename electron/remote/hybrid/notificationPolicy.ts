import { z } from "zod";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import type { NotificationSettings } from "../../../shared/types/ipc/api.js";
import {
  agentNotificationService,
  type ShellNotificationPolicy,
} from "../../services/AgentNotificationService.js";
import { store } from "../../store.js";
import type { LinkClientInfo } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";

/**
 * Shell → Host: which of the host's events alert this Shell, and when an
 * unanswered wait is raised again (#14701). The host still detects the
 * events and applies this to what it sends that Shell's views; quiet hours
 * aren't in it, since they are this Shell's clock, applied as notifications
 * arrive. A host from before it existed answers UNSUPPORTED and keeps
 * deciding by its own settings.
 */
export const NOTIFICATION_POLICY_METHOD = "notification.policy";

export const NotificationPolicySchema = z.object({
  enabled: z.boolean(),
  completedEnabled: z.boolean(),
  waitingEnabled: z.boolean(),
  waitingEscalationEnabled: z.boolean(),
  // The bounds this machine's own settings handler clamps to.
  waitingEscalationDelayMs: z.number().min(30_000).max(3_600_000),
}) satisfies z.ZodType<ShellNotificationPolicy>;

export function notificationPolicyOf(settings: NotificationSettings): ShellNotificationPolicy {
  return {
    enabled: settings.enabled,
    completedEnabled: settings.completedEnabled,
    waitingEnabled: settings.waitingEnabled,
    waitingEscalationEnabled: settings.waitingEscalationEnabled,
    waitingEscalationDelayMs: settings.waitingEscalationDelayMs,
  };
}

export interface NotificationPolicySource {
  read(): ShellNotificationPolicy;
  /** Told after any write that may have changed it; called freely. */
  onMaybeChanged(listener: () => void): () => void;
}

/**
 * This machine's settings file. Every write fires conf's change event, which
 * carries no key; the policy is read from the store's cached snapshot rather
 * than conf's own `onDidChange`, which parses the file again on each write.
 */
const storePolicySource: NotificationPolicySource = {
  read: () => notificationPolicyOf(store.get("notificationSettings")),
  onMaybeChanged(listener) {
    // The in-memory store an unreadable settings file falls back to has none.
    const events: EventTarget | undefined = store.events;
    if (!events) return () => {};
    events.addEventListener("change", listener);
    return () => events.removeEventListener("change", listener);
  },
};

/** How long a policy a busy link refused waits before it is sent again. */
export const POLICY_RETRY_MS = 5_000;

/** A full send queue, or a host that didn't answer in time: worth sending again. */
function isTransient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "RATE_LIMITED" || code === "OUTCOME_UNKNOWN";
}

interface Delivery {
  /** The policy last sent on the session, as JSON; null until one is. */
  sent: string | null;
  retry: ReturnType<typeof setTimeout> | null;
}

/**
 * Shell side: send this machine's policy on every session it opens to a
 * host, and again to each open one whenever it changes. Settings writes are
 * watched only while some session is open, so a machine with no hosts pays
 * nothing for it.
 */
export function installNotificationPolicyPush(
  manager: {
    onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  },
  source: NotificationPolicySource = storePolicySource
): () => void {
  const sessions = new Map<LinkSession, Delivery>();
  let offChanged: (() => void) | null = null;
  let disposed = false;

  const deliver = (session: LinkSession, delivery: Delivery): void => {
    if (!session.isOpen) return;
    const policy = source.read();
    const key = JSON.stringify(policy);
    if (delivery.sent === key) return;
    delivery.sent = key;
    session.call(NOTIFICATION_POLICY_METHOD, policy).catch((error: unknown) => {
      // A host from before this decides by its own settings; a closed link is
      // sent the policy when it reopens; a newer policy is already on its way.
      if (!isTransient(error) || sessions.get(session) !== delivery || delivery.sent !== key) {
        return;
      }
      delivery.sent = null;
      delivery.retry ??= setTimeout(() => {
        delivery.retry = null;
        deliver(session, delivery);
      }, POLICY_RETRY_MS);
    });
  };

  const forget = (session: LinkSession): void => {
    const delivery = sessions.get(session);
    if (!delivery) return;
    if (delivery.retry) clearTimeout(delivery.retry);
    sessions.delete(session);
    if (sessions.size > 0 || !offChanged) return;
    offChanged();
    offChanged = null;
  };

  // A settings save writes field by field: settle once they're all in.
  let pending = false;
  const onMaybeChanged = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (disposed) return;
      for (const [session, delivery] of sessions) deliver(session, delivery);
    });
  };

  const offOpened = manager.onSessionOpened((_hostId, session) => {
    if (!session.isOpen || sessions.has(session)) return;
    const delivery: Delivery = { sent: null, retry: null };
    sessions.set(session, delivery);
    session.onClose(() => forget(session));
    offChanged ??= source.onMaybeChanged(onMaybeChanged);
    deliver(session, delivery);
  });

  return () => {
    disposed = true;
    offOpened();
    for (const session of [...sessions.keys()]) forget(session);
    offChanged?.();
    offChanged = null;
  };
}

interface PolicySessionContext {
  session: LinkSession;
  client: LinkClientInfo;
}

/**
 * Host side: take each attached Shell's policy, keyed by the client the
 * session proved, never by anything in the payload.
 */
export function installNotificationPolicyHost(
  server: {
    readonly sessions: ReadonlyArray<PolicySessionContext>;
    onSession(listener: (ctx: PolicySessionContext) => void): () => void;
  },
  apply: (clientId: string, policy: ShellNotificationPolicy) => void = (clientId, policy) =>
    agentNotificationService.setShellPolicy(clientId, policy)
): () => void {
  const wired = new WeakSet<LinkSession>();
  const wire = ({ session, client }: PolicySessionContext): void => {
    if (wired.has(session)) return;
    wired.add(session);
    session.registerCallHandler(NOTIFICATION_POLICY_METHOD, NotificationPolicySchema, (policy) => {
      apply(client.clientId, policy);
      return null;
    });
  };
  for (const ctx of server.sessions) wire(ctx);
  return server.onSession(wire);
}

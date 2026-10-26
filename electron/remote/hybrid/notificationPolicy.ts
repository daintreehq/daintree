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
  const sessions = new Set<LinkSession>();
  let disposed = false;
  const send = (session: LinkSession, policy: ShellNotificationPolicy): void => {
    session.call(NOTIFICATION_POLICY_METHOD, policy).catch(() => {
      // An older host decides by its own settings; a closed link is sent the policy when it reopens.
    });
  };

  // A settings save writes field by field: settle once they're all in.
  let sent = "";
  let pending = false;
  const onMaybeChanged = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (disposed) return;
      const policy = source.read();
      const key = JSON.stringify(policy);
      if (key === sent) return;
      sent = key;
      for (const session of sessions) {
        if (session.isOpen) send(session, policy);
      }
    });
  };
  let offChanged: (() => void) | null = null;

  const offOpened = manager.onSessionOpened((_hostId, session) => {
    sessions.add(session);
    session.onClose(() => {
      sessions.delete(session);
      if (sessions.size > 0 || !offChanged) return;
      offChanged();
      offChanged = null;
    });
    const policy = source.read();
    if (!offChanged) {
      sent = JSON.stringify(policy);
      offChanged = source.onMaybeChanged(onMaybeChanged);
    }
    send(session, policy);
  });

  return () => {
    disposed = true;
    offOpened();
    offChanged?.();
    offChanged = null;
    sessions.clear();
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

import { createHash } from "node:crypto";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import type { MetricsSessionSource } from "../metrics/hostMetricsHost.js";
import type { RetiredExchangeStore } from "../exchange/RetiredExchangeStore.js";
import type { SenderActor } from "../exchange/types.js";
import { SenderSessions } from "./senderSessions.js";
import {
  AssistantLinkMethod,
  AuthenticatePayloadSchema,
  ListExchangesPayloadSchema,
  MessageIdPayloadSchema,
  RetiredExchangeMethod,
  SendPayloadSchema,
} from "./linkMethods.js";

declare module "../runtime.js" {
  interface RemoteServices {
    assistantSenderSessions: SenderSessions;
  }
}

/**
 * The sender a credential authenticates. Derived, so the host keeps nothing
 * to look it up by, and one-way, so a sender id seen in a record or a log
 * never lets anyone authenticate as it.
 */
export function senderIdForCredential(credential: string): string {
  return createHash("sha256")
    .update(`daintree.assistant-sender\0${credential}`, "utf8")
    .digest("hex");
}

function unsupported(): AppError {
  return new AppError({
    code: "UNSUPPORTED",
    message: "This host no longer takes assistant messages",
    userMessage: "This host doesn't support assistant messaging.",
  });
}

export interface AssistantSenderHostDeps {
  /** Where each session's proven sender is kept, for the relay to read. */
  senders: SenderSessions;
  /** What this host took before the inbox was retired; absent with no database. */
  retired?: RetiredExchangeStore;
  /** A link session ended for good, so no transport can resume it. */
  onSessionExpired?(listener: (info: { sessionId: string }) => void): () => void;
}

/**
 * The host's side of a Shell proving which sender it is (#13493): every
 * attached session, view or not, authenticates once with the credential its
 * Shell keeps for this host, and the tools this host runs for that Shell's
 * assistants read the sender from here.
 *
 * And what a v0.44 Shell still asks about the messages it sent before this
 * host was updated (#13496): the records this host holds for its sender,
 * read-only, so work this host accepted reads as ended, never as silently
 * gone. A resend of a message it took answers from that record; anything new
 * is UNSUPPORTED, which that Shell reads as "this host doesn't support
 * assistant messaging".
 */
export function installAssistantSenderHostWith(
  server: MetricsSessionSource,
  deps: AssistantSenderHostDeps
): () => void {
  const wired = new WeakSet<LinkSession>();
  const { senders, retired } = deps;

  const requireSender = (session: LinkSession): SenderActor => {
    const senderId = senders.senderOf(session);
    if (!senderId) {
      throw new AppError({
        code: "PERMISSION",
        message: "This session hasn't authenticated an assistant sender",
      });
    }
    return { kind: "sender", senderId };
  };

  const requireRetired = (): RetiredExchangeStore => {
    if (!retired) throw unsupported();
    return retired;
  };

  const wire = ({ session, sessionId }: { session: LinkSession; sessionId: string }): void => {
    if (wired.has(session)) return;
    wired.add(session);

    session.registerCallHandler(
      AssistantLinkMethod.AUTHENTICATE,
      AuthenticatePayloadSchema,
      ({ credential }) => {
        const senderId = senderIdForCredential(credential);
        // Per transport and per session id, so a resume can't swap senders either.
        const bound = senders.senderOf(session) ?? senders.senderOfSessionId(sessionId);
        if (bound !== undefined && bound !== senderId) {
          throw new AppError({
            code: "PERMISSION",
            message: "This session already authenticated another assistant sender",
          });
        }
        senders.bind(session, senderId, sessionId);
        return null;
      }
    );

    session.registerCallHandler(RetiredExchangeMethod.SEND, SendPayloadSchema, ({ messageId }) => {
      const sender = requireSender(session);
      const record = requireRetired().get(sender, { senderId: sender.senderId, messageId });
      if (!record) throw unsupported();
      return { disposition: record.tombstonedAt !== null ? "tombstoned" : "existing", record };
    });

    session.registerCallHandler(
      RetiredExchangeMethod.GET_EXCHANGE,
      MessageIdPayloadSchema,
      ({ messageId }) => {
        const sender = requireSender(session);
        return requireRetired().get(sender, { senderId: sender.senderId, messageId });
      }
    );

    session.registerCallHandler(
      RetiredExchangeMethod.LIST_EXCHANGES,
      ListExchangesPayloadSchema,
      ({ cursor, limit }) =>
        requireRetired().listChangesSince(requireSender(session), cursor, limit)
    );

    // Nothing can be canceled any more; what it ended as is the answer.
    session.registerCallHandler(
      RetiredExchangeMethod.CANCEL_EXCHANGE,
      MessageIdPayloadSchema,
      ({ messageId }) => {
        const sender = requireSender(session);
        const record = requireRetired().get(sender, { senderId: sender.senderId, messageId });
        if (!record) {
          throw new AppError({
            code: "NOT_FOUND",
            message: `No exchange ${messageId} for this participant`,
          });
        }
        return record;
      }
    );

    // The answers lived only in the process that took them.
    session.registerCallHandler(
      RetiredExchangeMethod.GET_RESPONSES,
      MessageIdPayloadSchema,
      () => ({ responses: [] })
    );
  };

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession(wire);
  const offExpired =
    deps.onSessionExpired?.(({ sessionId }) => senders.forgetSessionId(sessionId)) ?? (() => {});
  return () => {
    offSession();
    offExpired();
  };
}

const SWEEP_INTERVAL_MS = 60 * 60_000;
const MAX_SWEEP_BATCHES = 20;

/**
 * Wire sender authentication and the retired exchanges into a host server.
 * Whatever was still open when this build first ran is ended first, before a
 * Shell can read it, so it never reads as under way; each hourly pass ends
 * anything a failed write left open, then expires and purges the rest.
 */
export async function installAssistantSenderHost(
  server: MetricsSessionSource & {
    onSessionExpired?(listener: (info: { sessionId: string }) => void): () => void;
  }
): Promise<() => void> {
  const [{ getSharedSqlite }, { RetiredExchangeStore }, { registerRemoteService }] =
    await Promise.all([
      import("../../services/persistence/db.js"),
      import("../exchange/RetiredExchangeStore.js"),
      import("../runtime.js"),
    ]);
  const sqlite = getSharedSqlite();
  const retired = sqlite ? new RetiredExchangeStore(sqlite) : undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (retired) {
    const maintain = (): void => {
      try {
        while (retired.retireOpen().hasMore) {
          // Each batch ends what it read, so the next reads past it.
        }
      } catch (error) {
        console.warn("[AssistantSenders] Couldn't end exchanges left open:", error);
      }
      try {
        for (let batch = 0; batch < MAX_SWEEP_BATCHES && retired.sweep().hasMore; batch++) {
          // Bounded: the next interval takes what's left.
        }
      } catch (error) {
        console.warn("[AssistantSenders] Sweep failed:", error);
      }
    };
    maintain();
    timer = setInterval(maintain, SWEEP_INTERVAL_MS);
    timer.unref?.();
  }
  const senders = new SenderSessions();
  const unregister = registerRemoteService("assistantSenderSessions", senders);
  const unwire = installAssistantSenderHostWith(server, {
    senders,
    ...(retired ? { retired } : {}),
    ...(server.onSessionExpired
      ? { onSessionExpired: (listener) => server.onSessionExpired!(listener) }
      : {}),
  });
  return () => {
    if (timer !== undefined) clearInterval(timer);
    unwire();
    unregister();
  };
}

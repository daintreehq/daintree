import { createHash } from "node:crypto";
import { assistantSlotKey } from "../../../shared/config/assistantSlots.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { EmptyPayloadSchema } from "../host/linkMethods.js";
import type { LinkSession } from "../link/session.js";
import type { MetricsSessionSource } from "../metrics/hostMetricsHost.js";
import type { AssistantExchangeStore, ExchangeChange } from "../exchange/AssistantExchangeStore.js";
import type {
  CreateExchangeInput,
  ExchangeKey,
  ExchangeRecord,
  SenderActor,
} from "../exchange/types.js";
import { inboxBodyFits, type InboxEnvelope } from "./AssistantInbox.js";
import type {
  AssistantMessagingPolicy,
  LaneEnrollment,
  MessagingDenial,
  MessagingShell,
} from "./AssistantMessagingPolicy.js";
import {
  AssistantLinkMethod,
  AuthenticatePayloadSchema,
  MAX_EXCHANGE_RESPONSES,
  ListExchangesPayloadSchema,
  MAX_LISTED_LANES,
  MessageIdPayloadSchema,
  SendPayloadSchema,
  type EnrolledLane,
  type ExchangeResponse,
} from "./linkMethods.js";

declare module "../runtime.js" {
  interface RemoteServices {
    assistantExchangeStore: AssistantExchangeStore;
  }
}

export interface AssistantExchangeHostDeps {
  /** Read at each call: the policy is installed by the Shell side of boot and may come later. */
  policy(): AssistantMessagingPolicy | undefined;
  store: AssistantExchangeStore;
  /**
   * Hands a newly accepted exchange to its lane's wake. Absent, or when the
   * lane can't be woken now, the exchange waits as submitted: availability
   * never fails an exchange this host accepted.
   */
  wake?: (record: ExchangeRecord, enrollment: LaneEnrollment) => void | Promise<void>;
  /** Committed changes to any exchange on this host, whichever store wrote them. */
  onExchangeChanged?: (listener: (change: ExchangeChange) => void) => () => void;
  /**
   * Hands a newly accepted exchange's body to its lane's inbox, before any
   * wake. A throw means the lane can never read it: the exchange is rejected
   * rather than left waiting for a delivery that can't happen.
   */
  admit?: (record: ExchangeRecord, envelope: InboxEnvelope) => void;
  /** The answers a lane gave an exchange; absent, the host doesn't hand replies back. */
  responses?: (key: ExchangeKey) => ExchangeResponse[];
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

/**
 * The fixed words two PERMISSION refusals carry, so a Shell can name them
 * apart from "not enrolled for you" without the host saying more than that.
 */
export const LANE_NOT_RUNNING_MESSAGE = "The lane's assistant isn't running";
export const HOST_MESSAGING_PAUSED_MESSAGE = "Assistant messaging is paused on this host";

function refuseLane(reason: MessagingDenial): AppError {
  switch (reason) {
    case "unsupported-platform":
      return new AppError({
        code: "UNSUPPORTED",
        message: "Assistant messaging isn't supported on this host's platform",
        userMessage: "This host doesn't support assistant messaging.",
      });
    case "stale-generation":
      return new AppError({
        code: "STALE_GENERATION",
        message: "The lane was enrolled again since this Shell listed it",
      });
    case "unavailable":
      return new AppError({
        code: "PERMISSION",
        message: LANE_NOT_RUNNING_MESSAGE,
        userMessage: "That assistant isn't running on this host.",
      });
    case "paused":
      return new AppError({
        code: "PERMISSION",
        message: HOST_MESSAGING_PAUSED_MESSAGE,
        userMessage: "Assistant messaging is paused on this host.",
      });
    default:
      // Not enrolled, and enrolled by another Shell, read alike: neither may learn of the other.
      return new AppError({
        code: "PERMISSION",
        message: "The lane isn't enrolled for this Shell",
        userMessage: "That assistant hasn't been enrolled for this Shell.",
      });
  }
}

function unsupported(): AppError {
  return new AppError({
    code: "UNSUPPORTED",
    message: "Assistant messaging isn't running on this host",
    userMessage: "This host doesn't support assistant messaging.",
  });
}

/**
 * Host side of assistant exchanges. Every attached session can call these,
 * view or not. A session authenticates its sender once with the credential
 * its Shell keeps for this host; exchanges are scoped to that sender, so they
 * outlive the session and a restart on either side, and two Shells never see
 * each other's. Sending to a lane also needs the lane's enrollment, which
 * belongs to the link session that made it and ends with it.
 */
export function installAssistantExchangeHostWith(
  server: MetricsSessionSource,
  deps: AssistantExchangeHostDeps
): () => void {
  const wired = new WeakSet<LinkSession>();
  const senders = new WeakMap<LinkSession, string>();

  const requirePolicy = (): AssistantMessagingPolicy => {
    const policy = deps.policy();
    if (!policy) throw unsupported();
    return policy;
  };

  const requireSender = (session: LinkSession): SenderActor => {
    const senderId = senders.get(session);
    if (!senderId) {
      throw new AppError({
        code: "PERMISSION",
        message: "This session hasn't authenticated an assistant sender",
      });
    }
    return { kind: "sender", senderId };
  };

  const handOff = (
    policy: AssistantMessagingPolicy,
    record: ExchangeRecord,
    check: Parameters<AssistantMessagingPolicy["checkLane"]>[0]
  ): void => {
    const wake = deps.wake;
    if (!wake) return;
    const ready = policy.checkLane({ ...check, kind: "wake" });
    if (!ready.ok) return;
    try {
      void Promise.resolve(wake(record, ready.enrollment)).catch((error: unknown) => {
        console.warn("[AssistantExchanges] Lane wake failed:", error);
      });
    } catch (error) {
      console.warn("[AssistantExchanges] Lane wake failed:", error);
    }
  };

  /** False when the lane can never read the exchange, which is then rejected. */
  const admit = (record: ExchangeRecord, envelope: InboxEnvelope): boolean => {
    if (!deps.admit) return true;
    try {
      deps.admit(record, envelope);
      return true;
    } catch (error) {
      console.warn("[AssistantExchanges] Couldn't hand an exchange to its lane:", error);
      try {
        deps.store.setState(
          { kind: "receiver", ...record.receiver },
          { senderId: record.senderId, messageId: record.messageId },
          "rejected",
          "inbox-refused"
        );
      } catch (stateError) {
        console.warn("[AssistantExchanges] Couldn't record a refused exchange:", stateError);
      }
      return false;
    }
  };

  const wire = ({
    session,
    sessionId,
    client,
  }: {
    session: LinkSession;
    sessionId: string;
    client?: { clientName?: string };
  }): void => {
    if (wired.has(session)) return;
    wired.add(session);
    const shell: MessagingShell = { kind: "remote", linkSessionId: sessionId };
    // Display data the Shell chose for itself, cleaned by the inbox; never identity.
    const sendingHost = client?.clientName || "Remote Shell";

    session.registerCallHandler(
      AssistantLinkMethod.AUTHENTICATE,
      AuthenticatePayloadSchema,
      ({ credential }) => {
        const senderId = senderIdForCredential(credential);
        const bound = senders.get(session);
        if (bound !== undefined && bound !== senderId) {
          throw new AppError({
            code: "PERMISSION",
            message: "This session already authenticated another assistant sender",
          });
        }
        senders.set(session, senderId);
        return null;
      }
    );

    session.registerCallHandler(AssistantLinkMethod.LIST_LANES, EmptyPayloadSchema, () => {
      const policy = requirePolicy();
      const lanes: EnrolledLane[] = policy
        .listEnrollments(shell)
        .slice(0, MAX_LISTED_LANES)
        .map((enrollment) => ({
          projectId: enrollment.projectId,
          slot: enrollment.slot,
          generation: enrollment.generation,
          available: policy.checkLane({
            lane: { projectId: enrollment.projectId, slot: enrollment.slot },
            generation: enrollment.generation,
            shell,
            kind: "wake",
          }).ok,
        }));
      return { lanes };
    });

    session.registerCallHandler(AssistantLinkMethod.SEND, SendPayloadSchema, (payload) => {
      const sender = requireSender(session);
      const input: CreateExchangeInput = {
        messageId: payload.messageId,
        contextId: payload.contextId,
        referenceTaskIds: payload.referenceTaskIds,
        receiver: {
          hostId: LOCAL_HOST_ID,
          laneId: assistantSlotKey(payload.projectId, payload.slot),
          enrollmentGeneration: payload.generation,
        },
        body: payload.body,
      };
      // A resend of a message this host already took answers from its record,
      // even once the enrollment it came in under has ended.
      if (deps.store.get(sender, { senderId: sender.senderId, messageId: payload.messageId })) {
        return deps.store.create(sender, input);
      }
      const policy = requirePolicy();
      const check = {
        lane: { projectId: payload.projectId, slot: payload.slot },
        generation: payload.generation,
        shell,
      };
      const admitted = policy.checkLane({ ...check, kind: "admit" });
      if (!admitted.ok) throw refuseLane(admitted.reason);
      // Refused before anything is recorded: a body the lane could never be handed whole.
      if (deps.admit && !inboxBodyFits(payload.body)) {
        throw new AppError({
          code: "VALIDATION",
          message: "The message is too long for an assistant's inbox",
        });
      }
      const result = deps.store.create(sender, input);
      if (result.disposition !== "created") return result;
      // The hub on the sending Shell is the only lane that can address a host's lanes.
      const envelope: InboxEnvelope = {
        body: payload.body,
        provenance: { sendingHost, sendingLane: "hub", hopCount: 1 },
      };
      if (!admit(result.record, envelope)) {
        const refused = deps.store.get(sender, {
          senderId: sender.senderId,
          messageId: payload.messageId,
        });
        return refused ? { ...result, record: refused } : result;
      }
      handOff(policy, result.record, { ...check, kind: "wake" });
      return result;
    });

    session.registerCallHandler(
      AssistantLinkMethod.GET_EXCHANGE,
      MessageIdPayloadSchema,
      ({ messageId }) => {
        const sender = requireSender(session);
        return deps.store.get(sender, { senderId: sender.senderId, messageId });
      }
    );

    session.registerCallHandler(
      AssistantLinkMethod.LIST_EXCHANGES,
      ListExchangesPayloadSchema,
      ({ cursor, limit }) => deps.store.listChangesSince(requireSender(session), cursor, limit)
    );

    session.registerCallHandler(
      AssistantLinkMethod.GET_RESPONSES,
      MessageIdPayloadSchema,
      ({ messageId }) => {
        const sender = requireSender(session);
        if (!deps.responses) throw unsupported();
        // Only an exchange this sender owns; another's reads as having none.
        const key = { senderId: sender.senderId, messageId };
        if (deps.store.get(sender, key) === null) return { responses: [] };
        return { responses: deps.responses(key).slice(-MAX_EXCHANGE_RESPONSES) };
      }
    );

    session.registerCallHandler(
      AssistantLinkMethod.CANCEL_EXCHANGE,
      MessageIdPayloadSchema,
      ({ messageId }) => {
        const sender = requireSender(session);
        return deps.store.requestCancel(sender, { senderId: sender.senderId, messageId });
      }
    );
  };

  // Latest revision per sender, told once per tick: a reply writes several facts at once.
  const due = new Map<string, number>();
  const flush = (): void => {
    const batch = [...due];
    due.clear();
    for (const [senderId, revision] of batch) {
      for (const { session } of server.sessions) {
        if (!session.isOpen || senders.get(session) !== senderId) continue;
        session.call(AssistantLinkMethod.EXCHANGE_CHANGED, { revision }).catch(() => {
          // Nothing to retry: the Shell reads every change by cursor when a session opens.
        });
      }
    }
  };
  const offChanges =
    deps.onExchangeChanged?.(({ senderId, revision }) => {
      if (due.size === 0) queueMicrotask(flush);
      due.set(senderId, Math.max(revision, due.get(senderId) ?? 0));
    }) ?? (() => {});

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession(wire);
  return () => {
    offChanges();
    offSession();
    due.clear();
  };
}

const SWEEP_INTERVAL_MS = 60 * 60_000;
const MAX_SWEEP_BATCHES = 20;

/**
 * Wire the exchange store over the app's database into a host server. Without
 * a database nothing is registered, so a Shell is told this host doesn't
 * support assistant messaging rather than handed records that vanish.
 */
export async function installAssistantExchangeHost(
  server: MetricsSessionSource
): Promise<() => void> {
  const [
    { getSharedSqlite },
    { AssistantExchangeStore, onExchangeChanged },
    { getRemoteService, registerRemoteService },
    { exchangeWakeSink },
  ] = await Promise.all([
    import("../../services/persistence/db.js"),
    import("../exchange/AssistantExchangeStore.js"),
    import("../runtime.js"),
    import("../exchange/wakeSink.js"),
  ]);
  const sqlite = getSharedSqlite();
  if (!sqlite) {
    console.warn("[AssistantExchanges] No database; assistant messaging is off on this host");
    return () => {};
  }
  const store = new AssistantExchangeStore(sqlite);
  const sweep = (): void => {
    try {
      for (let batch = 0; batch < MAX_SWEEP_BATCHES && store.sweep().hasMore; batch++) {
        // Bounded: the next interval takes what's left.
      }
    } catch (error) {
      console.warn("[AssistantExchanges] Sweep failed:", error);
    }
  };
  sweep();
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref?.();
  const unregister = registerRemoteService("assistantExchangeStore", store);
  // The inbox and the waker come with the messaging policy, read at each
  // call; without them an exchange waits as submitted, as availability allows.
  const unwire = installAssistantExchangeHostWith(server, {
    policy: () => getRemoteService("assistantMessagingPolicy"),
    store,
    onExchangeChanged,
    admit: (record, envelope) => {
      const runtime = getRemoteService("assistantMessagingRuntime");
      if (!runtime) throw unsupported();
      runtime.admit(record, envelope);
    },
    wake: (record, enrollment) => {
      getRemoteService("assistantLaneWaker")?.wake({
        lane: { projectId: enrollment.projectId, slot: enrollment.slot },
        generation: record.receiver.enrollmentGeneration,
        shell: enrollment.enrolledBy,
        exchangeId: record.taskId,
        sink: exchangeWakeSink(
          store,
          { kind: "receiver", ...record.receiver },
          { senderId: record.senderId, messageId: record.messageId }
        ),
      });
    },
    responses: (key) => getRemoteService("assistantMessagingRuntime")?.getResponses(key) ?? [],
  });
  return () => {
    clearInterval(timer);
    unwire();
    unregister();
  };
}

import { createHash } from "node:crypto";
import { assistantSlotKey } from "../../../shared/config/assistantSlots.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { EmptyPayloadSchema } from "../host/linkMethods.js";
import type { LinkSession } from "../link/session.js";
import type { MetricsSessionSource } from "../metrics/hostMetricsHost.js";
import type { AssistantExchangeStore, ExchangeChange } from "../exchange/AssistantExchangeStore.js";
import type { AssistantHostOutbox } from "./AssistantHostOutbox.js";
import type {
  CreateExchangeInput,
  ExchangeKey,
  ExchangeRecord,
  SenderActor,
} from "../exchange/types.js";
import { inboxBodyFits, type InboxEnvelope } from "./AssistantInbox.js";
import {
  OPEN_LANE_GENERATION,
  type AssistantMessagingPolicy,
  type LaneRef,
  type MessagingDenial,
  type MessagingShell,
  type SessionRebind,
} from "./AssistantMessagingPolicy.js";
import {
  AssistantLinkMethod,
  AuthenticatePayloadSchema,
  EnrollStartedPayloadSchema,
  MAX_EXCHANGE_RESPONSES,
  ListExchangesPayloadSchema,
  MAX_LISTED_LANES,
  MessageIdPayloadSchema,
  SendPayloadSchema,
  type CodexQuotaReading,
  type EnrolledLane,
  type EnrollStartedResult,
  type ExchangeResponse,
  type LaneList,
  type RunningAssistant,
} from "./linkMethods.js";

declare module "../runtime.js" {
  interface RemoteServices {
    assistantExchangeStore: AssistantExchangeStore;
    assistantHostOutbox: AssistantHostOutbox;
  }
}

export interface AssistantExchangeHostDeps {
  /** Read at each call: the policy is installed by the Shell side of boot and may come later. */
  policy(): AssistantMessagingPolicy | undefined;
  store: AssistantExchangeStore;
  /**
   * Hands a newly accepted exchange to its lane's wake, with the Shell that
   * sent it. Absent, or when the lane can't be woken now, the exchange waits
   * as submitted: availability never fails an exchange this host accepted.
   */
  wake?: (record: ExchangeRecord, lane: LaneRef, shell: MessagingShell) => void | Promise<void>;
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
  /** A Shell's enrollments moved to its newer link session; what waits on the old one follows. */
  onSessionRebound?: (rebind: SessionRebind) => void;
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
export const LANE_NOT_ACCEPTING_MESSAGE =
  "The lane isn't taking messages from other machines: this host's setting or its run is off";

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
    case "not-accepting":
    case "declined":
      return new AppError({
        code: "PERMISSION",
        message: LANE_NOT_ACCEPTING_MESSAGE,
        userMessage: "That assistant isn't taking messages from other machines.",
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
 * each other's. Any authenticated Shell may send to any lane open to other
 * machines (`checkOpen`), filed under the lane's one stable address, so two
 * Shells can message the same assistant and a relaunched run reads what was
 * sent to the one before. A lane's own messages go to the Shell its
 * enrollment names, which a later session of that Shell takes over once it
 * authenticates (`bindSender`).
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
    lane: LaneRef,
    shell: MessagingShell
  ): void => {
    const wake = deps.wake;
    if (!wake) return;
    if (!policy.checkOpen(lane, "wake").ok) return;
    try {
      void Promise.resolve(wake(record, lane, shell)).catch((error: unknown) => {
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
        // Per transport here, and per session id in the policy, so a resume can't swap senders either.
        const bound = senders.get(session) ?? deps.policy()?.sessionSender(sessionId);
        if (bound !== undefined && bound !== senderId) {
          throw new AppError({
            code: "PERMISSION",
            message: "This session already authenticated another assistant sender",
          });
        }
        senders.set(session, senderId);
        // Consent follows the Shell this proves, not one connection.
        const policy = deps.policy();
        for (const rebind of policy?.bindSender(sessionId, senderId) ?? []) {
          try {
            deps.onSessionRebound?.(rebind);
          } catch (error) {
            console.warn("[AssistantExchanges] Moving a rebound session's messages failed:", error);
          }
        }
        return null;
      }
    );

    session.registerCallHandler(AssistantLinkMethod.LIST_LANES, EmptyPayloadSchema, () => {
      const policy = requirePolicy();
      // Agents are read from everything running, before the listing is capped.
      const running = policy.listRunning();
      const agents = new Map(
        running.map((lane) => [assistantSlotKey(lane.projectId, lane.slot), lane.agentId])
      );
      const agentOf = (projectId: string, slot: number) =>
        agents.get(assistantSlotKey(projectId, slot));
      const assistants: RunningAssistant[] = running.slice(0, MAX_LISTED_LANES);
      // What an older Shell reads as the lanes it may message, and owns: only
      // those whose own messages come to it, as before every lane was open.
      const lanes: EnrolledLane[] = policy
        .listEnrollments(shell)
        .slice(0, MAX_LISTED_LANES)
        .map((enrollment) =>
          openLane(policy, enrollment, agentOf(enrollment.projectId, enrollment.slot))
        );
      const open: EnrolledLane[] = policy
        .listOpen()
        .slice(0, MAX_LISTED_LANES)
        .map((run) => openLane(policy, run, agentOf(run.projectId, run.slot)));
      return { lanes, open, assistants } satisfies LaneList;
    });

    session.registerCallHandler(AssistantLinkMethod.READ_QUOTA, EmptyPayloadSchema, async () => {
      requirePolicy();
      // This host's own Codex profile, as Settings reads it; never Claude's (#12797).
      const { readCodexQuota } = await import("../../services/codex/CodexQuotaService.js");
      return (await readCodexQuota()) satisfies CodexQuotaReading;
    });

    session.registerCallHandler(
      AssistantLinkMethod.ENROLL_STARTED,
      EnrollStartedPayloadSchema,
      ({ projectId, slot, sessionId: helpSessionId }): EnrollStartedResult => {
        // Only a Shell that proved its sender: its route then outlives this connection.
        requireSender(session);
        const policy = requirePolicy();
        const lane = { projectId, slot };
        const result = policy.enrollStarted(lane, shell, helpSessionId);
        if (!result.ok) {
          const status =
            result.reason === "occupied" || result.reason === "wrong-session"
              ? result.reason
              : result.reason === "unavailable"
                ? "not-running"
                : "refused";
          return { status, lane: null };
        }
        const agentId = policy
          .listRunning()
          .find((running) => running.projectId === projectId && running.slot === slot)?.agentId;
        return { status: "enrolled", lane: openLane(policy, lane, agentId) };
      }
    );

    session.registerCallHandler(AssistantLinkMethod.SEND, SendPayloadSchema, (payload) => {
      const sender = requireSender(session);
      // Filed under the lane's stable address whatever generation the Shell
      // was listed: an older Shell may still name one from an enrollment.
      const input: CreateExchangeInput = {
        messageId: payload.messageId,
        contextId: payload.contextId,
        referenceTaskIds: payload.referenceTaskIds,
        receiver: {
          hostId: LOCAL_HOST_ID,
          laneId: assistantSlotKey(payload.projectId, payload.slot),
          enrollmentGeneration: OPEN_LANE_GENERATION,
        },
        body: payload.body,
      };
      // A resend of a message this host already took answers from its record,
      // even once its lane stopped taking new ones, filed where it was: one
      // taken before lanes were open has its enrollment's generation.
      const existing = deps.store.get(sender, {
        senderId: sender.senderId,
        messageId: payload.messageId,
      });
      if (existing) {
        const sameLane = existing.receiver.laneId === input.receiver.laneId;
        return deps.store.create(
          sender,
          sameLane ? { ...input, receiver: existing.receiver } : input
        );
      }
      const policy = requirePolicy();
      const lane = { projectId: payload.projectId, slot: payload.slot };
      const admitted = policy.checkOpen(lane, "admit");
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
      // The sending Shell's assistants are the only callers that can address a host's lanes.
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
      handOff(policy, result.record, lane, shell);
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

/** A lane as a Shell is listed it: under its open address, whatever enrolled it. */
function openLane(
  policy: AssistantMessagingPolicy,
  at: LaneRef,
  agentId: string | undefined
): EnrolledLane {
  const lane = { projectId: at.projectId, slot: at.slot };
  return {
    ...lane,
    generation: OPEN_LANE_GENERATION,
    available: policy.checkOpen(lane, "wake").ok,
    ...(agentId === undefined ? {} : { agentId }),
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
  server: MetricsSessionSource & { supersede?(sessionId: string): boolean }
): Promise<() => void> {
  const [
    { getSharedSqlite },
    { AssistantExchangeStore, closeExchangesLeftOpen, onExchangeChanged },
    { getRemoteService, registerRemoteService },
    { exchangeWakeSink },
    { AssistantHostOutbox },
  ] = await Promise.all([
    import("../../services/persistence/db.js"),
    import("../exchange/AssistantExchangeStore.js"),
    import("../runtime.js"),
    import("../exchange/wakeSink.js"),
    import("./AssistantHostOutbox.js"),
  ]);
  const sqlite = getSharedSqlite();
  if (!sqlite) {
    console.warn("[AssistantExchanges] No database; assistant messaging is off on this host");
    return () => {};
  }
  const store = new AssistantExchangeStore(sqlite);
  closeExchangesLeftOpen(store);
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
    wake: (record, lane, shell) => {
      getRemoteService("assistantLaneWaker")?.wake({
        lane,
        generation: record.receiver.enrollmentGeneration,
        shell,
        exchangeId: record.taskId,
        sink: exchangeWakeSink(
          store,
          { kind: "receiver", ...record.receiver },
          { senderId: record.senderId, messageId: record.messageId }
        ),
      });
    },
    responses: (key) => getRemoteService("assistantMessagingRuntime")?.getResponses(key) ?? [],
    onSessionRebound: (rebind) => {
      getRemoteService("assistantHostOutbox")?.rebindSession(rebind);
      // The Shell proved itself on a new session, so its old one, held for a
      // resume that can't come, would only keep its views' leases and the
      // assistants pinned to them.
      server.supersede?.(rebind.from);
    },
  });
  // What this host's lanes send the hub of the Shell that enrolled them (#13338).
  const outbox = new AssistantHostOutbox({
    server,
    policy: () => getRemoteService("assistantMessagingPolicy"),
    wake: ({ lane, generation, shell, messageId }) =>
      getRemoteService("assistantLaneWaker")?.wake({
        lane,
        generation,
        shell,
        exchangeId: messageId,
        kind: "update",
        // The outbox holds what happened; telling the lane twice costs nothing.
        sink: { beforeType: () => true, report: () => {} },
      }),
  });
  const unregisterOutbox = registerRemoteService("assistantHostOutbox", outbox);
  // Listening is what opens this machine's lanes to other machines: views and tools reread.
  getRemoteService("assistantMessagingPolicy")?.refresh();
  return () => {
    clearInterval(timer);
    unregisterOutbox();
    getRemoteService("assistantMessagingPolicy")?.refresh();
    outbox.dispose();
    unwire();
    unregister();
  };
}

import {
  ASSISTANT_CONVERSATION_MAX_HOPS,
  type AssistantSendRefusal,
} from "../../../shared/types/assistantMessaging.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { isAppError } from "../../utils/errorTypes.js";
import type { AssistantExchangeStore } from "../exchange/AssistantExchangeStore.js";
import type { ExchangeKey, ExchangeRecord, SenderActor } from "../exchange/types.js";
import { inboxBodyFits, type InboxResponse } from "./AssistantInbox.js";
import type {
  AssistantMessagingPolicy,
  LaneRef,
  MessagingDenial,
} from "./AssistantMessagingPolicy.js";
import { openReceiverFor, type AssistantMessagingRuntime } from "./AssistantMessagingRuntime.js";
import { MAX_EXCHANGE_RESPONSES, type HubExchange, type SendToHubPayload } from "./linkMethods.js";
import { TokenBucket } from "./tokenBucket.js";

const MINUTE_MS = 60_000;
/** Messages one host's assistants may start to this Shell, and all hosts', per minute. */
export const HUB_INBOUND_PER_HOST_PER_MINUTE = 10;
export const HUB_INBOUND_PER_MINUTE = 30;

/** Every exchange a host starts is filed under a sender only that host's connection is. */
const HOST_SENDER_PREFIX = "host:";

export function hubSenderFor(hostId: HostId): SenderActor {
  return { kind: "sender", senderId: `${HOST_SENDER_PREFIX}${hostId}` };
}

/** The host an exchange came from, when a host started it. */
export function hostOfSender(senderId: string): HostId | null {
  return senderId.startsWith(HOST_SENDER_PREFIX) ? senderId.slice(HOST_SENDER_PREFIX.length) : null;
}

export interface AssistantHubReceiverDeps {
  policy: Pick<AssistantMessagingPolicy, "checkHost">;
  store: AssistantExchangeStore;
  runtime: Pick<AssistantMessagingRuntime, "admit" | "getResponses" | "onResponse">;
  /**
   * Which of this Shell's assistants a message from `sourceLane` on `hostId`
   * goes to, of those taking messages from other machines now; null when none
   * is.
   */
  recipient(hostId: HostId, sourceLane: LaneRef): LaneRef | null;
  /** The host's display name, for the recipient to read beside the message. */
  hostName(hostId: HostId): string;
  /** Tells the recipient an admitted message is waiting; absent, it waits in the inbox unannounced. */
  wake?(record: ExchangeRecord, recipient: LaneRef): void;
  /** Tells the host one of its messages changed; absent or unreachable, the host reads it on reconnect. */
  tellHost?(hostId: HostId, messageId: string): void;
  now?: () => number;
}

function refusalFor(reason: MessagingDenial): AssistantSendRefusal {
  switch (reason) {
    case "unsupported-platform":
      return "unsupported";
    case "host-disabled":
      return "opted_out";
    case "paused":
      return "paused";
    case "unavailable":
      return "hub_unavailable";
    default:
      return "no_hub";
  }
}

/**
 * The Shell's side of a host assistant starting a conversation with it
 * (#13338). A message is admitted only with the host's opt-in on, this
 * machine's setting on, messaging not paused and an assistant here to take
 * it, within the rate limits and the conversation's hop limit. It goes to the
 * assistant that last spoke to the lane it came from, or another one taking
 * messages (#13468), and waits at that lane's open address like any other
 * machine's message, so a run that replaces the recipient reads it; the
 * recipient's `assistant.reply` is read back by the host.
 *
 * The host is whichever one the connection belongs to, never anything the
 * payload says. Hops are counted here, from the exchange records the host's
 * messages in that contextId left, as well as claimed by the host, and the
 * higher wins: a host that under-counts gains nothing, and nothing a restart
 * or a burst of other conversations does can reset the count.
 */
export class AssistantHubReceiver {
  private readonly now: () => number;
  private readonly perHost = new Map<HostId, TokenBucket>();
  private readonly overall: TokenBucket;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: AssistantHubReceiverDeps) {
    this.now = deps.now ?? Date.now;
    this.overall = new TokenBucket(
      HUB_INBOUND_PER_MINUTE,
      HUB_INBOUND_PER_MINUTE / MINUTE_MS,
      this.now()
    );
    this.unsubscribe = deps.runtime.onResponse((key) => this.responded(key));
  }

  /** Admits one message from `hostId`, or answers from its record when it was admitted before. */
  receive(hostId: HostId, payload: SendToHubPayload): HubExchange {
    const sender = hubSenderFor(hostId);
    const key: ExchangeKey = { senderId: sender.senderId, messageId: payload.messageId };
    // A resend answers from what was admitted, whatever has changed since; the
    // store still checks it is the same message, filed where it was.
    const existing = this.deps.store.get(sender, key);
    if (existing) {
      try {
        const again = this.deps.store.create(sender, {
          messageId: payload.messageId,
          contextId: payload.contextId,
          referenceTaskIds: payload.referenceTaskIds,
          receiver: existing.receiver,
          body: payload.body,
        });
        return this.snapshot(again.record);
      } catch (err) {
        if (isAppError(err) && err.code === "VALIDATION") {
          return { status: "refused", refusal: "conflict" };
        }
        throw err;
      }
    }

    const decision = this.deps.policy.checkHost({ hostId, kind: "admit" });
    if (!decision.ok) return { status: "refused", refusal: refusalFor(decision.reason) };
    if (!inboxBodyFits(payload.body)) return { status: "refused", refusal: "too_large" };

    const now = this.now();
    const counted = this.deps.store.countInContext(sender, payload.contextId);
    const hop = Math.max(payload.hopCount, counted + 1);
    if (hop > ASSISTANT_CONVERSATION_MAX_HOPS) return { status: "refused", refusal: "hop_limit" };

    const bucket = this.bucketFor(hostId, now);
    const wait = Math.max(bucket.waitFor(now), this.overall.waitFor(now));
    if (wait > 0) return { status: "rate_limited", retryAfterMs: wait };

    // Nobody here to take it now: the host's outbox holds it and offers it again.
    const recipient = this.deps.recipient(hostId, payload.sourceLane);
    if (recipient === null) return { status: "refused", refusal: "hub_unavailable" };

    const created = this.deps.store.create(sender, {
      messageId: payload.messageId,
      contextId: payload.contextId,
      referenceTaskIds: payload.referenceTaskIds,
      receiver: openReceiverFor(recipient),
      body: payload.body,
    });
    if (created.disposition !== "created") return this.snapshot(created.record);
    bucket.take(now);
    this.overall.take(now);

    const { record } = created;
    try {
      this.deps.runtime.admit(record, {
        body: payload.body,
        provenance: {
          sendingHost: this.deps.hostName(hostId),
          sendingLane: `slot ${payload.sourceLane.slot} of project ${payload.sourceLane.projectId}`,
          hopCount: hop,
        },
      });
    } catch (err) {
      console.warn("[AssistantHubReceiver] Couldn't hand a host's message to an assistant:", err);
      try {
        const rejected = this.deps.store.setState(
          { kind: "receiver", ...record.receiver },
          key,
          "rejected",
          "inbox-refused"
        );
        return this.snapshot(rejected, hop);
      } catch (stateErr) {
        console.warn("[AssistantHubReceiver] Couldn't record a refused message:", stateErr);
        return this.snapshot(record, hop);
      }
    }
    try {
      this.deps.wake?.(record, recipient);
    } catch (err) {
      // The message is in the recipient's inbox either way; only the announcement failed.
      console.warn("[AssistantHubReceiver] Waking the recipient failed:", err);
    }
    return this.snapshot(record, hop);
  }

  /** Where one of `hostId`'s messages stands, or null when this Shell has no record of it. */
  lookUp(hostId: HostId, messageId: string): HubExchange | null {
    const sender = hubSenderFor(hostId);
    const record = this.deps.store.get(sender, { senderId: sender.senderId, messageId });
    return record ? this.snapshot(record) : null;
  }

  dispose(): void {
    this.unsubscribe();
    this.perHost.clear();
  }

  /** `hop` is known only when this call admitted it; the host keeps the one it was told. */
  private snapshot(record: ExchangeRecord, hop?: number): HubExchange {
    const key = { senderId: record.senderId, messageId: record.messageId };
    const responses: InboxResponse[] = this.deps.runtime.getResponses(key);
    return {
      status: "accepted",
      taskId: record.taskId,
      state: record.state,
      ...(hop === undefined ? {} : { hopCount: hop }),
      responses: responses.slice(-MAX_EXCHANGE_RESPONSES),
    };
  }

  private responded(key: ExchangeKey): void {
    const hostId = hostOfSender(key.senderId);
    if (hostId === null) return;
    try {
      this.deps.tellHost?.(hostId, key.messageId);
    } catch (err) {
      console.warn("[AssistantHubReceiver] Telling a host of a reply failed:", err);
    }
  }

  private bucketFor(hostId: HostId, now: number): TokenBucket {
    let bucket = this.perHost.get(hostId);
    if (!bucket) {
      bucket = new TokenBucket(
        HUB_INBOUND_PER_HOST_PER_MINUTE,
        HUB_INBOUND_PER_HOST_PER_MINUTE / MINUTE_MS,
        now
      );
      this.perHost.set(hostId, bucket);
    }
    return bucket;
  }
}

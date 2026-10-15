import {
  ASSISTANT_CONVERSATION_MAX_HOPS,
  type AssistantSendRefusal,
} from "../../../shared/types/assistantMessaging.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import type { AssistantExchangeStore } from "../exchange/AssistantExchangeStore.js";
import { EXCHANGE_TTL_MS } from "../exchange/AssistantExchangeStore.js";
import type { ExchangeKey, ExchangeRecord, SenderActor } from "../exchange/types.js";
import { inboxBodyFits, type InboxResponse } from "./AssistantInbox.js";
import type {
  AssistantMessagingPolicy,
  LaneEnrollment,
  MessagingDenial,
} from "./AssistantMessagingPolicy.js";
import {
  exchangeReceiverFor,
  type AssistantMessagingRuntime,
} from "./AssistantMessagingRuntime.js";
import { MAX_EXCHANGE_RESPONSES, type HubExchange, type SendToHubPayload } from "./linkMethods.js";
import { TokenBucket } from "./tokenBucket.js";

const MINUTE_MS = 60_000;
/** Messages one host's assistants may start to the hub, and all hosts', per minute. */
export const HUB_INBOUND_PER_HOST_PER_MINUTE = 10;
export const HUB_INBOUND_PER_MINUTE = 30;
/** Conversations whose hops are remembered at once; the oldest is forgotten past this. */
const MAX_TRACKED_CONTEXTS = 4096;

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
  /** The host's display name, for the hub to read beside the message. */
  hostName(hostId: HostId): string;
  /** Tells the hub an admitted message is waiting; absent, it waits in the inbox unannounced. */
  wake?(record: ExchangeRecord, hub: LaneEnrollment): void;
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
 * The Shell's side of a host assistant starting a conversation with the hub
 * (#13338). A message is admitted only with the host's opt-in on, messaging
 * not paused and a hub enrolled and running, within the rate limits and the
 * conversation's hop limit; it then waits in the hub's inbox like any other,
 * and the hub's `assistant.reply` is read back by the host.
 *
 * The host is whichever one the connection belongs to, never anything the
 * payload says. Hops are counted here per host and contextId as well as
 * claimed by the host, and the higher wins, so a host that under-counts
 * gains nothing.
 */
export class AssistantHubReceiver {
  private readonly now: () => number;
  private readonly perHost = new Map<HostId, TokenBucket>();
  private readonly overall: TokenBucket;
  /** Highest hop admitted per host and contextId, and per exchange. */
  private readonly contextHops = new Map<string, { hop: number; expiresAt: number }>();
  private readonly exchangeHops = new Map<string, { hop: number; expiresAt: number }>();
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
    // A resend answers from what was admitted, whatever has changed since.
    const existing = this.deps.store.get(sender, key);
    if (existing) return this.snapshot(existing);

    const decision = this.deps.policy.checkHost({ hostId, kind: "admit" });
    if (!decision.ok) return { status: "refused", refusal: refusalFor(decision.reason) };
    const hub = decision.enrollment;
    if (!inboxBodyFits(payload.body)) return { status: "refused", refusal: "too_large" };

    const now = this.now();
    this.prune(now);
    const contextKey = `${hostId}\u0000${payload.contextId}`;
    const counted = this.contextHops.get(contextKey)?.hop ?? 0;
    const hop = Math.max(payload.hopCount, counted + 1);
    if (hop > ASSISTANT_CONVERSATION_MAX_HOPS) return { status: "refused", refusal: "hop_limit" };

    const bucket = this.bucketFor(hostId, now);
    const wait = Math.max(bucket.waitFor(now), this.overall.waitFor(now));
    if (wait > 0) return { status: "rate_limited", retryAfterMs: wait };

    const created = this.deps.store.create(sender, {
      messageId: payload.messageId,
      contextId: payload.contextId,
      referenceTaskIds: payload.referenceTaskIds,
      receiver: exchangeReceiverFor(hub),
      body: payload.body,
    });
    if (created.disposition !== "created") return this.snapshot(created.record);
    bucket.take(now);
    this.overall.take(now);
    const expiresAt = now + EXCHANGE_TTL_MS;
    this.remember(this.contextHops, contextKey, hop, expiresAt);
    this.remember(this.exchangeHops, `${key.senderId}\u0000${key.messageId}`, hop, expiresAt);

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
      console.warn("[AssistantHubReceiver] Couldn't hand a host's message to the hub:", err);
      try {
        const rejected = this.deps.store.setState(
          { kind: "receiver", ...record.receiver },
          key,
          "rejected",
          "inbox-refused"
        );
        return this.snapshot(rejected);
      } catch (stateErr) {
        console.warn("[AssistantHubReceiver] Couldn't record a refused message:", stateErr);
        return this.snapshot(record);
      }
    }
    try {
      this.deps.wake?.(record, hub);
    } catch (err) {
      // The message is in the hub's inbox either way; only the announcement failed.
      console.warn("[AssistantHubReceiver] Waking the hub failed:", err);
    }
    return this.snapshot(record);
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
    this.contextHops.clear();
    this.exchangeHops.clear();
  }

  private snapshot(record: ExchangeRecord): HubExchange {
    const key = { senderId: record.senderId, messageId: record.messageId };
    const responses: InboxResponse[] = this.deps.runtime.getResponses(key);
    const hop = this.exchangeHops.get(`${key.senderId}\u0000${key.messageId}`)?.hop;
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

  private remember(
    map: Map<string, { hop: number; expiresAt: number }>,
    key: string,
    hop: number,
    expiresAt: number
  ): void {
    const known = map.get(key)?.hop ?? 0;
    // Re-inserted, so the oldest key is always the least recently admitted.
    map.delete(key);
    map.set(key, { hop: Math.max(hop, known), expiresAt });
    while (map.size > MAX_TRACKED_CONTEXTS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private prune(now: number): void {
    for (const map of [this.contextHops, this.exchangeHops]) {
      for (const [key, entry] of map) if (entry.expiresAt <= now) map.delete(key);
    }
  }
}

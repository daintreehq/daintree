import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));

import { openDb } from "../../../services/persistence/db.js";
import type { RunningLaneSession } from "../../../services/HelpSessionService.js";
import { AssistantExchangeStore } from "../../exchange/AssistantExchangeStore.js";
import type { ExchangeRecord } from "../../exchange/types.js";
import {
  AssistantHubReceiver,
  HUB_INBOUND_PER_HOST_PER_MINUTE,
  hostOfSender,
} from "../AssistantHubReceiver.js";
import { AssistantInbox } from "../AssistantInbox.js";
import { AssistantMessagingPolicy, type LaneRef } from "../AssistantMessagingPolicy.js";
import { AssistantMessagingRuntime, openReceiverFor } from "../AssistantMessagingRuntime.js";
import type { SendToHubPayload } from "../linkMethods.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../services/persistence/migrations");

const HUB = { projectId: "hub-proj", slot: 0 };
const HUB_SESSION = "help-hub";

function payload(overrides: Partial<SendToHubPayload> = {}): SendToHubPayload {
  return {
    messageId: "m-1",
    contextId: "ctx-1",
    referenceTaskIds: [],
    sourceLane: { projectId: "proj-2", slot: 1 },
    hopCount: 1,
    body: "migration landed on feature/x",
    ...overrides,
  };
}

describe("AssistantHubReceiver", () => {
  let tmpDir: string;
  let sqlite: Database.Database;
  let clock: number;
  let optedIn: Set<string>;
  let running: Map<string, RunningLaneSession>;
  let store: AssistantExchangeStore;
  let policy: AssistantMessagingPolicy;
  let runtime: AssistantMessagingRuntime;
  let receiver: AssistantHubReceiver;
  let accepting: boolean;
  let woken: Array<{ record: ExchangeRecord; recipient: LaneRef }>;
  let told: Array<{ hostId: string; messageId: string }>;
  let recipientLane: LaneRef | null;
  let asked: Array<{ hostId: string; sourceLane: LaneRef }>;

  /** An assistant running here, taking messages from other machines: the recipient picked. */
  const startHub = (): void => {
    running.set(`${HUB.projectId}#${HUB.slot}`, {
      sessionId: HUB_SESSION,
      terminalId: "t-hub",
      projectViewWebContentsId: 1,
    });
    recipientLane = HUB;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-hub-receiver-"));
    sqlite = openDb(path.join(tmpDir, "exchange.db"), migrationsFolder).sqlite;
    clock = 1_000_000;
    optedIn = new Set(["host-a", "host-b"]);
    running = new Map();
    accepting = true;
    woken = [];
    told = [];
    recipientLane = null;
    asked = [];
    let generation = 0;
    store = new AssistantExchangeStore(sqlite, { now: () => clock });
    policy = new AssistantMessagingPolicy({
      getRunningLaneSession: (projectId, slot) => running.get(`${projectId}#${slot}`) ?? null,
      getLiveGeneration: () => 1,
      isHostMessagingEnabled: (hostId) => optedIn.has(hostId),
      acceptsRemoteMessages: () => accepting,
      onSessionEnded: () => () => {},
      platform: "darwin",
      now: () => clock,
      newGeneration: () => `gen-${++generation}`,
    });
    runtime = new AssistantMessagingRuntime({
      policy,
      store,
      inbox: new AssistantInbox({ now: () => clock }),
      getSessionLane: (sessionId) => (sessionId === HUB_SESSION ? HUB : null),
      hasHosts: () => true,
      now: () => clock,
    });
    receiver = new AssistantHubReceiver({
      policy,
      store,
      runtime,
      recipient: (hostId, sourceLane) => {
        asked.push({ hostId, sourceLane });
        return recipientLane;
      },
      hostName: (hostId) => (hostId === "host-a" ? "Studio 04" : "Other"),
      wake: (record, recipient) => woken.push({ record, recipient }),
      tellHost: (hostId, messageId) => told.push({ hostId, messageId }),
      now: () => clock,
    });
  });

  afterEach(() => {
    receiver.dispose();
    runtime.dispose();
    policy.dispose();
    if (sqlite.open) sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("files a host's message at the recipient's open address with its provenance, and wakes it", () => {
    startHub();
    const answer = receiver.receive("host-a", payload());
    expect(answer).toMatchObject({
      status: "accepted",
      state: "submitted",
      hopCount: 1,
      responses: [],
    });

    const inbox = runtime.getInbox(HUB_SESSION, {});
    if (!inbox.ok) throw new Error(inbox.code);
    expect(inbox.value.messages).toHaveLength(1);
    expect(inbox.value.messages[0]).toMatchObject({
      messageId: "m-1",
      contextId: "ctx-1",
      provenance: {
        sendingHost: "Studio 04",
        sendingLane: "slot 1 of project proj-2",
        hopCount: 1,
      },
    });
    expect(inbox.value.messages[0]!.untrustedBody).toContain("migration landed on feature/x");
    expect(woken).toHaveLength(1);
    expect(woken[0]!.recipient).toEqual(HUB);
    expect(woken[0]!.record.receiver).toEqual(openReceiverFor(HUB));
    expect(hostOfSender(woken[0]!.record.senderId)).toBe("host-a");
    // The recipient is picked for the lane the message came from, as the payload names it.
    expect(asked).toEqual([{ hostId: "host-a", sourceLane: { projectId: "proj-2", slot: 1 } }]);
  });

  it("answers a resend from its record without admitting or waking twice", () => {
    startHub();
    const first = receiver.receive("host-a", payload());
    if (first.status !== "accepted") throw new Error("not accepted");
    // Paused since: a resend still answers from what was admitted.
    policy.setPaused(true);
    const again = receiver.receive("host-a", payload());
    expect(again).toMatchObject({ status: "accepted", taskId: first.taskId, state: "submitted" });
    expect(woken).toHaveLength(1);
    policy.setPaused(false);
    // The same messageId from another host is another message.
    expect(receiver.receive("host-b", payload())).toMatchObject({ status: "accepted" });
    expect(woken).toHaveLength(2);
  });

  it("answers a resend from where it was filed, whoever would take it now", () => {
    startHub();
    const first = receiver.receive("host-a", payload());
    if (first.status !== "accepted") throw new Error("not accepted");
    const OTHER = { projectId: "other-proj", slot: 2 };
    recipientLane = OTHER;
    expect(receiver.receive("host-a", payload())).toMatchObject({
      status: "accepted",
      taskId: first.taskId,
    });
    recipientLane = null;
    expect(receiver.receive("host-a", payload())).toMatchObject({
      status: "accepted",
      taskId: first.taskId,
    });
    expect(asked).toHaveLength(1);
    expect(woken).toHaveLength(1);
    expect(receiver.lookUp("host-a", "m-1")).toMatchObject({ taskId: first.taskId });
    const inbox = runtime.getInbox(HUB_SESSION, {});
    expect(inbox.ok && inbox.value.messages.map((m) => m.taskId)).toEqual([first.taskId]);
  });

  it("refuses a messageId reused for different words, without touching the first", () => {
    startHub();
    receiver.receive("host-a", payload());
    expect(receiver.receive("host-a", payload({ body: "something else" }))).toEqual({
      status: "refused",
      refusal: "conflict",
    });
    const inbox = runtime.getInbox(HUB_SESSION, {});
    expect(inbox.ok && inbox.value.messages.map((m) => m.untrustedBody)).toEqual([
      expect.stringContaining("migration landed on feature/x"),
    ]);
  });

  it("keeps counting a conversation's hops across a Shell restart, from the records", () => {
    startHub();
    receiver.receive("host-a", payload({ messageId: "m-1" }));
    receiver.receive("host-a", payload({ messageId: "m-2" }));
    // A new receiver over the same records, as after a restart, holds nothing in memory.
    receiver.dispose();
    receiver = new AssistantHubReceiver({
      policy,
      store,
      runtime,
      recipient: () => recipientLane,
      hostName: () => "Studio 04",
      now: () => clock,
    });
    expect(receiver.receive("host-a", payload({ messageId: "m-3", hopCount: 1 }))).toEqual({
      status: "refused",
      refusal: "hop_limit",
    });
  });

  it("refuses without the host's opt-in, this machine's setting, a recipient, or while paused", () => {
    startHub();
    accepting = false;
    expect(receiver.receive("host-a", payload())).toEqual({ status: "refused", refusal: "no_hub" });
    accepting = true;
    optedIn.delete("host-a");
    expect(receiver.receive("host-a", payload())).toEqual({
      status: "refused",
      refusal: "opted_out",
    });
    optedIn.add("host-a");
    policy.setPaused(true);
    expect(receiver.receive("host-a", payload())).toEqual({ status: "refused", refusal: "paused" });
    policy.setPaused(false);
    // None of this Shell's assistants takes it now: nothing is filed for a later one.
    recipientLane = null;
    expect(receiver.receive("host-a", payload())).toEqual({
      status: "refused",
      refusal: "hub_unavailable",
    });
    expect(receiver.lookUp("host-a", "m-1")).toBeNull();
    expect(woken).toEqual([]);
    // Refused before a recipient is picked, the setting and opt-in never ask for one.
    expect(asked).toHaveLength(1);
  });

  it("refuses a body too large for the recipient to be handed whole", () => {
    startHub();
    expect(receiver.receive("host-a", payload({ body: "\u0001".repeat(15_000) }))).toEqual({
      status: "refused",
      refusal: "too_large",
    });
  });

  it("counts hops itself, so a host that claims fewer still hits the limit", () => {
    startHub();
    expect(receiver.receive("host-a", payload({ messageId: "m-1", hopCount: 1 }))).toMatchObject({
      hopCount: 1,
    });
    // The host under-claims; the Shell's own count wins.
    expect(receiver.receive("host-a", payload({ messageId: "m-2", hopCount: 1 }))).toMatchObject({
      hopCount: 2,
    });
    expect(receiver.receive("host-a", payload({ messageId: "m-3", hopCount: 1 }))).toEqual({
      status: "refused",
      refusal: "hop_limit",
    });
    // Another host's conversation of the same name is its own.
    expect(receiver.receive("host-b", payload({ messageId: "m-4" }))).toMatchObject({
      hopCount: 1,
    });
    // A claimed hop above the limit is refused outright.
    expect(
      receiver.receive("host-b", payload({ messageId: "m-5", contextId: "c-2", hopCount: 3 }))
    ).toEqual({ status: "refused", refusal: "hop_limit" });
  });

  it("rate-limits one host's messages and recovers as the bucket refills", () => {
    startHub();
    for (let i = 0; i < HUB_INBOUND_PER_HOST_PER_MINUTE; i++) {
      expect(
        receiver.receive("host-a", payload({ messageId: `m-${i}`, contextId: `c-${i}` })).status
      ).toBe("accepted");
    }
    const limited = receiver.receive("host-a", payload({ messageId: "late", contextId: "late" }));
    expect(limited.status).toBe("rate_limited");
    if (limited.status !== "rate_limited") throw new Error("not limited");
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    // Refused, not recorded: the same message is admitted once it may be.
    clock += limited.retryAfterMs;
    expect(
      receiver.receive("host-a", payload({ messageId: "late", contextId: "late" })).status
    ).toBe("accepted");
  });

  it("hands the recipient's replies back, and tells the host each time it answers", () => {
    startHub();
    receiver.receive("host-a", payload());
    const [message] = (
      runtime.getInbox(HUB_SESSION, {}) as {
        ok: true;
        value: { messages: Array<{ taskId: string }> };
      }
    ).value.messages;

    expect(
      runtime.reply(HUB_SESSION, {
        taskId: message!.taskId,
        state: "input-required",
        text: "which schema?",
      }).ok
    ).toBe(true);
    expect(
      runtime.reply(HUB_SESSION, {
        taskId: message!.taskId,
        state: "input-required",
        text: "v2 or v3?",
      }).ok
    ).toBe(true);
    // A repeated question doesn't move the exchange's state, but it is still news.
    expect(told).toEqual([
      { hostId: "host-a", messageId: "m-1" },
      { hostId: "host-a", messageId: "m-1" },
    ]);
    expect(receiver.lookUp("host-a", "m-1")).toMatchObject({
      status: "accepted",
      state: "input-required",
      responses: [
        { state: "input-required", text: "which schema?" },
        { state: "input-required", text: "v2 or v3?" },
      ],
    });
    // Another host can't read it.
    expect(receiver.lookUp("host-b", "m-1")).toBeNull();
  });
});

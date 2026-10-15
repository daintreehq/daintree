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
import { AssistantMessagingPolicy, type LaneEnrollment } from "../AssistantMessagingPolicy.js";
import { AssistantMessagingRuntime } from "../AssistantMessagingRuntime.js";
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
  let woken: Array<{ record: ExchangeRecord; hub: LaneEnrollment }>;
  let told: Array<{ hostId: string; messageId: string }>;

  const enrollHub = (): LaneEnrollment => {
    running.set(`${HUB.projectId}#${HUB.slot}`, {
      sessionId: HUB_SESSION,
      terminalId: "t-hub",
      projectViewWebContentsId: 1,
    });
    const result = policy.enroll(HUB, { kind: "local" });
    if (!result.ok) throw new Error(result.reason);
    return result.enrollment;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-hub-receiver-"));
    sqlite = openDb(path.join(tmpDir, "exchange.db"), migrationsFolder).sqlite;
    clock = 1_000_000;
    optedIn = new Set(["host-a", "host-b"]);
    running = new Map();
    woken = [];
    told = [];
    let generation = 0;
    store = new AssistantExchangeStore(sqlite, { now: () => clock });
    policy = new AssistantMessagingPolicy({
      getRunningLaneSession: (projectId, slot) => running.get(`${projectId}#${slot}`) ?? null,
      getLiveGeneration: () => 1,
      isHostMessagingEnabled: (hostId) => optedIn.has(hostId),
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
      now: () => clock,
    });
    receiver = new AssistantHubReceiver({
      policy,
      store,
      runtime,
      hostName: (hostId) => (hostId === "host-a" ? "Studio 04" : "Other"),
      wake: (record, hub) => woken.push({ record, hub }),
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

  it("puts a host's message in the hub's inbox with its provenance, and wakes the hub", () => {
    const hub = enrollHub();
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
    expect(woken[0]!.hub.generation).toBe(hub.generation);
    expect(hostOfSender(woken[0]!.record.senderId)).toBe("host-a");
  });

  it("answers a resend from its record without admitting or waking twice", () => {
    enrollHub();
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

  it("refuses a messageId reused for different words, without touching the first", () => {
    enrollHub();
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
    enrollHub();
    receiver.receive("host-a", payload({ messageId: "m-1" }));
    receiver.receive("host-a", payload({ messageId: "m-2" }));
    // A new receiver over the same records, as after a restart, holds nothing in memory.
    receiver.dispose();
    receiver = new AssistantHubReceiver({
      policy,
      store,
      runtime,
      hostName: () => "Studio 04",
      now: () => clock,
    });
    expect(receiver.receive("host-a", payload({ messageId: "m-3", hopCount: 1 }))).toEqual({
      status: "refused",
      refusal: "hop_limit",
    });
  });

  it("refuses without the host's opt-in, a hub, or while paused", () => {
    expect(receiver.receive("host-a", payload())).toEqual({ status: "refused", refusal: "no_hub" });
    enrollHub();
    optedIn.delete("host-a");
    expect(receiver.receive("host-a", payload())).toEqual({
      status: "refused",
      refusal: "opted_out",
    });
    optedIn.add("host-a");
    policy.setPaused(true);
    expect(receiver.receive("host-a", payload())).toEqual({ status: "refused", refusal: "paused" });
    policy.setPaused(false);
    running.clear();
    expect(receiver.receive("host-a", payload())).toEqual({
      status: "refused",
      refusal: "hub_unavailable",
    });
    expect(woken).toEqual([]);
  });

  it("refuses a body too large for the hub to be handed whole", () => {
    enrollHub();
    expect(receiver.receive("host-a", payload({ body: "\u0001".repeat(15_000) }))).toEqual({
      status: "refused",
      refusal: "too_large",
    });
  });

  it("counts hops itself, so a host that claims fewer still hits the limit", () => {
    enrollHub();
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
    enrollHub();
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

  it("hands the hub's replies back, and tells the host each time it answers", () => {
    enrollHub();
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

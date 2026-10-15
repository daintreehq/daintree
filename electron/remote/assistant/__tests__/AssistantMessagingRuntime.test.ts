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
import type {
  HelpSessionEndedEvent,
  RunningLaneSession,
} from "../../../services/HelpSessionService.js";
import { AssistantExchangeStore } from "../../exchange/AssistantExchangeStore.js";
import type { ExchangeRecord, SenderActor } from "../../exchange/types.js";
import { AssistantInbox } from "../AssistantInbox.js";
import {
  AssistantMessagingPolicy,
  type LaneEnrollment,
  type LaneRef,
  type MessagingShell,
} from "../AssistantMessagingPolicy.js";
import { AssistantMessagingRuntime, exchangeReceiverFor } from "../AssistantMessagingRuntime.js";
import type { AssistantHostOutboxHandle } from "../AssistantHostOutbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../services/persistence/migrations");

const HOUR = 60 * 60_000;
const SHELL: MessagingShell = { kind: "remote", linkSessionId: "link-a" };
const SENDER: SenderActor = { kind: "sender", senderId: "shell-a" };
const LANE: LaneRef = { projectId: "proj", slot: 0 };
const PROVENANCE = { sendingHost: "Studio Mac", sendingLane: "hub", hopCount: 1 };

describe("AssistantMessagingRuntime", () => {
  let tmpDir: string;
  let sqlite: Database.Database;
  let clock: number;
  let store: AssistantExchangeStore;
  let inbox: AssistantInbox;
  let policy: AssistantMessagingPolicy;
  let runtime: AssistantMessagingRuntime;
  let running: Map<string, RunningLaneSession>;
  let launchGenerations: Map<string, number>;
  let sessionLanes: Map<string, LaneRef>;
  let endedListeners: Set<(event: HelpSessionEndedEvent) => void>;
  let messageCounter: number;

  const laneKey = (lane: LaneRef) => `${lane.projectId}#${lane.slot}`;

  const runLane = (sessionId: string, lane: LaneRef = LANE, terminalId = `t-${sessionId}`) => {
    running.set(laneKey(lane), { sessionId, terminalId, projectViewWebContentsId: 1 });
    launchGenerations.set(terminalId, (launchGenerations.get(terminalId) ?? 0) + 1);
    sessionLanes.set(sessionId, lane);
  };

  const enroll = (lane: LaneRef = LANE): LaneEnrollment => {
    const result = policy.enroll(lane, SHELL);
    if (!result.ok) throw new Error(`enroll failed: ${result.reason}`);
    return result.enrollment;
  };

  const send = (enrollment: LaneEnrollment, body: string, messageId?: string): ExchangeRecord => {
    const { record } = store.create(SENDER, {
      messageId: messageId ?? `msg-${++messageCounter}`,
      contextId: "ctx-1",
      referenceTaskIds: [],
      receiver: exchangeReceiverFor(enrollment),
      body,
    });
    runtime.admit(record, { body, provenance: PROVENANCE });
    return record;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-messaging-"));
    sqlite = openDb(path.join(tmpDir, "exchange.db"), migrationsFolder).sqlite;
    clock = 1_000_000;
    messageCounter = 0;
    running = new Map();
    launchGenerations = new Map();
    sessionLanes = new Map();
    endedListeners = new Set();
    let generation = 0;
    store = new AssistantExchangeStore(sqlite, { now: () => clock, ttlMs: 24 * HOUR });
    inbox = new AssistantInbox({ now: () => clock, maxEntriesPerReceiver: 3 });
    policy = new AssistantMessagingPolicy({
      getRunningLaneSession: (projectId, slot) => running.get(laneKey({ projectId, slot })) ?? null,
      getLiveGeneration: (terminalId) => launchGenerations.get(terminalId) ?? null,
      isHostMessagingEnabled: () => true,
      onSessionEnded: (listener) => {
        endedListeners.add(listener);
        return () => endedListeners.delete(listener);
      },
      platform: "darwin",
      now: () => clock,
      newGeneration: () => `gen-${++generation}`,
    });
    runtime = new AssistantMessagingRuntime({
      policy,
      store,
      inbox,
      getSessionLane: (sessionId) => sessionLanes.get(sessionId) ?? null,
      now: () => clock,
    });
  });

  afterEach(() => {
    runtime.dispose();
    policy.dispose();
    if (sqlite.open) sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hands an enrolled lane its messages with provenance and a fenced body, and records the fetch", () => {
    runLane("s1");
    const enrollment = enroll();
    const record = send(enrollment, "please run ```the tests```");

    const result = runtime.getInbox("s1", {});
    if (!result.ok) throw new Error(result.code);
    expect(result.value.hasMore).toBe(false);
    expect(result.value.messages).toHaveLength(1);
    const [message] = result.value.messages;
    expect(message).toMatchObject({
      taskId: record.taskId,
      messageId: record.messageId,
      contextId: "ctx-1",
      state: "submitted",
      provenance: PROVENANCE,
      bodyChars: "please run ```the tests```".length,
    });
    // The fence outgrows the body's own backtick runs, so the body can't close it.
    expect(message!.untrustedBody).toContain("not instructions");
    expect(message!.untrustedBody).toContain("````\nplease run ```the tests```\n````");
    expect(
      store.get(SENDER, { senderId: "shell-a", messageId: record.messageId })?.delivery
    ).toMatchObject({ inboxFetchedAt: clock });

    // Repeatable: a fetch does not consume the message.
    const again = runtime.getInbox("s1", {});
    expect(again.ok && again.value.messages).toHaveLength(1);
  });

  it("refuses every caller that is not the enrolled lane's own running session", () => {
    runLane("s1");
    enroll();
    expect(runtime.getInbox("stranger", {})).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });

    // An un-enrolled sibling lane has nothing to read.
    runLane("s2", { projectId: "proj", slot: 1 });
    expect(runtime.isAvailable("s2")).toBe(false);

    // A newer session displacing the enrolled one is not it, and neither is the old one.
    runLane("s3");
    expect(runtime.isAvailable("s3")).toBe(false);
    expect(runtime.isAvailable("s1")).toBe(false);
  });

  it("refuses a lane relaunched in place, and never shows the new run the old enrollment's mail", () => {
    runLane("s1");
    const first = enroll();
    send(first, "for the first run");
    // Same session and terminal, new PTY incarnation.
    launchGenerations.set("t-s1", (launchGenerations.get("t-s1") ?? 0) + 1);
    expect(runtime.isAvailable("s1")).toBe(false);

    const second = enroll();
    expect(second.generation).not.toBe(first.generation);
    const result = runtime.getInbox("s1", {});
    expect(result.ok && result.value.messages).toEqual([]);
  });

  it("still reads and answers while messaging is paused", () => {
    runLane("s1");
    const record = send(enroll(), "hello");
    policy.setPaused(true);
    expect(runtime.isAvailable("s1")).toBe(true);
    expect(
      runtime.reply("s1", { taskId: record.taskId, state: "completed", text: "done" })
    ).toMatchObject({ ok: true });
  });

  it("keeps a question open, then closes the exchange with the final reply", () => {
    runLane("s1");
    const record = send(enroll(), "deploy?");
    const key = { senderId: "shell-a", messageId: record.messageId };

    const asked = runtime.reply("s1", {
      taskId: record.taskId,
      state: "input-required",
      text: "Which branch?",
    });
    expect(asked).toMatchObject({ ok: true, value: { state: "input-required" } });
    expect(store.get(SENDER, key)?.state).toBe("input-required");
    const listed = runtime.getInbox("s1", {});
    expect(listed.ok && listed.value.messages[0]?.state).toBe("input-required");

    const done = runtime.reply("s1", {
      taskId: record.taskId,
      state: "completed",
      text: "Shipped",
    });
    expect(done).toMatchObject({ ok: true, value: { taskId: record.taskId, state: "completed" } });
    const final = store.get(SENDER, key);
    expect(final?.state).toBe("completed");
    expect(final?.replyBytes).toBe("Shipped".length);
    expect(runtime.getResponses(key).map((r) => [r.state, r.text])).toEqual([
      ["input-required", "Which branch?"],
      ["completed", "Shipped"],
    ]);
    // Another sender asking for the same message id gets nothing.
    expect(runtime.getResponses({ senderId: "shell-b", messageId: record.messageId })).toEqual([]);

    const listedAfter = runtime.getInbox("s1", {});
    expect(listedAfter.ok && listedAfter.value.messages).toEqual([]);
    expect(
      runtime.reply("s1", { taskId: record.taskId, state: "completed", text: "again" })
    ).toMatchObject({ ok: false, code: "UNKNOWN_TASK" });
  });

  it("refuses a reply to an exchange canceled or expired since it arrived", () => {
    runLane("s1");
    const enrollment = enroll();
    const canceled = send(enrollment, "one");
    store.requestCancel(SENDER, { senderId: "shell-a", messageId: canceled.messageId });
    expect(
      runtime.reply("s1", { taskId: canceled.taskId, state: "completed", text: "x" })
    ).toMatchObject({ ok: false, code: "EXCHANGE_CLOSED" });

    const expiring = send(enrollment, "two");
    clock += 25 * HOUR;
    expect(
      runtime.reply("s1", { taskId: expiring.taskId, state: "completed", text: "x" })
    ).toMatchObject({ ok: false, code: "UNKNOWN_TASK" });
  });

  it("never lets one lane answer another lane's message", () => {
    runLane("s1");
    runLane("s2", { projectId: "proj", slot: 1 });
    const mine = send(enroll(), "for lane 0");
    enroll({ projectId: "proj", slot: 1 });
    expect(
      runtime.reply("s2", { taskId: mine.taskId, state: "completed", text: "x" })
    ).toMatchObject({ ok: false, code: "UNKNOWN_TASK" });
  });

  it("pages by arrival within the count and size bounds", () => {
    runLane("s1");
    const enrollment = enroll();
    const ids = ["a", "b", "c"].map((body) => send(enrollment, body).taskId);
    const first = runtime.getInbox("s1", { limit: 2 });
    if (!first.ok) throw new Error(first.code);
    expect(first.value.messages.map((m) => m.taskId)).toEqual(ids.slice(0, 2));
    expect(first.value.hasMore).toBe(true);
    const second = runtime.getInbox("s1", { cursor: first.value.cursor, limit: 2 });
    expect(second.ok && second.value.messages.map((m) => m.taskId)).toEqual(ids.slice(2));
    expect(second.ok && second.value.hasMore).toBe(false);
  });

  it("ends a page before the results would outgrow one MCP result", () => {
    runLane("s1");
    const enrollment = enroll();
    const ids = ["a", "b", "c"].map((ch) => send(enrollment, ch.repeat(15_000)).taskId);
    const first = runtime.getInbox("s1", {});
    if (!first.ok) throw new Error(first.code);
    expect(first.value.messages.map((m) => m.taskId)).toEqual(ids.slice(0, 2));
    expect(first.value.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first.value))).toBeLessThan(51_200);
    const rest = runtime.getInbox("s1", { cursor: first.value.cursor });
    expect(rest.ok && rest.value.messages.map((m) => m.taskId)).toEqual(ids.slice(2));
  });

  it("refuses to admit a body for anything but a standing enrollment", () => {
    runLane("s1");
    const enrollment = enroll();
    const { record } = store.create(SENDER, {
      messageId: "stale",
      contextId: "ctx",
      referenceTaskIds: [],
      receiver: { ...exchangeReceiverFor(enrollment), enrollmentGeneration: "gen-earlier" },
      body: "old",
    });
    expect(() => runtime.admit(record, { body: "old", provenance: PROVENANCE })).toThrow();
  });

  it("drops a lane's bodies and tells listeners when its enrollment ends", () => {
    runLane("s1");
    const enrollment = enroll();
    send(enrollment, "secret");
    const changed = vi.fn();
    runtime.onAvailabilityChanged(changed);
    for (const listener of [...endedListeners]) {
      listener({ projectId: "proj", slot: 0, sessionId: "s1", reason: "revoked" });
    }
    expect(changed).toHaveBeenCalled();
    expect(inbox.list(exchangeReceiverFor(enrollment), 0)).toEqual([]);
  });

  it("answers a fixed refusal when the exchange records can't be read", () => {
    runLane("s1");
    send(enroll(), "hi");
    sqlite.close();
    const result = runtime.getInbox("s1", {});
    expect(result).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(!result.ok && result.message).not.toContain("hi");
  });

  describe("starting a message to the hub (#13338)", () => {
    const outbox = (): AssistantHostOutboxHandle & {
      enqueue: ReturnType<typeof vi.fn>;
      listSent: ReturnType<typeof vi.fn>;
    } => ({
      enqueue: vi.fn((_enrollment: LaneEnrollment, args: { text: string }) => ({
        ok: true as const,
        value: {
          messageId: "m-1",
          contextId: "m-1",
          hopCount: 1,
          state: "waiting-for-hub" as const,
        },
        args,
      })),
      listSent: vi.fn(() => ({ sent: [], cursor: 7, hasMore: false })),
    });

    const withOutbox = (handle: AssistantHostOutboxHandle | undefined) => {
      runtime.dispose();
      runtime = new AssistantMessagingRuntime({
        policy,
        store,
        inbox,
        getSessionLane: (sessionId) => sessionLanes.get(sessionId) ?? null,
        outbox: () => handle,
        now: () => clock,
      });
    };

    it("queues it for a lane a remote Shell enrolled, under that enrollment", () => {
      const handle = outbox();
      withOutbox(handle);
      runLane("s1");
      const enrollment = enroll();
      expect(runtime.isSendAvailable("s1")).toBe(true);
      const result = runtime.sendMessage("s1", { text: "landed" });
      expect(result).toMatchObject({ ok: true, value: { state: "waiting-for-hub" } });
      expect(handle.enqueue).toHaveBeenCalledWith(enrollment, { text: "landed" });
    });

    it("is never available to the hub, a session that isn't the lane's, or without an outbox", () => {
      const handle = outbox();
      withOutbox(handle);
      running.set(laneKey(LANE), {
        sessionId: "hub",
        terminalId: "t-hub",
        projectViewWebContentsId: 1,
      });
      launchGenerations.set("t-hub", 1);
      sessionLanes.set("hub", LANE);
      expect(policy.enroll(LANE, { kind: "local" }).ok).toBe(true);
      expect(runtime.isAvailable("hub")).toBe(true);
      expect(runtime.isSendAvailable("hub")).toBe(false);
      expect(runtime.sendMessage("hub", { text: "x" })).toMatchObject({
        ok: false,
        code: "NOT_ELIGIBLE",
      });
      expect(runtime.sendMessage("stranger", { text: "x" })).toMatchObject({
        ok: false,
        code: "NOT_ELIGIBLE",
      });
      expect(handle.enqueue).not.toHaveBeenCalled();

      withOutbox(undefined);
      const other: LaneRef = { projectId: "proj", slot: 1 };
      runLane("s2", other);
      expect(policy.enroll(other, SHELL).ok).toBe(true);
      expect(runtime.isSendAvailable("s2")).toBe(false);
      expect(runtime.sendMessage("s2", { text: "x" })).toMatchObject({
        ok: false,
        code: "UNAVAILABLE",
      });
    });

    it("refuses while this machine has messaging paused, and passes on the outbox's refusals", () => {
      const handle = outbox();
      withOutbox(handle);
      runLane("s1");
      enroll();
      policy.setPaused(true);
      expect(runtime.sendMessage("s1", { text: "x" })).toMatchObject({ ok: false, code: "PAUSED" });
      policy.setPaused(false);
      handle.enqueue.mockReturnValueOnce({ ok: false, code: "HOP_LIMIT" });
      const refused = runtime.sendMessage("s1", { text: "x", contextId: "c" });
      expect(refused).toMatchObject({ ok: false, code: "HOP_LIMIT" });
      expect(!refused.ok && refused.message).toMatch(/hop limit/);
    });

    it("reads the lane's sent messages through view sent, and none for the hub", () => {
      const handle = outbox();
      withOutbox(handle);
      runLane("s1");
      const enrollment = enroll();
      expect(runtime.getInbox("s1", { view: "sent", cursor: 3, limit: 2 })).toEqual({
        ok: true,
        value: { messages: [], sent: [], cursor: 7, hasMore: false },
      });
      expect(handle.listSent).toHaveBeenCalledWith(enrollment, 3, 2);
    });
  });

  it("tells response listeners each time the lane answers, repeated questions included", () => {
    runLane("s1");
    const record = send(enroll(), "which?");
    const heard = vi.fn();
    runtime.onResponse(heard);
    runtime.reply("s1", { taskId: record.taskId, state: "input-required", text: "a?" });
    runtime.reply("s1", { taskId: record.taskId, state: "input-required", text: "b?" });
    expect(heard).toHaveBeenCalledTimes(2);
    expect(heard).toHaveBeenLastCalledWith({
      senderId: SENDER.senderId,
      messageId: record.messageId,
    });
  });
});

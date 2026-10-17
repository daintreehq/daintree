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
import {
  AssistantMessagingRuntime,
  exchangeReceiverFor,
  openReceiverFor,
} from "../AssistantMessagingRuntime.js";
import type { AssistantHostOutboxHandle } from "../AssistantHostOutbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../services/persistence/migrations");

const HOUR = 60 * 60_000;
const SHELL: MessagingShell = { kind: "remote", linkSessionId: "link-a" };
const SENDER: SenderActor = { kind: "sender", senderId: "shell-a" };
const LANE: LaneRef = { projectId: "proj", slot: 0 };
const PROVENANCE = { sendingHost: "Studio Mac", sendingLane: "hub", hopCount: 1 };
/** This machine listening as a host: what makes its lanes open to other machines. */
const LISTENING: AssistantHostOutboxHandle = {
  enqueue: () => ({ ok: false, code: "NOT_ELIGIBLE" }),
  listSent: () => ({ sent: [], cursor: 0, hasMore: false }),
};

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

  /** A remote Shell's message to a lane, filed under its open address as the host's link call files it. */
  const send = (
    lane: LaneRef,
    body: string,
    messageId?: string,
    sender: SenderActor = SENDER
  ): ExchangeRecord => {
    const { record } = store.create(sender, {
      messageId: messageId ?? `msg-${++messageCounter}`,
      contextId: "ctx-1",
      referenceTaskIds: [],
      receiver: openReceiverFor(lane),
      body,
    });
    runtime.admit(record, { body, provenance: PROVENANCE });
    return record;
  };

  const newRuntime = (
    deps: Partial<ConstructorParameters<typeof AssistantMessagingRuntime>[0]> = {}
  ) => {
    runtime.dispose();
    runtime = new AssistantMessagingRuntime({
      policy,
      store,
      inbox,
      getSessionLane: (sessionId) => sessionLanes.get(sessionId) ?? null,
      outbox: () => LISTENING,
      now: () => clock,
      ...deps,
    });
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
      acceptsRemoteMessages: () => true,
      platform: "darwin",
      now: () => clock,
      newGeneration: () => `gen-${++generation}`,
    });
    runtime = new AssistantMessagingRuntime({
      policy,
      store,
      inbox,
      getSessionLane: (sessionId) => sessionLanes.get(sessionId) ?? null,
      outbox: () => LISTENING,
      now: () => clock,
    });
  });

  afterEach(() => {
    runtime.dispose();
    policy.dispose();
    if (sqlite.open) sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wakes a lane again for what it still owes an answer once it has its tools back (#13392)", () => {
    const rewake = vi.fn();
    newRuntime({ rewake });
    runLane("s1");
    const read = send(LANE, "build it");
    const answered = send(LANE, "list the panes");
    const asked = send(LANE, "deploy it");
    runtime.getInbox("s1", {});
    runtime.reply("s1", { taskId: answered.taskId, state: "completed", text: "two panes" });
    runtime.reply("s1", {
      taskId: asked.taskId,
      state: "input-required",
      text: "staging or prod?",
    });
    const unread = send(LANE, "and the docs");

    expect(runtime.reannounce(LANE)).toBe(2);
    expect(rewake.mock.calls.map(([, record]) => (record as ExchangeRecord).taskId)).toEqual([
      read.taskId,
      unread.taskId,
    ]);
    expect(rewake.mock.calls[0]![0]).toEqual(LANE);
    // A queued re-wake asks again before typing: once answered, it's no longer owed.
    const stillOwed = rewake.mock.calls[0]![2] as () => boolean;
    expect(stillOwed()).toBe(true);
    runtime.reply("s1", { taskId: read.taskId, state: "completed", text: "built" });
    expect(stillOwed()).toBe(false);
    // A running lane nobody sent anything has nothing owed; one not running yet can't be woken yet.
    runLane("s-other", { projectId: "proj", slot: 1 });
    expect(runtime.reannounce({ projectId: "proj", slot: 1 })).toBe(0);
    expect(runtime.reannounce({ projectId: "elsewhere", slot: 0 })).toBeNull();
    // Nothing can be woken while paused: still owed, so it says not yet rather than none.
    rewake.mockClear();
    policy.setPaused(true);
    expect(runtime.reannounce(LANE)).toBeNull();
    expect(rewake).not.toHaveBeenCalled();
  });

  it("moves an exchange its lane has read to working", () => {
    runLane("s1");
    const record = send(LANE, "run the tests");
    expect(
      store.get(SENDER, { senderId: SENDER.senderId, messageId: record.messageId })?.state
    ).toBe("submitted");
    runtime.getInbox("s1", {});
    expect(
      store.get(SENDER, { senderId: SENDER.senderId, messageId: record.messageId })?.state
    ).toBe("working");
  });

  const sendReferencing = (
    lane: LaneRef,
    body: string,
    referenceTaskIds: string[]
  ): ExchangeRecord => {
    const { record } = store.create(SENDER, {
      messageId: `msg-${++messageCounter}`,
      contextId: "ctx-1",
      referenceTaskIds,
      receiver: openReceiverFor(lane),
      body,
    });
    runtime.admit(record, { body, provenance: PROVENANCE });
    return record;
  };

  it("closes the question a completed follow-up names, with the follow-up's reply", () => {
    runLane("s1");
    const asking = send(LANE, "deploy it");
    runtime.getInbox("s1", {});
    expect(
      runtime.reply("s1", {
        taskId: asking.taskId,
        state: "input-required",
        text: "staging or prod?",
      })
    ).toMatchObject({ ok: true });
    const answer = sendReferencing(LANE, "staging", [asking.messageId]);
    expect(
      runtime.reply("s1", {
        taskId: answer.taskId,
        state: "completed",
        text: "deployed to staging",
      })
    ).toMatchObject({ ok: true });
    const asked = store.get(SENDER, { senderId: SENDER.senderId, messageId: asking.messageId });
    expect(asked?.state).toBe("completed");
    expect(asked?.delivery.replyReceivedAt).not.toBeNull();
    expect(
      runtime.getResponses({ senderId: SENDER.senderId, messageId: asking.messageId })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "completed", text: "deployed to staging" }),
      ])
    );
  });

  it("closes nothing for a message that only shares the conversation, queued before or after", () => {
    runLane("s1");
    const asking = send(LANE, "deploy it");
    const queued = send(LANE, "and update the changelog");
    runtime.getInbox("s1", {});
    runtime.reply("s1", {
      taskId: asking.taskId,
      state: "input-required",
      text: "staging or prod?",
    });
    runtime.reply("s1", { taskId: queued.taskId, state: "completed", text: "changelog updated" });
    const later = send(LANE, "also bump the version");
    runtime.reply("s1", { taskId: later.taskId, state: "completed", text: "bumped" });
    expect(
      store.get(SENDER, { senderId: SENDER.senderId, messageId: asking.messageId })?.state
    ).toBe("input-required");
  });

  it("leaves a question in another conversation open", () => {
    runLane("s1");
    const { record: other } = store.create(SENDER, {
      messageId: "msg-other",
      contextId: "ctx-2",
      referenceTaskIds: [],
      receiver: openReceiverFor(LANE),
      body: "different thing",
    });
    runtime.admit(other, { body: "different thing", provenance: PROVENANCE });
    runtime.getInbox("s1", {});
    runtime.reply("s1", { taskId: other.taskId, state: "input-required", text: "which?" });
    const answer = send(LANE, "unrelated");
    runtime.reply("s1", { taskId: answer.taskId, state: "completed", text: "done" });
    expect(store.get(SENDER, { senderId: SENDER.senderId, messageId: "msg-other" })?.state).toBe(
      "input-required"
    );
  });

  it("hands a lane its messages with provenance and a fenced body, and records the fetch", () => {
    runLane("s1");
    const record = send(LANE, "please run ```the tests```");

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

  it("refuses every caller that is not a lane's own running session", () => {
    runLane("s1");
    expect(runtime.getInbox("stranger", {})).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });

    // Every running lane has an inbox of its own, with nobody enrolling it (#13467).
    runLane("s2", { projectId: "proj", slot: 1 });
    expect(runtime.isAvailable("s2")).toBe(true);

    // A newer session in the same lane is its caller now; the one it displaced isn't.
    runLane("s3");
    expect(runtime.isAvailable("s3")).toBe(true);
    expect(runtime.isAvailable("s1")).toBe(false);
  });

  it("hands what was sent to a lane's run to the run that replaces it, never to the one replaced (#13467)", () => {
    runLane("s1");
    const record = send(LANE, "for whichever run is there");
    // Same session and terminal, new PTY incarnation: still the lane's caller, with its mail.
    launchGenerations.set("t-s1", (launchGenerations.get("t-s1") ?? 0) + 1);
    const relaunched = runtime.getInbox("s1", {});
    expect(relaunched.ok && relaunched.value.messages.map((m) => m.taskId)).toEqual([
      record.taskId,
    ]);

    // A new session takes the lane over: it reads and answers the message, the old one can't.
    runLane("s2");
    expect(runtime.getInbox("s1", {})).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    expect(
      runtime.reply("s2", { taskId: record.taskId, state: "completed", text: "done" })
    ).toMatchObject({ ok: true });
  });

  it("keeps two Shells' messages to one lane apart, each answered to its own sender", () => {
    runLane("s1");
    const other: SenderActor = { kind: "sender", senderId: "shell-b" };
    const fromA = send(LANE, "from a", "same-id");
    const fromB = send(LANE, "from b", "same-id", other);
    const listed = runtime.getInbox("s1", {});
    expect(listed.ok && listed.value.messages.map((m) => m.taskId)).toEqual([
      fromA.taskId,
      fromB.taskId,
    ]);
    runtime.reply("s1", { taskId: fromB.taskId, state: "completed", text: "for b" });
    expect(store.get(other, { senderId: "shell-b", messageId: "same-id" })?.state).toBe(
      "completed"
    );
    expect(store.get(SENDER, { senderId: "shell-a", messageId: "same-id" })?.state).toBe("working");
    expect(runtime.getResponses({ senderId: "shell-a", messageId: "same-id" })).toEqual([]);
  });

  it("gives this machine's hub both its own messages and other machines', on one cursor", () => {
    runLane("s1");
    const hub = policy.enroll(LANE, { kind: "local" });
    if (!hub.ok) throw new Error(hub.reason);
    const remote = send(LANE, "from another Shell");
    const { record: fromHost } = store.create(
      { kind: "sender", senderId: "host-x" },
      {
        messageId: "from-host",
        contextId: "ctx-h",
        referenceTaskIds: [],
        receiver: exchangeReceiverFor(hub.enrollment),
        body: "from a host's lane",
      }
    );
    runtime.admit(fromHost, { body: "from a host's lane", provenance: PROVENANCE });
    const first = runtime.getInbox("s1", { limit: 1 });
    if (!first.ok) throw new Error(first.code);
    expect(first.value.messages.map((m) => m.taskId)).toEqual([remote.taskId]);
    const rest = runtime.getInbox("s1", { cursor: first.value.cursor });
    expect(rest.ok && rest.value.messages.map((m) => m.taskId)).toEqual([fromHost.taskId]);
    expect(
      runtime.reply("s1", { taskId: fromHost.taskId, state: "completed", text: "ok" })
    ).toMatchObject({ ok: true });
    // Answering the hub's message left its enrollment as it was.
    expect(policy.getHub()?.generation).toBe(hub.enrollment.generation);
  });

  it("still reads and answers while messaging is paused", () => {
    runLane("s1");
    const record = send(LANE, "hello");
    policy.setPaused(true);
    expect(runtime.isAvailable("s1")).toBe(true);
    expect(
      runtime.reply("s1", { taskId: record.taskId, state: "completed", text: "done" })
    ).toMatchObject({ ok: true });
  });

  it("keeps a question open, then closes the exchange with the final reply", () => {
    runLane("s1");
    const record = send(LANE, "deploy?");
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
    const canceled = send(LANE, "one");
    store.requestCancel(SENDER, { senderId: "shell-a", messageId: canceled.messageId });
    expect(
      runtime.reply("s1", { taskId: canceled.taskId, state: "completed", text: "x" })
    ).toMatchObject({ ok: false, code: "EXCHANGE_CLOSED" });

    const expiring = send(LANE, "two");
    clock += 25 * HOUR;
    expect(
      runtime.reply("s1", { taskId: expiring.taskId, state: "completed", text: "x" })
    ).toMatchObject({ ok: false, code: "UNKNOWN_TASK" });
  });

  it("never lets one lane answer another lane's message", () => {
    runLane("s1");
    runLane("s2", { projectId: "proj", slot: 1 });
    const mine = send(LANE, "for lane 0");
    expect(
      runtime.reply("s2", { taskId: mine.taskId, state: "completed", text: "x" })
    ).toMatchObject({ ok: false, code: "UNKNOWN_TASK" });
  });

  it("pages by arrival within the count and size bounds", () => {
    runLane("s1");
    const ids = ["a", "b", "c"].map((body) => send(LANE, body).taskId);
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
    const ids = ["a", "b", "c"].map((ch) => send(LANE, ch.repeat(15_000)).taskId);
    const first = runtime.getInbox("s1", {});
    if (!first.ok) throw new Error(first.code);
    expect(first.value.messages.map((m) => m.taskId)).toEqual(ids.slice(0, 2));
    expect(first.value.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first.value))).toBeLessThan(51_200);
    const rest = runtime.getInbox("s1", { cursor: first.value.cursor });
    expect(rest.ok && rest.value.messages.map((m) => m.taskId)).toEqual(ids.slice(2));
  });

  it("refuses to admit a body for anything but an open address or a standing enrollment", () => {
    runLane("s1");
    const { record } = store.create(SENDER, {
      messageId: "stale",
      contextId: "ctx",
      referenceTaskIds: [],
      receiver: { ...openReceiverFor(LANE), enrollmentGeneration: "gen-earlier" },
      body: "old",
    });
    expect(() => runtime.admit(record, { body: "old", provenance: PROVENANCE })).toThrow();

    // Nothing is open to other machines where this machine doesn't listen as a host.
    newRuntime({ outbox: () => undefined });
    const { record: open } = store.create(SENDER, {
      messageId: "unheard",
      contextId: "ctx",
      referenceTaskIds: [],
      receiver: openReceiverFor(LANE),
      body: "hello",
    });
    expect(() => runtime.admit(open, { body: "hello", provenance: PROVENANCE })).toThrow();
  });

  it("drops a hub's bodies when its enrollment ends, and keeps a lane's open mail for its next run", () => {
    runLane("s1");
    const hub = policy.enroll(LANE, { kind: "local" });
    if (!hub.ok) throw new Error(hub.reason);
    const { record: fromHost } = store.create(SENDER, {
      messageId: "for-the-hub",
      contextId: "ctx",
      referenceTaskIds: [],
      receiver: exchangeReceiverFor(hub.enrollment),
      body: "secret",
    });
    runtime.admit(fromHost, { body: "secret", provenance: PROVENANCE });
    send(LANE, "for the lane");
    const changed = vi.fn();
    runtime.onAvailabilityChanged(changed);
    for (const listener of [...endedListeners]) {
      listener({ projectId: "proj", slot: 0, sessionId: "s1", reason: "revoked" });
    }
    expect(changed).toHaveBeenCalled();
    expect(inbox.list(exchangeReceiverFor(hub.enrollment), 0)).toEqual([]);
    expect(inbox.list(openReceiverFor(LANE), 0)).toHaveLength(1);
  });

  it("takes nothing new on a run the person turned off or a machine that doesn't accept, but still answers", () => {
    let accepting = true;
    policy.dispose();
    policy = new AssistantMessagingPolicy({
      getRunningLaneSession: (projectId, slot) => running.get(laneKey({ projectId, slot })) ?? null,
      getLiveGeneration: (terminalId) => launchGenerations.get(terminalId) ?? null,
      isHostMessagingEnabled: () => true,
      acceptsRemoteMessages: () => accepting,
      onSessionEnded: () => () => {},
      platform: "darwin",
    });
    newRuntime();
    runLane("s1");
    const record = send(LANE, "before");
    expect(policy.declineRun(LANE, { kind: "local" })).toBe(true);
    expect(policy.checkOpen(LANE, "admit")).toEqual({ ok: false, reason: "declined" });
    expect(runtime.isAvailable("s1")).toBe(true);
    policy.acceptRun(LANE);
    expect(policy.checkOpen(LANE, "admit").ok).toBe(true);
    accepting = false;
    expect(policy.checkOpen(LANE, "wake")).toEqual({ ok: false, reason: "not-accepting" });
    expect(
      runtime.reply("s1", { taskId: record.taskId, state: "completed", text: "done" })
    ).toMatchObject({ ok: true });
  });

  it("answers a fixed refusal when the exchange records can't be read", () => {
    runLane("s1");
    send(LANE, "hi");
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

    const withOutbox = (handle: AssistantHostOutboxHandle | undefined) =>
      newRuntime({ outbox: () => handle });

    const enroll = (): LaneEnrollment => {
      const result = policy.enroll(LANE, SHELL);
      if (!result.ok) throw new Error(`enroll failed: ${result.reason}`);
      return result.enrollment;
    };

    it("has an inbox as soon as it runs on a listening host, and sends only once a Shell started it", () => {
      withOutbox(outbox());
      runLane("s1");
      expect(runtime.isAvailable("s1")).toBe(true);
      expect(runtime.isSendAvailable("s1")).toBe(false);
      expect(runtime.isReachable("s1")).toBe(true);
      expect(runtime.isSendReachable("s1")).toBe(true);
      expect(runtime.sendMessage("s1", { text: "x" })).toMatchObject({
        ok: false,
        code: "NOT_ELIGIBLE",
      });
      expect(runtime.isReachable("stranger")).toBe(false);

      // A Shell with no host side reaches a lane only once it has hosts of its own.
      let hasHosts = false;
      newRuntime({ outbox: () => undefined, hasHosts: () => hasHosts });
      expect(runtime.isAvailable("s1")).toBe(false);
      expect(runtime.isReachable("s1")).toBe(false);
      hasHosts = true;
      expect(runtime.isReachable("s1")).toBe(true);
      expect(runtime.isSendReachable("s1")).toBe(false);
    });

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

  it("refuses an answer too large for the sender to be handed whole", () => {
    runLane("s1");
    const record = send(LANE, "which?");
    // Few characters, but six bytes each once serialized.
    const result = runtime.reply("s1", {
      taskId: record.taskId,
      state: "completed",
      text: "\u0001".repeat(15_000),
    });
    expect(result).toMatchObject({ ok: false, code: "TOO_LARGE" });
    expect(
      store.get(SENDER, { senderId: SENDER.senderId, messageId: record.messageId })?.state
    ).toBe("submitted");
  });

  it("tells response listeners each time the lane answers, repeated questions included", () => {
    runLane("s1");
    const record = send(LANE, "which?");
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

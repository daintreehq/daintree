import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
import {
  AssistantExchangeStore,
  onExchangeChanged,
  type ExchangeChange,
} from "../AssistantExchangeStore.js";
import type { CreateExchangeInput, ExchangeKey, ReceiverActor, SenderActor } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../services/persistence/migrations");

const HOUR = 60 * 60_000;
const SECRET_BODY = "deploy the payroll fix — passphrase tangerine-41";

const shellA: SenderActor = { kind: "sender", senderId: "shell-a" };
const shellB: SenderActor = { kind: "sender", senderId: "shell-b" };
const lane: ReceiverActor = {
  kind: "receiver",
  hostId: "host-1",
  laneId: "lane-assistant",
  enrollmentGeneration: "gen-3",
};

function input(overrides: Partial<CreateExchangeInput> = {}): CreateExchangeInput {
  return {
    messageId: "msg-1",
    contextId: "ctx-1",
    referenceTaskIds: [],
    receiver: { hostId: lane.hostId, laneId: lane.laneId, enrollmentGeneration: "gen-3" },
    body: SECRET_BODY,
    ...overrides,
  };
}

const keyA: ExchangeKey = { senderId: "shell-a", messageId: "msg-1" };

describe("AssistantExchangeStore", () => {
  let tmpDir: string;
  let dbPath: string;
  let sqlite: Database.Database;
  let clock: number;
  let store: AssistantExchangeStore;
  let taskCounter: number;

  const open = () => {
    sqlite = openDb(dbPath, migrationsFolder).sqlite;
    store = new AssistantExchangeStore(sqlite, {
      now: () => clock,
      ttlMs: 24 * HOUR,
      retryWindowMs: HOUR,
      tombstoneRetentionMs: 48 * HOUR,
      auditRetentionMs: 72 * HOUR,
      newTaskId: () => `task-${++taskCounter}`,
    });
  };

  const auditRows = () =>
    (
      sqlite
        .prepare("SELECT revision, attributes FROM assistant_exchange_audit ORDER BY revision")
        .all() as {
        revision: number;
        attributes: string;
      }[]
    ).map((row) => ({ revision: row.revision, ...JSON.parse(row.attributes) }));

  const drain = (actor: SenderActor, from: number, limit: number) => {
    const seen: string[] = [];
    let cursor = from;
    let reset = false;
    for (let pages = 0; pages < 50; pages++) {
      const page = store.listChangesSince(actor, cursor, limit);
      reset ||= page.reset;
      seen.push(...page.records.map((r) => r.messageId));
      cursor = page.cursor;
      if (!page.hasMore) return { seen, cursor, reset };
    }
    throw new Error("listing never finished");
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-exchange-"));
    dbPath = path.join(tmpDir, "exchange.db");
    clock = 1_000_000;
    taskCounter = 0;
    open();
  });

  afterEach(() => {
    if (sqlite.open) sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("idempotency", () => {
    it("returns the existing record for a resend of the same message", () => {
      const first = store.create(shellA, input());
      const again = store.create(shellA, input());

      expect(first.disposition).toBe("created");
      expect(again.disposition).toBe("existing");
      expect(again.record.taskId).toBe(first.record.taskId);
      expect(again.record.revision).toBe(first.record.revision);
      expect(auditRows()).toHaveLength(1);
    });

    it.each([
      ["body", { body: "something else" }],
      ["context", { contextId: "ctx-2" }],
      ["references", { referenceTaskIds: ["t-9"] }],
      [
        "lane",
        { receiver: { hostId: "host-1", laneId: "lane-other", enrollmentGeneration: "gen-3" } },
      ],
      [
        "generation",
        { receiver: { hostId: "host-1", laneId: "lane-assistant", enrollmentGeneration: "gen-4" } },
      ],
    ] as const)("refuses a reused message id with a different %s", (_label, change) => {
      store.create(shellA, input());
      expect(() => store.create(shellA, input(change))).toThrow(
        expect.objectContaining({ code: "VALIDATION" })
      );
    });

    it("never echoes the body in a refusal", () => {
      store.create(shellA, input());
      try {
        store.create(shellA, input({ body: "different" }));
        expect.unreachable();
      } catch (error) {
        expect(String((error as Error).message)).not.toContain("tangerine");
      }
    });

    it("refuses a reference list with holes in it", () => {
      expect(() => store.create(shellA, input({ referenceTaskIds: new Array<string>(1) }))).toThrow(
        expect.objectContaining({ code: "VALIDATION" })
      );
    });

    it("scopes message ids per sender, so two Shells never collide", () => {
      const a = store.create(shellA, input());
      const b = store.create(shellB, input({ body: "shell b's own message" }));

      expect(b.disposition).toBe("created");
      expect(b.record.taskId).not.toBe(a.record.taskId);
    });
  });

  describe("participant scope", () => {
    it("hides one Shell's exchange from another Shell on the same host", () => {
      store.create(shellA, input());

      expect(store.get(shellB, keyA)).toBeNull();
      expect(store.listChangesSince(shellB, 0).records).toEqual([]);
      expect(() => store.markAmbiguous(shellB, keyA)).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" })
      );
    });

    it("shows the exchange to the receiving lane only at its own enrollment generation", () => {
      store.create(shellA, input());

      expect(store.get(lane, keyA)?.messageId).toBe("msg-1");
      const reEnrolled: ReceiverActor = { ...lane, enrollmentGeneration: "gen-4" };
      expect(store.get(reEnrolled, keyA)).toBeNull();
      expect(() => store.recordDelivery(reEnrolled, keyA, "accepted")).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" })
      );
    });

    it("lets only the sender cancel", () => {
      store.create(shellA, input());
      expect(() => store.requestCancel(lane as unknown as SenderActor, keyA)).toThrow(
        expect.objectContaining({ code: "VALIDATION" })
      );
    });
  });

  describe("state", () => {
    it("completes only when a reply arrives, recording the reply's digest and size", () => {
      store.create(shellA, input());
      expect(() => store.setState(lane, keyA, "completed")).toThrow(
        expect.objectContaining({ code: "VALIDATION" })
      );

      const reply = "Done — 3 files changed";
      const record = store.recordDelivery(lane, keyA, "reply-received", { body: reply });

      expect(record.state).toBe("completed");
      expect(record.replyBytes).toBe(Buffer.byteLength(reply, "utf8"));
      expect(record.replyDigest).toBe(createHash("sha256").update(reply).digest("hex"));
    });

    it.each(["completed", "canceled", "failed", "rejected"] as const)(
      "never leaves %s",
      (terminal) => {
        store.create(shellA, input());
        if (terminal === "completed") {
          store.recordDelivery(lane, keyA, "reply-received", { body: "ok" });
        } else if (terminal === "canceled") {
          store.requestCancel(shellA, keyA);
        } else {
          store.setState(lane, keyA, terminal);
        }

        expect(() => store.setState(lane, keyA, "working")).toThrow(
          expect.objectContaining({ code: "VALIDATION" })
        );
        expect(store.get(shellA, keyA)?.state).toBe(terminal);
      }
    );

    it("records a late reply after failure without changing the state", () => {
      store.create(shellA, input());
      store.setState(lane, keyA, "failed", "receiver_unavailable");
      const record = store.recordDelivery(lane, keyA, "reply-received", { body: "late" });

      expect(record.state).toBe("failed");
      expect(record.outcome).toBe("receiver_unavailable");
      expect(record.delivery.replyReceivedAt).toBe(clock);
    });

    it("keeps delivery facts apart from the exchange state", () => {
      store.create(shellA, input());
      store.beginDelivery(shellA, keyA);
      store.recordDelivery(shellA, keyA, "accepted");
      const record = store.recordDelivery(shellA, keyA, "wake-typed");

      expect(record.state).toBe("submitted");
      expect(record.delivery.acceptedAt).toBe(clock);
      expect(record.delivery.wakeTypedAt).toBe(clock);
      expect(record.delivery.inboxFetchedAt).toBeNull();
    });

    it("writes nothing for a repeated observation", () => {
      store.create(shellA, input());
      const first = store.recordDelivery(lane, keyA, "accepted");
      clock += 5_000;
      const repeat = store.recordDelivery(lane, keyA, "accepted");

      expect(repeat.revision).toBe(first.revision);
      expect(repeat.delivery.acceptedAt).toBe(first.delivery.acceptedAt);
      expect(auditRows()).toHaveLength(2);
    });
  });

  describe("cancel", () => {
    it("cancels an exchange nothing has left for yet", () => {
      store.create(shellA, input());
      const record = store.requestCancel(shellA, keyA);

      expect(record.state).toBe("canceled");
      expect(record.cancelRequestedAt).toBe(clock);
      expect(() => store.beginDelivery(shellA, keyA)).toThrow(
        expect.objectContaining({ code: "VALIDATION" })
      );
    });

    it("only records the request once a delivery was attempted", () => {
      store.create(shellA, input());
      store.beginDelivery(shellA, keyA);
      const record = store.requestCancel(shellA, keyA);

      expect(record.state).toBe("submitted");
      expect(record.cancelRequestedAt).toBe(clock);
    });

    it("only records the request when the outcome is unknown", () => {
      store.create(shellA, input());
      store.markAmbiguous(shellA, keyA);
      const record = store.requestCancel(shellA, keyA);

      expect(record.state).toBe("submitted");
      expect(record.delivery.ambiguousAt).toBe(clock);
    });
  });

  describe("unknown outcomes", () => {
    it("refuses to send again after an attempt, even across a restart", () => {
      store.create(shellA, input());
      store.beginDelivery(shellA, keyA);
      sqlite.close();
      open();

      expect(store.get(shellA, keyA)?.delivery.attemptedAt).toBe(clock);
      expect(() => store.beginDelivery(shellA, keyA)).toThrow(
        expect.objectContaining({ code: "OUTCOME_UNKNOWN" })
      );
    });

    it("never sends an exchange whose outcome was left unknown, across a restart", () => {
      store.create(shellA, input());
      store.markAmbiguous(shellA, keyA);
      sqlite.close();
      open();

      expect(() => store.beginDelivery(shellA, keyA)).toThrow(
        expect.objectContaining({ code: "OUTCOME_UNKNOWN" })
      );
      expect(store.get(shellA, keyA)?.delivery.attemptedAt).toBeNull();
    });

    it("never sends an exchange the receiver was already seen to accept", () => {
      store.create(shellA, input());
      store.recordDelivery(lane, keyA, "accepted");

      expect(() => store.beginDelivery(shellA, keyA)).toThrow(
        expect.objectContaining({ code: "OUTCOME_UNKNOWN" })
      );
    });

    it("records ambiguity alongside the state and keeps it across a restart", () => {
      store.create(shellA, input());
      store.setState(lane, keyA, "working");
      store.markAmbiguous(shellA, keyA);
      sqlite.close();
      open();

      const record = store.get(shellA, keyA)!;
      expect(record.state).toBe("working");
      expect(record.delivery.ambiguousAt).toBe(clock);
    });
  });

  describe("durability and revisions", () => {
    it("keeps records and keeps counting revisions after a restart", () => {
      const created = store.create(shellA, input()).record;
      store.recordDelivery(lane, keyA, "accepted");
      sqlite.close();
      open();

      expect(store.get(shellA, keyA)?.delivery.acceptedAt).toBe(clock);
      const next = store.create(shellA, input({ messageId: "msg-2" })).record;
      expect(next.revision).toBeGreaterThan(created.revision + 1);
      expect(store.create(shellA, input()).disposition).toBe("existing");
    });

    it("lists each changed record once, at its latest state, from a cursor", () => {
      store.create(shellA, input());
      const { cursor } = store.listChangesSince(shellA, 0);
      store.create(shellA, input({ messageId: "msg-2", body: "second" }));
      store.recordDelivery(lane, keyA, "accepted");
      store.setState(lane, keyA, "working");

      const changes = store.listChangesSince(shellA, cursor);
      expect(changes.records.map((r) => [r.messageId, r.state])).toEqual([
        ["msg-2", "submitted"],
        ["msg-1", "working"],
      ]);
      expect(changes.reset).toBe(false);
      expect(store.listChangesSince(shellA, changes.cursor).records).toEqual([]);
    });

    it("pages through changes without skipping or repeating", () => {
      for (let i = 0; i < 5; i++) {
        store.create(shellA, input({ messageId: `m-${i}`, body: `body ${i}` }));
      }
      expect(drain(shellA, 0, 2).seen).toEqual(["m-0", "m-1", "m-2", "m-3", "m-4"]);
    });

    it("refuses page limits that would make a read or sweep unbounded", () => {
      for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => store.listChangesSince(shellA, 0, limit)).toThrow(
          expect.objectContaining({ code: "VALIDATION" })
        );
        expect(() => store.sweep(limit)).toThrow(expect.objectContaining({ code: "VALIDATION" }));
      }
    });

    it("rolls the whole transition back when the audit write fails", () => {
      store.create(shellA, input());
      const before = store.get(shellA, keyA)!;
      sqlite.exec("DROP TABLE assistant_exchange_audit");

      expect(() => store.recordDelivery(lane, keyA, "accepted")).toThrow(
        expect.objectContaining({ code: "PERSIST_FAILED" })
      );
      expect(store.get(shellA, keyA)).toEqual(before);
      const { revision } = sqlite
        .prepare("SELECT revision FROM assistant_exchange_clock")
        .get() as { revision: number };
      expect(revision).toBe(before.revision);
    });

    it("fails closed with no database rather than answering not-found", () => {
      const closed = new AssistantExchangeStore(null);
      expect(() => closed.get(shellA, keyA)).toThrow(
        expect.objectContaining({ code: "PERSIST_FAILED" })
      );
      expect(() => closed.create(shellA, input())).toThrow(
        expect.objectContaining({ code: "PERSIST_FAILED" })
      );

      sqlite.close();
      expect(() => store.listChangesSince(shellA, 0)).toThrow(
        expect.objectContaining({ code: "PERSIST_FAILED" })
      );
    });
  });

  describe("expiry and tombstones", () => {
    it("expires a live exchange into a failed tombstone that refuses further changes", () => {
      store.create(shellA, input());
      clock += 24 * HOUR;
      expect(() => store.setState(lane, keyA, "working")).toThrow(
        expect.objectContaining({ code: "VALIDATION" })
      );

      const swept = store.sweep();
      expect(swept.expired).toBe(1);
      const record = store.get(shellA, keyA)!;
      expect(record.state).toBe("failed");
      expect(record.outcome).toBe("expired");
      expect(record.tombstonedAt).toBe(clock);
    });

    it("keeps a terminal state when it expires", () => {
      store.create(shellA, input());
      store.setState(lane, keyA, "rejected");
      clock += 24 * HOUR;
      store.sweep();

      expect(store.get(shellA, keyA)?.state).toBe("rejected");
    });

    it("answers a late resend from the tombstone instead of reviving the exchange", () => {
      const created = store.create(shellA, input()).record;
      store.recordDelivery(lane, keyA, "reply-received", { body: "ok" });
      clock += 24 * HOUR;
      store.sweep();

      const resend = store.create(shellA, input());
      expect(resend.disposition).toBe("tombstoned");
      expect(resend.record.taskId).toBe(created.taskId);
      expect(resend.record.state).toBe("completed");
      expect(() => store.create(shellA, input({ body: "changed" }))).toThrow(
        expect.objectContaining({ code: "VALIDATION" })
      );
    });

    it("purges tombstones after retention and resets cursors that predate the purge", () => {
      store.create(shellA, input());
      const stale = store.listChangesSince(shellA, 0).cursor;
      clock += 24 * HOUR;
      store.sweep();
      const sawTombstone = store.listChangesSince(shellA, stale);
      expect(sawTombstone.records[0]?.tombstonedAt).toBe(clock);

      clock += 48 * HOUR;
      expect(store.sweep().purged).toBe(1);
      expect(store.get(shellA, keyA)).toBeNull();

      expect(store.listChangesSince(shellA, stale).reset).toBe(true);
      expect(store.listChangesSince(shellA, sawTombstone.cursor).reset).toBe(false);

      const fresh = store.create(shellA, input({ messageId: "msg-9", body: "new" })).record;
      expect(fresh.revision).toBeGreaterThan(sawTombstone.cursor);
    });

    it("pages a reset listing forward without looping when sweeps run in small batches", () => {
      for (const id of ["a", "b", "c"]) store.create(shellA, input({ messageId: id, body: id }));
      const stale = store.listChangesSince(shellA, 0).cursor;

      clock += 24 * HOUR;
      store.sweep(1);
      clock += 48 * HOUR;
      // "a" is due for purge, but "c" still sits below it unswept, so nothing
      // is purged yet: purging past it would strand "c" under the reset line.
      expect(store.sweep(1).purged).toBe(0);
      expect(store.sweep(1).purged).toBe(1);

      const listing = drain(shellA, stale, 1);
      expect(listing.reset).toBe(true);
      expect(listing.seen).toEqual(["b", "c"]);
    });

    it("refuses invalid retention settings", () => {
      expect(() => new AssistantExchangeStore(sqlite, { ttlMs: -1 })).toThrow();
      expect(() => new AssistantExchangeStore(sqlite, { retryWindowMs: Number.NaN })).toThrow();
      expect(
        () => new AssistantExchangeStore(sqlite, { tombstoneRetentionMs: Number.POSITIVE_INFINITY })
      ).toThrow();
    });

    it("refuses a store whose tombstones would not outlive the retry window", () => {
      expect(
        () =>
          new AssistantExchangeStore(sqlite, { retryWindowMs: HOUR, tombstoneRetentionMs: HOUR })
      ).toThrow();
    });
  });

  describe("audit", () => {
    it("writes one metadata-only record per transition, never the body", () => {
      store.create(shellA, input({ referenceTaskIds: ["task-0"] }));
      store.beginDelivery(shellA, keyA);
      clock += 1_500;
      store.recordDelivery(lane, keyA, "reply-received", { body: "reply with tangerine" });

      const rows = auditRows();
      expect(rows.map((r) => r["daintree.exchange.event"])).toEqual([
        "created",
        "delivery-attempted",
        "reply-received",
      ]);
      expect(new Set(rows.map((r) => r.revision)).size).toBe(rows.length);

      const last = rows[rows.length - 1]!;
      expect(last).toMatchObject({
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.id": "lane-assistant",
        "gen_ai.conversation.id": "ctx-1",
        "daintree.exchange.message_id": "msg-1",
        "daintree.exchange.sender_id": "shell-a",
        "daintree.exchange.previous_state": "submitted",
        "daintree.exchange.state": "completed",
        "daintree.exchange.body_bytes": Buffer.byteLength(SECRET_BODY, "utf8"),
        "daintree.exchange.body_digest": createHash("sha256").update(SECRET_BODY).digest("hex"),
        "daintree.exchange.latency_ms": 1_500,
      });

      const everything =
        JSON.stringify(sqlite.prepare("SELECT * FROM assistant_exchange_audit").all()) +
        JSON.stringify(sqlite.prepare("SELECT * FROM assistant_exchanges").all());
      expect(everything).not.toContain("tangerine");
    });

    it("drops audit rows after their own retention", () => {
      store.create(shellA, input());
      clock += 72 * HOUR;
      expect(store.sweep().auditPurged).toBe(1);
      // The expiry this sweep just recorded is newer than the retention line and stays.
      expect(auditRows().map((r) => r["daintree.exchange.event"])).toEqual(["expired"]);
    });
  });

  describe("change notices", () => {
    let heard: ExchangeChange[];
    let off: () => void;

    beforeEach(() => {
      heard = [];
      off = onExchangeChanged((change) => heard.push(change));
    });

    afterEach(() => off());

    it("tells listeners each committed change, from any store over the database", () => {
      const seen: Array<{ inTransaction: boolean; revision: number | undefined }> = [];
      const offReader = onExchangeChanged(() =>
        seen.push({
          inTransaction: sqlite.inTransaction,
          revision: store.get(shellA, keyA)?.revision,
        })
      );
      const created = store.create(shellA, input()).record;
      offReader();
      // Told after the commit: a listener reading back sees what was written.
      expect(seen).toEqual([{ inTransaction: false, revision: created.revision }]);
      expect(heard).toEqual([{ senderId: "shell-a", revision: created.revision }]);

      const other = new AssistantExchangeStore(sqlite, { now: () => clock });
      const accepted = other.recordDelivery(lane, keyA, "accepted");
      expect(heard.at(-1)).toEqual({ senderId: "shell-a", revision: accepted.revision });
      expect(store.get(shellA, keyA)?.revision).toBe(accepted.revision);
    });

    it("says nothing for a repeat that writes nothing, or a write that fails", () => {
      store.create(shellA, input());
      heard = [];
      store.create(shellA, input());
      store.markAmbiguous(lane, keyA);
      store.markAmbiguous(lane, keyA);
      expect(heard).toHaveLength(1);
      expect(() => store.create(shellA, input({ body: "something else" }))).toThrow();
      expect(heard).toHaveLength(1);
    });

    it("keeps telling the rest when one listener throws", () => {
      const offThrowing = onExchangeChanged(() => {
        throw new Error("boom");
      });
      const after: ExchangeChange[] = [];
      const offAfter = onExchangeChanged((change) => after.push(change));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        store.create(shellA, input());
        expect(after).toHaveLength(1);
        expect(errors).toHaveBeenCalled();
      } finally {
        offAfter();
        offThrowing();
        errors.mockRestore();
      }
    });

    it("tells the sweep's expiries too", () => {
      store.create(shellA, input());
      heard = [];
      clock += 25 * HOUR;
      store.sweep();
      expect(heard).toEqual([{ senderId: "shell-a", revision: expect.any(Number) }]);
    });
  });
});

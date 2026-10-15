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
import { AssistantExchangeJournal } from "../../exchange/AssistantExchangeJournal.js";
import type { ExchangeRecord, ExchangeState } from "../../exchange/types.js";
import type { LinkSession } from "../../link/session.js";
import { AssistantExchangeClient, type MovedExchange } from "../AssistantExchangeClient.js";
import type { AssistantMessagingPolicy } from "../AssistantMessagingPolicy.js";
import { AssistantLinkMethod } from "../linkMethods.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../services/persistence/migrations");
const HOST = "studio";

function record(messageId: string, revision: number, state: ExchangeState): ExchangeRecord {
  return {
    taskId: `task-${messageId}`,
    senderId: "sender",
    messageId,
    contextId: "ctx",
    referenceTaskIds: [],
    receiver: { hostId: "local", laneId: "proj#0", enrollmentGeneration: "gen-1" },
    state,
    outcome: null,
    bodyDigest: "d",
    bodyBytes: 4,
    replyDigest: null,
    replyBytes: null,
    delivery: {
      attemptedAt: null,
      acceptedAt: null,
      wakeTypedAt: null,
      inboxFetchedAt: null,
      replyReceivedAt: null,
      ambiguousAt: null,
    },
    cancelRequestedAt: null,
    createdAt: 100,
    updatedAt: 100 + revision,
    expiresAt: Date.now() + 60 * 60_000,
    terminalAt: null,
    tombstonedAt: null,
    revision,
  };
}

/** A host's side of one session: its records, and the calls the Shell made. */
class FakeHost {
  records = new Map<string, ExchangeRecord>();
  revision = 0;
  listCalls = 0;
  /** Resolves the next LIST_EXCHANGES only when released, to land an event mid-read. */
  gate: Promise<void> | null = null;
  handlers = new Map<string, (payload: unknown) => unknown>();
  failNextList = false;

  put(messageId: string, state: ExchangeState, replied = false): ExchangeRecord {
    const next = record(messageId, ++this.revision, state);
    if (replied) next.delivery.replyReceivedAt = 1;
    this.records.set(messageId, next);
    return next;
  }

  session(): LinkSession {
    return {
      isOpen: true,
      call: async (method: string, payload: unknown) => {
        switch (method) {
          case AssistantLinkMethod.AUTHENTICATE:
            return null;
          case AssistantLinkMethod.SEND: {
            const { messageId } = payload as { messageId: string };
            return { disposition: "created", record: this.put(messageId, "submitted") };
          }
          case AssistantLinkMethod.GET_EXCHANGE:
            return this.records.get((payload as { messageId: string }).messageId) ?? null;
          case AssistantLinkMethod.LIST_EXCHANGES: {
            this.listCalls++;
            const gate = this.gate;
            this.gate = null;
            const fail = this.failNextList;
            this.failNextList = false;
            const { cursor } = payload as { cursor: number };
            const records = [...this.records.values()]
              .filter((r) => r.revision > cursor)
              .sort((a, b) => a.revision - b.revision);
            const cursorAfter = this.revision;
            // Listed before the gate opens: a change made meanwhile isn't in this page.
            if (gate) await gate;
            if (fail) throw Object.assign(new Error("timed out"), { code: "TIMEOUT" });
            return { records, cursor: cursorAfter, hasMore: false, reset: false };
          }
          default:
            throw new Error(`unexpected ${method}`);
        }
      },
      registerCallHandler: (method: string, schema: unknown, handler: unknown) => {
        const parse = (schema as { parse(v: unknown): unknown }).parse;
        this.handlers.set(method, (payload) =>
          (handler as (p: unknown) => unknown)(parse.call(schema, payload))
        );
      },
    } as unknown as LinkSession;
  }

  announce(): unknown {
    return this.handlers.get(AssistantLinkMethod.EXCHANGE_CHANGED)!({ revision: this.revision });
  }
}

describe("AssistantExchangeClient change events", () => {
  let dir: string;
  let sqlite: Database.Database;
  let journal: AssistantExchangeJournal;
  let host: FakeHost;
  let session: LinkSession;
  let opened: (hostId: string, session: LinkSession) => void;
  let moved: MovedExchange[];
  let hubGeneration: string | null;
  let client: AssistantExchangeClient;

  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const makeClient = () => {
    client = new AssistantExchangeClient({
      journal,
      session: async () => session,
      onSessionOpened: (listener) => {
        opened = listener;
        return () => {};
      },
      policy: () =>
        ({
          checkHost: () => ({ ok: true }),
          getHub: () => (hubGeneration === null ? null : { generation: hubGeneration }),
        }) as unknown as AssistantMessagingPolicy,
      onExchangesMoved: (_hostId, batch) => moved.push(...batch),
    });
    client.start();
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-exchange-client-"));
    sqlite = openDb(path.join(dir, "shell.db"), migrationsFolder).sqlite;
    journal = new AssistantExchangeJournal(sqlite);
    host = new FakeHost();
    session = host.session();
    moved = [];
    hubGeneration = "hub-1";
    makeClient();
  });

  afterEach(() => {
    client.dispose();
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function sendOne(messageId = "m-1"): Promise<void> {
    opened(HOST, session);
    await client.send(HOST, {
      messageId,
      contextId: "ctx",
      referenceTaskIds: [],
      projectId: "proj",
      slot: 0,
      generation: "lane-gen",
      body: "hello",
    });
    await settle();
  }

  it("reads the host's changes when it announces one, and tells the hub that sent it", async () => {
    await sendOne();
    host.put("m-1", "completed");
    expect(host.announce()).toBeNull();
    await settle();

    expect(journal.get(HOST, "m-1")?.record?.state).toBe("completed");
    expect(moved).toEqual([
      { record: expect.objectContaining({ messageId: "m-1" }), hubGeneration: "hub-1" },
    ]);
  });

  it("ignores an announcement it has already read past, and a repeat", async () => {
    await sendOne();
    host.put("m-1", "working");
    host.announce();
    await settle();
    const reads = host.listCalls;
    host.announce();
    host.handlers.get(AssistantLinkMethod.EXCHANGE_CHANGED)!({ revision: 1 });
    await settle();
    expect(host.listCalls).toBe(reads);
    expect(moved).toHaveLength(1);
  });

  it("reads again when a change is announced while a read is under way", async () => {
    await sendOne();
    let release!: () => void;
    host.gate = new Promise((resolve) => (release = resolve));
    host.put("m-1", "working");
    host.announce();
    await settle();
    // The running read listed before this change.
    host.put("m-1", "completed");
    host.announce();
    release();
    await settle();

    expect(journal.get(HOST, "m-1")?.record?.state).toBe("completed");
    expect(moved.map((m) => m.record.state)).toEqual(["working", "completed"]);
  });

  it("tells no hub of a change that doesn't move the state, or of an exchange sent before a restart", async () => {
    await sendOne();
    // A delivery fact bumps the revision but leaves the state where it was.
    host.put("m-1", "submitted");
    host.announce();
    await settle();
    expect(moved).toEqual([]);

    client.dispose();
    makeClient();
    opened(HOST, session);
    await settle();
    host.put("m-1", "completed");
    host.announce();
    await settle();
    expect(journal.get(HOST, "m-1")?.record?.state).toBe("completed");
    expect(moved).toEqual([]);
  });

  it("names no hub for an exchange sent while none was enrolled", async () => {
    hubGeneration = null;
    await sendOne();
    host.put("m-1", "completed");
    host.announce();
    await settle();
    expect(moved).toEqual([]);
  });

  it("keeps an exchange with the hub that first sent it, through a resend under another", async () => {
    await sendOne();
    hubGeneration = "hub-2";
    await sendOne();
    host.put("m-1", "completed", true);
    host.announce();
    await settle();
    expect(moved.map((m) => m.hubGeneration)).toEqual(["hub-1"]);
  });

  it("binds no hub to a resend of an exchange sent before a restart", async () => {
    await sendOne();
    client.dispose();
    makeClient();
    await settle();
    await sendOne();
    host.put("m-1", "completed", true);
    host.announce();
    await settle();
    expect(moved).toEqual([]);
  });

  it("tells the hub of a reply that lands after the exchange already failed", async () => {
    await sendOne();
    host.put("m-1", "failed");
    host.announce();
    await settle();
    host.put("m-1", "failed", true);
    host.announce();
    await settle();
    expect(moved.map((m) => [m.record.state, m.record.delivery.replyReceivedAt !== null])).toEqual([
      ["failed", false],
      ["failed", true],
    ]);
  });

  it("reads again later when a read fails with a change announced meanwhile", async () => {
    await sendOne();
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let release!: () => void;
      host.gate = new Promise((resolve) => (release = resolve));
      host.failNextList = true;
      host.put("m-1", "working");
      host.announce();
      await vi.advanceTimersByTimeAsync(0);
      host.put("m-1", "completed", true);
      host.announce();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(journal.get(HOST, "m-1")?.record?.state).toBe("submitted");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(journal.get(HOST, "m-1")?.record?.state).toBe("completed");
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("answers an announcement after it was disposed without reading anything", async () => {
    await sendOne();
    client.dispose();
    const reads = host.listCalls;
    host.put("m-1", "completed", true);
    host.announce();
    await settle();
    expect(host.listCalls).toBe(reads);
  });

  it("reads hosts with open exchanges again on start, quietly when one is out of reach", async () => {
    await sendOne();
    client.dispose();
    host.put("m-1", "completed");
    makeClient();
    await settle();
    expect(journal.get(HOST, "m-1")?.record?.state).toBe("completed");

    client.dispose();
    journal.recordAnswer(HOST, record("m-2", 50, "working"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    session = { isOpen: false } as LinkSession;
    makeClient();
    await settle();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

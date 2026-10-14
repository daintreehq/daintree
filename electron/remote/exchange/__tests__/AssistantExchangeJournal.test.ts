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
import { AssistantExchangeJournal } from "../AssistantExchangeJournal.js";
import type { ExchangeRecord } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../services/persistence/migrations");

function record(messageId: string, revision: number, state: ExchangeRecord["state"] = "submitted") {
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
    expiresAt: 10_000,
    terminalAt: null,
    tombstonedAt: null,
    revision,
  } satisfies ExchangeRecord;
}

describe("AssistantExchangeJournal", () => {
  let dir: string;
  let dbPath: string;
  let sqlite: Database.Database;
  let journal: AssistantExchangeJournal;
  let credentials: number;

  const open = () => {
    sqlite = openDb(dbPath, migrationsFolder).sqlite;
    journal = new AssistantExchangeJournal(sqlite, {
      now: () => 500,
      newCredential: () => `credential-${++credentials}`,
    });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-exchange-journal-"));
    dbPath = path.join(dir, "shell.db");
    credentials = 0;
    open();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mints one credential per host and keeps it, and the cursor and exchanges, across a restart", () => {
    expect(journal.existingCredential("studio")).toBeNull();
    const credential = journal.credential("studio");
    expect(journal.credential("studio")).toBe(credential);
    expect(journal.credential("other")).not.toBe(credential);

    journal.noteSending("studio", "m-1");
    journal.applyChanges("studio", {
      records: [record("m-1", 4)],
      cursor: 4,
      hasMore: false,
      reset: false,
    });
    sqlite.close();
    open();

    expect(journal.existingCredential("studio")).toBe(credential);
    expect(journal.cursor("studio")).toBe(4);
    expect(journal.get("studio", "m-1")).toMatchObject({
      unresolvedAt: null,
      record: { messageId: "m-1", revision: 4 },
    });
  });

  it("keeps a send unresolved until the host answers or says it never got it", () => {
    journal.credential("studio");
    journal.noteSending("studio", "lost");
    journal.noteSending("studio", "arrived");
    expect(journal.unresolved("studio")).toEqual(["arrived", "lost"]);

    journal.recordAnswer("studio", record("arrived", 2));
    journal.markNotReceived("studio", "lost");
    expect(journal.unresolved("studio")).toEqual([]);
    // Never on the host: nothing of it is kept, so its id is free to send again.
    expect(journal.get("studio", "lost")).toBeNull();
    expect(journal.get("studio", "arrived")?.record?.revision).toBe(2);
  });

  it("never replaces a newer record with an older one, wherever the older one came from", () => {
    journal.credential("studio");
    journal.recordAnswer("studio", record("m-1", 7, "working"));
    journal.applyChanges("studio", {
      records: [record("m-1", 3)],
      cursor: 3,
      hasMore: true,
      reset: false,
    });
    expect(journal.get("studio", "m-1")?.record).toMatchObject({ revision: 7, state: "working" });
    expect(journal.cursor("studio")).toBe(3);
  });

  it("forgets a host's credential, cursor and exchanges together, leaving other hosts alone", () => {
    journal.credential("studio");
    journal.credential("other");
    journal.recordAnswer("studio", record("m-1", 1));
    journal.recordAnswer("other", record("m-2", 1));

    journal.forgetHost("studio");
    expect(journal.hosts()).toEqual(["other"]);
    expect(journal.list("studio")).toEqual([]);
    expect(journal.list("other").map((entry) => entry.messageId)).toEqual(["m-2"]);
  });
});

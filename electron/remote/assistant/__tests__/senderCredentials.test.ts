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
import { AssistantSenderCredentials } from "../senderCredentials.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../services/persistence/migrations");

describe("AssistantSenderCredentials (#13493)", () => {
  let dir: string;
  let dbPath: string;
  let sqlite: Database.Database;
  let minted: number;
  const mint = () => `credential-${++minted}`;

  const reopen = () => {
    sqlite?.close();
    sqlite = openDb(dbPath, migrationsFolder).sqlite;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-sender-credentials-"));
    dbPath = path.join(dir, "shell.db");
    minted = 0;
    sqlite = openDb(dbPath, migrationsFolder).sqlite;
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mints one credential per host and keeps it across a restart", () => {
    const store = new AssistantSenderCredentials(sqlite, { newCredential: mint });
    expect(store.existing("studio")).toBeNull();
    const first = store.credential("studio");
    expect(store.credential("studio")).toBe(first);
    expect(store.credential("other")).not.toBe(first);

    reopen();
    expect(new AssistantSenderCredentials(sqlite, { newCredential: mint }).existing("studio")).toBe(
      first
    );
  });

  it("takes over a credential the exchange journal minted before it existed, unchanged", () => {
    // What a Shell from before the store left behind: the journal's own row only.
    sqlite
      .prepare(
        "INSERT INTO assistant_exchange_hosts (host_id, sender_credential, cursor) VALUES (?, ?, 7)"
      )
      .run("studio", "credential-from-before");
    const store = new AssistantSenderCredentials(sqlite, { newCredential: mint });

    expect(store.credential("studio")).toBe("credential-from-before");
    expect(minted).toBe(0);
  });

  it("takes the journal's credential where the two disagree: an older build presented it last", () => {
    const store = new AssistantSenderCredentials(sqlite, { newCredential: mint });
    store.credential("studio");
    // An older build forgot the host, then minted its own when it was added again.
    sqlite
      .prepare(
        "INSERT INTO assistant_exchange_hosts (host_id, sender_credential, cursor) VALUES (?, ?, 0)"
      )
      .run("studio", "minted-by-older-build");

    expect(new AssistantSenderCredentials(sqlite).credential("studio")).toBe(
      "minted-by-older-build"
    );
  });

  it("is what the journal authenticates with, and goes with a removed host", () => {
    const credentials = new AssistantSenderCredentials(sqlite, { newCredential: mint });
    const journal = new AssistantExchangeJournal(sqlite, { credentials });
    const credential = journal.credential("studio");

    expect(credentials.existing("studio")).toBe(credential);
    expect(journal.existingCredential("studio")).toBe(credential);
    expect(journal.cursor("studio")).toBe(0);

    // A host known only by its credential is still one the journal can forget.
    credentials.credential("relay-only");
    expect(journal.hosts().sort()).toEqual(["relay-only", "studio"]);
    journal.forgetHost("studio");
    journal.forgetHost("relay-only");
    expect(credentials.hosts()).toEqual([]);
    expect(journal.hosts()).toEqual([]);
  });
});

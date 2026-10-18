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

  it("goes with a removed host, the journal's copy included, so it is never adopted back", () => {
    sqlite
      .prepare(
        "INSERT INTO assistant_exchange_hosts (host_id, sender_credential, cursor) VALUES (?, ?, 0)"
      )
      .run("studio", "credential-from-before");
    const store = new AssistantSenderCredentials(sqlite, { newCredential: mint });
    store.credential("relay-only");
    expect(store.hosts().sort()).toEqual(["relay-only", "studio"]);

    store.forget("studio");
    store.forget("relay-only");
    expect(store.hosts()).toEqual([]);

    reopen();
    const again = new AssistantSenderCredentials(sqlite, { newCredential: mint });
    expect(again.existing("studio")).toBeNull();
    expect(again.credential("studio")).toBe("credential-2");
  });
});

import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { ExchangeChanges, ExchangeRecord } from "./types.js";

/** One exchange this Shell sent to a host, as it last knew it. */
export interface JournalEntry {
  hostId: string;
  messageId: string;
  sentAt: number;
  /**
   * Set while a send's answer is unknown (lost, timed out, the link dropped).
   * Resolved only by looking the messageId up on the host, never by sending
   * it under a new id.
   */
  unresolvedAt: number | null;
  /**
   * Set when a send's outcome stayed unknown past the retry window: the host
   * having no record no longer proves it never arrived, so its id is not sent again.
   */
  lapsedAt: number | null;
  /** The host's record; null until the host answered with one. */
  record: ExchangeRecord | null;
  updatedAt: number;
}

interface JournalRow {
  host_id: string;
  message_id: string;
  sent_at: number;
  unresolved_at: number | null;
  lapsed_at: number | null;
  record: string | null;
  updated_at: number;
}

export interface AssistantExchangeJournalOptions {
  now?: () => number;
  newCredential?: () => string;
}

function toEntry(row: JournalRow): JournalEntry {
  return {
    hostId: row.host_id,
    messageId: row.message_id,
    sentAt: row.sent_at,
    unresolvedAt: row.unresolved_at,
    lapsedAt: row.lapsed_at,
    record: row.record === null ? null : (JSON.parse(row.record) as ExchangeRecord),
    updatedAt: row.updated_at,
  };
}

/**
 * The Shell's own record of the assistant exchanges it sent, per host, with
 * the sender credential it authenticates to each host with and how far it has
 * read that host's changes. The host's record is the authority; this keeps
 * what the Shell last heard of it, across restarts and while the host sleeps.
 * Bodies never reach it: the host's records carry only digests and sizes.
 */
export class AssistantExchangeJournal {
  private readonly now: () => number;
  private readonly newCredential: () => string;
  /** The last attempt mark handed out, so marks never repeat even once a row is gone. */
  private lastAttempt = 0;

  constructor(
    private readonly sqlite: Database.Database,
    options: AssistantExchangeJournalOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.newCredential = options.newCredential ?? (() => randomBytes(32).toString("base64url"));
  }

  /** The credential this Shell authenticates to `hostId` with, minted and saved on first use. */
  credential(hostId: string): string {
    const existing = this.existingCredential(hostId);
    if (existing) return existing;
    const credential = this.newCredential();
    this.sqlite
      .prepare(
        "INSERT INTO assistant_exchange_hosts (host_id, sender_credential, cursor) VALUES (?, ?, 0) ON CONFLICT(host_id) DO NOTHING"
      )
      .run(hostId, credential);
    return this.existingCredential(hostId)!;
  }

  /** Null for a host this Shell never sent an exchange to. */
  existingCredential(hostId: string): string | null {
    const row = this.sqlite
      .prepare("SELECT sender_credential FROM assistant_exchange_hosts WHERE host_id = ?")
      .get(hostId) as { sender_credential: string } | undefined;
    return row?.sender_credential ?? null;
  }

  cursor(hostId: string): number {
    const row = this.sqlite
      .prepare("SELECT cursor FROM assistant_exchange_hosts WHERE host_id = ?")
      .get(hostId) as { cursor: number } | undefined;
    return row?.cursor ?? 0;
  }

  /**
   * Before a send leaves: from here on its outcome is unknown until the host
   * says. Returns this attempt's mark, later than any earlier attempt's, so
   * an answer about an earlier attempt never settles this one.
   */
  noteSending(hostId: string, messageId: string): number {
    return this.sqlite.transaction(() => {
      const now = this.now();
      const previous = this.sqlite
        .prepare(
          "SELECT unresolved_at FROM assistant_exchange_journal WHERE host_id = ? AND message_id = ?"
        )
        .get(hostId, messageId) as { unresolved_at: number | null } | undefined;
      const attempt = Math.max(now, this.lastAttempt + 1, (previous?.unresolved_at ?? 0) + 1);
      this.lastAttempt = attempt;
      this.sqlite
        .prepare(
          `INSERT INTO assistant_exchange_journal (host_id, message_id, sent_at, unresolved_at, record, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?)
           ON CONFLICT(host_id, message_id) DO UPDATE SET unresolved_at = excluded.unresolved_at, updated_at = excluded.updated_at`
        )
        .run(hostId, messageId, now, attempt, now);
      return attempt;
    })();
  }

  /** The host's answer for one exchange; never replaces a newer revision with an older one. */
  recordAnswer(hostId: string, record: ExchangeRecord): void {
    this.sqlite.transaction(() => this.upsert(hostId, record))();
  }

  /**
   * The host refused `attempt` outright, so it left nothing there. Settles
   * only that attempt: a later one stays unresolved.
   */
  abandonAttempt(hostId: string, messageId: string, attempt: number): void {
    this.settle(hostId, messageId, attempt, "forget");
  }

  /**
   * A lookup found no record of `attempt`. Within the retry window of the
   * first send that means it never arrived (the host keeps every record it
   * took far longer), and the id may be sent again; past it, the record may
   * have been purged, so the send is marked lapsed instead.
   */
  resolveMissing(hostId: string, messageId: string, attempt: number, retryWindowMs: number): void {
    const sentAt = this.get(hostId, messageId)?.sentAt ?? attempt;
    this.settle(
      hostId,
      messageId,
      attempt,
      this.now() - sentAt <= retryWindowMs ? "forget" : "lapse"
    );
  }

  /**
   * One page of the host's changes and the cursor after it, together or not
   * at all. A page that restarts from the beginning opens a full listing,
   * kept open across sessions until a page ends it; then records the host no
   * longer listed were purged there, and go here too.
   */
  applyChanges(hostId: string, changes: ExchangeChanges): void {
    this.sqlite.transaction(() => {
      const now = this.now();
      for (const record of changes.records) this.upsert(hostId, record);
      if (changes.reset) {
        this.sqlite
          .prepare(
            "UPDATE assistant_exchange_hosts SET reset_since = COALESCE(reset_since, ?) WHERE host_id = ?"
          )
          .run(now, hostId);
      }
      this.sqlite
        .prepare("UPDATE assistant_exchange_hosts SET cursor = ? WHERE host_id = ?")
        .run(changes.cursor, hostId);
      if (changes.hasMore) return;
      const open = this.sqlite
        .prepare("SELECT reset_since FROM assistant_exchange_hosts WHERE host_id = ?")
        .get(hostId) as { reset_since: number | null } | undefined;
      if (open?.reset_since == null) return;
      this.sqlite
        .prepare(
          "DELETE FROM assistant_exchange_journal WHERE host_id = ? AND record IS NOT NULL AND unresolved_at IS NULL AND updated_at < ?"
        )
        .run(hostId, open.reset_since);
      this.sqlite
        .prepare("UPDATE assistant_exchange_hosts SET reset_since = NULL WHERE host_id = ?")
        .run(hostId);
    })();
  }

  get(hostId: string, messageId: string): JournalEntry | null {
    const row = this.sqlite
      .prepare("SELECT * FROM assistant_exchange_journal WHERE host_id = ? AND message_id = ?")
      .get(hostId, messageId) as JournalRow | undefined;
    return row ? toEntry(row) : null;
  }

  list(hostId: string): JournalEntry[] {
    return (
      this.sqlite
        .prepare(
          "SELECT * FROM assistant_exchange_journal WHERE host_id = ? ORDER BY sent_at, message_id"
        )
        .all(hostId) as JournalRow[]
    ).map(toEntry);
  }

  unresolved(hostId: string): string[] {
    return (
      this.sqlite
        .prepare(
          "SELECT message_id FROM assistant_exchange_journal WHERE host_id = ? AND unresolved_at IS NOT NULL ORDER BY unresolved_at, message_id"
        )
        .all(hostId) as Array<{ message_id: string }>
    ).map((row) => row.message_id);
  }

  hosts(): string[] {
    return (
      this.sqlite.prepare("SELECT host_id FROM assistant_exchange_hosts").all() as Array<{
        host_id: string;
      }>
    ).map((row) => row.host_id);
  }

  /** A host removed from this Shell takes its credential, cursor and exchanges with it. */
  forgetHost(hostId: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM assistant_exchange_journal WHERE host_id = ?").run(hostId);
      this.sqlite.prepare("DELETE FROM assistant_exchange_hosts WHERE host_id = ?").run(hostId);
    })();
  }

  private settle(
    hostId: string,
    messageId: string,
    attempt: number,
    outcome: "forget" | "lapse"
  ): void {
    this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          "SELECT unresolved_at, record FROM assistant_exchange_journal WHERE host_id = ? AND message_id = ?"
        )
        .get(hostId, messageId) as
        { unresolved_at: number | null; record: string | null } | undefined;
      if (!row || row.unresolved_at !== attempt) return;
      const now = this.now();
      if (row.record === null && outcome === "forget") {
        this.sqlite
          .prepare("DELETE FROM assistant_exchange_journal WHERE host_id = ? AND message_id = ?")
          .run(hostId, messageId);
        return;
      }
      this.sqlite
        .prepare(
          "UPDATE assistant_exchange_journal SET unresolved_at = NULL, lapsed_at = ?, updated_at = ? WHERE host_id = ? AND message_id = ?"
        )
        .run(row.record === null ? now : null, now, hostId, messageId);
    })();
  }

  private upsert(hostId: string, record: ExchangeRecord): void {
    const existing = this.sqlite
      .prepare("SELECT record FROM assistant_exchange_journal WHERE host_id = ? AND message_id = ?")
      .get(hostId, record.messageId) as { record: string | null } | undefined;
    if (existing?.record) {
      const known = JSON.parse(existing.record) as ExchangeRecord;
      if (known.revision > record.revision) return;
    }
    const now = this.now();
    this.sqlite
      .prepare(
        `INSERT INTO assistant_exchange_journal (host_id, message_id, sent_at, unresolved_at, record, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(host_id, message_id) DO UPDATE SET unresolved_at = NULL, lapsed_at = NULL, record = excluded.record, updated_at = excluded.updated_at`
      )
      .run(hostId, record.messageId, record.createdAt, JSON.stringify(record), now);
  }
}

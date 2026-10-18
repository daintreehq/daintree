import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export interface AssistantSenderCredentialsOptions {
  newCredential?: () => string;
}

/**
 * The credential this Shell authenticates its assistants to each host with
 * (#13493): one per host, minted on first use and kept until the host is
 * removed. What a host knows this Shell by, for messaging and for the tools
 * it relays, so it lives apart from either. A credential the exchange journal
 * minted before this store existed is taken over as it is: a new one would be
 * a stranger to every host that knew the old.
 */
export class AssistantSenderCredentials {
  private readonly newCredential: () => string;

  constructor(
    private readonly sqlite: Database.Database,
    options: AssistantSenderCredentialsOptions = {}
  ) {
    this.newCredential = options.newCredential ?? (() => randomBytes(32).toString("base64url"));
    this.adoptJournalCredentials();
  }

  /** The credential for `hostId`, minted and saved before it is ever presented. */
  credential(hostId: string): string {
    const existing = this.existing(hostId);
    if (existing) return existing;
    this.sqlite
      .prepare(
        "INSERT INTO assistant_sender_credentials (host_id, sender_credential) VALUES (?, ?) ON CONFLICT(host_id) DO NOTHING"
      )
      .run(hostId, this.newCredential());
    return this.existing(hostId)!;
  }

  /** Null for a host this Shell never authenticated to. */
  existing(hostId: string): string | null {
    const row = this.sqlite
      .prepare("SELECT sender_credential FROM assistant_sender_credentials WHERE host_id = ?")
      .get(hostId) as { sender_credential: string } | undefined;
    return row?.sender_credential ?? null;
  }

  hosts(): string[] {
    return (
      this.sqlite.prepare("SELECT host_id FROM assistant_sender_credentials").all() as Array<{
        host_id: string;
      }>
    ).map((row) => row.host_id);
  }

  /** A host removed from this Shell takes its credential with it. */
  forget(hostId: string): void {
    this.sqlite.prepare("DELETE FROM assistant_sender_credentials WHERE host_id = ?").run(hostId);
  }

  /**
   * Every credential the journal holds that this store doesn't, on each start:
   * a build from before the store, run in between, may have minted one since.
   */
  private adoptJournalCredentials(): void {
    const journal = this.sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_exchange_hosts'"
      )
      .get();
    if (!journal) return;
    this.sqlite
      .prepare(
        "INSERT OR IGNORE INTO assistant_sender_credentials (host_id, sender_credential) SELECT host_id, sender_credential FROM assistant_exchange_hosts"
      )
      .run();
  }
}

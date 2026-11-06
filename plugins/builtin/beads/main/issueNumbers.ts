import { createHash } from "node:crypto";

const SAFE_RANGE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The number the host addresses a bead by. Beads ids have none, and storing
 * one on each bead would mean a write per bead plus a shared counter, so it is
 * derived: SHA-256 of the full id, folded into 1…MAX_SAFE_INTEGER. Stable
 * across runs and machines; nobody reads it, since labels show the key.
 */
export function beadNumber(id: string): number {
  const digest = createHash("sha256").update(id, "utf8").digest("hex");
  return Number((BigInt(`0x${digest}`) % SAFE_RANGE) + 1n);
}

/** Per-server cap. Past it the oldest entries go, and a lookup relists. */
const MAX_ENTRIES_PER_SERVER = 20_000;
const AMBIGUOUS = Symbol("ambiguous");

type Entry = string | typeof AMBIGUOUS;

/**
 * Number → bead id, learned from every bead this provider has mapped, per
 * server. A number two ids hash to is never resolved to either: numeric
 * access refuses it, while lookups by id keep working.
 */
export class IssueNumberIndex {
  private readonly servers = new Map<string, Map<number, Entry>>();

  remember(server: string, id: string): number {
    const number = beadNumber(id);
    let entries = this.servers.get(server);
    if (!entries) {
      entries = new Map();
      this.servers.set(server, entries);
    }
    const existing = entries.get(number);
    const next: Entry = existing === undefined || existing === id ? id : AMBIGUOUS;
    entries.delete(number);
    entries.set(number, next);
    if (entries.size > MAX_ENTRIES_PER_SERVER) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    return number;
  }

  /** The id for a number, `null` when none is known, or throws when two ids share it. */
  lookup(server: string, number: number): string | null {
    const entry = this.servers.get(server)?.get(number);
    if (entry === AMBIGUOUS) {
      throw new Error(
        `Two beads on this server share issue number ${number}. Open the bead by its id instead.`
      );
    }
    return entry ?? null;
  }

  clear(): void {
    this.servers.clear();
  }
}

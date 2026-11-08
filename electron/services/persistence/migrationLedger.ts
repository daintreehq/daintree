/**
 * Frozen-migration ledger (#16402). drizzle's migrator records a hash per
 * migration but never compares it: it applies every journal entry whose `when`
 * is later than the newest applied one. So an edit to a shipped migration's SQL
 * only reaches fresh installs, and a shipped `when` that moves backwards is
 * skipped on every existing database. The ledger records what each released
 * migration looked like, and its test fails when the journal or SQL drifts.
 *
 * Not imported at runtime: the ledger test and `npm run db:freeze` use it.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** Everything drizzle's migrator reads for one migration. */
export interface FrozenMigration {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
  sha256: string;
}

export interface MigrationLedger {
  migrations: FrozenMigration[];
}

export interface MigrationSource {
  entries: JournalEntry[];
  /** The text of every `.sql` file in the folder, keyed by file name without `.sql`. */
  sql: Map<string, string>;
}

/** The hash drizzle stores in `__drizzle_migrations.hash` for the same file. */
export function hashMigrationSql(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function readMigrationSource(migrationsFolder: string): MigrationSource {
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")
  ) as { entries: JournalEntry[] };
  const sql = new Map<string, string>();
  for (const file of fs.readdirSync(migrationsFolder)) {
    if (!file.endsWith(".sql")) continue;
    // Read the way drizzle does (Buffer#toString), so the hash matches its own.
    sql.set(file.slice(0, -4), fs.readFileSync(path.join(migrationsFolder, file)).toString());
  }
  return { entries: journal.entries, sql };
}

export function readMigrationLedger(ledgerPath: string): MigrationLedger {
  return JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as MigrationLedger;
}

export function serializeMigrationLedger(ledger: MigrationLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

/**
 * Problems drizzle would never report: an entry stamped no later than the one
 * before it is skipped on every database that applied that one, and an idx out
 * of step with its position or tag prefix means the journal was edited by hand.
 */
export function findJournalProblems(source: MigrationSource): string[] {
  const problems: string[] = [];
  const tags = new Set<string>();
  source.entries.forEach((entry, position) => {
    const { idx, tag, when } = entry;
    tags.add(tag);
    if (idx !== position) {
      problems.push(`${tag}: idx ${idx} sits at position ${position}; idx must count up from 0`);
    }
    const expectedPrefix = `${String(position).padStart(4, "0")}_`;
    if (!tag.startsWith(expectedPrefix)) {
      problems.push(`${tag}: tag must start with ${expectedPrefix} to match its position`);
    }
    if (!Number.isSafeInteger(when)) {
      problems.push(`${tag}: when ${String(when)} is not an integer timestamp`);
    } else if (position > 0) {
      const previous = source.entries[position - 1];
      if (when <= previous.when) {
        problems.push(
          `${tag}: when ${when} is not later than ${previous.tag}'s ${previous.when}, so drizzle skips it on every database that already applied ${previous.tag}`
        );
      }
    }
    if (!source.sql.has(tag)) {
      problems.push(`${tag}: ${tag}.sql is missing`);
    }
  });
  for (const name of source.sql.keys()) {
    if (!tags.has(name)) {
      problems.push(`${name}: ${name}.sql has no journal entry, so drizzle never applies it`);
    }
  }
  return problems;
}

/** Journal entries as the ledger would record them; entries without SQL are left out. */
export function toFrozenMigrations(source: MigrationSource): FrozenMigration[] {
  const frozen: FrozenMigration[] = [];
  for (const { idx, tag, when, breakpoints } of source.entries) {
    const sql = source.sql.get(tag);
    if (sql === undefined) continue;
    frozen.push({ idx, tag, when, breakpoints, sha256: hashMigrationSql(sql) });
  }
  return frozen;
}

/**
 * Every frozen migration must still sit at its position in the journal with the
 * same tag, idx, `when`, breakpoints and SQL bytes. Entries past the end of the
 * ledger have not shipped and may change freely.
 */
export function findLedgerDrift(ledger: MigrationLedger, source: MigrationSource): string[] {
  const problems: string[] = [];
  ledger.migrations.forEach((frozen, position) => {
    const entry = source.entries[position];
    if (!entry) {
      problems.push(`${frozen.tag}: shipped in a release but is no longer in the journal`);
      return;
    }
    const name = frozen.tag;
    if (entry.tag !== frozen.tag) {
      problems.push(`${name}: tag changed to ${entry.tag} after it shipped`);
    }
    if (entry.idx !== frozen.idx) {
      problems.push(`${name}: idx changed from ${frozen.idx} to ${entry.idx} after it shipped`);
    }
    if (entry.when !== frozen.when) {
      problems.push(`${name}: when changed from ${frozen.when} to ${entry.when} after it shipped`);
    }
    if (entry.breakpoints !== frozen.breakpoints) {
      problems.push(
        `${name}: breakpoints changed from ${frozen.breakpoints} to ${entry.breakpoints} after it shipped`
      );
    }
    const sql = source.sql.get(entry.tag);
    if (sql === undefined) {
      problems.push(`${name}: ${entry.tag}.sql is missing`);
    } else {
      const sha256 = hashMigrationSql(sql);
      if (sha256 !== frozen.sha256) {
        problems.push(
          `${name}: SQL changed after it shipped (sha256 ${frozen.sha256} is now ${sha256})`
        );
      }
    }
  });
  return problems;
}

/**
 * Append every journal entry the ledger doesn't hold yet. Refuses while the
 * journal is malformed or a frozen migration has drifted, so freezing can never
 * paper over a change to a migration that already shipped.
 */
export function freezeMigrations(
  ledger: MigrationLedger,
  source: MigrationSource
): { ledger: MigrationLedger; added: FrozenMigration[] } {
  const problems = [...findJournalProblems(source), ...findLedgerDrift(ledger, source)];
  if (problems.length > 0) {
    throw new Error(`Refusing to freeze migrations:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
  const added = toFrozenMigrations(source).slice(ledger.migrations.length);
  return { ledger: { migrations: [...ledger.migrations, ...added] }, added };
}

/** `npm run db:freeze`: writes the ledger only when something new was frozen. */
export function freezeMigrationLedger(
  migrationsFolder: string,
  ledgerPath: string
): FrozenMigration[] {
  const { ledger, added } = freezeMigrations(
    readMigrationLedger(ledgerPath),
    readMigrationSource(migrationsFolder)
  );
  if (added.length > 0) fs.writeFileSync(ledgerPath, serializeMigrationLedger(ledger));
  return added;
}

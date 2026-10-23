import type { PluginDatabase, PluginHostApi } from "@daintreehq/plugin-sdk";
import {
  MAX_NOTES_CHARS,
  MAX_TITLE_CHARS,
  REQUEST_STATUSES,
  type RequestRecord,
  type RequestStatus,
  type UpdateRequestArgs,
  type UpdateRequestResult,
} from "./contracts";

export const DATABASE_ID = "requests";

const MAX_PAGE = 100;

/**
 * Append only: the host runs migration n when the file's `user_version` is n,
 * and `plugin.json` declares `schemaVersion` as this list's length. The demo
 * records are a migration rather than an "if empty" check on start, so they
 * arrive exactly once: a user who deletes them never sees them come back.
 */
export const MIGRATIONS = [
  `CREATE TABLE requests (
     id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
     title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND ${MAX_TITLE_CHARS}),
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (${REQUEST_STATUSES.map((s) => `'${s}'`).join(", ")})),
     notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= ${MAX_NOTES_CHARS}),
     revision INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   ) STRICT;
   CREATE INDEX requests_by_status ON requests (status, updated_at DESC);`,
  `INSERT INTO requests (id, title, status, notes, created_at, updated_at) VALUES
     ('demo-1', 'Add dark mode to the invoice page', 'open', 'Synthetic demo record.', '2026-01-05T09:00:00.000Z', '2026-01-05T09:00:00.000Z'),
     ('demo-2', 'Export customers as CSV', 'in_progress', 'Synthetic demo record.', '2026-01-06T10:30:00.000Z', '2026-01-07T14:00:00.000Z'),
     ('demo-3', 'Fix the broken password reset link', 'done', 'Synthetic demo record.', '2026-01-02T16:45:00.000Z', '2026-01-03T11:20:00.000Z');`,
  // What the synthetic provider keeps about its jobs, and the reports they
  // produced. A real provider holds its jobs on its own side; this one keeps
  // them in the project so the demo survives a restart like a real one would.
  `CREATE TABLE provider_jobs (
     idempotency_key TEXT PRIMARY KEY,
     provider_id TEXT NOT NULL UNIQUE,
     submitted_at INTEGER NOT NULL,
     ready_at INTEGER NOT NULL,
     cancelled INTEGER NOT NULL DEFAULT 0,
     report_id TEXT
   ) STRICT;
   CREATE TABLE reports (
     id TEXT PRIMARY KEY,
     path TEXT NOT NULL,
     request_count INTEGER NOT NULL,
     created_at TEXT NOT NULL
   ) STRICT;`,
];

interface RequestRow {
  id: string;
  title: string;
  status: string;
  notes: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: RequestRow): RequestRecord {
  return {
    id: row.id,
    title: row.title,
    status: row.status as RequestStatus,
    notes: row.notes,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === "string" && (REQUEST_STATUSES as readonly string[]).includes(value);
}

/** Thrown for input a caller can fix; its message is written for them. */
export class RequestInputError extends Error {}

function cleanTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RequestInputError("A request needs a title.");
  }
  const title = value.trim();
  if (title.length > MAX_TITLE_CHARS) {
    throw new RequestInputError(`A title is at most ${MAX_TITLE_CHARS} characters.`);
  }
  return title;
}

function cleanNotes(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new RequestInputError("Notes must be text.");
  if (value.length > MAX_NOTES_CHARS) {
    throw new RequestInputError(`Notes are at most ${MAX_NOTES_CHARS} characters.`);
  }
  return value;
}

export interface RequestStore {
  list(filter?: { status?: RequestStatus; limit?: number }): Promise<RequestRecord[]>;
  get(id: string): Promise<RequestRecord | null>;
  add(input: { title: unknown; notes?: unknown; id?: string }): Promise<RequestRecord>;
  update(args: UpdateRequestArgs): Promise<UpdateRequestResult>;
  snapshot(limit: number): Promise<RequestRecord[]>;
  readonly db: PluginDatabase;
}

/**
 * Open lazily, from the first handler or tool that needs it: a project
 * database asks the user for write consent the first time, and activation must
 * not wait on a prompt. The promise is kept so every caller shares one open,
 * and dropped on failure so a declined prompt can be asked again.
 */
export function createStoreOpener(
  host: Pick<PluginHostApi, "db">,
  onOpen: (store: RequestStore) => void
): () => Promise<RequestStore> {
  let opening: Promise<RequestStore> | undefined;
  return () =>
    (opening ??= host.db
      .open(DATABASE_ID, { migrations: MIGRATIONS })
      .then((db) => {
        const store = createStore(db);
        onOpen(store);
        return store;
      })
      .catch((error: unknown) => {
        opening = undefined;
        throw error;
      }));
}

export function createStore(db: PluginDatabase, now: () => Date = () => new Date()): RequestStore {
  const stamp = () => now().toISOString();

  async function get(id: string): Promise<RequestRecord | null> {
    const row = (await db.get("SELECT * FROM requests WHERE id = ?", [id])) as
      RequestRow | undefined;
    return row ? toRecord(row) : null;
  }

  return {
    db,
    get,
    async list(filter = {}) {
      const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 50)), MAX_PAGE);
      const rows = (filter.status
        ? await db.query(
            "SELECT * FROM requests WHERE status = ? ORDER BY updated_at DESC, id LIMIT ?",
            [filter.status, limit]
          )
        : await db.query("SELECT * FROM requests ORDER BY updated_at DESC, id LIMIT ?", [
            limit,
          ])) as unknown as RequestRow[];
      return rows.map(toRecord);
    },
    async add(input) {
      const title = cleanTitle(input.title);
      const notes = cleanNotes(input.notes);
      const id = input.id ?? `req-${crypto.randomUUID().slice(0, 8)}`;
      const at = stamp();
      // An agent that retries a timed-out call with the same id gets the row it
      // already made instead of a duplicate.
      const existing = await get(id);
      if (existing) return existing;
      await db.run(
        "INSERT INTO requests (id, title, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [id, title, notes, at, at]
      );
      return (await get(id))!;
    },
    async update(args) {
      const current = await get(args.id);
      if (!current) return { ok: false, reason: "not-found" };
      if (current.revision !== args.revision) return { ok: false, reason: "conflict", current };
      if (args.status !== undefined && !isRequestStatus(args.status)) {
        throw new RequestInputError(`Status must be one of ${REQUEST_STATUSES.join(", ")}.`);
      }
      const title = args.title === undefined ? current.title : cleanTitle(args.title);
      const notes = args.notes === undefined ? current.notes : cleanNotes(args.notes);
      const { changes } = await db.run(
        `UPDATE requests SET title = ?, status = ?, notes = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [title, args.status ?? current.status, notes, stamp(), args.id, args.revision]
      );
      const after = await get(args.id);
      if (!after) return { ok: false, reason: "not-found" };
      // Someone else wrote between the read and the update: the WHERE kept
      // their change, so report it rather than claim ours landed.
      if (changes === 0) return { ok: false, reason: "conflict", current: after };
      return { ok: true, request: after };
    },
    async snapshot(limit) {
      const rows = (await db.query(
        "SELECT * FROM requests ORDER BY status, updated_at DESC, id LIMIT ?",
        [limit]
      )) as unknown as RequestRow[];
      return rows.map(toRecord);
    },
  };
}

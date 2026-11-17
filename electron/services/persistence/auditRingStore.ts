// eager-import-allow: reads/writes audit ring records via the shared SQLite DB
import type Database from "better-sqlite3";
import {
  applyRingDelta,
  prepareRingStatements,
  replaceRing,
  type RingRow,
  type RingStatements,
} from "./auditRingSql.js";
import { getSharedSqlite } from "./db.js";
import { fenceDbWorkerWrites, isDbWorkerFenceIntact, runDbWork } from "./dbWorkerClient.js";

export type AuditRingName =
  | "mcpAuditLog"
  | "mcpTurnOutcomeLog"
  | "pluginAuditLog"
  | "forgeAuditLog"
  | "runHistoryRecords"
  | "pluginMcpAuditLog";

interface RingTarget {
  rows: RingRow[];
  maxRecords: number;
  // Every row carries a unique string id, so it can be diffed by key.
  keyed: boolean;
}

interface RingState {
  // Bumped by every synchronous write; a background write that settles under
  // an older generation must not touch `acked` — the sync write owns it now.
  generation: number;
  // What the DB is known to hold for this ring (id -> serialized record, in
  // row order), or null when unknown: never written this session, a write was
  // dropped or failed, or the rows are not keyed. Advanced only after a write
  // is acknowledged, never optimistically — a delta computed on top of a
  // write that later turns out to be fenced would lose that write's records.
  acked: Map<string, string> | null;
  // At most one background write per ring is in flight; later snapshots
  // coalesce into `pending` and are diffed against the acknowledged state
  // once the current write settles.
  inFlight: boolean;
  pending: RingTarget | null;
}

interface RingDelta {
  upserts: RingRow[];
  deletes: string[];
}

// A plain object's or array's contents when it was serialized: `keys` is null
// for an array, and each value is a primitive or a nested Shape.
interface Shape {
  keys: string[] | null;
  values: unknown[];
}

interface SerializedRecord {
  json: string;
  shape: Shape;
}

/**
 * SQLite-backed ring buffer replacing the electron-store audit-logs JSON file.
 * Owners hand over their whole in-memory array on every flush; the store diffs
 * it against the ring's last acknowledged contents by record id and persists
 * only the change (keyed upserts and deletes), so a flush that appends one
 * record writes one row instead of rewriting the ring. Anything a keyed delta
 * cannot express — the first write of a session, records without unique ids,
 * reordered survivors, recovery after a dropped write, synchronous flushes —
 * goes through an atomic full replacement instead.
 */
export class AuditRingStore {
  private sqlite: Database.Database | null = null;
  private stmts: RingStatements | null = null;
  private readStmt: Database.Statement | null = null;
  private readonly rings = new Map<AuditRingName, RingState>();
  // Owners hand over the same record objects flush after flush, so a record
  // whose contents still match what was serialized reuses that string instead
  // of re-serializing the whole retained ring for a one-record change.
  private readonly serialized = new WeakMap<object, SerializedRecord>();

  private db(): Database.Database | null {
    if (!this.sqlite) {
      this.sqlite = getSharedSqlite();
    }
    return this.sqlite;
  }

  private prepareAll(sqlite: Database.Database): RingStatements {
    if (!this.stmts) {
      this.stmts = prepareRingStatements(sqlite);
      this.readStmt = sqlite.prepare(
        "SELECT record FROM audit_rings WHERE ring = ? ORDER BY id ASC"
      );
    }
    return this.stmts;
  }

  private state(ring: AuditRingName): RingState {
    let state = this.rings.get(ring);
    if (!state) {
      state = { generation: 0, acked: null, inFlight: false, pending: null };
      this.rings.set(ring, state);
    }
    return state;
  }

  /** Read all persisted records for a ring, oldest first. Returns [] if none. */
  readAll<T>(ring: AuditRingName): T[] {
    const sqlite = this.db();
    if (!sqlite) return [];
    try {
      this.prepareAll(sqlite);
      const rows = this.readStmt!.all(ring) as { record: string }[];
      return rows
        .map((row) => {
          try {
            return JSON.parse(row.record) as T;
          } catch {
            return null;
          }
        })
        .filter((r): r is T => r !== null);
    } catch (error) {
      console.warn(`[AuditRingStore] readAll failed for "${ring}":`, error);
      return [];
    }
  }

  /**
   * Persist the ring's new contents, trimmed to the newest `maxRecords`.
   *
   * Background writes run on the DB worker thread (falling back to the main
   * connection when it is unavailable) and are safe to defer because every
   * ring's owner hydrates via readAll BEFORE its first write and treats its
   * in-memory array as the source of truth afterwards.
   *
   * `options.sync` is for flushNow()-style critical moments (clear, dispose,
   * session teardown) that need the contents durable on return: a full
   * replacement runs synchronously on the main connection, after advancing the
   * write fence so a write still queued on the worker can never land on top of
   * it — which is also what keeps a pre-clear delta from resurrecting history.
   */
  writeAll<T>(
    ring: AuditRingName,
    records: T[],
    maxRecords: number,
    options?: { sync?: boolean }
  ): void {
    let target: RingTarget;
    try {
      // A sync write is the durability backstop, so it serializes exactly as
      // it always has and leaves the cache alone.
      target = toTarget(
        records,
        maxRecords,
        options?.sync ? (record) => JSON.stringify(record) : (record) => this.serialize(record)
      );
    } catch (error) {
      console.warn(`[AuditRingStore] writeAll failed for "${ring}":`, error);
      return;
    }
    const state = this.state(ring);
    if (options?.sync) {
      state.generation++;
      state.pending = null;
      const fenced = fenceDbWorkerWrites(ring);
      const applied = this.replaceOnMain(ring, target);
      // An unfenced worker write can still land on top of this one, so the DB
      // contents are unknown until the next full replacement.
      state.acked = applied === true && fenced ? ackedOf(target) : null;
      return;
    }
    state.pending = target;
    if (!state.inFlight) {
      this.dispatch(ring, state);
    }
  }

  /**
   * Owners update retained records in place (pre-auth coalescing) and records
   * can alias caller-owned objects, so identity alone cannot vouch for a
   * cached string. The string is the JSON of a snapshot taken in a single
   * read of the record, reused only while the record still reads exactly that
   * snapshot; caching is best-effort, and anything the snapshot cannot vouch
   * for takes the plain JSON.stringify path.
   */
  private serialize(record: unknown): string {
    if (typeof record !== "object" || record === null) return JSON.stringify(record);
    let shape: Shape | null;
    try {
      const cached = this.serialized.get(record);
      if (cached && matchesShape(record, cached.shape)) return cached.json;
      shape = shapeOf(record, 0);
    } catch {
      shape = null;
    }
    if (!shape) {
      this.serialized.delete(record);
      return JSON.stringify(record);
    }
    const json = JSON.stringify(materialize(shape));
    this.serialized.set(record, { json, shape });
    return json;
  }

  private dispatch(ring: AuditRingName, state: RingState): void {
    const target = state.pending;
    if (!target) return;
    state.pending = null;
    // After a failed fence a stale worker write can land behind any later one,
    // so only full replacements (which repair whatever it changed) are safe.
    const delta =
      state.acked && target.keyed && isDbWorkerFenceIntact()
        ? diffRows(state.acked, target.rows)
        : null;
    if (delta && delta.upserts.length === 0 && delta.deletes.length === 0) return;

    const generation = state.generation;
    state.inFlight = true;
    const write: Promise<unknown> = delta
      ? runDbWork({ op: "ringApply", ring, upserts: delta.upserts, deletes: delta.deletes }, () =>
          this.applyOnMain(ring, delta)
        )
      : runDbWork(
          { op: "ringWriteAll", ring, rows: target.rows, maxRecords: target.maxRecords },
          () => this.replaceOnMain(ring, target)
        );
    void write
      .catch((error: unknown) => {
        console.warn(`[AuditRingStore] writeAll failed for "${ring}":`, error);
        return undefined;
      })
      .then((result) => this.settle(ring, state, generation, target, result));
  }

  /**
   * `result` is `true` when the rows were written, `false` when the worker
   * no-op'd the write because a newer fence epoch beat it, and `undefined`
   * when it was superseded or failed outright.
   */
  private settle(
    ring: AuditRingName,
    state: RingState,
    generation: number,
    target: RingTarget,
    result: unknown
  ): void {
    state.inFlight = false;
    if (generation === state.generation) {
      if (result === true) {
        state.acked = ackedOf(target);
      } else {
        state.acked = null;
        // A fence for another ring (the epoch is DB-wide) or a shutdown drain
        // dropped this write; nothing guarantees the owner flushes again, so
        // re-send its contents as a full replacement. Outright failures are
        // not retried — the next owner flush replaces the ring anyway.
        if (result === false && !state.pending) {
          state.pending = target;
        }
      }
    }
    this.dispatch(ring, state);
  }

  private replaceOnMain(ring: AuditRingName, target: RingTarget): true | undefined {
    const sqlite = this.db();
    if (!sqlite) return undefined;
    try {
      const stmts = this.prepareAll(sqlite);
      return replaceRing(sqlite, stmts, ring, target.rows, target.maxRecords) || undefined;
    } catch (error) {
      console.warn(`[AuditRingStore] writeAll failed for "${ring}":`, error);
      return undefined;
    }
  }

  private applyOnMain(ring: AuditRingName, delta: RingDelta): true | undefined {
    const sqlite = this.db();
    if (!sqlite) return undefined;
    try {
      const stmts = this.prepareAll(sqlite);
      return applyRingDelta(sqlite, stmts, ring, delta.upserts, delta.deletes) || undefined;
    } catch (error) {
      console.warn(`[AuditRingStore] writeAll failed for "${ring}":`, error);
      return undefined;
    }
  }
}

function recordIdOf(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return null;
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

// Deeper data is serialized every time; it also keeps a cyclic record from
// recursing until the stack overflows before JSON.stringify reports it.
const MAX_SHAPE_DEPTH = 16;

// JSON.stringify reads only own enumerable keys and primitive values of
// these; anything else (class instances such as Date, a toJSON hook anywhere,
// null-prototype objects, functions) is never cached.
function isPlainObject(value: object): value is Record<string, unknown> {
  return (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    !("toJSON" in value)
  );
}

function isPlainArray(value: object): value is unknown[] {
  return (
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && !("toJSON" in value)
  );
}

const UNCACHEABLE = Symbol("uncacheable");

function shapeOf(value: object, depth: number): Shape | null {
  if (depth > MAX_SHAPE_DEPTH) return null;
  if (isPlainArray(value)) {
    const values = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i++) {
      const item = shapeValue(value[i], depth);
      if (item === UNCACHEABLE) return null;
      values[i] = item;
    }
    return { keys: null, values };
  }
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  const values = new Array<unknown>(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const item = shapeValue(value[keys[i]!], depth);
    if (item === UNCACHEABLE) return null;
    values[i] = item;
  }
  return { keys, values };
}

function shapeValue(value: unknown, depth: number): unknown {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "undefined":
      return value;
    case "object":
      return value === null ? null : (shapeOf(value, depth + 1) ?? UNCACHEABLE);
    default:
      return UNCACHEABLE;
  }
}

function matchesShape(value: object, shape: Shape): boolean {
  const { keys, values } = shape;
  if (keys === null) {
    if (!isPlainArray(value) || value.length !== values.length) return false;
    for (let i = 0; i < values.length; i++) {
      if (!matchesValue(value[i], values[i])) return false;
    }
    return true;
  }
  if (!isPlainObject(value)) return false;
  const liveKeys = Object.keys(value);
  if (liveKeys.length !== keys.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (liveKeys[i] !== key || !matchesValue(value[key], values[i])) return false;
  }
  return true;
}

function matchesValue(value: unknown, expected: unknown): boolean {
  if (typeof expected === "object" && expected !== null) {
    return typeof value === "object" && value !== null && matchesShape(value, expected as Shape);
  }
  return value === expected;
}

// Plain data rebuilt from a snapshot. Null-prototype objects, so an own
// "__proto__" key stays an own key.
function materialize(shape: Shape): unknown {
  const { keys, values } = shape;
  if (keys === null) return values.map(materializeValue);
  const out = Object.create(null) as Record<string, unknown>;
  for (let i = 0; i < keys.length; i++) out[keys[i]!] = materializeValue(values[i]);
  return out;
}

function materializeValue(value: unknown): unknown {
  return typeof value === "object" && value !== null ? materialize(value as Shape) : value;
}

function toTarget<T>(
  records: T[],
  maxRecords: number,
  serialize: (record: T) => string
): RingTarget {
  // Trim here rather than relying on the SQL trim, so the rows written are
  // exactly the rows the acknowledged state records.
  const retained =
    maxRecords > 0 && records.length > maxRecords ? records.slice(-maxRecords) : records;
  const ids = retained.map(recordIdOf);
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let keyed = true;
  const rows = retained.map((record, i) => {
    let recordId = ids[i] ?? null;
    // Duplicate ids would collide on the (ring, record_id) unique index; store
    // every occurrence unkeyed so a full replacement still keeps them all.
    if (recordId === null || counts.get(recordId)! > 1) {
      recordId = null;
      keyed = false;
    }
    return { recordId, record: serialize(record) };
  });
  return { rows, maxRecords, keyed };
}

function ackedOf(target: RingTarget): Map<string, string> | null {
  if (!target.keyed) return null;
  return new Map(target.rows.map((row) => [row.recordId!, row.record]));
}

/**
 * Keyed delta from `acked` to `rows`, or null when one cannot preserve order:
 * rows are ordered by their numeric id, which an upsert keeps and an insert
 * allocates at the end, so surviving records must keep their relative order
 * and every new record must come after all of them.
 */
function diffRows(acked: Map<string, string>, rows: RingRow[]): RingDelta | null {
  const position = new Map<string, number>();
  let i = 0;
  for (const id of acked.keys()) position.set(id, i++);

  const upserts: RingRow[] = [];
  const survivors = new Set<string>();
  let lastPosition = -1;
  let sawNew = false;
  for (const row of rows) {
    const id = row.recordId!;
    const previous = acked.get(id);
    if (previous === undefined) {
      sawNew = true;
      upserts.push(row);
      continue;
    }
    const at = position.get(id)!;
    if (sawNew || at < lastPosition) return null;
    lastPosition = at;
    survivors.add(id);
    if (previous !== row.record) upserts.push(row);
  }
  const deletes: string[] = [];
  for (const id of acked.keys()) {
    if (!survivors.has(id)) deletes.push(id);
  }
  return { upserts, deletes };
}

export const auditRingStore = new AuditRingStore();

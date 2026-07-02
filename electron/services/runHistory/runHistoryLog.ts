import { randomUUID } from "node:crypto";
import type {
  RecipeRunHistoryRecord,
  FleetRunHistoryRecord,
  RunHistoryAppendInput,
  RunHistoryRecord,
  RunHistoryTargetOutcome,
} from "../../../shared/types/ipc/runHistory.js";
import {
  RUN_HISTORY_DEFAULT_MAX_RECORDS,
  RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH,
  RUN_HISTORY_MAX_TARGETS,
  RUN_HISTORY_REASON_MAX_LENGTH,
  RUN_HISTORY_SCHEMA_VERSION,
  RUN_HISTORY_TITLE_MAX_LENGTH,
} from "../../../shared/types/ipc/runHistory.js";

/**
 * Debounce window for flushing the ring buffer to disk. Rapid recipe/fleet runs
 * must not trigger one synchronous store write each; mirrors the forge audit
 * service's `FORGE_AUDIT_FLUSH_DEBOUNCE_MS`.
 */
const RUN_HISTORY_FLUSH_DEBOUNCE_MS = 2000;

function clampString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Defensively normalize a persisted record's array fields. Records written by
 * {@link RunHistoryLog.append} always have these; this guards against corrupted
 * or hand-edited on-disk JSON so consumers can dereference them unconditionally.
 */
function backfillRecord(record: RunHistoryRecord): RunHistoryRecord {
  if (record.kind === "recipe") {
    return {
      ...record,
      spawned: Array.isArray(record.spawned) ? record.spawned : [],
      failed: Array.isArray(record.failed) ? record.failed : [],
    };
  }
  if (record.kind === "fleet") {
    return {
      ...record,
      perTarget: Array.isArray(record.perTarget) ? record.perTarget : [],
    };
  }
  return record;
}

function sanitizeTarget(raw: RunHistoryTargetOutcome): RunHistoryTargetOutcome {
  const out: RunHistoryTargetOutcome = {
    terminalId: String(raw.terminalId),
    status: raw.status === "rejected" ? "rejected" : "fulfilled",
  };
  const title = clampString(raw.title, RUN_HISTORY_TITLE_MAX_LENGTH);
  if (title !== undefined) out.title = title;
  const reason = clampString(raw.reason, RUN_HISTORY_REASON_MAX_LENGTH);
  if (reason !== undefined) out.reason = reason;
  return out;
}

/**
 * Pure, store-free ring buffer for durable run-history records. Persistence is
 * injected via the `saveRecords` / `readRecords` callbacks so the class stays
 * unit-testable (mirrors `ForgeAuditService`'s separation from the store key).
 * The wiring to the `runHistory` electron-store key lives in
 * `runHistoryService.ts`.
 */
export class RunHistoryLog {
  private records: RunHistoryRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrated = false;

  constructor(
    private readonly saveRecords: (
      records: RunHistoryRecord[],
      options?: { sync?: boolean }
    ) => void,
    private readonly readRecords: () => unknown,
    private readonly maxRecords: number = RUN_HISTORY_DEFAULT_MAX_RECORDS
  ) {}

  hydrate(): void {
    if (this.hydrated) return;
    const persisted = this.readRecords();
    const safe = Array.isArray(persisted)
      ? persisted
          .filter(
            (r: unknown): r is RunHistoryRecord =>
              r !== null && typeof r === "object" && "kind" in (r as object)
          )
          // Backfill the array fields so a corrupted / hand-edited store can't
          // crash a consumer that dereferences `spawned`/`failed`/`perTarget`
          // (e.g. the Settings viewer). The append() path always writes these,
          // but on-disk JSON is not trusted (mirrors the MCP audit backfill).
          .map(backfillRecord)
      : [];
    this.records = safe.length > this.maxRecords ? safe.slice(safe.length - this.maxRecords) : safe;
    this.hydrated = true;
  }

  /**
   * Append a completed run. The renderer supplies the outcome; this method is
   * authoritative for `id`, `schemaVersion`, and `timestamp` and caps every
   * free-text/array field before persisting. Returns the stored record so the
   * IPC layer can broadcast the fresh snapshot.
   */
  append(input: RunHistoryAppendInput): RunHistoryRecord {
    this.hydrate();

    const base = {
      id: randomUUID(),
      schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
      timestamp: Date.now(),
      ...(typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
        ? { durationMs: Math.max(0, Math.round(input.durationMs)) }
        : {}),
    };

    let record: RunHistoryRecord;
    if (input.kind === "recipe") {
      const recipe: RecipeRunHistoryRecord = {
        ...base,
        kind: "recipe",
        recipeName: clampString(input.recipeName, RUN_HISTORY_TITLE_MAX_LENGTH) ?? "Recipe",
        totalTerminals: Math.max(0, Math.round(input.totalTerminals ?? 0)),
        spawned: (input.spawned ?? []).slice(0, RUN_HISTORY_MAX_TARGETS).map((s) => {
          const entry: { index: number; terminalId: string; title?: string } = {
            index: Math.max(0, Math.round(s.index)),
            terminalId: String(s.terminalId),
          };
          const title = clampString(s.title, RUN_HISTORY_TITLE_MAX_LENGTH);
          if (title !== undefined) entry.title = title;
          return entry;
        }),
        failed: (input.failed ?? []).slice(0, RUN_HISTORY_MAX_TARGETS).map((f) => ({
          index: Math.max(0, Math.round(f.index)),
          error: clampString(f.error, RUN_HISTORY_REASON_MAX_LENGTH) ?? "Unknown error",
        })),
      };
      if (input.recipeId) recipe.recipeId = String(input.recipeId);
      if (input.worktreeId) recipe.worktreeId = String(input.worktreeId);
      const worktreeName = clampString(input.worktreeName, RUN_HISTORY_TITLE_MAX_LENGTH);
      if (worktreeName !== undefined) recipe.worktreeName = worktreeName;
      record = recipe;
    } else {
      const fleet: FleetRunHistoryRecord = {
        ...base,
        kind: "fleet",
        targetCount: Math.max(0, Math.round(input.targetCount ?? 0)),
        successCount: Math.max(0, Math.round(input.successCount ?? 0)),
        failureCount: Math.max(0, Math.round(input.failureCount ?? 0)),
        cancelled: input.cancelled === true,
        perTarget: (input.perTarget ?? []).slice(0, RUN_HISTORY_MAX_TARGETS).map(sanitizeTarget),
      };
      const draftPreview = clampString(input.draftPreview, RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH);
      if (draftPreview !== undefined) fleet.draftPreview = draftPreview;
      record = fleet;
    }

    this.enqueueAndTrim(record);
    return record;
  }

  private enqueueAndTrim(record: RunHistoryRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    this.scheduleFlush();
  }

  /** Newest-first view of the ring buffer. */
  getRecords(): RunHistoryRecord[] {
    this.hydrate();
    return [...this.records].reverse();
  }

  clear(): void {
    this.hydrate();
    this.records = [];
    this.flushNow();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, RUN_HISTORY_FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private flush(sync = false): void {
    if (!this.hydrated) return;
    try {
      this.saveRecords([...this.records], { sync });
    } catch (err) {
      console.error("[RunHistory] Failed to flush run history:", err);
    }
  }

  // Critical-moment flush (clear, shutdown): persists synchronously on the
  // main connection instead of the fire-and-forget worker path, so the
  // snapshot is durable when this returns.
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush(true);
  }
}

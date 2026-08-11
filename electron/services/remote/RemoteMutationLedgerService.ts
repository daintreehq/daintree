import { createHash } from "node:crypto";
import { and, asc, eq, lte, ne } from "drizzle-orm";
import { RemoteOpaqueIdSchema } from "../../../shared/types/remote/index.js";
import type { AppDb } from "../persistence/db.js";
import { remoteMutationLedger } from "../persistence/schema.js";

export const REMOTE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_REMOTE_IDEMPOTENCY_RECORDS = 10_000;

export type RemoteMutationOperation = "agent.launch" | "prompt.submit";
export type RemoteMutationOutcome = "committed" | "rejected" | "unknown";
export type RemoteMutationResultCode =
  | "queued"
  | "created"
  | "invalid-target"
  | "unauthorized"
  | "unavailable"
  | "stale-generation"
  | "not-live"
  | "revoked"
  | "capability-denied"
  | "cancelled"
  | "internal-error"
  | "commit-in-progress"
  | "rate-limited";

const REMOTE_MUTATION_RESULT_CODES = new Set<RemoteMutationResultCode>([
  "queued",
  "created",
  "invalid-target",
  "unauthorized",
  "unavailable",
  "stale-generation",
  "not-live",
  "revoked",
  "capability-denied",
  "cancelled",
  "internal-error",
  "commit-in-progress",
  "rate-limited",
]);

export interface RemoteMutationResult {
  outcome: RemoteMutationOutcome;
  resultCode?: RemoteMutationResultCode;
  createdResourceId?: string;
}

export interface RemoteMutationRequest {
  deviceId: string;
  idempotencyKey: string;
  operation: RemoteMutationOperation;
  arguments: unknown;
}

export interface RemoteMutationExecution {
  replayed: boolean;
  result: RemoteMutationResult;
}

export class RemoteIdempotencyConflictError extends Error {
  readonly code = "CONFLICT" as const;

  constructor() {
    super("Idempotency key was already used for a different operation");
    this.name = "RemoteIdempotencyConflictError";
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Mutation arguments require finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  throw new Error("Mutation arguments contain an unsupported value");
}

export function remoteMutationFingerprint(
  operation: RemoteMutationOperation,
  args: unknown
): string {
  const canonical = JSON.stringify({ operation, arguments: canonicalize(args) });
  return `sha256:${createHash("sha256").update(canonical).digest("base64url")}`;
}

function reservedResourceId(request: RemoteMutationRequest): string | null {
  if (request.operation !== "agent.launch" || !request.arguments) return null;
  if (typeof request.arguments !== "object" || !("requestedPanelId" in request.arguments)) {
    return null;
  }
  const requestedPanelId = (request.arguments as { requestedPanelId?: unknown }).requestedPanelId;
  if (typeof requestedPanelId !== "string") return null;
  return RemoteOpaqueIdSchema.parse(requestedPanelId);
}

export class RemoteMutationLedgerService {
  constructor(
    private readonly db: AppDb,
    private readonly now: () => number = Date.now
  ) {}

  async execute(
    request: RemoteMutationRequest,
    effect: () => Promise<RemoteMutationResult>
  ): Promise<RemoteMutationExecution> {
    const digest = remoteMutationFingerprint(request.operation, request.arguments);
    RemoteOpaqueIdSchema.parse(request.deviceId);
    RemoteOpaqueIdSchema.parse(request.idempotencyKey);
    const existing = this.begin(request, digest);
    if (existing) return { replayed: true, result: existing };

    let result: RemoteMutationResult;
    try {
      result = this.validateResult(await effect());
    } catch {
      result = { outcome: "rejected", resultCode: "internal-error" };
    }
    this.complete(request, digest, result);
    return { replayed: false, result };
  }

  recoverInterrupted(): void {
    const recoveredAt = this.now();
    this.db
      .update(remoteMutationLedger)
      .set({
        outcome: "unknown",
        resultCode: "internal-error",
        committedAt: recoveredAt,
        expiresAt: recoveredAt + REMOTE_IDEMPOTENCY_TTL_MS,
      })
      .where(eq(remoteMutationLedger.outcome, "pending"))
      .run();
  }

  async retryUnknown(
    request: RemoteMutationRequest,
    effect: () => Promise<RemoteMutationResult>
  ): Promise<RemoteMutationExecution> {
    const digest = remoteMutationFingerprint(request.operation, request.arguments);
    const resourceId = reservedResourceId(request);
    RemoteOpaqueIdSchema.parse(request.deviceId);
    RemoteOpaqueIdSchema.parse(request.idempotencyKey);
    const claimed = this.db.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(remoteMutationLedger)
          .where(
            and(
              eq(remoteMutationLedger.deviceId, request.deviceId),
              eq(remoteMutationLedger.idempotencyKey, request.idempotencyKey)
            )
          )
          .get();
        if (!row) throw new Error("Remote mutation reservation was not found");
        if (row.operationType !== request.operation || row.argumentDigest !== digest) {
          throw new RemoteIdempotencyConflictError();
        }
        if (row.outcome !== "unknown") return false;
        const update = tx
          .update(remoteMutationLedger)
          .set({
            outcome: "pending",
            resultCode: null,
            createdResourceId: resourceId,
            committedAt: null,
            expiresAt: this.now() + REMOTE_IDEMPOTENCY_TTL_MS,
          })
          .where(
            and(
              eq(remoteMutationLedger.deviceId, request.deviceId),
              eq(remoteMutationLedger.idempotencyKey, request.idempotencyKey),
              eq(remoteMutationLedger.argumentDigest, digest),
              eq(remoteMutationLedger.outcome, "unknown")
            )
          )
          .run();
        return update.changes === 1;
      },
      { behavior: "immediate" }
    );
    if (!claimed) {
      return {
        replayed: true,
        result: this.status(request.deviceId, request.idempotencyKey) ?? {
          outcome: "unknown",
          resultCode: "internal-error",
        },
      };
    }

    let result: RemoteMutationResult;
    try {
      result = this.validateResult(await effect());
    } catch {
      result = { outcome: "rejected", resultCode: "internal-error" };
    }
    this.complete(request, digest, result);
    return { replayed: false, result };
  }

  status(deviceId: string, idempotencyKey: string): RemoteMutationResult | null {
    RemoteOpaqueIdSchema.parse(deviceId);
    RemoteOpaqueIdSchema.parse(idempotencyKey);
    const row = this.db
      .select()
      .from(remoteMutationLedger)
      .where(
        and(
          eq(remoteMutationLedger.deviceId, deviceId),
          eq(remoteMutationLedger.idempotencyKey, idempotencyKey)
        )
      )
      .get();
    if (!row) return null;
    if (row.outcome !== "pending" && row.expiresAt <= this.now()) {
      this.db
        .delete(remoteMutationLedger)
        .where(
          and(
            eq(remoteMutationLedger.deviceId, deviceId),
            eq(remoteMutationLedger.idempotencyKey, idempotencyKey),
            ne(remoteMutationLedger.outcome, "pending")
          )
        )
        .run();
      return null;
    }
    if (row.outcome === "pending") {
      return { outcome: "unknown", resultCode: "commit-in-progress" };
    }
    if (
      !new Set<RemoteMutationOutcome>(["committed", "rejected", "unknown"]).has(
        row.outcome as RemoteMutationOutcome
      )
    ) {
      return { outcome: "unknown", resultCode: "internal-error" };
    }
    return {
      outcome: row.outcome as RemoteMutationOutcome,
      ...(row.resultCode &&
      REMOTE_MUTATION_RESULT_CODES.has(row.resultCode as RemoteMutationResultCode)
        ? { resultCode: row.resultCode as RemoteMutationResultCode }
        : {}),
      ...(row.createdResourceId ? { createdResourceId: row.createdResourceId } : {}),
    };
  }

  reconcile(request: RemoteMutationRequest, result: RemoteMutationResult): RemoteMutationResult {
    const digest = remoteMutationFingerprint(request.operation, request.arguments);
    RemoteOpaqueIdSchema.parse(request.deviceId);
    RemoteOpaqueIdSchema.parse(request.idempotencyKey);
    const validated = this.validateResult(result);
    return this.db.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(remoteMutationLedger)
          .where(
            and(
              eq(remoteMutationLedger.deviceId, request.deviceId),
              eq(remoteMutationLedger.idempotencyKey, request.idempotencyKey)
            )
          )
          .get();
        if (!row) throw new Error("Remote mutation reservation was not found");
        if (row.operationType !== request.operation || row.argumentDigest !== digest) {
          throw new RemoteIdempotencyConflictError();
        }
        if (row.outcome === "committed" || row.outcome === "rejected") {
          return {
            outcome: row.outcome,
            ...(row.resultCode ? { resultCode: row.resultCode as RemoteMutationResultCode } : {}),
            ...(row.createdResourceId ? { createdResourceId: row.createdResourceId } : {}),
          };
        }
        const committedAt = this.now();
        tx.update(remoteMutationLedger)
          .set({
            outcome: validated.outcome,
            resultCode: validated.resultCode ?? null,
            createdResourceId: validated.createdResourceId ?? null,
            committedAt,
            expiresAt: committedAt + REMOTE_IDEMPOTENCY_TTL_MS,
          })
          .where(
            and(
              eq(remoteMutationLedger.deviceId, request.deviceId),
              eq(remoteMutationLedger.idempotencyKey, request.idempotencyKey),
              eq(remoteMutationLedger.argumentDigest, digest),
              eq(remoteMutationLedger.outcome, row.outcome)
            )
          )
          .run();
        return validated;
      },
      { behavior: "immediate" }
    );
  }

  private validateResult(result: RemoteMutationResult): RemoteMutationResult {
    if (result.createdResourceId) RemoteOpaqueIdSchema.parse(result.createdResourceId);
    if (result.resultCode && !REMOTE_MUTATION_RESULT_CODES.has(result.resultCode)) {
      throw new Error("Remote mutation result code is invalid");
    }
    return result;
  }

  private begin(request: RemoteMutationRequest, digest: string): RemoteMutationResult | null {
    return this.db.transaction(
      (tx) => {
        const now = this.now();
        tx.delete(remoteMutationLedger)
          .where(
            and(
              lte(remoteMutationLedger.expiresAt, now),
              ne(remoteMutationLedger.outcome, "pending")
            )
          )
          .run();
        const existing = tx
          .select()
          .from(remoteMutationLedger)
          .where(
            and(
              eq(remoteMutationLedger.deviceId, request.deviceId),
              eq(remoteMutationLedger.idempotencyKey, request.idempotencyKey)
            )
          )
          .get();
        if (existing) {
          if (existing.operationType !== request.operation || existing.argumentDigest !== digest) {
            throw new RemoteIdempotencyConflictError();
          }
          if (existing.outcome === "pending") {
            return { outcome: "unknown", resultCode: "commit-in-progress" };
          }
          if (
            !new Set<RemoteMutationOutcome>(["committed", "rejected", "unknown"]).has(
              existing.outcome as RemoteMutationOutcome
            )
          ) {
            throw new Error("Stored remote mutation outcome is invalid");
          }
          if (
            existing.resultCode !== null &&
            !REMOTE_MUTATION_RESULT_CODES.has(existing.resultCode as RemoteMutationResultCode)
          ) {
            throw new Error("Stored remote mutation result code is invalid");
          }
          return {
            outcome: existing.outcome as RemoteMutationOutcome,
            ...(existing.resultCode
              ? { resultCode: existing.resultCode as RemoteMutationResultCode }
              : {}),
            ...(existing.createdResourceId
              ? { createdResourceId: existing.createdResourceId }
              : {}),
          };
        }

        const resourceId = reservedResourceId(request);
        if (resourceId) {
          const conflicting = tx
            .select({ deviceId: remoteMutationLedger.deviceId })
            .from(remoteMutationLedger)
            .where(
              and(
                eq(remoteMutationLedger.operationType, "agent.launch"),
                eq(remoteMutationLedger.createdResourceId, resourceId),
                ne(remoteMutationLedger.outcome, "rejected")
              )
            )
            .get();
          if (conflicting) throw new RemoteIdempotencyConflictError();
        }

        const rows = tx
          .select({
            deviceId: remoteMutationLedger.deviceId,
            key: remoteMutationLedger.idempotencyKey,
          })
          .from(remoteMutationLedger)
          .where(ne(remoteMutationLedger.outcome, "pending"))
          .orderBy(asc(remoteMutationLedger.createdAt))
          .all();
        const removeCount = Math.max(0, rows.length - (MAX_REMOTE_IDEMPOTENCY_RECORDS - 1));
        for (const row of rows.slice(0, removeCount)) {
          tx.delete(remoteMutationLedger)
            .where(
              and(
                eq(remoteMutationLedger.deviceId, row.deviceId),
                eq(remoteMutationLedger.idempotencyKey, row.key)
              )
            )
            .run();
        }
        tx.insert(remoteMutationLedger)
          .values({
            deviceId: request.deviceId,
            idempotencyKey: request.idempotencyKey,
            operationType: request.operation,
            argumentDigest: digest,
            outcome: "pending",
            createdResourceId: resourceId,
            createdAt: now,
            committedAt: null,
            expiresAt: now + REMOTE_IDEMPOTENCY_TTL_MS,
          })
          .run();
        return null;
      },
      { behavior: "immediate" }
    );
  }

  private complete(
    request: RemoteMutationRequest,
    digest: string,
    result: RemoteMutationResult
  ): void {
    const committedAt = this.now();
    this.db.transaction(
      (tx) => {
        tx.update(remoteMutationLedger)
          .set({
            outcome: result.outcome,
            resultCode: result.resultCode ?? null,
            createdResourceId: result.createdResourceId ?? null,
            committedAt,
            expiresAt: committedAt + REMOTE_IDEMPOTENCY_TTL_MS,
          })
          .where(
            and(
              eq(remoteMutationLedger.deviceId, request.deviceId),
              eq(remoteMutationLedger.idempotencyKey, request.idempotencyKey),
              eq(remoteMutationLedger.argumentDigest, digest),
              eq(remoteMutationLedger.outcome, "pending")
            )
          )
          .run();
        const terminalRows = tx
          .select({
            deviceId: remoteMutationLedger.deviceId,
            key: remoteMutationLedger.idempotencyKey,
          })
          .from(remoteMutationLedger)
          .where(ne(remoteMutationLedger.outcome, "pending"))
          .orderBy(asc(remoteMutationLedger.createdAt))
          .all();
        for (const row of terminalRows.slice(0, -MAX_REMOTE_IDEMPOTENCY_RECORDS)) {
          tx.delete(remoteMutationLedger)
            .where(
              and(
                eq(remoteMutationLedger.deviceId, row.deviceId),
                eq(remoteMutationLedger.idempotencyKey, row.key)
              )
            )
            .run();
        }
      },
      { behavior: "immediate" }
    );
  }
}

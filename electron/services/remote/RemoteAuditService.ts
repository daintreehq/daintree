import { createHash, randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import type { RemoteActivityEvent } from "../../../shared/types/remote/index.js";
import { RemoteOpaqueIdSchema } from "../../../shared/types/remote/index.js";
import type { AppDb } from "../persistence/db.js";
import { remoteAuditEvents } from "../persistence/schema.js";

const MAX_REMOTE_AUDIT_RECORDS = 10_000;

export type RemoteAuditOperation =
  | "connection.start"
  | "connection.end"
  | "pairing.attempt"
  | "pairing.result"
  | "capability.change"
  | "device.rename"
  | "device.revoke"
  | "project.select"
  | "agent.launch.request"
  | "agent.launch.result"
  | "agent.close.request"
  | "agent.close.result"
  | "prompt.submit.result"
  | "console.subscribe.start"
  | "console.subscribe.end"
  | "authorization.failure"
  | "rate.limit"
  | "frame.malformed"
  | "protocol.mismatch"
  | "console.resync";

export type RemoteAuditResult =
  | "started"
  | "ended"
  | "accepted"
  | "committed"
  | "rejected"
  | "revoked"
  | "denied"
  | "limited"
  | "invalid"
  | "conflict"
  | "unknown"
  | "resync-required";

export interface RemoteAuditEventInput {
  actorDeviceId?: string;
  sessionId?: string;
  operation: RemoteAuditOperation;
  result: RemoteAuditResult;
  targetProjectId?: string;
  targetWorktreeId?: string;
  targetPanelId?: string;
  characterCount?: number;
  byteCount?: number;
  contentDigest?: string;
}

export function remoteContentMetadata(content: string): {
  characterCount: number;
  byteCount: number;
  contentDigest: string;
} {
  return {
    characterCount: [...content].length,
    byteCount: Buffer.byteLength(content, "utf8"),
    contentDigest: `sha256:${createHash("sha256").update(content).digest("base64url")}`,
  };
}

export class RemoteAuditService {
  constructor(
    private readonly db: AppDb,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID
  ) {}

  record(event: RemoteAuditEventInput): void {
    try {
      for (const id of [
        event.actorDeviceId,
        event.sessionId,
        event.targetProjectId,
        event.targetWorktreeId,
        event.targetPanelId,
      ]) {
        if (id) RemoteOpaqueIdSchema.parse(id);
      }
      if (event.contentDigest && !/^sha256:[A-Za-z0-9_-]{43}$/.test(event.contentDigest)) {
        throw new Error("Remote audit content digest is invalid");
      }
      this.db.transaction(
        (tx) => {
          tx.insert(remoteAuditEvents)
            .values({
              id: this.createId(),
              actorDeviceId: event.actorDeviceId ?? null,
              sessionId: event.sessionId ?? null,
              operation: event.operation,
              result: event.result,
              targetProjectId: event.targetProjectId ?? null,
              targetWorktreeId: event.targetWorktreeId ?? null,
              targetPanelId: event.targetPanelId ?? null,
              characterCount: event.characterCount ?? null,
              byteCount: event.byteCount ?? null,
              contentDigest: event.contentDigest ?? null,
              occurredAt: this.now(),
            })
            .run();
          const overflow = tx
            .select({ id: remoteAuditEvents.id })
            .from(remoteAuditEvents)
            .orderBy(asc(remoteAuditEvents.occurredAt))
            .all()
            .slice(0, -MAX_REMOTE_AUDIT_RECORDS);
          for (const row of overflow) {
            tx.delete(remoteAuditEvents).where(eq(remoteAuditEvents.id, row.id)).run();
          }
        },
        { behavior: "immediate" }
      );
    } catch (error) {
      console.warn(`[RemoteAudit] Failed to persist ${event.operation}:`, error);
    }
  }

  listRecent(limit = 50): RemoteActivityEvent[] {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    return this.db
      .select({
        id: remoteAuditEvents.id,
        actorDeviceId: remoteAuditEvents.actorDeviceId,
        sessionId: remoteAuditEvents.sessionId,
        operation: remoteAuditEvents.operation,
        result: remoteAuditEvents.result,
        targetProjectId: remoteAuditEvents.targetProjectId,
        targetWorktreeId: remoteAuditEvents.targetWorktreeId,
        targetPanelId: remoteAuditEvents.targetPanelId,
        characterCount: remoteAuditEvents.characterCount,
        byteCount: remoteAuditEvents.byteCount,
        occurredAt: remoteAuditEvents.occurredAt,
      })
      .from(remoteAuditEvents)
      .orderBy(desc(remoteAuditEvents.occurredAt))
      .limit(boundedLimit)
      .all();
  }
}

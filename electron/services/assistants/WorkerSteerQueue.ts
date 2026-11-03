import { randomUUID } from "node:crypto";
import {
  QUEUED_SEND_TTL_MAX_SECONDS,
  QUEUED_SEND_TTL_MIN_SECONDS,
  type QueuedSendDropReason,
  type QueuedSendRecord,
} from "../../../shared/types/queuedSend.js";
import {
  foreignPromptInputAt,
  foreignPromptInputMoved,
  type PromptInputProvenance,
} from "../../../shared/utils/terminalInputProvenance.js";
import { EXACT_PROMPT_GATE, evaluateWakeGate } from "../../../shared/utils/terminalWakeGate.js";
import type {
  LaneWake,
  LaneWakeCheck,
  LaneWakeEvidence,
  LaneWakeOutcome,
  NotifyTerminalInfo,
  OwnPane,
  PendingNotify,
} from "../mcp-server/terminalNotify.js";

/** The run a held prompt is for, as the steer read it when it was queued. */
export interface HeldRunIdentity extends PromptInputProvenance {
  agentIncarnation?: number;
  agentSessionId?: string;
  worktreeId?: string;
}

export interface HoldSteerRequest {
  /** The steering assistant's ownership principal: one held prompt per principal and worker. */
  principal: string;
  projectId: string;
  terminalId: string;
  generation: number;
  run: HeldRunIdentity;
  /** The line to type: stamped as the Assistant's, with any handback instruction. */
  text: string;
  /** The text as the Assistant wrote it, for the run's first-prompt record. */
  promptAsWritten: string;
  handbackCode?: string;
  ttlSeconds: number;
  /**
   * Asked right before the line is written, long after the call that queued
   * it: everything the call itself was held to but its own MCP session, which
   * may have closed meanwhile. Null while it may go ahead.
   */
  authorize(): { code: string; message: string } | null;
  /** A live steer is writing to the worker now: the held prompt waits its turn. */
  isWriting(): boolean;
  /**
   * Takes the call's `notify`, armed when the call was made, once the prompt
   * is held: completed with the line's token once written, cancelled if it
   * never is. Not called when nothing is held.
   */
  takeNotice?(): PendingNotify | undefined;
}

export interface HoldSteerResult {
  queuedSendToken: string;
  expiresAt: number;
  supersededToken?: string;
}

export interface WorkerSteerQueueDeps {
  /** Queue on the worker's own notice line, so its notices and this share one writer. */
  enqueueWake(pane: OwnPane, projectId: string, wake: LaneWake): void;
  /** The worker's notice line: the key its own notices are held under. */
  paneFor(terminalId: string): OwnPane;
  getLiveGeneration(terminalId: string): number | null;
  getTerminalProjectId(terminalId: string): string | null;
  now?: () => number;
  newToken?: () => string;
}

/** Thrown when a held prompt can't be taken; nothing is held and nothing replaced. */
export class HoldRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`The message couldn't be held: ${reason}.`);
    this.name = "HoldRefusedError";
  }
}

interface Entry {
  readonly record: QueuedSendRecord;
  readonly principal: string;
  readonly projectId: string;
  readonly generation: number;
  readonly run: HeldRunIdentity;
  readonly promptBaseline: number | undefined;
  readonly authorize: HoldSteerRequest["authorize"];
  readonly isWriting: HoldSteerRequest["isWriting"];
  notice?: PendingNotify;
  /** Taken onto a line: from here only the host's record says what became of it. */
  reserved: boolean;
}

/** Ended records kept for status reads, oldest forgotten first. */
const MAX_ENDED_RECORDS = 256;

function clampTtlSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return QUEUED_SEND_TTL_MAX_SECONDS;
  return Math.min(
    QUEUED_SEND_TTL_MAX_SECONDS,
    Math.max(QUEUED_SEND_TTL_MIN_SECONDS, Math.floor(seconds))
  );
}

function pendingKey(principal: string, terminalId: string): string {
  return `${principal}\u0000${terminalId}`;
}

/**
 * Prompts the global Assistant asked to deliver the next time a busy worker
 * waits at its own prompt (#16187). Each rides the worker's own notice line
 * as a lane wake, so one writer types into that prompt, and is checked again
 * right before it is typed exactly as an immediate steer is: the same run,
 * nothing typed since the settle, at its own prompt and not at a question,
 * and still allowed there. Someone else's prompt-capable input since it was
 * held drops it rather than holding it. Kept in memory only; nothing here
 * outlives the app.
 */
export class WorkerSteerQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, string>();
  private readonly ended: string[] = [];
  private disposed = false;

  constructor(private readonly deps: WorkerSteerQueueDeps) {}

  hold(request: HoldSteerRequest): HoldSteerResult {
    if (this.disposed) throw new HoldRefusedError("this host is shutting down");
    const now = this.now();
    const token = this.deps.newToken?.() ?? randomUUID();
    const expiresAt = now + clampTtlSeconds(request.ttlSeconds) * 1_000;
    const entry: Entry = {
      record: {
        queuedSendToken: token,
        terminalId: request.terminalId,
        status: "queued",
        queuedAt: now,
        expiresAt,
        waitingOn: "working",
      },
      principal: request.principal,
      projectId: request.projectId,
      generation: request.generation,
      run: request.run,
      promptBaseline: foreignPromptInputAt(request.run, request.principal),
      authorize: request.authorize,
      isWriting: request.isWriting,
      reserved: false,
    };
    this.entries.set(token, entry);
    const wake: LaneWake = {
      id: token,
      kind: "steer",
      steer: {
        text: request.text,
        promptAsWritten: request.promptAsWritten,
        ...(request.handbackCode !== undefined ? { handbackCode: request.handbackCode } : {}),
      },
      maxPendingMs: expiresAt - now,
      recheck: (info) => this.recheck(entry, info),
      beforeType: () => this.beforeType(entry),
      report: (outcome, evidence) => this.report(entry, outcome, evidence),
    };
    let queueError: unknown;
    try {
      this.deps.enqueueWake(this.deps.paneFor(request.terminalId), request.projectId, wake);
    } catch (err) {
      queueError = err;
    }
    // The engine answers some refusals synchronously, through `report`.
    if (queueError !== undefined || entry.record.status !== "queued") {
      // Ended before it is forgotten, so a wake the engine kept anyway never types it.
      this.end(entry, "dropped", { reason: "stopped" });
      const reason = entry.record.reason;
      this.entries.delete(token);
      throw new HoldRefusedError(
        reason === undefined || reason === "stopped"
          ? "that worker's notice line can't take it right now"
          : `it would be dropped at once (${reason})`
      );
    }
    entry.notice = request.takeNotice?.();
    const key = pendingKey(request.principal, request.terminalId);
    const previousToken = this.pending.get(key);
    this.pending.set(key, token);
    const previous = previousToken === undefined ? undefined : this.entries.get(previousToken);
    let supersededToken: string | undefined;
    if (previous !== undefined && previous.record.status === "queued") {
      supersededToken = previous.record.queuedSendToken;
      // Already on a line, it is no longer this one's to replace.
      if (!previous.reserved) this.end(previous, "superseded", { supersededBy: token });
      else supersededToken = undefined;
    }
    return { queuedSendToken: token, expiresAt, ...(supersededToken ? { supersededToken } : {}) };
  }

  /** What became of `token`, for the principal that queued it; null when this host holds no record. */
  status(principal: string, token: string): QueuedSendRecord | null {
    const entry = this.entries.get(token);
    if (entry === undefined || entry.principal !== principal) return null;
    this.expireIfDue(entry);
    return { ...entry.record };
  }

  /**
   * Withdraw a held prompt not yet on a line. One already handed to the
   * terminal's lane can't be taken back by itself: its record says how far it got.
   */
  cancel(
    principal: string,
    token: string
  ): { cancelled: boolean; record: QueuedSendRecord } | null {
    const entry = this.entries.get(token);
    if (entry === undefined || entry.principal !== principal) return null;
    this.expireIfDue(entry);
    if (entry.record.status !== "queued" || entry.reserved) {
      return { cancelled: false, record: { ...entry.record } };
    }
    this.end(entry, "cancelled");
    return { cancelled: true, record: { ...entry.record } };
  }

  /** The Assistant session behind `principal` ended: nothing it held is typed for a successor. */
  revokePrincipal(principal: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.principal !== principal) continue;
      if (entry.record.status === "queued" && !entry.reserved) {
        this.end(entry, "dropped", { reason: "session-gone" });
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.entries.values()]) {
      if (entry.record.status === "queued" && !entry.reserved) {
        this.end(entry, "dropped", { reason: "stopped" });
      }
    }
  }

  private recheck(entry: Entry, info?: NotifyTerminalInfo): LaneWakeCheck {
    const { terminalId } = entry.record;
    if (entry.record.status !== "queued")
      return { kind: "unavailable", reason: entry.record.status };
    const drop = (reason: QueuedSendDropReason): LaneWakeCheck => {
      this.end(entry, "dropped", { reason });
      return { kind: "unavailable", reason };
    };
    if (this.now() >= entry.record.expiresAt) return drop("expired");
    if (this.deps.getTerminalProjectId(terminalId) !== entry.projectId) return drop("target-gone");
    if (this.deps.getLiveGeneration(terminalId) !== entry.generation) return drop("restarted");
    if (info === undefined) return { kind: "ready" };
    if (
      info.isExited === true ||
      info.hasPty === false ||
      info.isTrashed === true ||
      info.isClosing === true ||
      (info.projectId !== undefined && info.projectId !== entry.projectId)
    ) {
      return drop("target-gone");
    }
    const { run } = entry;
    if (
      info.agentIncarnation !== run.agentIncarnation ||
      (info.launchGeneration !== undefined && info.launchGeneration !== entry.generation) ||
      (run.agentSessionId !== undefined && info.agentSessionId !== run.agentSessionId) ||
      (info.worktreeId ?? "") !== (run.worktreeId ?? "")
    ) {
      return drop("restarted");
    }
    // Keys pressed at an approval dialog are no prompt and let it be;
    // anything the agent could have taken as one means the moment it was
    // queued for has passed.
    if (foreignPromptInputMoved(info, entry.principal, entry.promptBaseline)) return drop("typed");
    if (entry.isWriting()) return this.waiting(entry, "writing");
    // Its own prompt only: an Assistant that never saw a question must not answer it.
    const verdict = evaluateWakeGate(info, EXACT_PROMPT_GATE);
    if (verdict.kind === "ready") return verdict;
    return this.waiting(entry, verdict.reason);
  }

  private waiting(entry: Entry, reason: string): LaneWakeCheck {
    entry.record.waitingOn = reason;
    return { kind: "held", reason };
  }

  private beforeType(entry: Entry): boolean {
    if (entry.record.status !== "queued") return false;
    let refusal: { code: string; message: string } | null;
    try {
      refusal = entry.authorize();
    } catch {
      refusal = { code: "EXECUTION_ERROR", message: "unreadable" };
    }
    if (refusal !== null) {
      this.end(entry, "dropped", { reason: "not-allowed" });
      return false;
    }
    entry.reserved = true;
    delete entry.record.waitingOn;
    return true;
  }

  private report(entry: Entry, outcome: LaneWakeOutcome, evidence?: LaneWakeEvidence): void {
    if (outcome.kind === "held") {
      if (entry.record.status === "queued") entry.record.waitingOn = outcome.reason;
      return;
    }
    if (outcome.kind === "delivered" && entry.reserved) {
      const submissionToken = evidence?.submissionToken;
      if (evidence?.phase !== "pty_written" || submissionToken === undefined) {
        this.end(entry, "unconfirmed");
        return;
      }
      const notice = entry.notice;
      entry.notice = undefined;
      this.end(entry, "delivered", { submissionToken, deliveredAt: this.now() });
      notice?.complete({ submissionToken });
      return;
    }
    if (entry.record.status !== "queued") return;
    if (outcome.kind === "ambiguous" || entry.reserved) {
      this.end(entry, "unconfirmed");
      return;
    }
    this.end(entry, "dropped", {
      reason:
        outcome.kind === "unavailable" && outcome.reason === "expired" ? "expired" : "stopped",
    });
  }

  private expireIfDue(entry: Entry): void {
    if (
      entry.record.status === "queued" &&
      !entry.reserved &&
      this.now() >= entry.record.expiresAt
    ) {
      this.end(entry, "dropped", { reason: "expired" });
    }
  }

  private end(
    entry: Entry,
    status: Exclude<QueuedSendRecord["status"], "queued">,
    fields: Partial<QueuedSendRecord> = {}
  ): void {
    if (entry.record.status !== "queued") return;
    Object.assign(entry.record, fields, { status, endedAt: this.now() });
    delete entry.record.waitingOn;
    const key = pendingKey(entry.principal, entry.record.terminalId);
    if (this.pending.get(key) === entry.record.queuedSendToken) this.pending.delete(key);
    // The notice follows the line, so one with no line written has nothing to follow.
    if (status !== "delivered") {
      const notice = entry.notice;
      entry.notice = undefined;
      notice?.cancel();
    }
    this.ended.push(entry.record.queuedSendToken);
    while (this.ended.length > MAX_ENDED_RECORDS) {
      const oldest = this.ended.shift()!;
      this.entries.delete(oldest);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

import { persistAgentSession, type AgentSessionRecord } from "./agentSessionHistory.js";
import { isClaudeSessionWithoutTranscript } from "../claude/ClaudeSessionStore.js";
import { getAgentSessionRetentionDays } from "./agentSessionRetention.js";
import { getLifecycleLedger } from "./lifecycleLedger.js";
import { events } from "../events.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:AgentSessionJournal");

export interface JournalCloseContext {
  /** Terminal whose close produced this record. */
  terminalId: string;
  /**
   * Launch generation of the closing incarnation. Capture it BEFORE initiating
   * the kill: a restart can respawn the same terminal id mid-close, and the
   * record must stay attributed to the generation that produced it.
   *
   * Three states:
   * - `number` — the frozen generation; gate on it.
   * - omitted (`undefined`) — no generation captured; fall back to the ledger's
   *   current generation (used by callers that resolve it just-in-time).
   * - `null` — the caller froze the generation but the ledger had evicted the
   *   entry (bounded LRU), so it is genuinely UNKNOWN. Journal fail-open and do
   *   NOT consult the current generation: a same-id respawn would otherwise gate
   *   the predecessor's record on the successor's generation and suppress the
   *   successor's real record later (#11340).
   */
  generation?: number | null;
}

async function hasNoClaudeConversation(
  record: Omit<AgentSessionRecord, "savedAt">,
  terminalId: string
): Promise<boolean> {
  try {
    return await isClaudeSessionWithoutTranscript(record, terminalId);
  } catch {
    return false;
  }
}

/**
 * Journal one resumable agent session, exactly once per terminal generation,
 * returning the durable record (or `null` when the write was gated out as a
 * duplicate, or as a Claude session with no conversation to resume). Single
 * funnel for every close path — the trash-expiry capture,
 * the IPC kill / gracefulKill, app shutdown, AND the bookmark-and-close capture
 * (#11288), which passes the same shape with a `bookmark` field set. Main is the
 * journal's only writer; the lifecycle ledger provides the idempotency key
 * `(terminalId, generation)` so overlapping close paths produce one record
 * instead of relying on sessionId-dedupe timing at eviction.
 *
 * Fail-open: a terminal the ledger never saw (spawned before this process
 * instance, ledger evicted) is journaled without gating — losing a resume
 * record is worse than a rare duplicate, which sessionId-dedupe still catches.
 */
export async function journalAgentSessionRecord(
  record: Omit<AgentSessionRecord, "savedAt">,
  ctx: JournalCloseContext
): Promise<AgentSessionRecord | null> {
  const ledger = getLifecycleLedger();
  // A null generation is an explicit "frozen but unknown" — fail open without
  // consulting the current (possibly respawned) generation. Omitted falls back
  // to the current generation; a number gates on itself.
  const generation =
    ctx.generation === null
      ? undefined
      : (ctx.generation ?? ledger.currentGeneration(ctx.terminalId));

  // A Claude pane nobody typed into leaves an assigned id with no conversation
  // behind it (#12371). Journaling it offers a resume that can never open and
  // spends a slot of the per-worktree cap. Judged against the store the pane
  // itself launched against, never a guess. Checked after the generation is
  // frozen, so the wait can't pick up a respawn's, and before the ledger is
  // consulted, so a skip claims nothing. A bookmark is the user's explicit pin
  // and is never second-guessed; a failed lookup journals as before.
  if (!record.bookmark && (await hasNoClaudeConversation(record, ctx.terminalId))) {
    logger.debug(`Skipping journal for ${ctx.terminalId}: no Claude conversation was written`);
    return null;
  }

  // Whether the ledger still knows this terminal is read only now: a bounded
  // ledger can evict it during that wait, and an entry it no longer holds fails
  // open exactly like one it never saw.
  const gatedGeneration =
    generation !== undefined && ledger.currentGeneration(ctx.terminalId) !== undefined
      ? generation
      : undefined;
  if (gatedGeneration !== undefined) {
    const verdict = ledger.recordJournal(ctx.terminalId, gatedGeneration, record.sessionId);
    if (!verdict.accepted) {
      logger.debug(
        `Skipping duplicate journal for ${ctx.terminalId} gen ${gatedGeneration}: ${verdict.reason}`
      );
      return null;
    }
  }

  let persisted: AgentSessionRecord | null;
  try {
    const { app } = await import("electron");
    persisted = await persistAgentSession(
      record,
      app.getPath("userData"),
      getAgentSessionRetentionDays()
    );
  } catch (err) {
    // The mark is a reservation, not a receipt — release it so a retry or a
    // concurrent close path can still journal this generation. Losing the
    // record outright is strictly worse than the duplicate the gate prevents.
    if (gatedGeneration !== undefined) {
      ledger.rescindJournal(ctx.terminalId, gatedGeneration);
    }
    throw err;
  }

  // Signal AFTER the write lands so a refetch it triggers sees the record.
  events.emit("agent-session:recorded", {
    sessionId: record.sessionId,
    worktreeId: record.worktreeId ?? null,
    projectId: record.projectId ?? null,
    timestamp: Date.now(),
  });
  return persisted;
}

/**
 * Boolean-returning close-path funnel — returns true when a record was written.
 * Thin wrapper over {@link journalAgentSessionRecord} so the many close-path
 * callers keep their existing contract; the bookmark capture path uses the
 * record-returning variant directly.
 */
export async function journalAgentSession(
  record: Omit<AgentSessionRecord, "savedAt">,
  ctx: JournalCloseContext
): Promise<boolean> {
  return (await journalAgentSessionRecord(record, ctx)) !== null;
}

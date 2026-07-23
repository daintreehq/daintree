import { persistAgentSession, type AgentSessionRecord } from "./agentSessionHistory.js";
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

/**
 * Journal one resumable agent session, exactly once per terminal generation.
 *
 * Single funnel for every close path (trash expiry via `agent-session:captured`,
 * IPC kill / gracefulKill, app shutdown). Main is the journal's only writer;
 * the lifecycle ledger provides the idempotency key `(terminalId, generation)`
 * so overlapping close paths (a user kill landing mid-shutdown, a trash expiry
 * racing an explicit kill) produce one record instead of relying on
 * sessionId-dedupe timing at eviction.
 *
 * Fail-open: a terminal the ledger never saw (spawned before this process
 * instance, ledger evicted) is journaled without gating — losing a resume
 * record is worse than a rare duplicate, which sessionId-dedupe still catches.
 *
 * Returns true when a record was written.
 */
export async function journalAgentSession(
  record: Omit<AgentSessionRecord, "savedAt">,
  ctx: JournalCloseContext
): Promise<boolean> {
  const ledger = getLifecycleLedger();
  // A null generation is an explicit "frozen but unknown" — fail open without
  // consulting the current (possibly respawned) generation. Omitted falls back
  // to the current generation; a number gates on itself.
  const generation =
    ctx.generation === null
      ? undefined
      : (ctx.generation ?? ledger.currentGeneration(ctx.terminalId));
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
      return false;
    }
  }

  try {
    const { app } = await import("electron");
    await persistAgentSession(record, app.getPath("userData"), getAgentSessionRetentionDays());
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
  return true;
}

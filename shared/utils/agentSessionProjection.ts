import { AgentFacingSessionRecordSchema } from "../types/agentSessionSchemas.js";
import type {
  AgentSessionBookmarkMetadata,
  AgentSessionRecord,
} from "../types/ipc/agentSessionHistory.js";

/**
 * Rebuild bookmark metadata as the lean shape an agent is given (#11530).
 * Allowlist rather than omit/rest-destructuring: a pane-presentation field
 * added to the record later must stay out of MCP output until someone
 * deliberately opts it in here.
 */
function toAgentFacingBookmark(
  bookmark: AgentSessionBookmarkMetadata
): AgentSessionBookmarkMetadata {
  return {
    bookmarkedAt: bookmark.bookmarkedAt,
    label: bookmark.label,
    ...(bookmark.sourceLocation !== undefined && { sourceLocation: bookmark.sourceLocation }),
    ...(bookmark.agentPresetId !== undefined && { agentPresetId: bookmark.agentPresetId }),
    ...(bookmark.originalPresetId !== undefined && { originalPresetId: bookmark.originalPresetId }),
    ...(bookmark.isInputLocked !== undefined && { isInputLocked: bookmark.isInputLocked }),
  };
}

/**
 * Rebuild a journal record as the agent-facing shape (#11530). Applied by BOTH
 * list actions — a bookmarked record surfaces through session history too, so
 * stripping in only one of them would leave the other as an open path for the
 * same pane-presentation fields. Dispatch parses results against `resultSchema`
 * now (#11539), but this stays real code: the records ride under an
 * `z.unknown()` arm that opts out of stripping, so the parse cannot narrow them.
 */
export function toAgentFacingRecord(record: AgentSessionRecord): AgentSessionRecord {
  return {
    sessionId: record.sessionId,
    agentId: record.agentId,
    worktreeId: record.worktreeId,
    title: record.title,
    projectId: record.projectId,
    savedAt: record.savedAt,
    ...(record.agentLaunchFlags !== undefined && { agentLaunchFlags: record.agentLaunchFlags }),
    ...(record.agentModelId !== undefined && { agentModelId: record.agentModelId }),
    ...(record.cwd !== undefined && { cwd: record.cwd }),
    ...(record.branch !== undefined && { branch: record.branch }),
    // Truthiness, not `!== undefined`, only for the nested object: the journal
    // is a plain JSON file on disk and `normalizeRecords` admits any object
    // with a string sessionId, so a hand-edited `"bookmark": null` would reach
    // this projection and throw — taking down a whole listing the journal is
    // documented to survive. The scalar spreads above stay `!== undefined` on
    // purpose so falsy-but-present values (`isInputLocked: false`) survive.
    ...(record.bookmark ? { bookmark: toAgentFacingBookmark(record.bookmark) } : {}),
  };
}

/**
 * Drop projected records the advertised shape cannot carry.
 *
 * `normalizeRecords` (electron/services/pty/agentSessionHistory.ts) deliberately
 * admits any object with a string `sessionId` so a garbage, hand-edited, or
 * newer-schema journal degrades gracefully instead of crashing reads that are
 * documented never to error. Dispatch now parses results against `resultSchema`
 * (#11539), which would turn one degraded row back into exactly that crash — for
 * the whole page, not the row. Filtering here keeps the guarantee: the caller
 * loses the unrepresentable record and nothing else. `session.bookmarks.list`
 * needs this doubly, since it selects on `bookmark !== undefined` and so admits
 * a hand-written `"bookmark": {}` that carries neither `bookmarkedAt` nor
 * `label`.
 */
export function keepRepresentableRecords(records: AgentSessionRecord[]): AgentSessionRecord[] {
  return records.filter((record) => AgentFacingSessionRecordSchema.safeParse(record).success);
}

/**
 * One page of the journal as an agent is handed it. The journal is already
 * newest-first, so the window keeps the most recent records; `hasMore` is
 * computed from the unfiltered slice so a row dropped as unrepresentable can't
 * read as "end of list" and strand the records behind it.
 */
export function pageAgentFacingSessions(
  sessions: AgentSessionRecord[],
  offset: number,
  limit: number
): { sessions: AgentSessionRecord[]; total: number; hasMore: boolean } {
  const total = sessions.length;
  const scanned = sessions.slice(offset, offset + limit);
  return {
    sessions: keepRepresentableRecords(scanned.map(toAgentFacingRecord)),
    total,
    hasMore: offset + scanned.length < total,
  };
}

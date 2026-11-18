import {
  CLAUDE_USAGE_STATEMENTS,
  CLAUDE_USAGE_WINDOWS,
  type ClaudeUsageObservation,
} from "../../../shared/types/ipc/agentQuota.js";

/**
 * The saved form of the Claude Code usage readings (#17610): one versioned
 * JSON document, Main-only like the readings themselves. A reading names the
 * folder the launch that saw it decided it was for, not the pane's own folder
 * and shell, so no later launch has to place it again.
 */
const DOCUMENT_VERSION = 1;

/** How long a reading that named no readable reset is kept, from when it showed. */
export const UNDATED_CLAUDE_USAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SavedClaudeUsageReading extends ClaudeUsageObservation {
  /** The canonical folder the reading was for; null when it couldn't be told. */
  identity: string | null;
}

interface ClaudeUsageDocument {
  version: number;
  readings: SavedClaudeUsageReading[];
}

const WINDOWS = new Set<unknown>(CLAUDE_USAGE_WINDOWS);
const STATEMENTS = new Set<unknown>(CLAUDE_USAGE_STATEMENTS);

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Still current while the app runs: a reading with no reset goes stale a week
 * after it showed, since its limit's name says nothing about how long it lasts.
 * One whose reset has passed is still what a pane showed, and stays.
 */
export function isCurrentClaudeUsageReading(
  reading: Pick<ClaudeUsageObservation, "resetsAt" | "observedAt">,
  now: number
): boolean {
  return reading.resetsAt !== null || now - reading.observedAt < UNDATED_CLAUDE_USAGE_TTL_MS;
}

/**
 * Worth bringing into a new launch: current, with its reset still ahead, and
 * not dated after `now`, which only a clock set back can do and which would
 * outrank every real sighting until that time came round.
 */
export function isRestorableClaudeUsageReading(
  reading: Pick<ClaudeUsageObservation, "resetsAt" | "observedAt">,
  now: number
): boolean {
  return (
    isCurrentClaudeUsageReading(reading, now) &&
    (reading.resetsAt === null || reading.resetsAt > now) &&
    reading.observedAt <= now
  );
}

function parseReading(value: unknown): SavedClaudeUsageReading | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  const { window, statement, usedPercent, resetsAt, terminalId, observedAt, identity } = entry;
  if (
    !WINDOWS.has(window) ||
    !STATEMENTS.has(statement) ||
    !(usedPercent === null || isTime(usedPercent)) ||
    !(resetsAt === null || isTime(resetsAt)) ||
    typeof terminalId !== "string" ||
    !isTime(observedAt) ||
    !(identity === null || (typeof identity === "string" && identity !== ""))
  ) {
    return null;
  }
  return {
    window: window as SavedClaudeUsageReading["window"],
    statement: statement as SavedClaudeUsageReading["statement"],
    usedPercent: usedPercent as number | null,
    resetsAt: resetsAt as number | null,
    terminalId,
    observedAt,
    identity: identity as string | null,
  };
}

/**
 * The saved readings still worth showing at `now`. A malformed entry is
 * skipped rather than failing the rest; a document that isn't one, or comes
 * from another version, reads as empty and is replaced by the next save.
 */
export function parseClaudeUsageDocument(
  value: string | null,
  now: number
): SavedClaudeUsageReading[] {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const document = parsed as Partial<ClaudeUsageDocument>;
  if (document.version !== DOCUMENT_VERSION || !Array.isArray(document.readings)) return [];
  return document.readings.flatMap((entry) => {
    const reading = parseReading(entry);
    return reading !== null && isRestorableClaudeUsageReading(reading, now) ? [reading] : [];
  });
}

export function serializeClaudeUsageDocument(readings: SavedClaudeUsageReading[]): string {
  return JSON.stringify({
    version: DOCUMENT_VERSION,
    readings: readings.map(
      ({ window, statement, usedPercent, resetsAt, terminalId, observedAt, identity }) => ({
        window,
        statement,
        usedPercent,
        resetsAt,
        terminalId,
        observedAt,
        identity,
      })
    ),
  } satisfies ClaudeUsageDocument);
}

import { coerceAgentState } from "../types/agent.js";
import type { TerminalRestoreDisposition, TerminalRestoreProvenance } from "../types/panel.js";

const DISPOSITIONS: ReadonlySet<string> = new Set<TerminalRestoreDisposition>([
  "resume",
  "fresh",
  "held",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

type LastSeen = NonNullable<TerminalRestoreProvenance["lastSeen"]>;

/**
 * A saved agent state and the time it began, as one observation. "directing" is
 * a renderer-only overlay the serializer never writes, so it is no observation.
 */
export function readLastSeen(agentState: unknown, at: unknown): LastSeen | undefined {
  const state = coerceAgentState(agentState);
  if (state === undefined || state === "directing") return undefined;
  return { agentState: state, ...(isTimestamp(at) && { at }) };
}

/**
 * Read an on-disk provenance record (#14017). The snapshot schema passes unknown
 * keys through, so this is the only validation it gets. A record without a
 * usable time or disposition is dropped whole: it would describe a restore no
 * one can place.
 */
export function sanitizeRestoreProvenance(value: unknown): TerminalRestoreProvenance | undefined {
  if (!isPlainObject(value)) return undefined;
  if (!isTimestamp(value.at)) return undefined;
  if (typeof value.disposition !== "string" || !DISPOSITIONS.has(value.disposition)) {
    return undefined;
  }
  const lastSeen = isPlainObject(value.lastSeen)
    ? readLastSeen(value.lastSeen.agentState, value.lastSeen.at)
    : undefined;
  return {
    at: value.at,
    disposition: value.disposition as TerminalRestoreDisposition,
    ...(lastSeen !== undefined && { lastSeen }),
  };
}

/**
 * The `restored` field the terminal listing and info reads report (#14017).
 * A pane held right now reports `held` with its hold's reason, whatever the
 * record says, so the answer follows the hold rather than a stale copy of it.
 */
export interface RestoredSummary {
  at: number;
  disposition: TerminalRestoreDisposition;
  heldReason?: string;
  lastSeen?: LastSeen;
}

export function summarizeRestoreProvenance(panel: {
  restoreProvenance?: unknown;
  restoreRecovery?: unknown;
}): RestoredSummary | undefined {
  const provenance = sanitizeRestoreProvenance(panel.restoreProvenance);
  if (provenance === undefined) return undefined;
  const heldReason =
    isPlainObject(panel.restoreRecovery) && typeof panel.restoreRecovery.reason === "string"
      ? panel.restoreRecovery.reason
      : undefined;
  return {
    at: provenance.at,
    disposition: heldReason !== undefined ? "held" : provenance.disposition,
    ...(heldReason !== undefined && { heldReason }),
    ...(provenance.lastSeen !== undefined && { lastSeen: provenance.lastSeen }),
  };
}

/** `{ restored }` for a pane restore rebuilt, `{}` otherwise — for spreading into a listing row. */
export function restoredField(panel: { restoreProvenance?: unknown; restoreRecovery?: unknown }): {
  restored?: RestoredSummary;
} {
  const restored = summarizeRestoreProvenance(panel);
  return restored !== undefined ? { restored } : {};
}

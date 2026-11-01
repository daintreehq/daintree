import { coerceAgentState } from "../types/agent.js";
import type {
  TerminalAgentObservation,
  TerminalRestoreDisposition,
  TerminalRestoreProvenance,
} from "../types/panel.js";

const DISPOSITIONS: ReadonlySet<string> = new Set<TerminalRestoreDisposition>([
  "resume",
  "fresh",
  "held",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The latest instant a `Date` can hold; anything past it is no time at all. */
const MAX_DATE_MS = 8.64e15;

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_DATE_MS;
}

/**
 * An agent state and the time it began, as one observation. "directing" is a
 * renderer-only overlay, never something the host reported, so it is none.
 */
export function readLastSeen(
  agentState: unknown,
  at: unknown
): TerminalAgentObservation | undefined {
  const state = coerceAgentState(agentState);
  if (state === undefined || state === "directing") return undefined;
  return { agentState: state, ...(isTimestamp(at) && { at }) };
}

/** Read an on-disk observation (#14017); untrusted, like the rest of the snapshot. */
export function sanitizeAgentObservation(value: unknown): TerminalAgentObservation | undefined {
  return isPlainObject(value) ? readLastSeen(value.agentState, value.at) : undefined;
}

/**
 * The later of two observations of one pane, by when each state began. A read
 * taken before a live report must not roll the pane back to it. Ties keep `a`.
 */
export function newerObservation(
  a: TerminalAgentObservation | undefined,
  b: TerminalAgentObservation | undefined
): TerminalAgentObservation | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  return (b.at ?? 0) > (a.at ?? 0) ? b : a;
}

/**
 * When the state the host last reported for a pane began, by the host's clock,
 * which is the only clock its reports can be ordered by. The pane's
 * `lastStateChange` won't do: this machine stamps its own overlays there (a
 * launch guess, directing, an optimistic working), and a remote host's clock
 * need not agree with this one's, so a host report that is the newest thing
 * known could read as older than an overlay and be refused (#16062).
 */
export function hostObservedAt(pane: {
  lastAgentObservation?: TerminalAgentObservation;
}): number | undefined {
  return pane.lastAgentObservation?.at;
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
  const lastSeen = sanitizeAgentObservation(value.lastSeen);
  return {
    at: value.at,
    disposition: value.disposition as TerminalRestoreDisposition,
    ...(lastSeen !== undefined && { lastSeen }),
  };
}

/**
 * Provenance for a pane whose process is running right now. A record saying the
 * pane is held contradicts that — it left the hold by a route nobody recorded,
 * as when the window closed before saving the launch — so it is dropped rather
 * than reported.
 */
export function sanitizeLiveRestoreProvenance(
  value: unknown
): TerminalRestoreProvenance | undefined {
  const provenance = sanitizeRestoreProvenance(value);
  return provenance?.disposition === "held" ? undefined : provenance;
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
  lastSeen?: TerminalAgentObservation;
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

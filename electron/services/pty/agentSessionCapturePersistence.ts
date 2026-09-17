import { panelKindHasPty } from "../../../shared/config/panelKindRegistry.js";
import type { ProjectState } from "../../../shared/types/project.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { createLogger } from "../../utils/logger.js";
import { isAssistantTerminalRecord } from "../assistantTerminal.js";
import type { DaintreeEventMap } from "../events.js";
import { projectStore } from "../ProjectStore.js";
import { journalAgentSession } from "./agentSessionJournal.js";
import { getLifecycleLedger } from "./lifecycleLedger.js";

const logger = createLogger("main:AgentSessionCapturePersistence");

export type CapturedAgentSession = DaintreeEventMap["agent-session:captured"];

/**
 * What happened to the saved pane. Only `filled`, `superseded` and `unchanged`
 * mean the pane holds the captured id; everything else names why it was left
 * alone.
 */
export type PaneWritebackOutcome =
  | "filled"
  | "superseded"
  | "unchanged"
  | "conflict"
  | "ineligible-boundary"
  | "unknown-generation"
  | "stale-generation"
  | "no-project"
  | "project-mismatch"
  | "agent-mismatch"
  | "identity-edited"
  | "missing-project"
  | "missing-pane"
  | "ineligible-pane"
  | "failed";

export type JournalOutcome = "written" | "skipped" | "failed";

export interface CapturePersistenceResult {
  journal: JournalOutcome;
  pane: PaneWritebackOutcome;
}

const WRITING_OUTCOMES: ReadonlySet<PaneWritebackOutcome> = new Set([
  "filled",
  "superseded",
  "unchanged",
]);

const MAX_TRACKED_TERMINALS = 512;

/**
 * Ids this module wrote, per pane, with the generation that owned them. The
 * renderer never learns a scraped id during the session, so a restart's
 * "start over" has nothing to clear and the id would otherwise outlive the
 * incarnation that produced it — locking the pane's later exits out as
 * conflicts. An id recorded here may be replaced by a newer generation of the
 * same pane; any renderer edit to the field hands authority back.
 */
const authoredIds = new Map<string, { generation: number; sessionId: string }>();

/**
 * Generations whose writeback a renderer identity edit revoked. Only a
 * generation that had already closed when the edit landed — the restart that
 * clears an exited pane's identity — so a capture still queued behind that
 * save cannot put the id back. A live generation is never revoked here:
 * renderer saves are debounced, so its edit usually lands after the respawn
 * and belongs to the new incarnation, not this one.
 */
const revokedGenerations = new Map<string, number>();

function rememberBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED_TERMINALS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Called for every accepted renderer save that states it changed a pane's
 * `agentSessionId` (#11461's field-level authority). That edit is the user's
 * word on the pane's identity from here on.
 */
export function noteRendererSessionIdentityEdits(terminalIds: Iterable<string>): void {
  const ledger = getLifecycleLedger();
  for (const terminalId of terminalIds) {
    authoredIds.delete(terminalId);
    const entry = ledger.getEntry(terminalId);
    if (entry?.closedAt !== undefined) {
      rememberBounded(revokedGenerations, terminalId, entry.generation);
    }
  }
}

function decidePaneWriteback(
  state: ProjectState | null,
  capture: CapturedAgentSession,
  generation: number,
  projectId: string
): PaneWritebackOutcome {
  const { terminalId, record } = capture;

  // Ownership is read here, when the queued update runs, not when it was
  // enqueued: a respawn of the same id can land while this waits. A closed
  // entry is still current — the exit being captured is what closed it.
  const entry = getLifecycleLedger().getEntry(terminalId);
  if (!entry) return "unknown-generation";
  if (entry.generation !== generation) return "stale-generation";
  if (entry.facts.projectId !== projectId) return "project-mismatch";
  if (entry.facts.launchAgentId !== record.agentId) return "agent-mismatch";
  if (revokedGenerations.get(terminalId) === generation) return "identity-edited";

  if (!state?.terminals) return "missing-project";
  const pane = state.terminals.find((t) => t.id === terminalId);
  if (!pane) return "missing-pane";
  if (
    (pane.kind !== undefined && !panelKindHasPty(pane.kind)) ||
    pane.location === "trash" ||
    isAssistantTerminalRecord({ id: terminalId })
  ) {
    return "ineligible-pane";
  }
  if (pane.launchAgentId !== record.agentId) return "agent-mismatch";

  if (!pane.agentSessionId) {
    pane.agentSessionId = record.sessionId;
    return "filled";
  }
  if (pane.agentSessionId === record.sessionId) return "unchanged";

  const authored = authoredIds.get(terminalId);
  if (
    authored !== undefined &&
    authored.sessionId === pane.agentSessionId &&
    authored.generation < generation
  ) {
    pane.agentSessionId = record.sessionId;
    return "superseded";
  }
  return "conflict";
}

/**
 * Write a passively captured session id onto the saved pane that owns it, so
 * cold restore resumes the exact conversation (#12433). Only a final PTY exit
 * qualifies: a demotion leaves a live shell that can host another
 * conversation, and trash expiry belongs to a pane already on its way out.
 *
 * Goes through the project's serialized state queue like every other writer.
 * Fills an absent id, keeps an identical one, and never overwrites someone
 * else's — a conflict is reported, not resolved.
 */
export async function writeBackCapturedSessionId(
  capture: CapturedAgentSession
): Promise<PaneWritebackOutcome> {
  const { terminalId, boundary, launchGeneration: generation, record } = capture;
  if (boundary !== "exit") return "ineligible-boundary";
  if (typeof generation !== "number") return "unknown-generation";
  const projectId = record.projectId;
  if (!projectId) return "no-project";

  // Assigned by the updater; the cast keeps TS from narrowing it to the seed.
  let outcome = "missing-project" as PaneWritebackOutcome;
  try {
    await projectStore.enqueueProjectStateUpdate(projectId, (state) => {
      outcome = decidePaneWriteback(state, capture, generation, projectId);
      // Returning the state for an identical id lets the answer share the
      // batch's save, rather than claiming durability this updater can't see.
      return WRITING_OUTCOMES.has(outcome) ? state : null;
    });
  } catch (error) {
    logger.warn("Saved-pane writeback of a captured session failed", {
      terminalId,
      projectId,
      error: formatErrorMessage(error, "project state update failed"),
    });
    return "failed";
  }

  if (outcome === "filled" || outcome === "superseded") {
    rememberBounded(authoredIds, terminalId, { generation, sessionId: record.sessionId });
  }
  return outcome;
}

async function journalCapture(capture: CapturedAgentSession): Promise<JournalOutcome> {
  try {
    const written = await journalAgentSession(capture.record, {
      terminalId: capture.terminalId,
      generation: capture.launchGeneration,
    });
    return written ? "written" : "skipped";
  } catch (error) {
    logger.warn("Journaling a captured session failed", {
      terminalId: capture.terminalId,
      error: formatErrorMessage(error, "journal write failed"),
    });
    return "failed";
  }
}

/**
 * Persist one capture: the session journal and the saved pane, as independent
 * responsibilities — a journal dedupe or failure never suppresses the pane
 * write, and the reverse. Never rejects.
 */
export async function persistCapturedAgentSession(
  capture: CapturedAgentSession
): Promise<CapturePersistenceResult> {
  const [journal, pane] = await Promise.all([
    journalCapture(capture),
    writeBackCapturedSessionId(capture),
  ]);
  // Correlation only — never the session id, which is a resume credential.
  logger.info("Captured agent session persistence outcome", {
    terminalId: capture.terminalId,
    projectId: capture.record.projectId ?? null,
    boundary: capture.boundary,
    generation: capture.launchGeneration ?? null,
    journal,
    pane,
  });
  return { journal, pane };
}

const inFlight = new Set<Promise<unknown>>();
let sealed = false;

/**
 * Entry point for `agent-session:captured`. Starts persistence synchronously —
 * the journal reservation and the project-state queue entry both exist before
 * this returns — and tracks it so a quit can wait for it.
 */
export function acceptCapturedAgentSession(capture: CapturedAgentSession): void {
  if (sealed) {
    logger.warn("Captured agent session arrived after quit sealed persistence", {
      terminalId: capture.terminalId,
      boundary: capture.boundary,
    });
    return;
  }
  const work = persistCapturedAgentSession(capture).catch((error: unknown) => {
    logger.warn("Captured agent session persistence threw", {
      terminalId: capture.terminalId,
      error: formatErrorMessage(error, "capture persistence threw"),
    });
  });
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work));
}

/**
 * Quit-time consumer drain: refuse new captures, then wait up to `budgetMs`
 * for the accepted ones to settle. Permanent — the journal and project store
 * are about to go away. Resolves either way; `drained` says which.
 */
export async function sealAndDrainCapturedSessionPersistence(
  budgetMs: number
): Promise<{ drained: boolean; pending: number }> {
  sealed = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(
      () => {
        expired = true;
        resolve();
      },
      Math.max(0, budgetMs)
    );
  });
  try {
    while (inFlight.size > 0 && !expired) {
      await Promise.race([Promise.allSettled([...inFlight]), deadline]);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { drained: inFlight.size === 0, pending: inFlight.size };
}

export function resetCapturedSessionPersistenceForTests(): void {
  authoredIds.clear();
  revokedGenerations.clear();
  inFlight.clear();
  sealed = false;
}

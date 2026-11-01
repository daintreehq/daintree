import { isHostThrowawayWorkspaceId } from "../../../shared/config/hostThrowaway.js";
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
export type ObservedAgentSession = DaintreeEventMap["agent-session:observed"];

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
  | "sealed"
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

/** Persistence a quit must wait for; see `sealAndDrainCapturedSessionPersistence`. */
const inFlight = new Set<Promise<void>>();
let sealed = false;

interface AuthoredId {
  generation: number;
  sessionId: string;
  projectId: string;
  /**
   * What wrote it. Anything but `exit` was learned before the generation
   * ended — attributed while live (#15268), read off a run's argv (#15994), or
   * a farewell at a demotion — and the generation can switch conversations
   * after that, so its own exit capture may replace the id.
   */
  source: PaneClaim["source"];
  /** The agent run within the generation, for an `argv` or `demotion` claim. */
  incarnation?: number;
  /**
   * The claim this one replaced, kept until this one's save lands: if that
   * save fails, the pane still holds the older id, which is still ours.
   */
  previous?: AuthoredId;
}

/** Whether `sessionId` is one this claim — or one it is still replacing — wrote. */
function claimCovers(claim: AuthoredId, sessionId: string): boolean {
  for (let link: AuthoredId | undefined = claim; link; link = link.previous) {
    if (link.sessionId === sessionId) return true;
  }
  return false;
}

/**
 * Ids this module wrote, per pane, with the generation that owned them. The
 * renderer never learns a scraped id during the session, so a restart's
 * "start over" has nothing to clear: left alone, the id would outlive the
 * incarnation that produced it. An id recorded here is released when the pane
 * relaunches without resuming it, and may be replaced by a newer generation's
 * capture; any renderer edit to the field hands authority back.
 */
const authoredIds = new Map<string, AuthoredId>();

/**
 * Generations whose writeback a renderer identity edit revoked. Only a
 * generation that had already closed when the edit landed — the restart that
 * clears an exited pane's identity — so a capture still queued behind that
 * save cannot put the id back. A live generation is never revoked here:
 * renderer saves are debounced, so its edit usually lands after the respawn
 * and belongs to the new incarnation, not this one.
 */
const revokedGenerations = new Map<string, number>();

/**
 * Renderer identity edits seen per pane. A live attribution reads the saved
 * pane before its write is queued, so it carries the count from before that
 * read and is refused if an edit landed in between: unlike an exit capture, its
 * generation is still open, so `revokedGenerations` can't fence it.
 */
const identityEditRevisions = new Map<string, number>();

/** The current renderer identity-edit count for a pane; see `identityEditRevisions`. */
export function sessionIdentityRevision(terminalId: string): number {
  return identityEditRevisions.get(terminalId) ?? 0;
}

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
    rememberBounded(identityEditRevisions, terminalId, sessionIdentityRevision(terminalId) + 1);
    const entry = ledger.getEntry(terminalId);
    if (entry?.closedAt !== undefined) {
      rememberBounded(revokedGenerations, terminalId, entry.generation);
    }
  }
}

/**
 * Error text for a log line, with the capture's own id taken out: upstream
 * failures may quote the record they were handed, and the id resumes a
 * conversation.
 */
function describeError(error: unknown, fallback: string, sessionId: string): string {
  const message = formatErrorMessage(error, fallback);
  return sessionId ? message.split(sessionId).join("[session]") : message;
}

/**
 * One id offered for one saved pane: a capture as the PTY exited or as the
 * agent demoted to its shell, a live attribution, or a run's own argv.
 */
interface PaneClaim {
  terminalId: string;
  agentId: string;
  sessionId: string;
  generation: number;
  projectId: string;
  source: "exit" | "demotion" | "live" | "argv";
  /** `argv` and `demotion`: the agent run within the generation. */
  incarnation?: number;
  /** `live` and `argv`: `sessionIdentityRevision` from before the claim was made. */
  identityRevision?: number;
}

/** Whether the pane's id was written by this run's own argv: the one thing a demotion may correct. */
function argvClaimOfRun(
  authored: AuthoredId | undefined,
  claim: PaneClaim
): authored is AuthoredId {
  return (
    authored?.source === "argv" &&
    authored.generation === claim.generation &&
    authored.incarnation === claim.incarnation
  );
}

function decidePaneWriteback(state: ProjectState | null, claim: PaneClaim): PaneWritebackOutcome {
  const { terminalId, agentId, sessionId, generation, projectId } = claim;

  // Ownership is read here, when the queued update runs, not when it was
  // enqueued: a respawn of the same id can land while this waits. A closed
  // entry is still current — the exit being captured is what closed it.
  const entry = getLifecycleLedger().getEntry(terminalId);
  if (!entry) return "unknown-generation";
  if (entry.generation !== generation) return "stale-generation";
  if (entry.facts.projectId !== projectId) return "project-mismatch";
  if (entry.facts.launchAgentId !== agentId) return "agent-mismatch";
  if (revokedGenerations.get(terminalId) === generation) return "identity-edited";
  if (
    claim.identityRevision !== undefined &&
    sessionIdentityRevision(terminalId) !== claim.identityRevision
  ) {
    return "identity-edited";
  }

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
  if (pane.launchAgentId !== agentId) return "agent-mismatch";

  const authored = authoredIds.get(terminalId);
  // A demotion leaves a live shell that can host another conversation, so its
  // farewell never stands for the pane on its own. It only corrects an id the
  // same run's argv wrote: `/resume` or `/new` inside the TUI switched
  // conversations without touching argv.
  if (claim.source === "demotion") {
    if (!pane.agentSessionId || !argvClaimOfRun(authored, claim)) return "ineligible-boundary";
    if (pane.agentSessionId === sessionId) return "unchanged";
    if (!claimCovers(authored, pane.agentSessionId)) return "conflict";
    pane.agentSessionId = sessionId;
    return "superseded";
  }

  if (!pane.agentSessionId) {
    pane.agentSessionId = sessionId;
    return "filled";
  }
  if (pane.agentSessionId === sessionId) return "unchanged";
  // A live attribution only ever fills: whatever already holds the pane was
  // either captured as a run ended or chosen by the user.
  if (claim.source === "live") return "conflict";
  // The process was started on this conversation, which outranks whatever the
  // pane held from before the run. Once per run, so a later capture of the
  // same run still replaces it.
  if (claim.source === "argv") {
    pane.agentSessionId = sessionId;
    return "superseded";
  }

  if (
    authored !== undefined &&
    (authored.generation < generation ||
      (authored.source !== "exit" && authored.generation === generation)) &&
    claimCovers(authored, pane.agentSessionId)
  ) {
    pane.agentSessionId = sessionId;
    return "superseded";
  }
  return "conflict";
}

/**
 * Write a passively captured session id onto the saved pane that owns it, so
 * cold restore resumes the exact conversation (#12433). Only a final PTY exit
 * qualifies: a demotion leaves a live shell that can host another
 * conversation, and trash expiry belongs to a pane already on its way out.
 * The one exception is a demotion correcting the id its own run's argv wrote
 * (#15994), which the run may have left for another conversation.
 *
 * Goes through the project's serialized state queue like every other writer.
 * Fills an absent id, keeps an identical one, and never overwrites someone
 * else's — a conflict is reported, not resolved.
 */
export async function writeBackCapturedSessionId(
  capture: CapturedAgentSession
): Promise<PaneWritebackOutcome> {
  const { terminalId, boundary, launchGeneration: generation, record, run } = capture;
  if (boundary === "demotion" && run && record.projectId) {
    const claim: PaneClaim = {
      terminalId,
      agentId: record.agentId,
      sessionId: record.sessionId,
      generation: run.launchGeneration,
      projectId: record.projectId,
      source: "demotion",
      incarnation: run.agentIncarnation,
    };
    // Decided again when the queued update runs; this only spares the queue
    // the common demotion that has nothing to correct.
    if (argvClaimOfRun(authoredIds.get(terminalId), claim)) return writeBackPaneClaim(claim);
  }
  if (boundary !== "exit") return "ineligible-boundary";
  if (typeof generation !== "number") return "unknown-generation";
  const projectId = record.projectId;
  if (!projectId) return "no-project";
  return writeBackPaneClaim({
    terminalId,
    agentId: record.agentId,
    sessionId: record.sessionId,
    generation,
    projectId,
    source: "exit",
  });
}

async function writeBackPaneClaim(claim: PaneClaim): Promise<PaneWritebackOutcome> {
  const { terminalId, sessionId, generation, projectId } = claim;
  // Assigned by the updater; the cast keeps TS from narrowing it to the seed.
  let outcome = "missing-project" as PaneWritebackOutcome;
  let claimed: { mine: AuthoredId; previous: AuthoredId | undefined } | undefined;
  try {
    await projectStore.enqueueProjectStateUpdate(projectId, (state) => {
      outcome = decidePaneWriteback(state, claim);
      // An argv id the pane already held is still this run's from now on, so
      // the run's own later capture can replace it.
      if (
        outcome === "filled" ||
        outcome === "superseded" ||
        (outcome === "unchanged" && claim.source === "argv")
      ) {
        // Claimed at decision time, not after the save: a renderer edit that
        // lands while the save is pending drops this claim, and must stay the
        // last word.
        const previous = authoredIds.get(terminalId);
        const mine: AuthoredId = {
          generation,
          sessionId,
          projectId,
          previous,
          source: claim.source,
          ...(claim.incarnation !== undefined && { incarnation: claim.incarnation }),
        };
        claimed = { mine, previous };
        rememberBounded(authoredIds, terminalId, mine);
      }
      // Returning the state for an identical id lets the answer share the
      // batch's save, rather than claiming durability this updater can't see.
      return WRITING_OUTCOMES.has(outcome) ? state : null;
    });
  } catch (error) {
    // Nothing reached disk, so the claim this write took is void — unless a
    // renderer edit already replaced it.
    if (claimed && authoredIds.get(terminalId) === claimed.mine) {
      if (claimed.previous) rememberBounded(authoredIds, terminalId, claimed.previous);
      else authoredIds.delete(terminalId);
    }
    logger.warn("Saved-pane writeback of a captured session failed", {
      terminalId,
      projectId,
      source: claim.source,
      error: describeError(error, "project state update failed", sessionId),
    });
    return "failed";
  }
  // Saved: the id this claim replaced is gone from disk.
  if (claimed) claimed.mine.previous = undefined;
  return outcome;
}

interface LaunchIntent {
  generation: number;
  projectId: string | undefined;
  command: string | undefined;
  agentSessionId: string | undefined;
}

/** The latest renderer-requested launch of each pane, as the ledger minted it. */
const requestedLaunches = new Map<string, LaunchIntent>();

/**
 * The latest of those the host confirmed. Only these decide a release: a
 * refused spawn leaves the previous process — whatever it resumed — running.
 */
const confirmedLaunches = new Map<string, LaunchIntent>();

/**
 * Record what a renderer-requested spawn asked for, keyed to the generation
 * `PtyClient.spawn` just minted. Nothing is released here: the host can still
 * refuse the spawn, and a pane whose previous process keeps running must keep
 * its id. See {@link releaseSupersededCapturedSession}.
 */
export function noteTerminalLaunch(
  terminalId: string,
  launch: { command?: string; agentSessionId?: string }
): void {
  const entry = getLifecycleLedger().getEntry(terminalId);
  if (!entry) return;
  rememberBounded(requestedLaunches, terminalId, {
    generation: entry.generation,
    projectId: entry.facts.projectId,
    command: launch.command,
    agentSessionId: launch.agentSessionId,
  });
}

function launchResumes(launch: LaunchIntent, sessionId: string): boolean {
  return launch.agentSessionId === sessionId || (launch.command?.includes(sessionId) ?? false);
}

/**
 * Release an id this module wrote once its pane has actually relaunched
 * without resuming it (#12433). A fresh restart of a pane whose scraped id the
 * renderer never learned has no way to say "start over"; without this, cold
 * restore would resume the abandoned conversation until the new incarnation's
 * own exit replaced it. A launch that carries the id — resuming it by argument
 * or by assignment — keeps it.
 *
 * Driven by a successful spawn result, and decided only when the queued update
 * runs, against the latest confirmed launch and the current claim: a later
 * confirmed relaunch that resumes the id, a spawn in another project, or a
 * claim the renderer has since taken over all leave the pane alone. The claim itself survives
 * until the removal is saved, so a failed save still lets the successor's
 * capture replace the id.
 */
export function releaseSupersededCapturedSession(
  terminalId: string,
  spawnedGeneration: number | undefined
): void {
  const launch = requestedLaunches.get(terminalId);
  if (!launch || spawnedGeneration !== launch.generation) return;
  rememberBounded(confirmedLaunches, terminalId, launch);
  const claim = authoredIds.get(terminalId);
  if (!claim) return;
  if (launch.generation <= claim.generation || launch.projectId !== claim.projectId) return;

  const projectId = claim.projectId;
  let released: AuthoredId | undefined;
  track(
    projectStore
      .enqueueProjectStateUpdate(projectId, (state) => {
        const current = authoredIds.get(terminalId);
        const latest = confirmedLaunches.get(terminalId);
        if (
          !current ||
          !latest ||
          current.projectId !== projectId ||
          latest.projectId !== projectId ||
          latest.generation <= current.generation
        ) {
          return null;
        }
        const pane = state?.terminals?.find((t) => t.id === terminalId);
        const held = pane?.agentSessionId;
        if (
          !state ||
          !pane ||
          !held ||
          !claimCovers(current, held) ||
          launchResumes(latest, held)
        ) {
          return null;
        }
        delete pane.agentSessionId;
        released = current;
        return state;
      })
      .then(
        () => {
          if (!released) return;
          if (authoredIds.get(terminalId) === released) authoredIds.delete(terminalId);
          logger.info("Released a captured session superseded by a fresh launch", {
            terminalId,
            projectId,
            generation: spawnedGeneration,
          });
        },
        (error: unknown) => {
          logger.warn("Releasing a superseded captured session failed", {
            terminalId,
            projectId,
            error: describeError(error, "project state update failed", claim.sessionId),
          });
        }
      )
  );
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
      error: describeError(error, "journal write failed", capture.record.sessionId),
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

/**
 * Entry point for `agent-session:captured`. Starts persistence synchronously —
 * the journal reservation and the project-state queue entry both exist before
 * this returns — and tracks it so a quit can wait for it.
 */
export function acceptCapturedAgentSession(capture: CapturedAgentSession): void {
  // A throwaway run (#14445) has no journal entry or saved pane to fill.
  if (isHostThrowawayWorkspaceId(capture.record.projectId)) return;
  if (sealed) {
    logger.warn("Captured agent session arrived after quit sealed persistence", {
      terminalId: capture.terminalId,
      boundary: capture.boundary,
    });
    return;
  }
  track(
    persistCapturedAgentSession(capture).then(
      () => {},
      (error: unknown) => {
        logger.warn("Captured agent session persistence threw", {
          terminalId: capture.terminalId,
          error: describeError(error, "capture persistence threw", capture.record.sessionId),
        });
      }
    )
  );
}

export interface LiveSessionAttribution {
  terminalId: string;
  generation: number;
  projectId: string;
  agentId: string;
  sessionId: string;
  /** `sessionIdentityRevision(terminalId)`, read before the saved pane was. */
  identityRevision: number;
}

/**
 * Write the conversation a still-running pane was attributed to onto its saved
 * pane (#15268), so a quit, crash or kill that never reaches the teardown
 * scrape still restores it. Not a journal record: the run hasn't closed, and
 * the journal's one record per generation belongs to the close.
 *
 * Fills an absent id and nothing else, under the same generation and renderer
 * authority checks as an exit capture. The claim it leaves is marked live, so
 * the same run's exit capture can still replace it after a `/new`, and a fresh
 * relaunch releases it like any other id this module wrote. Tracked for the
 * quit drain; never rejects.
 */
export function acceptLiveSessionAttribution(
  attribution: LiveSessionAttribution
): Promise<PaneWritebackOutcome> {
  if (isHostThrowawayWorkspaceId(attribution.projectId)) return Promise.resolve("no-project");
  if (sealed) return Promise.resolve("sealed");
  const work = writeBackPaneClaim({ ...attribution, source: "live" }).then((pane) => {
    // Correlation only — never the session id, which is a resume credential.
    logger.info("Live agent session attribution outcome", {
      terminalId: attribution.terminalId,
      projectId: attribution.projectId,
      generation: attribution.generation,
      pane,
    });
    return pane;
  });
  track(work.then(() => {}));
  return work;
}

/**
 * Write the conversation a run's own argv resumes onto its saved pane (#15994):
 * `codex resume <id>` typed into the pane's shell starts a run no capture can
 * name if it ends mid-turn. Replaces whatever the pane held, once per run (the
 * pty-host asks once), under the same generation, agent and pane checks as
 * every claim, and is refused if a renderer identity edit lands before the
 * write. The run's own later capture, a farewell or the quit teardown, still
 * replaces it. Not a journal record: nothing has closed. Tracked for the quit
 * drain; never rejects.
 */
export function acceptObservedAgentSession(
  observation: ObservedAgentSession
): Promise<PaneWritebackOutcome> {
  const { terminalId, agentId, projectId, sessionId, run } = observation;
  if (isHostThrowawayWorkspaceId(projectId)) return Promise.resolve("no-project");
  if (sealed) return Promise.resolve("sealed");
  const work = writeBackPaneClaim({
    terminalId,
    agentId,
    sessionId,
    generation: run.launchGeneration,
    projectId,
    source: "argv",
    incarnation: run.agentIncarnation,
    identityRevision: sessionIdentityRevision(terminalId),
  }).then((pane) => {
    // Correlation only — never the session id, which is a resume credential.
    logger.info("Observed agent session outcome", {
      terminalId,
      projectId,
      generation: run.launchGeneration,
      incarnation: run.agentIncarnation,
      pane,
    });
    return pane;
  });
  track(work.then(() => {}));
  return work;
}

/** Register settled-safe work so a quit's drain waits for it. */
function track(work: Promise<void>): void {
  inFlight.add(work);
  void work.then(() => inFlight.delete(work));
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
  identityEditRevisions.clear();
  requestedLaunches.clear();
  confirmedLaunches.clear();
  inFlight.clear();
  sealed = false;
}

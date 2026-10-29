/**
 * Learns which Codex conversation a running pane is in, while it runs (#15268).
 *
 * Without this a Codex pane's id is only ever learned as it ends — the teardown
 * scrape of the `codex resume <id>` hint, or the passive scrape of a natural
 * exit — so a mid-turn quit, a force quit, a crash or a kill leaves it with no
 * id, and restore can't tell its conversation from any other in the folder.
 *
 * The evidence is what Daintree itself recorded and what the app-server
 * reports, never the CLI's own files: the first prompt Daintree delivered to
 * the run (`TerminalFirstPrompt`), and the folder's root threads with their
 * first message (`preview`) and creation time. Spawn time alone can't separate
 * panes launched seconds apart; spawn time plus the exact prompt can.
 *
 * It never guesses. A pane is attributed only when exactly one thread fits it
 * and that thread fits no other pane, and the write only ever fills an absent
 * id. Every other outcome leaves the pane as it was.
 */

import { isHostThrowawayWorkspaceId } from "../../../shared/config/hostThrowaway.js";
import type { ProjectState, TerminalSnapshot } from "../../../shared/types/project.js";
import { sanitizeFirstPrompt } from "../../../shared/utils/firstPrompt.js";
import { createLogger } from "../../utils/logger.js";
import { events } from "../events.js";
import { projectStore } from "../ProjectStore.js";
import type { PtyClient } from "../PtyClient.js";
import {
  acceptLiveSessionAttribution,
  sessionIdentityRevision,
  type PaneWritebackOutcome,
} from "../pty/agentSessionCapturePersistence.js";
import { subagentTerminalAgentId } from "../subagentTerminalAgent.js";
import { listCodexThreadsCreatedSince, type CodexCreatedThread } from "./CodexSubagentService.js";

const logger = createLogger("main:CodexLiveSessionAttribution");

const CODEX_AGENT_ID = "codex";

/**
 * Delays before each attempt, from the run's first `working` observation. The
 * first waits out the renderer's save of the launch prompt and Codex indexing
 * the new thread; later ones cover a slow machine. After the last, the run is
 * left unattributed — there is no standing poll.
 */
const ATTEMPT_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 45_000];

/** Bound on remembered finished runs; one entry per pane. */
const MAX_SETTLED_RUNS = 1_000;

/** Outcomes after which the pane holds the attributed id. */
const HOLDS_ID: ReadonlySet<PaneWritebackOutcome> = new Set(["filled", "unchanged"]);

/** A pane in the running for a thread: a live Codex run with no id yet. */
export interface LiveAttributionPane {
  terminalId: string;
  spawnedAtMs: number;
  /** The first prompt Daintree delivered to this run. Conversation text: never log it. */
  promptText: string;
}

/**
 * The launch command trims the prompt and flattens its line breaks to spaces
 * before Codex sees it, and a handback instruction can follow it after a blank
 * line. Collapsing every run of whitespace on both sides makes the stored text
 * and the received text compare as what they are: the same words in the same
 * order.
 */
function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Pair panes with the threads they started, or decline to.
 *
 * A thread fits a pane when it was created no earlier than the pane's process,
 * and its first message begins with the whole prompt Daintree sent — the
 * stored prompt can be cut at its cap and can be followed by an appended
 * handback, so it is a prefix of what the thread received, never the reverse.
 * A preview shorter than the prompt therefore fits nothing, which is the safe
 * reading of a server that truncates.
 *
 * A pair is accepted only when the pane fits exactly one thread and that
 * thread fits exactly one pane. Nothing is ranked or chosen by proximity: two
 * panes sent the same prompt, or one prompt that begins another, stay
 * unattributed together. Threads another pane already holds are left out, so a
 * pane isn't counted ambiguous against a conversation that is someone else's.
 */
export function matchLiveCodexThreads(
  panes: readonly LiveAttributionPane[],
  threads: readonly CodexCreatedThread[],
  claimedSessionIds: ReadonlySet<string>
): Map<string, string> {
  const candidates = new Map<string, { createdAt: number; preview: string }>();
  for (const thread of threads) {
    if (claimedSessionIds.has(thread.sessionId) || candidates.has(thread.sessionId)) continue;
    candidates.set(thread.sessionId, {
      createdAt: thread.createdAt,
      preview: normalizePromptText(thread.preview),
    });
  }

  const fitsByPane = new Map<string, string[]>();
  const panesPerThread = new Map<string, number>();
  for (const pane of panes) {
    const prompt = normalizePromptText(pane.promptText);
    // Protocol timestamps are whole seconds, so the spawn is compared at the
    // same precision rather than letting a thread created in the spawn's own
    // second fall before it.
    const spawnedAt = Math.floor(pane.spawnedAtMs / 1000);
    if (!prompt || !(spawnedAt > 0)) continue;
    const fits: string[] = [];
    for (const [sessionId, thread] of candidates) {
      if (thread.createdAt < spawnedAt || !thread.preview.startsWith(prompt)) continue;
      fits.push(sessionId);
      panesPerThread.set(sessionId, (panesPerThread.get(sessionId) ?? 0) + 1);
    }
    fitsByPane.set(pane.terminalId, fits);
  }

  const matches = new Map<string, string>();
  for (const [terminalId, fits] of fitsByPane) {
    const only = fits.length === 1 ? fits[0] : undefined;
    if (only !== undefined && panesPerThread.get(only) === 1) matches.set(terminalId, only);
  }
  return matches;
}

type TerminalRecord = Awaited<
  ReturnType<PtyClient["getAllTerminalsWithCompletenessAsync"]>
>["terminals"][number];

/** The launched Codex run is still the one in the pane, and nothing has named its conversation. */
function isUnattributedCodexRun(info: TerminalRecord): boolean {
  return (
    info.launchAgentId === CODEX_AGENT_ID &&
    subagentTerminalAgentId(info) === CODEX_AGENT_ID &&
    info.agentIncarnation === 0 &&
    info.isAssistantTerminal !== true &&
    info.isTrashed !== true &&
    !info.agentSessionId &&
    typeof info.projectId === "string" &&
    !isHostThrowawayWorkspaceId(info.projectId) &&
    Boolean(info.cwd)
  );
}

/**
 * A pane launched under its own `CODEX_HOME` keeps its conversations in that
 * profile, so it is matched against that profile's threads and no other.
 */
function codexHomeOf(saved: TerminalSnapshot): string | undefined {
  for (const [key, value] of Object.entries(saved.env ?? {})) {
    if (key.toUpperCase() === "CODEX_HOME" && value) return value;
  }
  return undefined;
}

interface RunTrack {
  generation: number;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface AttemptGroup {
  cwd: string;
  codexHome: string | undefined;
  panes: Array<LiveAttributionPane & { projectId: string; identityRevision: number }>;
  /** Earliest spawn, in protocol seconds, of a due pane here that has a prompt to match. */
  since: number | null;
}

export interface CodexLiveSessionAttributionDeps {
  ptyClient: Pick<
    PtyClient,
    "getAllTerminalsWithCompletenessAsync" | "getLiveGeneration" | "noteLiveAgentSessionId"
  >;
  /** True while graceful shutdown tears every terminal down. */
  isQuitting?: () => boolean;
  getProjectState?: (projectId: string) => Promise<ProjectState | null>;
  listThreads?: typeof listCodexThreadsCreatedSince;
  persist?: typeof acceptLiveSessionAttribution;
  attemptDelaysMs?: readonly number[];
}

/**
 * Watches for each Codex run's first turn and attributes it, with a few
 * bounded attempts per run. Process-wide and in memory only; attempts across
 * runs are serialized and batched, so a fleet of panes starting at once costs
 * one app-server query per folder per attempt rather than one per pane.
 */
export class CodexLiveSessionAttribution {
  private readonly deps: Required<Omit<CodexLiveSessionAttributionDeps, "ptyClient">> &
    Pick<CodexLiveSessionAttributionDeps, "ptyClient">;
  private readonly tracks = new Map<string, RunTrack>();
  /** The generation each pane finished with, so its later turns don't start it over. */
  private readonly settled = new Map<string, number>();
  private readonly due = new Set<string>();
  private draining = false;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(deps: CodexLiveSessionAttributionDeps) {
    this.deps = {
      ptyClient: deps.ptyClient,
      isQuitting: deps.isQuitting ?? (() => false),
      getProjectState: deps.getProjectState ?? ((id) => projectStore.getProjectState(id)),
      listThreads: deps.listThreads ?? listCodexThreadsCreatedSince,
      persist: deps.persist ?? acceptLiveSessionAttribution,
      attemptDelaysMs: deps.attemptDelaysMs ?? ATTEMPT_DELAYS_MS,
    };
    this.unsubscribe = events.on("agent:state-changed", (payload) => {
      if (payload.state !== "working" || payload.agentId !== CODEX_AGENT_ID) return;
      if (payload.terminalId) this.observeWorking(payload.terminalId);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const track of this.tracks.values()) {
      if (track.timer) clearTimeout(track.timer);
    }
    this.tracks.clear();
    this.due.clear();
  }

  private observeWorking(terminalId: string): void {
    if (this.disposed || this.deps.isQuitting()) return;
    const generation = this.deps.ptyClient.getLiveGeneration(terminalId);
    if (generation === null || this.settled.get(terminalId) === generation) return;
    const existing = this.tracks.get(terminalId);
    if (existing?.generation === generation) return;
    if (existing?.timer) clearTimeout(existing.timer);
    this.due.delete(terminalId);
    this.tracks.set(terminalId, { generation, attempt: 0, timer: null });
    this.schedule(terminalId);
  }

  private schedule(terminalId: string): void {
    const track = this.tracks.get(terminalId);
    if (!track) return;
    const delay = this.deps.attemptDelaysMs[track.attempt];
    if (delay === undefined) {
      this.settle(terminalId, track.generation);
      return;
    }
    track.timer = setTimeout(() => {
      track.timer = null;
      if (this.tracks.get(terminalId) !== track) return;
      this.due.add(terminalId);
      void this.drain();
    }, delay);
  }

  private settle(terminalId: string, generation: number): void {
    const track = this.tracks.get(terminalId);
    if (track?.generation === generation) {
      if (track.timer) clearTimeout(track.timer);
      this.tracks.delete(terminalId);
      this.due.delete(terminalId);
    }
    this.settled.delete(terminalId);
    this.settled.set(terminalId, generation);
    if (this.settled.size > MAX_SETTLED_RUNS) {
      const oldest = this.settled.keys().next().value;
      if (oldest !== undefined) this.settled.delete(oldest);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.due.size > 0 && !this.disposed) {
        const due = new Map<string, number>();
        for (const terminalId of this.due) {
          const track = this.tracks.get(terminalId);
          if (track) due.set(terminalId, track.generation);
        }
        this.due.clear();
        let finished: Set<string>;
        try {
          finished = await this.attempt(due);
        } catch (error) {
          logger.warn("Live Codex session attribution attempt threw", {
            error: error instanceof Error ? error.name : typeof error,
          });
          finished = new Set();
        }
        if (this.disposed) return;
        for (const [terminalId, generation] of due) {
          const track = this.tracks.get(terminalId);
          if (track?.generation !== generation) continue;
          if (finished.has(terminalId)) {
            this.settle(terminalId, generation);
          } else {
            track.attempt += 1;
            this.schedule(terminalId);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * One pass over every folder a due pane runs in. Returns the due panes that
   * are finished — attributed, or no longer a run attribution could apply to;
   * the rest try again. A partial inventory or a failed query finishes nothing,
   * since either could be hiding the rival that makes a match ambiguous.
   */
  private async attempt(due: ReadonlyMap<string, number>): Promise<Set<string>> {
    const finished = new Set<string>();
    if (this.deps.isQuitting()) {
      for (const terminalId of due.keys()) finished.add(terminalId);
      return finished;
    }
    const { ptyClient } = this.deps;
    const inventory = await ptyClient.getAllTerminalsWithCompletenessAsync();
    if (inventory.degraded || this.disposed) return finished;

    // Read before any saved pane is, so an identity edit that lands while the
    // attempt is in flight refuses its write.
    const revisions = new Map<string, number>();
    for (const info of inventory.terminals) {
      revisions.set(info.id, sessionIdentityRevision(info.id));
    }

    const states = new Map<string, Promise<ProjectState | null>>();
    const stateOf = (projectId: string): Promise<ProjectState | null> => {
      let state = states.get(projectId);
      if (!state) {
        state = this.deps.getProjectState(projectId).catch(() => null);
        states.set(projectId, state);
      }
      return state;
    };

    const claimed = new Set<string>();
    for (const info of inventory.terminals) {
      if (info.agentSessionId) claimed.add(info.agentSessionId);
    }

    const groups = new Map<string, AttemptGroup>();
    for (const info of inventory.terminals) {
      if (!isUnattributedCodexRun(info)) {
        if (due.has(info.id)) finished.add(info.id);
        continue;
      }
      const generation = ptyClient.getLiveGeneration(info.id);
      const dueGeneration = due.get(info.id);
      if (dueGeneration !== undefined && generation !== dueGeneration) {
        finished.add(info.id);
        continue;
      }
      const projectId = info.projectId as string;
      const state = await stateOf(projectId);
      for (const pane of state?.terminals ?? []) {
        if (pane.agentSessionId) claimed.add(pane.agentSessionId);
      }
      const saved = state?.terminals?.find((pane) => pane.id === info.id);
      // Not saved yet is worth another look; saved with an id is done.
      if (!saved || saved.location === "trash") continue;
      if (saved.agentSessionId) {
        if (dueGeneration !== undefined) finished.add(info.id);
        continue;
      }
      const codexHome = codexHomeOf(saved);
      const key = `${codexHome ?? ""}\0${info.cwd}`;
      let group = groups.get(key);
      if (!group) {
        group = { cwd: info.cwd, codexHome, panes: [], since: null };
        groups.set(key, group);
      }
      const prompt = sanitizeFirstPrompt(saved.firstPrompt);
      if (!prompt) continue;
      group.panes.push({
        terminalId: info.id,
        spawnedAtMs: info.spawnedAt,
        promptText: prompt.text,
        projectId,
        identityRevision: revisions.get(info.id) ?? 0,
      });
      if (dueGeneration !== undefined) {
        const spawnedAt = Math.floor(info.spawnedAt / 1000);
        group.since = group.since === null ? spawnedAt : Math.min(group.since, spawnedAt);
      }
    }
    // A due pane missing from a complete inventory has gone.
    for (const terminalId of due.keys()) {
      if (!inventory.terminals.some((info) => info.id === terminalId)) finished.add(terminalId);
    }

    for (const group of groups.values()) {
      const { since } = group;
      if (since === null || this.disposed || this.deps.isQuitting()) continue;
      // Read back only as far as the due panes need. An older pane still counts
      // against every thread its prompt fits, but threads from before the
      // window are missing from its own list, so it can't be accepted here.
      const threads = await this.deps.listThreads(group.cwd, since, group.codexHome);
      if (!threads || this.disposed) continue;
      const matches = matchLiveCodexThreads(group.panes, threads, claimed);
      logger.info("Live Codex session attribution pass", {
        panes: group.panes.length,
        threads: threads.length,
        matched: matches.size,
      });
      for (const pane of group.panes) {
        const sessionId = matches.get(pane.terminalId);
        if (sessionId === undefined || Math.floor(pane.spawnedAtMs / 1000) < since) continue;
        const generation = ptyClient.getLiveGeneration(pane.terminalId);
        if (generation === null) continue;
        const outcome = await this.deps.persist({
          terminalId: pane.terminalId,
          generation,
          projectId: pane.projectId,
          agentId: CODEX_AGENT_ID,
          sessionId,
          identityRevision: pane.identityRevision,
        });
        if (!HOLDS_ID.has(outcome)) continue;
        ptyClient.noteLiveAgentSessionId(pane.terminalId, sessionId, generation);
        finished.add(pane.terminalId);
        // A pane matched before its own first turn was seen needs no attempts of its own.
        if (!due.has(pane.terminalId)) this.settle(pane.terminalId, generation);
      }
    }
    return finished;
  }
}

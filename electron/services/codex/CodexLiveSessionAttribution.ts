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

import { realpath } from "fs/promises";
import { isHostThrowawayWorkspaceId } from "../../../shared/config/hostThrowaway.js";
import type { ProjectState, TerminalSnapshot } from "../../../shared/types/project.js";
import { HANDBACK_CODE_LENGTH } from "../../../shared/types/handback.js";
import { sanitizeFirstPrompt } from "../../../shared/utils/firstPrompt.js";
import {
  buildHandbackInstruction,
  handbackStartMarker,
  isHandbackCode,
} from "../../../shared/utils/handback.js";
import { createLogger } from "../../utils/logger.js";
import { events } from "../events.js";
import type { PtyClient } from "../PtyClient.js";
import {
  acceptLiveSessionAttribution,
  sessionIdentityRevision,
  type PaneWritebackOutcome,
} from "../pty/agentSessionCapturePersistence.js";
import { getEnvVar, hasEnvVar } from "../pty/EnvironmentFilter.js";
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

/** A folder that won't resolve in this long can't be grouped, so the pass is skipped. */
const REALPATH_TIMEOUT_MS = 1_000;

/**
 * Bound on folder resolutions still outstanding. Past it nothing new is asked
 * and every pass is skipped until one settles: each stuck `realpath` holds a
 * threadpool thread, and asking again would only stick another.
 */
const MAX_PENDING_FOLDERS = 8;

/** Outcomes after which the pane holds the attributed id. */
const HOLDS_ID: ReadonlySet<PaneWritebackOutcome> = new Set(["filled", "unchanged"]);

/** A pane in the running for a thread: a live Codex run with no id yet. */
export interface LiveAttributionPane {
  terminalId: string;
  spawnedAtMs: number;
  /** The first prompt Daintree delivered to this run. Conversation text: never log it. */
  promptText: string;
  /** The stored prompt was cut at its cap, so the thread's text runs on mid-word. */
  promptTruncated?: boolean;
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

const HANDBACK_MARKER_PREFIX = handbackStartMarker("");

/**
 * Whether a thread's first message is exactly what Daintree launched with: the
 * prompt alone, or the prompt followed by a handback instruction (a scheduled
 * run's included), the only thing Daintree appends. Anything else the message runs on with was typed by
 * someone, so "Fix the tests" never fits a thread that says "Fix the tests and
 * the lint". A prompt cut at its cap leaves the rest of the text unknown, so it
 * only has to be the start.
 */
function isLaunchedText(preview: string, prompt: string, truncated: boolean): boolean {
  if (truncated) return preview.startsWith(prompt);
  if (preview === prompt) return true;
  if (!preview.startsWith(`${prompt} `)) return false;
  const rest = preview.slice(prompt.length + 1);
  const markerAt = rest.indexOf(HANDBACK_MARKER_PREFIX);
  if (markerAt < 0) return false;
  const start = markerAt + HANDBACK_MARKER_PREFIX.length;
  const code = rest.slice(start, start + HANDBACK_CODE_LENGTH);
  return (
    isHandbackCode(code) &&
    (rest === normalizePromptText(buildHandbackInstruction(code)) ||
      rest === normalizePromptText(buildHandbackInstruction(code, "run")))
  );
}

/**
 * Pair panes with the threads they started, or decline to.
 *
 * A thread fits a pane when it was created no earlier than the pane's process
 * and its first message is the text Daintree launched it with. A preview that
 * stops short of that text fits nothing, which is the safe reading of a server
 * that truncates (codex-cli 0.165.0 reports the whole first message).
 *
 * A pair is accepted only when the pane fits exactly one thread and that
 * thread fits exactly one pane. Nothing is ranked or chosen by proximity: two
 * panes sent the same prompt stay unattributed together. Threads another pane
 * already holds are left out, so a pane isn't counted ambiguous against a
 * conversation that is someone else's.
 *
 * Panes Daintree sent no prompt are not in the running, so they can't make a
 * thread ambiguous. Counting them would refuse every pane in a folder that also
 * holds the Codex pane orchestrating them, and for one of them to own a match
 * its own first message would have to be another pane's launch text, word for
 * word.
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
      if (thread.createdAt < spawnedAt) continue;
      if (!isLaunchedText(thread.preview, prompt, pane.promptTruncated === true)) continue;
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

/**
 * The pane is still running the Codex session it launched, so the prompt on
 * its record describes what it is running. Trashed panes keep running until
 * they expire, so they stay in the running for threads; nothing writes to them.
 */
function isLaunchedCodexRun(info: TerminalRecord): boolean {
  return (
    info.launchAgentId === CODEX_AGENT_ID &&
    subagentTerminalAgentId(info) === CODEX_AGENT_ID &&
    info.agentIncarnation === 0 &&
    info.isAssistantTerminal !== true &&
    typeof info.projectId === "string" &&
    !isHostThrowawayWorkspaceId(info.projectId) &&
    Boolean(info.cwd)
  );
}

/**
 * The Codex profile the pane runs against, read the way its launch env is
 * applied: exact on POSIX, case-insensitive on Windows. Null for an explicit
 * empty `CODEX_HOME`, which names no profile this can query.
 */
function codexProfileOf(saved: TerminalSnapshot): { codexHome: string | undefined } | null {
  const env = saved.env ?? {};
  if (!hasEnvVar(env, "CODEX_HOME")) return { codexHome: undefined };
  const codexHome = getEnvVar(env, "CODEX_HOME");
  return codexHome ? { codexHome } : null;
}

/** `promise`'s value, or null once `ms` passes first. */
async function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface RunTrack {
  generation: number;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface CandidatePane extends LiveAttributionPane {
  projectId: string;
  identityRevision: number;
  /** Generation of the host record the prompt and spawn time were read against. */
  generation: number;
  /** Null when this pane is only a rival: trashed, or under a profile this can't query. */
  profileKey: string | null;
}

/** Every Codex run in one folder, and the profiles there with a due pane to answer for. */
interface AttemptGroup {
  cwds: Set<string>;
  panes: CandidatePane[];
  /** Per profile key: its `CODEX_HOME`, and the earliest due pane's spawn in protocol seconds. */
  profiles: Map<string, { codexHome: string | undefined; since: number }>;
  /** Some run here couldn't be read, so a rival may be missing; skip the folder this pass. */
  unavailable: boolean;
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
  canonicalFolder?: (cwd: string) => Promise<string>;
  now?: () => number;
  attemptDelaysMs?: readonly number[];
}

/**
 * Watches for each Codex run's first turn and attributes it, with a few
 * bounded attempts per run. Process-wide and in memory only. Attempts across
 * runs are serialized: panes that come due while a pass runs share the next
 * one, and a pass writes every unique match in a folder, not just the due
 * pane's, so a fleet starting at once costs a query per folder per pass rather
 * than one per pane.
 */
export class CodexLiveSessionAttribution {
  private readonly deps: Required<Omit<CodexLiveSessionAttributionDeps, "ptyClient">> &
    Pick<CodexLiveSessionAttributionDeps, "ptyClient">;
  private readonly tracks = new Map<string, RunTrack>();
  /** The generation each pane finished with, so its later turns don't start it over. */
  private readonly settled = new Map<string, number>();
  private readonly due = new Set<string>();
  /**
   * Folder resolutions still in flight, shared across passes. `realpath` can
   * hang on a dead network mount and hold a threadpool thread while it does,
   * so a stuck folder is asked once rather than on every attempt. Each leaves
   * when it settles; a failure is never kept, so the next pass asks again.
   */
  private readonly resolving = new Map<string, Promise<string | null>>();
  /**
   * The folder each run resolved to, kept for that run's generation. The
   * process went on running where its path led when it launched, so a symlink
   * retargeted since must not move it out of its rivals' group. A relaunch
   * resolves afresh.
   */
  private readonly runFolders = new Map<string, { generation: number; folder: string }>();
  private draining = false;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(deps: CodexLiveSessionAttributionDeps) {
    this.deps = {
      ptyClient: deps.ptyClient,
      isQuitting: deps.isQuitting ?? (() => false),
      // Resolved on first use: the store's module constructs it, and this is
      // built for every terminal-event registration, tests included.
      getProjectState:
        deps.getProjectState ??
        (async (id) => (await import("../ProjectStore.js")).projectStore.getProjectState(id)),
      listThreads: deps.listThreads ?? listCodexThreadsCreatedSince,
      persist: deps.persist ?? ((attribution) => acceptLiveSessionAttribution(attribution)),
      canonicalFolder: deps.canonicalFolder ?? ((cwd) => realpath(cwd)),
      now: deps.now ?? Date.now,
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

  /**
   * `cwd`'s canonical folder, or null when it can't be had. A failure is not
   * evidence the path names a folder of its own: it can be a symlink to a
   * sibling's folder that just failed to resolve.
   */
  private resolveFolder(cwd: string): Promise<string | null> {
    const inFlight = this.resolving.get(cwd);
    if (inFlight) return inFlight;
    if (this.resolving.size >= MAX_PENDING_FOLDERS) return Promise.resolve(null);
    const pending = this.deps.canonicalFolder(cwd).then(
      (folder) => folder,
      () => null
    );
    this.resolving.set(cwd, pending);
    void pending.then(() => {
      if (this.resolving.get(cwd) === pending) this.resolving.delete(cwd);
    });
    return pending;
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
      // Attempts that come due in the same turn share the pass, so their panes
      // are weighed against each other rather than one pass apiece.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
   * the rest try again. A partial inventory, a run whose record or folder
   * can't be read, a relaunch caught mid-way, or a failed query finishes
   * nothing, since each could be hiding the rival that makes a match ambiguous.
   */
  private async attempt(due: ReadonlyMap<string, number>): Promise<Set<string>> {
    const finished = new Set<string>();
    if (this.deps.isQuitting()) {
      for (const terminalId of due.keys()) finished.add(terminalId);
      return finished;
    }
    const { ptyClient } = this.deps;
    // Taken before the inventory is asked for. A thread created from this
    // second on can belong to a run the inventory doesn't show, whether newly
    // spawned or relaunched while the pass was out, so its folder waits.
    const readAtSeconds = Math.floor(this.deps.now() / 1000);
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
    const folders = new Map<string, Promise<string | null>>();
    const folderOfPath = new Map<string, string>();
    const folderOf = async (terminalId: string, generation: number, cwd: string) => {
      const known = this.runFolders.get(terminalId);
      if (known?.generation === generation) return known.folder;
      let resolving = folders.get(cwd);
      if (!resolving) {
        resolving = withinMs(this.resolveFolder(cwd), REALPATH_TIMEOUT_MS);
        folders.set(cwd, resolving);
      }
      const folder = await resolving;
      if (folder !== null) {
        this.runFolders.delete(terminalId);
        this.runFolders.set(terminalId, { generation, folder });
        if (this.runFolders.size > MAX_SETTLED_RUNS) {
          const oldest = this.runFolders.keys().next().value;
          if (oldest !== undefined) this.runFolders.delete(oldest);
        }
      }
      return folder;
    };

    const claimed = new Set<string>();
    for (const info of inventory.terminals) {
      if (info.agentSessionId) claimed.add(info.agentSessionId);
    }

    const groups = new Map<string, AttemptGroup>();
    for (const info of inventory.terminals) {
      const dueGeneration = due.get(info.id);
      if (!isLaunchedCodexRun(info) || info.agentSessionId) {
        if (dueGeneration !== undefined) finished.add(info.id);
        continue;
      }
      // The run the working observation was about has been replaced; its
      // successor gets an observation of its own. The pane still competes
      // below, as whatever run its row turns out to describe.
      let observed = dueGeneration;
      if (observed !== undefined && ptyClient.getLiveGeneration(info.id) !== observed) {
        finished.add(info.id);
        observed = undefined;
      }
      // The prompt and spawn time are only this run's if the record that
      // answered is the generation Main is running. Mid-relaunch they aren't,
      // and the run's folder isn't known either, so it could be anyone's rival.
      const generation = info.launchGeneration;
      if (typeof generation !== "number" || ptyClient.getLiveGeneration(info.id) !== generation) {
        return finished;
      }
      const folder = await folderOf(info.id, generation, info.cwd);
      // Unresolved, this pane could be any folder's rival, so nothing can be
      // shown unique this pass.
      if (folder === null) return finished;
      // One path, two runs in different folders: a link moved between them.
      if ((folderOfPath.get(info.cwd) ?? folder) !== folder) return finished;
      folderOfPath.set(info.cwd, folder);
      let group = groups.get(folder);
      if (!group) {
        group = { cwds: new Set(), panes: [], profiles: new Map(), unavailable: false };
        groups.set(folder, group);
      }
      group.cwds.add(info.cwd);
      const projectId = info.projectId as string;
      const state = await stateOf(projectId);
      const saved = state?.terminals?.find((pane) => pane.id === info.id);
      if (!state || !saved) {
        group.unavailable = true;
        continue;
      }
      for (const pane of state.terminals) {
        if (pane.agentSessionId) claimed.add(pane.agentSessionId);
      }
      if (saved.agentSessionId) {
        if (observed !== undefined) finished.add(info.id);
        continue;
      }
      const prompt = sanitizeFirstPrompt(saved.firstPrompt);
      if (!prompt) continue;

      const profile = codexProfileOf(saved);
      const target = profile !== null && info.isTrashed !== true && saved.location !== "trash";
      const profileKey = target ? (profile.codexHome ?? "") : null;
      group.panes.push({
        terminalId: info.id,
        spawnedAtMs: info.spawnedAt,
        promptText: prompt.text,
        ...(prompt.truncated && { promptTruncated: true }),
        projectId,
        identityRevision: revisions.get(info.id) ?? 0,
        generation,
        profileKey,
      });
      if (observed !== undefined && profileKey === null) finished.add(info.id);
      if (observed !== undefined && profileKey !== null) {
        const spawnedAt = Math.floor(info.spawnedAt / 1000);
        const existing = group.profiles.get(profileKey);
        group.profiles.set(profileKey, {
          codexHome: profile?.codexHome,
          since: existing ? Math.min(existing.since, spawnedAt) : spawnedAt,
        });
      }
    }
    // A due pane missing from a complete inventory has gone.
    for (const terminalId of due.keys()) {
      if (!inventory.terminals.some((info) => info.id === terminalId)) finished.add(terminalId);
    }

    for (const [folder, group] of groups) {
      if (group.unavailable) continue;
      for (const [profileKey, { codexHome, since }] of group.profiles) {
        if (this.disposed || this.deps.isQuitting()) return finished;
        // Read back only as far as the due panes need. An older pane still
        // counts against every thread its prompt fits, but threads from before
        // the window are missing from its own list, so it can't be accepted.
        // Every pane in the folder competes whatever its profile: two homes can
        // be one directory, and a rival counted wrongly only costs a match.
        const threads = await this.deps.listThreads(
          [...new Set([...group.cwds, folder])],
          since,
          codexHome
        );
        if (this.disposed || this.deps.isQuitting()) return finished;
        // Skipped, not filtered: dropping a thread whose owner isn't known
        // could leave a pane fitting only someone else's.
        if (!threads || threads.some((thread) => thread.createdAt >= readAtSeconds)) continue;
        const matches = matchLiveCodexThreads(group.panes, threads, claimed);
        logger.info("Live Codex session attribution pass", {
          panes: group.panes.length,
          threads: threads.length,
          matched: matches.size,
        });
        for (const pane of group.panes) {
          if (pane.profileKey !== profileKey) continue;
          const sessionId = matches.get(pane.terminalId);
          if (sessionId === undefined || claimed.has(sessionId)) continue;
          if (Math.floor(pane.spawnedAtMs / 1000) < since) continue;
          if (ptyClient.getLiveGeneration(pane.terminalId) !== pane.generation) continue;
          if (this.disposed || this.deps.isQuitting()) return finished;
          const outcome = await this.deps.persist({
            terminalId: pane.terminalId,
            generation: pane.generation,
            projectId: pane.projectId,
            agentId: CODEX_AGENT_ID,
            sessionId,
            identityRevision: pane.identityRevision,
          });
          // Whatever the saved pane did, the host mirror and the next write
          // are this service's to stop.
          if (this.disposed || this.deps.isQuitting()) return finished;
          if (!HOLDS_ID.has(outcome)) continue;
          claimed.add(sessionId);
          ptyClient.noteLiveAgentSessionId(pane.terminalId, sessionId, pane.generation);
          finished.add(pane.terminalId);
          // A pane matched before its own first turn was seen needs no attempts of its own.
          if (!due.has(pane.terminalId)) this.settle(pane.terminalId, pane.generation);
        }
      }
    }
    return finished;
  }
}

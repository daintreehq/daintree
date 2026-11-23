import type { QuestionOrigin } from "@daintreehq/decisions-client";
import type {
  DecisionAskerPresence,
  DecisionAskerResume,
} from "../../../shared/types/decisionsQuestion.js";
import { resumePrerequisite, type ResumeFailure } from "./daintreeResumeAdapter.js";
import { NO_WORKTREE, incarnationOf, type DecisionGenerationReader } from "./decisionWake.js";

/** Pane events that come together (an exit, then its trash) are read once. */
export const ASKER_SETTLE_MS = 100;

/** The fields of a pane's record the observation reads. */
export interface AskerTerminalRecord {
  id: string;
  isTrashed?: boolean;
  hasPty?: boolean;
  isExited?: boolean;
  isClosing?: boolean;
  launchGeneration?: number;
  agentIncarnation?: number;
  agentSessionId?: string;
  worktreeId?: string;
  detectedAgentId?: string;
  everDetectedAgent?: boolean;
  agentState?: string;
}

/** The pty client calls an observation reads panes with. */
export interface AskerPresencePtyClient extends DecisionGenerationReader {
  getAllTerminalsWithCompletenessAsync(): Promise<{
    terminals: readonly AskerTerminalRecord[];
    degraded: boolean;
  }>;
}

export type DirectoryState = "present" | "missing" | "unknown";

/**
 * What an event says changed, so only an asker it can concern is read again:
 * a pane by id; a worktree by id, or with `missingOnly` only for an asker
 * whose folder was last seen missing (a worktree that came back). No hint
 * (a pty host lost) reads every asker.
 */
export type AskerHint = { paneId: string } | { worktreeId: string; missingOnly?: true };

/** What an observation reads in main. */
export interface AskerPresenceSources {
  /** This machine's Decisions host id; null before a relay identity exists. */
  hostId(): string | null;
  /** The pane's current ownership principal; null while it holds no bearer. */
  principalFor(paneId: string): string | null;
  getPtyClient(): AskerPresencePtyClient | null;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  /** Whether delivery already resumed into the run `origin` names, and it went away. */
  resumeEnded(origin: QuestionOrigin): boolean;
  /** Calls `onPane` whenever a pane or worktree may have changed; returns the unsubscribe. */
  watch(onPane: (hint?: AskerHint) => void): () => void;
  settleMs?: number;
}

/**
 * Whether `path` is a directory now: `missing` only when the system says
 * nothing is there (or something other than a directory is); a check that
 * failed any other way, such as permissions, says nothing.
 */
export async function directoryState(
  path: string,
  stat: (path: string) => Promise<{ isDirectory(): boolean }>
): Promise<DirectoryState> {
  try {
    return (await stat(path)).isDirectory() ? "present" : "missing";
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
  }
}

/** The asking run, as a key: every identity field of the origin, and where it ran. */
function originKey(o: QuestionOrigin): string {
  return JSON.stringify([
    o.host_id,
    o.pane_id,
    o.terminal_generation,
    o.ownership_principal,
    o.agent_incarnation,
    o.agent_session_id,
    o.agent_kind,
    o.project_id,
    o.worktree_id,
    o.worktree_root,
  ]);
}

function hasWorktree(origin: QuestionOrigin): boolean {
  return origin.worktree_id !== NO_WORKTREE && origin.worktree_root.trim() !== "";
}

/**
 * What the pane `origin` asked from shows now, in the order delivery's
 * identity check reads it (`identityMismatch`). A pane missing from an
 * inventory a shard didn't answer, or from none at all, is unknown, never
 * closed; so is a record of a run main no longer holds live under that id
 * while the asking run is the live one, since the live record wasn't read.
 * Only a run identity the record or main positively shows as another's makes
 * it `replaced`: one it doesn't show (a revoked bearer, a session not
 * learned) says nothing. An agent no longer detected in the same run is just
 * that, since detection can be revoked while its CLI runs.
 */
export function targetOf(
  origin: QuestionOrigin,
  record: AskerTerminalRecord | undefined,
  inventoryComplete: boolean,
  principal: string | null,
  liveGeneration: number | null
): DecisionAskerPresence["target"] {
  if (record === undefined) return inventoryComplete ? "closed" : "unknown";
  if (
    liveGeneration !== null &&
    record.launchGeneration !== undefined &&
    record.launchGeneration !== liveGeneration
  ) {
    return liveGeneration === origin.terminal_generation ? "unknown" : "replaced";
  }
  if (record.isTrashed === true) return "trashed";
  if (record.isExited === true || record.hasPty === false || record.isClosing === true) {
    return "closed";
  }
  const incarnation = incarnationOf(record);
  // Compared as delivery compares it, exactly.
  const session = origin.agent_session_id;
  if (
    (principal !== null && principal !== origin.ownership_principal) ||
    (incarnation !== null && incarnation !== origin.agent_incarnation) ||
    (liveGeneration !== null && liveGeneration !== origin.terminal_generation) ||
    (record.launchGeneration !== undefined &&
      record.launchGeneration !== origin.terminal_generation) ||
    (session !== null && record.agentSessionId !== undefined && record.agentSessionId !== session)
  ) {
    return "replaced";
  }
  if ((record.worktreeId ?? NO_WORKTREE) !== origin.worktree_id) return "moved";
  if (
    record.detectedAgentId === undefined &&
    (record.everDetectedAgent === true || record.agentState === "exited")
  ) {
    return "agent-undetected";
  }
  return "running";
}

/**
 * The record of pane `id` an inventory holds for the run main holds live
 * under it. A pane id can show on two pty hosts at once (an exit preserved
 * on one, a reuse live on another): the live generation says which is the
 * pane's, else a running record over an ended one.
 */
export function recordFor(
  records: readonly AskerTerminalRecord[] | undefined,
  liveGeneration: number | null
): AskerTerminalRecord | undefined {
  if (records === undefined || records.length <= 1) return records?.[0];
  return (
    (liveGeneration !== null
      ? records.find((record) => record.launchGeneration === liveGeneration)
      : undefined) ??
    records.find(
      (record) => record.isExited !== true && record.hasPty !== false && record.isTrashed !== true
    ) ??
    records[0]
  );
}

const RESUME_REFUSALS: Partial<Record<ResumeFailure, DecisionAskerResume>> = {
  resume_unsupported_agent: "unsupported-agent",
  resume_no_session: "no-session",
  resume_no_worktree: "no-worktree",
  resume_ended: "ended",
};

/**
 * Whether an answer could reopen the session, by the checks delivery's resume
 * makes before it launches anything, in the same order: what main holds,
 * then the directory. One that can't be made here is unknown.
 */
export function resumeOf(
  origin: QuestionOrigin,
  facts: { hostId: string | null; hasPtyClient: boolean; ended: boolean },
  directory: DecisionAskerPresence["directory"]
): DecisionAskerResume {
  const refused = resumePrerequisite(origin, facts);
  if (refused !== null) return RESUME_REFUSALS[refused] ?? "unknown";
  if (directory === "missing") return "worktree-missing";
  return directory === "present" ? "resumable" : "unknown";
}

/**
 * Observes each of `origins` once: one inventory of every pane, one check of
 * each distinct folder, and main's own run identity read after both, so it
 * is the freshest part. Keyed by origin.
 */
export async function observeAskers(
  origins: readonly QuestionOrigin[],
  sources: AskerPresenceSources
): Promise<Map<string, DecisionAskerPresence>> {
  const client = sources.getPtyClient();
  let records: Map<string, AskerTerminalRecord[]> | null = null;
  let complete = false;
  if (client !== null) {
    try {
      const inventory = await client.getAllTerminalsWithCompletenessAsync();
      records = new Map();
      for (const record of inventory.terminals) {
        const same = records.get(record.id);
        if (same === undefined) records.set(record.id, [record]);
        else same.push(record);
      }
      complete = !inventory.degraded;
    } catch {
      records = null;
    }
  }
  const roots = [...new Set(origins.filter(hasWorktree).map((origin) => origin.worktree_root))];
  const folders = new Map(
    await Promise.all(
      roots.map(
        async (root) => [root, await directoryState(root, (path) => sources.stat(path))] as const
      )
    )
  );
  const hostId = sources.hostId();
  const reader = sources.getPtyClient();
  const observed = new Map<string, DecisionAskerPresence>();
  for (const origin of origins) {
    const paneId = origin.pane_id;
    const live = reader?.getLiveGeneration(paneId) ?? null;
    const record = records === null ? undefined : recordFor(records.get(paneId), live);
    const target =
      records === null
        ? "unknown"
        : targetOf(origin, record, complete, sources.principalFor(paneId), live);
    const directory = hasWorktree(origin)
      ? (folders.get(origin.worktree_root) ?? "unknown")
      : "none";
    const resumable = resumeOf(
      origin,
      { hostId, hasPtyClient: reader !== null, ended: sources.resumeEnded(origin) },
      directory
    );
    // The session itself runs on in another worktree: a resume finds it there and won't take it.
    // Only while its agent runs there: one that quit to its shell no longer holds the session.
    const elsewhere =
      target === "moved" &&
      origin.agent_session_id !== null &&
      record?.agentSessionId === origin.agent_session_id &&
      record.agentState !== "exited" &&
      record.detectedAgentId !== undefined;
    const resume = elsewhere && resumable === "resumable" ? "other-worktree" : resumable;
    observed.set(originKey(origin), { target, directory, resume });
  }
  return observed;
}

function samePresence(a: DecisionAskerPresence, b: DecisionAskerPresence): boolean {
  return a.target === b.target && a.directory === b.directory && a.resume === b.resume;
}

/**
 * The run that asked each of this computer's open questions, as last
 * observed (#18029), for its list to show. It reads panes only while it has
 * an asker to observe: a new one soon after it is tracked, and every tracked
 * one again after a pane or worktree event, coalesced, one read at a time.
 * `onChange` hears only an observation that changed. Nothing here acts on
 * what it observes.
 */
export class AskerPresence {
  private origins = new Map<string, QuestionOrigin>();
  private observed = new Map<string, DecisionAskerPresence>();
  private unwatch: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  private again = false;
  private disposed = false;

  constructor(
    private readonly sources: AskerPresenceSources,
    private readonly onChange: () => void
  ) {}

  /**
   * The askers to observe from now on. One not tracked before is read soon;
   * one no longer listed is forgotten, and with none left nothing is watched.
   */
  track(origins: readonly QuestionOrigin[]): void {
    if (this.disposed) return;
    const next = new Map(origins.map((origin) => [originKey(origin), origin]));
    const added = [...next.keys()].some((key) => !this.origins.has(key));
    this.origins = next;
    for (const key of [...this.observed.keys()]) {
      if (!next.has(key)) this.observed.delete(key);
    }
    if (next.size === 0) {
      this.stopWatching();
      return;
    }
    if (this.unwatch === null) {
      // Best effort, like the list it feeds: a watcher that fails never keeps a question unlisted.
      try {
        this.unwatch = this.sources.watch((hint) => {
          if (this.concerns(hint)) this.schedule();
        });
      } catch (err) {
        console.warn("[Decisions] Watching panes for askers failed:", err);
      }
    }
    if (added) this.schedule();
  }

  /** Whether any asker is observed: only then can an observation change. */
  get tracking(): boolean {
    return this.origins.size > 0;
  }

  /** The last observation of the run `origin` names; undefined before its first read. */
  lookup(origin: QuestionOrigin): DecisionAskerPresence | undefined {
    return this.observed.get(originKey(origin));
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching();
    this.origins.clear();
    this.observed.clear();
  }

  private stopWatching(): void {
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Whether an event with `hint` can concern any asker tracked now. */
  private concerns(hint: AskerHint | undefined): boolean {
    if (hint === undefined) return true;
    for (const [key, origin] of this.origins) {
      if ("paneId" in hint) {
        if (origin.pane_id === hint.paneId) return true;
      } else if (origin.worktree_id === hint.worktreeId) {
        if (hint.missingOnly !== true || this.observed.get(key)?.directory === "missing") {
          return true;
        }
      }
    }
    return false;
  }

  private schedule(): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.read();
    }, this.sources.settleMs ?? ASKER_SETTLE_MS);
  }

  /** One read at a time; anything that changed during one is read again right after it. */
  private async read(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.again = false;
        const origins = [...this.origins.values()];
        if (origins.length === 0) return;
        const observed = await observeAskers(origins, this.sources).catch(() => null);
        if (this.disposed) return;
        if (observed !== null) this.apply(observed);
      } while (this.again && !this.disposed);
    } finally {
      this.reading = false;
    }
  }

  /** Keeps what was read of the askers still tracked, and says so when any of it changed. */
  private apply(observed: ReadonlyMap<string, DecisionAskerPresence>): void {
    let changed = false;
    for (const [key, presence] of observed) {
      if (!this.origins.has(key)) continue;
      const before = this.observed.get(key);
      if (before !== undefined && samePresence(before, presence)) continue;
      this.observed.set(key, presence);
      changed = true;
    }
    if (!changed) return;
    try {
      this.onChange();
    } catch (err) {
      console.warn("[Decisions] An asker presence listener threw:", err);
    }
  }
}

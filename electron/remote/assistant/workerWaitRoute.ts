import {
  HOST_WATCH_AGENTS_MAX,
  HOST_WATCH_DEFAULT_WAITING_REASONS,
  type HostWatchAgent,
} from "../../../shared/types/hostControl.js";
import { isGlobalAssistantId } from "../../../shared/config/globalAssistant.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { NOTIFY_TARGET_SETTLE_MS } from "../../../shared/types/terminalNotify.js";
import {
  LANE_WAKE_LONGEST_PENDING_MS,
  type LaneWake,
  type LaneWakeCheck,
  type LaneWakeOutcome,
} from "../../services/mcp-server/terminalNotify.js";
import { createLogger } from "../../utils/logger.js";
import type { AgentWaitingHeard } from "../metrics/agentWaiting.js";
import type { OpenRun } from "./HostCallRuntime.js";

const logger = createLogger("main:WorkerWaitRoute");

/**
 * How long a wait holds before it is told: past a requested notice's own
 * settle, so one that covers the same wait has fired, or is settling, by then.
 */
export const WORKER_WAIT_SETTLE_MS = NOTIFY_TARGET_SETTLE_MS + 500;
/** How soon a wait another notice may still tell is looked at again. */
export const WORKER_WAIT_PENDING_RECHECK_MS = 5_000;
/** How soon a line its receiver couldn't take is offered to it again. */
export const WORKER_WAIT_RETRY_MS = 30_000;
/** Lines one wait is offered on before it is given up. */
export const WORKER_WAIT_ATTEMPTS_MAX = 3;
/** How long another notice that may still tell a wait holds it back; past this it goes out anyway. */
export const WORKER_WAIT_PENDING_MAX_MS = 10 * 60_000;
/** Waits remembered at once; past this the oldest not on a line is forgotten. */
const EPISODES_MAX = 512;

const ROUTED_REASONS: ReadonlySet<string> = new Set(HOST_WATCH_DEFAULT_WAITING_REASONS);

/**
 * What another notice says of a wait: `told` once its line went out,
 * `pending` while it may still tell it, `pending-here` when that is a line
 * of the receiver's own pane, null when it won't.
 */
export type WaitCoverage = "told" | "pending" | "pending-here" | null;

/** A wait already open when the route started, as this machine's directory read it. */
export interface OpenWait {
  terminalId: string;
  projectId: string;
  incarnation: number | null;
  waitingReason: AgentWaitingHeard["waitingReason"];
  approvalKind?: AgentWaitingHeard["approvalKind"];
  seenAt: number | null;
}

export interface WorkerWaitRouteDeps {
  /**
   * This machine's agents' state changes: `heard` when one waits, null when
   * it is anything else or its pane went to the trash. Subscribed for the
   * route's whole life.
   */
  observe(listener: (terminalId: string, heard: AgentWaitingHeard | null) => void): () => void;
  /** Waits open now, read once at the start, for those that began before it listened. */
  readOpenWaits?(): Promise<readonly OpenWait[]>;
  /** One of the assistants' own panes, project or global: never a worker. */
  isAssistantTerminal(terminalId: string): boolean;
  /** The terminal's live PTY generation; null once it has none. */
  liveGeneration(terminalId: string): number | null;
  /** Who hears a project's waits now: its lowest running lane, else the global coordinator. */
  receiverFor(projectId: string): OpenRun | null;
  /**
   * What a pane's requested notice says of the wait that turned actionable at
   * `since`, `receiverPane` being the pane that would hear it from the route.
   */
  coveredByNotice(terminalId: string, since: number, receiverPane: string): WaitCoverage;
  /** What an agent watch the receiver armed itself says of that wait: always its own pane's. */
  coveredByWatch(run: OpenRun, terminalId: string, since: number): WaitCoverage;
  /** Whether the person stopped the receiver pane's notices at or after `since`. */
  receiverStopped(run: OpenRun, since: number): boolean;
  queueNotice(
    lane: { helpSessionId: string; terminalId: string; projectId: string },
    wake: LaneWake
  ): void;
  now(): number;
  newId(): string;
}

/** One stretch of waiting by one worker run, told at most once. */
interface Episode {
  terminalId: string;
  projectId: string;
  /**
   * When it was first seen on an approval or a question: what another notice
   * must have told for it to count, so one that reported a plain prompt doesn't.
   */
  actionableAt: number | null;
  latest: AgentWaitingHeard;
  /** When it is next looked at; null while nothing is due. */
  dueAt: number | null;
  /**
   * `queued` on a line not yet typed, `typing` once its line is being
   * written, `done` once told or given up.
   */
  told: "none" | "queued" | "typing" | "done";
  /** No Assistant heard its project when it was due: the next one seen starting looks again. */
  unreceived?: true;
  /** Lines it was offered on that didn't reach their receiver. */
  attempts: number;
  /** Receivers whose notices the person stopped since it turned actionable: never offered it again. */
  stoppedBy: Set<string>;
  /** The receiver the last of those was for, and when it may be offered to it again. */
  failedTo?: { key: string; retryAt: number };
}

function runKey(run: OpenRun): string {
  return `${run.sessionId}\u0000${run.terminalId}\u0000${run.launchGeneration}`;
}

/** The same worker run: the PTY launch and, where both name it, the agent inside it. */
function sameRun(episode: Episode, heard: AgentWaitingHeard): boolean {
  const was = episode.latest;
  if (was.incarnation !== heard.incarnation) return false;
  return (
    was.agentIncarnation === null ||
    heard.agentIncarnation === null ||
    was.agentIncarnation === heard.agentIncarnation
  );
}

function routes(heard: AgentWaitingHeard): boolean {
  return heard.waitingReason !== null && ROUTED_REASONS.has(heard.waitingReason);
}

function agentOf(episode: Episode): HostWatchAgent {
  const heard = episode.latest;
  return {
    hostId: LOCAL_HOST_ID,
    projectId: episode.projectId,
    worktreeId: heard.worktreeId,
    terminalId: episode.terminalId,
    incarnation: heard.incarnation,
    agentIncarnation: heard.agentIncarnation,
    waitingReason: heard.waitingReason,
    ...(heard.waitingReason === "approval" && heard.approvalKind !== undefined
      ? { approvalKind: heard.approvalKind }
      : {}),
    seenAt: heard.seenAt,
  };
}

/**
 * A project's workers' waits, told unasked to the Assistant that hears the
 * project (#18279): its lowest-numbered running lane, else the global
 * coordinator, else nobody until one starts. Starting an Assistant is the
 * opt-in. One notice per wait, on approval or a question, and none for a wait
 * a pane's requested notice or the receiver's own watch tells. This machine's
 * workers only.
 */
export class WorkerWaitRoute {
  /** Each worker's current wait, by terminal. */
  private readonly episodes = new Map<string, Episode>();
  /** While the first read of open waits runs: every terminal heard meanwhile, which it skips. */
  private seeding: Set<string> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null;
  private disposed = false;

  constructor(private readonly deps: WorkerWaitRouteDeps) {
    this.unsubscribe = deps.observe((terminalId, heard) => this.onChange(terminalId, heard));
    void this.seed();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.episodes.clear();
    this.seeding = null;
  }

  /** Waits open before it listened, unless their terminal was heard meanwhile. */
  private async seed(): Promise<void> {
    const read = this.deps.readOpenWaits;
    if (read === undefined) return;
    const touched = new Set<string>();
    this.seeding = touched;
    let open: readonly OpenWait[];
    try {
      open = await read();
    } catch (error) {
      logger.debug("Couldn't read the waits already open", { error });
      return;
    } finally {
      if (this.seeding === touched) this.seeding = null;
    }
    if (this.disposed) return;
    for (const wait of open) {
      if (touched.has(wait.terminalId) || this.episodes.has(wait.terminalId)) continue;
      this.onChange(wait.terminalId, {
        source: "event",
        terminalId: wait.terminalId,
        projectId: wait.projectId,
        worktreeId: null,
        incarnation: wait.incarnation,
        agentIncarnation: null,
        waitingReason: wait.waitingReason,
        ...(wait.approvalKind !== undefined ? { approvalKind: wait.approvalKind } : {}),
        refined: false,
        seenAt: wait.seenAt,
      });
    }
  }

  private onChange(terminalId: string, heard: AgentWaitingHeard | null): void {
    if (this.disposed) return;
    this.seeding?.add(terminalId);
    if (this.deps.isAssistantTerminal(terminalId)) {
      // An Assistant stirring may be one starting: waits nobody heard look again.
      this.lookAgainUnreceived();
      return;
    }
    if (heard === null) {
      if (this.episodes.delete(terminalId)) this.schedule();
      return;
    }
    const projectId = heard.projectId;
    if (projectId === null) return;
    const now = this.deps.now();
    let episode = this.episodes.get(terminalId);
    // A wait entered afresh, or by another run in the same pane, is a new one.
    if (episode !== undefined && (!heard.refined || !sameRun(episode, heard))) {
      this.episodes.delete(terminalId);
      episode = undefined;
    }
    if (episode === undefined) {
      episode = {
        terminalId,
        projectId,
        actionableAt: null,
        latest: heard,
        dueAt: null,
        told: "none",
        attempts: 0,
        stoppedBy: new Set(),
      };
      this.remember(episode);
    } else {
      episode.latest = heard;
    }
    // A prompt that becomes a question starts its settle then.
    if (routes(heard)) {
      episode.actionableAt ??= heard.seenAt ?? now;
      if (episode.told === "none" && episode.dueAt === null && episode.unreceived !== true) {
        episode.dueAt = now + WORKER_WAIT_SETTLE_MS;
      }
    }
    this.schedule();
  }

  private lookAgainUnreceived(): void {
    let any = false;
    const now = this.deps.now();
    for (const episode of this.episodes.values()) {
      if (episode.unreceived !== true) continue;
      delete episode.unreceived;
      episode.dueAt = now;
      any = true;
    }
    if (any) this.schedule();
  }

  private remember(episode: Episode): void {
    this.episodes.set(episode.terminalId, episode);
    if (this.episodes.size <= EPISODES_MAX) return;
    // A wait on a line keeps its place: forgetting it would drop the line's word of it.
    for (const [terminalId, old] of this.episodes) {
      if (this.episodes.size <= EPISODES_MAX) break;
      if (old.told === "queued" || old.told === "typing" || old === episode) continue;
      this.episodes.delete(terminalId);
    }
  }

  /** Still the wait it was: nothing replaced it, and its pane runs the same launch. */
  private open(episode: Episode): boolean {
    if (this.episodes.get(episode.terminalId) !== episode) return false;
    const generation = this.deps.liveGeneration(episode.terminalId);
    return (
      generation !== null &&
      (episode.latest.incarnation === null || episode.latest.incarnation === generation)
    );
  }

  private flush(): void {
    if (this.disposed) return;
    const now = this.deps.now();
    const batches = new Map<string, { run: OpenRun; episodes: Episode[] }>();
    for (const episode of this.episodes.values()) {
      if (episode.dueAt === null || episode.dueAt > now) continue;
      episode.dueAt = null;
      if (episode.told !== "none" || !routes(episode.latest) || !this.open(episode)) continue;
      const run = this.deps.receiverFor(episode.projectId);
      if (run === null || run.terminalId === episode.terminalId) {
        episode.unreceived = true;
        continue;
      }
      const key = runKey(run);
      const since = episode.actionableAt ?? now;
      // The person's Stop on a receiver is never undone: the next one is looked for when one starts.
      if (episode.stoppedBy.has(key) || this.deps.receiverStopped(run, since)) {
        episode.stoppedBy.add(key);
        episode.unreceived = true;
        continue;
      }
      if (episode.failedTo?.key === key && now < episode.failedTo.retryAt) {
        episode.dueAt = episode.failedTo.retryAt;
        continue;
      }
      const notice = this.deps.coveredByNotice(episode.terminalId, since, run.terminalId);
      const watch = this.deps.coveredByWatch(run, episode.terminalId, since);
      if (notice === "told" || watch === "told") {
        episode.told = "done";
        continue;
      }
      // A line in the receiver's own pane reaches it whenever the route's would, so it waits
      // as long as that; one in another pane holds the wait back only for a while.
      const here = notice === "pending-here" || watch === "pending" || watch === "pending-here";
      if (here || (notice === "pending" && now - since < WORKER_WAIT_PENDING_MAX_MS)) {
        episode.dueAt = now + WORKER_WAIT_PENDING_RECHECK_MS;
        continue;
      }
      const batch = batches.get(key) ?? { run, episodes: [] };
      batch.episodes.push(episode);
      batches.set(key, batch);
    }
    for (const { run, episodes } of batches.values()) {
      // Every one a line tells is named on it.
      for (let at = 0; at < episodes.length; at += HOST_WATCH_AGENTS_MAX) {
        this.tell(run, episodes.slice(at, at + HOST_WATCH_AGENTS_MAX));
      }
    }
    this.schedule();
  }

  /** One line for one receiver, pinned to it: a wait that moves to another goes to that one. */
  private tell(run: OpenRun, episodes: Episode[]): void {
    const key = runKey(run);
    let pending = [...episodes];
    for (const episode of pending) episode.told = "queued";
    const global = isGlobalAssistantId(run.projectId);
    const waits = (): NonNullable<LaneWake["workerWaits"]> => ({
      agents: pending.map(agentOf),
      global,
    });
    const wake: LaneWake = {
      id: `ww-${this.deps.newId()}`,
      kind: "worker-wait",
      workerWaits: waits(),
      maxPendingMs: LANE_WAKE_LONGEST_PENDING_MS,
      recheck: (): LaneWakeCheck => {
        if (this.disposed) return { kind: "unavailable", reason: "relaunched" };
        pending = this.keep(key, pending);
        wake.workerWaits = waits();
        return pending.length > 0 ? { kind: "ready" } : { kind: "unavailable", reason: "moved-on" };
      },
      // A false here ends the wake unreported, so `keep` already let go of what it dropped.
      beforeType: () => {
        if (this.disposed) return false;
        pending = this.keep(key, pending);
        wake.workerWaits = waits();
        if (pending.length === 0) return false;
        for (const episode of pending) episode.told = "typing";
        return true;
      },
      report: (outcome: LaneWakeOutcome) => {
        if (outcome.kind === "held") return;
        if (outcome.kind === "unavailable") {
          // Never written, even once typing began (the host refused it at admission).
          for (const episode of pending) this.release(episode, key);
          this.schedule();
        } else {
          // Delivered, or perhaps written: never told twice.
          for (const episode of pending) if (episode.told === "typing") episode.told = "done";
        }
        pending = [];
      },
    };
    try {
      this.deps.queueNotice(
        { helpSessionId: run.sessionId, terminalId: run.terminalId, projectId: run.projectId },
        wake
      );
    } catch (error) {
      logger.warn("Couldn't queue a worker wait's notice", { error });
      for (const episode of pending) this.release(episode, key);
    }
  }

  /**
   * The waits a line still carries for its receiver: one that ended drops
   * out, one back at a plain prompt waits to become actionable again, and one
   * whose project another Assistant hears now goes to it.
   */
  private keep(key: string, pending: Episode[]): Episode[] {
    const kept: Episode[] = [];
    let moved = false;
    for (const episode of pending) {
      if (episode.told !== "queued") continue;
      if (!this.open(episode)) {
        // Its pane runs another launch now: whatever it waits on is a new wait.
        if (this.episodes.get(episode.terminalId) === episode)
          this.episodes.delete(episode.terminalId);
        continue;
      }
      if (!routes(episode.latest)) {
        episode.told = "none";
        episode.dueAt = null;
        continue;
      }
      const now = this.deps.receiverFor(episode.projectId);
      if (now !== null && runKey(now) === key) {
        kept.push(episode);
      } else {
        episode.told = "none";
        episode.dueAt = this.deps.now();
        moved = true;
      }
    }
    if (moved) this.schedule();
    return kept;
  }

  /** A line that never reached its receiver: offered again, to it only after a while, a few times. */
  private release(episode: Episode, failedTo: string): void {
    if (episode.told !== "queued" && episode.told !== "typing") return;
    episode.attempts += 1;
    if (episode.attempts >= WORKER_WAIT_ATTEMPTS_MAX) {
      episode.told = "done";
      return;
    }
    const now = this.deps.now();
    episode.told = "none";
    episode.failedTo = { key: failedTo, retryAt: now + WORKER_WAIT_RETRY_MS };
    if (this.open(episode)) episode.dueAt = now;
  }

  /** One timer, to the next wait due; none while nothing is. */
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed) return;
    let next = Number.POSITIVE_INFINITY;
    for (const episode of this.episodes.values()) {
      if (episode.dueAt !== null) next = Math.min(next, episode.dueAt);
    }
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.flush();
      },
      Math.max(0, next - this.deps.now())
    );
    this.timer.unref?.();
  }
}

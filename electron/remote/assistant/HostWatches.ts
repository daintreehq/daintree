import {
  HOST_WATCHES_PER_RUN_MAX,
  HOST_WATCHES_TOTAL_MAX,
  HOST_WATCH_AGENTS_MAX,
  HOST_WATCH_CONNECTION_SETTLE_MS,
  HOST_WATCH_DEFAULT_WAITING_REASONS,
  HOST_WATCH_EXPIRES_DEFAULT_S,
  HOST_WATCH_HISTORY_MAX,
  HOST_WATCH_MATCHES_MAX,
  HOST_WATCH_WAITING_REASONS,
  type HostControlOutcomeCode,
  type HostWatch,
  type HostWatchAgent,
  type HostWatchArgs,
  type HostWatchCondition,
  type HostWatchDelivery,
  type HostWatchHostCoverage,
  type HostWatchLostReason,
  type HostWatchObserved,
  type HostWatchResult,
  type HostWatchStatus,
  type HostWatchWaitingReasons,
} from "../../../shared/types/hostControl.js";
import type { AgentDirectory } from "../../../shared/types/agentDirectory.js";
import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import {
  NOTIFY_TARGET_SETTLE_MS,
  sanitizeNotifyNote,
} from "../../../shared/types/terminalNotify.js";
import type { LaneWake, LaneWakeOutcome } from "../../services/mcp-server/terminalNotify.js";
import type { HostWatchNotice } from "../../services/mcp-server/noticeFormat.js";
import { createLogger } from "../../utils/logger.js";
import type { ElapsedStamp } from "../link/elapsed.js";
import type { AgentWaitingHeard, AgentWaitingListener } from "../metrics/agentWaiting.js";
import { sampleFreshness } from "../metrics/summaryReceipt.js";
import { projectHostLoad } from "./hostLoad.js";
import { projectHostLink } from "./hostObservations.js";
import type { ObservedHost, OpenRun } from "./HostCallRuntime.js";

const logger = createLogger("main:HostWatches");

/** What the watches hear while any is armed; nothing is asked of a host to produce either. */
export interface HostWatchListener {
  /** A host's link, or this Shell's list of hosts or their switches, changed. */
  changed(): void;
  /** A host's summary was recorded. */
  summary(hostId: HostId): void;
}

/**
 * One host's agents as its own directory read them for an arm, over a link
 * already up: `link-down` when none is, `refused` when the host takes no
 * assistants' work, `unsupported` from a host too old to list them, `unread`
 * when it didn't answer. `waitingEvents`: it sends its agents' waits.
 */
export type AgentWatchRead =
  | { status: "read"; directory: AgentDirectory; waitingEvents: boolean }
  | { status: "link-down" | "refused" | "unsupported" | "unread" };

export interface HostWatchesDeps {
  hosts(): ObservedHost[];
  controlOn(hostId: HostId): boolean;
  stillRunning(run: OpenRun): boolean;
  /**
   * Hears the link, the host list and summaries as they already arrive,
   * subscribed only while a watch is armed. Absent, no watch is armed.
   */
  observe?(listener: HostWatchListener): () => void;
  /**
   * Hears this machine's and its hosts' agents starting to wait (#16188),
   * subscribed only while an agent watch is armed. Absent, none is armed.
   */
  observeAgents?(listener: AgentWaitingListener): () => void;
  /**
   * One host's agents now, `local` included, for an arm to name those
   * already waiting. Never dials a host. Absent, no agent watch is armed.
   */
  readAgents?(hostId: HostId, options: { projectId?: string }): Promise<AgentWatchRead>;
  /** This machine's name, for an agent watch on it. */
  localName?(): string;
  /** The run's own notice line. Absent, no watch is armed: nothing could tell it. */
  queueNotice?(
    lane: { helpSessionId: string; terminalId: string; projectId: string },
    wake: LaneWake
  ): void;
  now(): number;
  /** This machine's clocks, for how old a sample is; `now` and the monotonic clock by default. */
  clock?(): ElapsedStamp;
  newId(): string;
}

interface BaseRecord {
  watchId: string;
  run: OpenRun;
  condition: HostWatchCondition;
  note?: string;
  armedAt: number;
  expiresAt: number;
  status: HostWatchStatus;
  endedAt: number | null;
  lostReason: HostWatchLostReason | null;
  observed: HostWatchObserved | null;
  delivery: HostWatchDelivery;
  /** Its notice's line was reserved for typing: past here a cancel can't take it back. */
  typing?: true;
}

/** A watch on one host's link or capacity (#14463). */
interface HostRecord extends BaseRecord {
  kind: "host";
  hostId: HostId;
  hostName: string;
  /** A link watch: since when the watched state has held, by this Shell's clock. */
  holdingSince?: number;
}

/** A watch on agents starting to wait (#16188), on one host or every one the caller controls. */
interface AgentsRecord extends BaseRecord {
  kind: "agents";
  /** Null: every host with control on as it is heard, this machine included. */
  hostId: HostId | null;
  hostName: string | null;
  reasons: HostWatchWaitingReasons;
  projectId: string | null;
  /** Hosts its arm read as too old to send their agents' waits: "any" hears their attention instead. */
  olderHosts: Set<HostId>;
  /** What the settle has gathered, by host and terminal: each one's latest. */
  pending: Map<string, HostWatchAgent>;
  /** Matching agents the settle had no room for. */
  pendingOmitted: number;
  /** When the settle ends, by this Shell's clock; null while none runs. */
  flushAt: number | null;
  /** What it fired on. */
  fired: { seen: HostWatchAgent[]; omitted: number } | null;
}

type WatchRecord = HostRecord | AgentsRecord;

type Reply = Omit<HostWatchResult, "outcome" | "detail" | "retryAfterMs">;

const ARMED_DETAIL =
  "Armed. One notice comes when it is first observed, or when it expires or is lost. Cancel it with operation cancel and its watchId.";
const DUPLICATE_DETAIL = "The same watch is already armed; that one stands.";
const ALREADY_DETAIL =
  "Already observed now, so nothing was armed. Act on what host.list shows instead.";
const LOCAL_DETAIL = "This machine is always reachable here; watch a remote host.";
const NO_HOST_DETAIL = "This Shell has no host with that id. List the hosts it knows.";
const CONTROL_OFF_DETAIL =
  "The person has assistant control off for this host, so it can't be watched.";
const UNSUPPORTED_DETAIL = "This Shell can't watch its hosts right now.";
const BUDGET_DETAIL = `This run already holds ${HOST_WATCHES_PER_RUN_MAX} watches. Cancel one first.`;
const TOTAL_DETAIL = "This Shell's assistants hold as many watches as it keeps. Cancel one first.";
const NOT_FOUND_DETAIL = "This run holds no watch with that id.";
const CANCELLED_DETAIL = "Cancelled. No notice will come for it.";
const WITHDRAWN_DETAIL = "Its notice was not typed yet and now won't be.";
const TYPING_DETAIL =
  "Its notice was already being typed and can't be taken back; delivery says how it went.";
const ENDED_DETAIL = "It had already ended; nothing changed.";
const AGENTS_ARMED_DETAIL =
  "Armed. One notice comes when an agent is first seen starting to wait for a reason you named, or when it expires or is lost. Those already waiting are in agents.matches; no notice comes for them. Cancel it with operation cancel and its watchId.";
const AGENTS_ENDED_DETAIL =
  "It was armed and has already ended; see its status. Those already waiting are in agents.matches.";

/** Agents a settle keeps, so a burst of waits across a fleet stays bounded. */
const PENDING_AGENTS_MAX = HOST_WATCH_AGENTS_MAX * 4;

function runKey(run: OpenRun): string {
  return `${run.sessionId}\u0000${run.terminalId}\u0000${run.launchGeneration}`;
}

/** The reasons named, in one order and once each; "any" anywhere is `["any"]`: every one, and none. */
function reasonsOf(named: HostWatchArgs["waitingReasons"]): HostWatchWaitingReasons {
  if (named === undefined) return [...HOST_WATCH_DEFAULT_WAITING_REASONS];
  if (named.includes("any")) return ["any"];
  return HOST_WATCH_WAITING_REASONS.filter((reason) => named.includes(reason));
}

function anyReason(reasons: HostWatchWaitingReasons): boolean {
  return reasons.includes("any");
}

function conditionOf(args: HostWatchArgs): HostWatchCondition {
  return {
    connection: args.connection ?? null,
    memoryAvailableBytesAtLeast: args.memoryAvailableBytesAtLeast ?? null,
    cpuIdleCoresAtLeast: args.cpuIdleCoresAtLeast ?? null,
    memoryPressureAtMost: args.memoryPressureAtMost ?? null,
    agentsWaiting:
      args.agentsWaiting === true
        ? { waitingReasons: reasonsOf(args.waitingReasons), projectId: args.projectId ?? null }
        : null,
  };
}

function sameReasons(a: HostWatchWaitingReasons, b: HostWatchWaitingReasons): boolean {
  return a.length === b.length && a.every((reason, index) => b[index] === reason);
}

function sameCondition(a: HostWatchCondition, b: HostWatchCondition): boolean {
  const agentsA = a.agentsWaiting;
  const agentsB = b.agentsWaiting;
  return (
    a.connection === b.connection &&
    a.memoryAvailableBytesAtLeast === b.memoryAvailableBytesAtLeast &&
    a.cpuIdleCoresAtLeast === b.cpuIdleCoresAtLeast &&
    a.memoryPressureAtMost === b.memoryPressureAtMost &&
    (agentsA === null || agentsB === null
      ? agentsA === agentsB
      : agentsA.projectId === agentsB.projectId &&
        sameReasons(agentsA.waitingReasons, agentsB.waitingReasons))
  );
}

/** An unknown reason, from a host too old to say, is heard only by "any". */
function reasonMatches(
  reasons: HostWatchWaitingReasons,
  reason: HostWatchAgent["waitingReason"]
): boolean {
  return anyReason(reasons) || (reason !== null && reasons.includes(reason));
}

/** The arming run's own pane: it is never told it waits itself. */
function isCallerTerminal(run: OpenRun, hostId: HostId, terminalId: string): boolean {
  return hostId === LOCAL_HOST_ID && terminalId === run.terminalId;
}

function agentKey(hostId: HostId, terminalId: string): string {
  return `${hostId}\u0000${terminalId}`;
}

/** The link in the watched state: connected, or neither connected nor still connecting. */
function linkHolds(host: ObservedHost, want: "connected" | "disconnected"): boolean {
  const status = host.connection.status;
  return want === "connected"
    ? status === "connected"
    : status !== "connected" && status !== "connecting";
}

const PRESSURE_RANK = { normal: 0, warn: 1, critical: 2 } as const;

/** Every figure the caller named, read off a fresh sample; an unmeasured one never meets it. */
function capacityHolds(observed: HostWatchObserved, condition: HostWatchCondition): boolean {
  if (observed.link !== "connected" || observed.sampledAt === null || observed.stale) return false;
  const memory = condition.memoryAvailableBytesAtLeast;
  const available = observed.memoryAvailableBytes;
  if (memory !== null && (available === null || available < memory)) return false;
  const cores = condition.cpuIdleCoresAtLeast;
  if (cores !== null && (observed.cpuIdleCores === null || observed.cpuIdleCores < cores)) {
    return false;
  }
  const pressure = condition.memoryPressureAtMost;
  const seen = observed.memoryPressure;
  return pressure === null || (seen !== null && PRESSURE_RANK[seen] <= PRESSURE_RANK[pressure]);
}

/**
 * One-shot watches for this Shell's assistants: on a host's link or capacity
 * (#14463), or on agents starting to wait (#16188). Each belongs to the exact
 * run that armed it, and a run that replaced it neither sees nor inherits it.
 * A watch fires, expires or is lost once, and says so on its run's own notice
 * line; nothing it does reaches a host. The link, summaries and agents' waits
 * are only listened to while a watch that needs them is armed, and there is no
 * timer while none is.
 */
export class HostWatches {
  /** Every watch still remembered: armed ones, and ended ones a `list` still shows. */
  private readonly watches = new Map<string, WatchRecord>();
  private unsubscribe: (() => void) | null = null;
  private unsubscribeAgents: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: HostWatchesDeps) {}

  run(caller: OpenRun, args: HostWatchArgs): HostWatchResult {
    this.prune();
    switch (args.operation) {
      case "arm":
        return this.arm(caller, args);
      case "cancel":
        return this.cancel(caller, args.watchId ?? "");
      case "list":
        return this.list(caller, args.hostId);
    }
  }

  /** Whether anything is listening or timed: true only while a watch is armed. */
  isActive(): boolean {
    return this.unsubscribe !== null || this.unsubscribeAgents !== null || this.timer !== null;
  }

  /** A help session ended or was relaunched: what its runs armed goes, unannounced. */
  endSession(helpSessionId: string): void {
    for (const [watchId, record] of this.watches) {
      if (record.run.sessionId === helpSessionId) this.watches.delete(watchId);
    }
    this.release();
  }

  dispose(): void {
    this.disposed = true;
    this.watches.clear();
    this.release();
  }

  private arm(caller: OpenRun, args: HostWatchArgs): HostWatchResult {
    if (args.agentsWaiting === true) return this.refuse("unsupported", UNSUPPORTED_DETAIL);
    const hostId = args.hostId ?? "";
    if (hostId === LOCAL_HOST_ID) return this.refuse("unsupported", LOCAL_DETAIL);
    if (this.deps.observe === undefined || this.deps.queueNotice === undefined || this.disposed) {
      return this.refuse("unsupported", UNSUPPORTED_DETAIL);
    }
    const host = this.host(hostId);
    if (host === undefined) return this.refuse("not_found", NO_HOST_DETAIL);
    if (!this.deps.controlOn(hostId)) {
      return this.refuse("opted_out", CONTROL_OFF_DETAIL, this.observe(host));
    }
    const condition = conditionOf(args);
    const key = runKey(caller);
    const mine = [...this.watches.values()].filter((record) => runKey(record.run) === key);
    const duplicate = mine.find(
      (record) =>
        record.kind === "host" &&
        record.status === "armed" &&
        record.hostId === hostId &&
        sameCondition(record.condition, condition)
    );
    if (duplicate !== undefined) {
      return this.answer("ok", DUPLICATE_DETAIL, {
        armed: true,
        watches: [this.view(duplicate)],
        observed: this.observe(host),
      });
    }
    const observed = this.observe(host);
    const already =
      condition.connection !== null
        ? linkHolds(host, condition.connection)
        : capacityHolds(observed, condition);
    if (already) {
      return this.answer("ok", ALREADY_DETAIL, { armed: false, watches: [], observed });
    }
    const room = this.room(mine, observed);
    if (room !== null) return room;
    const now = this.deps.now();
    const note = sanitizeNotifyNote(args.note);
    const record: HostRecord = {
      kind: "host",
      watchId: `hw-${this.deps.newId()}`,
      run: caller,
      hostId,
      hostName: host.name,
      condition,
      ...(note !== undefined ? { note } : {}),
      armedAt: now,
      expiresAt: now + (args.expiresInSeconds ?? HOST_WATCH_EXPIRES_DEFAULT_S) * 1000,
      status: "armed",
      endedAt: null,
      lostReason: null,
      observed: null,
      delivery: "none",
    };
    this.watches.set(record.watchId, record);
    this.acquire();
    // What changed between the read above and the subscription is read again here.
    this.evaluate();
    return this.answer("ok", ARMED_DETAIL, {
      armed: record.status === "armed",
      watches: [this.view(record)],
      observed,
    });
  }

  /**
   * Arms one watch on agents starting to wait (#16188), on one host or every
   * one the caller controls with this machine, and names those already
   * waiting as the hosts' own directories read them now. It listens before
   * it reads, so a wait that starts during the read is heard, never lost.
   */
  async armAgents(caller: OpenRun, args: HostWatchArgs): Promise<HostWatchResult> {
    this.prune();
    const condition = conditionOf(args);
    const agents = condition.agentsWaiting;
    if (
      agents === null ||
      this.deps.observeAgents === undefined ||
      this.deps.readAgents === undefined ||
      this.deps.queueNotice === undefined ||
      this.disposed
    ) {
      return this.refuse("unsupported", UNSUPPORTED_DETAIL);
    }
    const scope = args.hostId ?? null;
    let scopeName: string | null = null;
    if (scope === LOCAL_HOST_ID) {
      scopeName = this.localName();
    } else if (scope !== null) {
      const host = this.host(scope);
      if (host === undefined) return this.refuse("not_found", NO_HOST_DETAIL);
      if (!this.deps.controlOn(scope)) {
        return this.refuse("opted_out", CONTROL_OFF_DETAIL, this.observe(host));
      }
      scopeName = host.name;
    }
    const key = runKey(caller);
    const mine = [...this.watches.values()].filter((record) => runKey(record.run) === key);
    let record = mine.find(
      (candidate): candidate is AgentsRecord =>
        candidate.kind === "agents" &&
        candidate.status === "armed" &&
        candidate.hostId === scope &&
        sameCondition(candidate.condition, condition)
    );
    const duplicate = record !== undefined;
    if (record === undefined) {
      const room = this.room(mine, null);
      if (room !== null) return room;
      const now = this.deps.now();
      const note = sanitizeNotifyNote(args.note);
      record = {
        kind: "agents",
        watchId: `hw-${this.deps.newId()}`,
        run: caller,
        hostId: scope,
        hostName: scopeName,
        condition,
        reasons: agents.waitingReasons,
        projectId: agents.projectId,
        olderHosts: new Set(),
        pending: new Map(),
        pendingOmitted: 0,
        flushAt: null,
        fired: null,
        ...(note !== undefined ? { note } : {}),
        armedAt: now,
        expiresAt: now + (args.expiresInSeconds ?? HOST_WATCH_EXPIRES_DEFAULT_S) * 1000,
        status: "armed",
        endedAt: null,
        lostReason: null,
        observed: null,
        delivery: "none",
      };
      this.watches.set(record.watchId, record);
      this.acquire();
    }
    const current = await this.readCurrent(caller, record);
    const armed = record.status === "armed";
    return this.answer(
      "ok",
      duplicate ? DUPLICATE_DETAIL : armed ? AGENTS_ARMED_DETAIL : AGENTS_ENDED_DETAIL,
      { armed, watches: [this.view(record)], observed: null, agents: current }
    );
  }

  /** Null when the run and this Shell have room for one more; the refusal otherwise. */
  private room(mine: WatchRecord[], observed: HostWatchObserved | null): HostWatchResult | null {
    if (mine.filter((record) => this.holdsRoom(record)).length >= HOST_WATCHES_PER_RUN_MAX) {
      return this.refuse("conflict", BUDGET_DETAIL, observed);
    }
    if (this.armedCount() >= HOST_WATCHES_TOTAL_MAX) {
      return this.refuse("conflict", TOTAL_DETAIL, observed);
    }
    return null;
  }

  /**
   * Who an agent watch's hosts show waiting now, and how each is heard. A
   * host whose control went off while it was read shows nothing; a directory
   * read before, or only in part, names no one as waiting now.
   */
  private async readCurrent(
    caller: OpenRun,
    record: AgentsRecord
  ): Promise<NonNullable<HostWatchResult["agents"]>> {
    const read = this.deps.readAgents;
    const targets: Array<{ hostId: HostId; name: string }> =
      record.hostId !== null
        ? [{ hostId: record.hostId, name: record.hostName ?? record.hostId }]
        : [
            { hostId: LOCAL_HOST_ID, name: this.localName() },
            ...this.deps
              .hosts()
              .filter((host) => host.hostId !== LOCAL_HOST_ID && this.deps.controlOn(host.hostId))
              .map((host) => ({ hostId: host.hostId, name: host.name })),
          ];
    const options = record.projectId === null ? {} : { projectId: record.projectId };
    const reads = await Promise.all(
      targets.map((target): Promise<AgentWatchRead> =>
        read === undefined
          ? Promise.resolve({ status: "unread" })
          : Promise.resolve()
              .then(() => read(target.hostId, options))
              .catch((): AgentWatchRead => ({ status: "unread" }))
      )
    );
    const matches: HostWatchAgent[] = [];
    const hosts: HostWatchHostCoverage[] = [];
    let omitted = 0;
    targets.forEach((target, index) => {
      if (!this.reachable(target.hostId)) return;
      const answer = reads[index] ?? { status: "unread" };
      hosts.push(this.coverage(record, target, answer));
      if (answer.status === "unsupported" || (answer.status === "read" && !answer.waitingEvents)) {
        record.olderHosts.add(target.hostId);
      }
      if (answer.status !== "read" || answer.directory.coverage !== "ok") return;
      for (const entry of answer.directory.entries) {
        if (entry.state !== "live" || entry.agentState !== "waiting") continue;
        if (!reasonMatches(record.reasons, entry.waitingReason)) continue;
        const scope = entry.subject.scope;
        const projectId = scope.kind === "project" ? scope.projectId : null;
        if (record.projectId !== null && projectId !== record.projectId) continue;
        if (isCallerTerminal(caller, target.hostId, entry.subject.terminalId)) continue;
        if (matches.length >= HOST_WATCH_MATCHES_MAX) {
          omitted += 1;
          continue;
        }
        matches.push({
          hostId: target.hostId,
          projectId,
          worktreeId: null,
          terminalId: entry.subject.terminalId,
          incarnation: entry.subject.incarnation,
          agentIncarnation: null,
          waitingReason: entry.waitingReason,
          seenAt: entry.since,
        });
      }
    });
    return { matches, omitted, hosts };
  }

  private coverage(
    record: AgentsRecord,
    target: { hostId: HostId; name: string },
    answer: AgentWatchRead
  ): HostWatchHostCoverage {
    const base = { hostId: target.hostId, name: target.name };
    // An older host's waits come only as the person's attention, which names no reason.
    const older = {
      ...base,
      hears: anyReason(record.reasons) ? "attention" : "older-host",
    } as const;
    switch (answer.status) {
      case "read":
        return answer.waitingEvents ? { ...base, hears: "events" } : older;
      case "unsupported":
        return older;
      case "link-down":
        return { ...base, hears: "link-down" };
      case "refused":
        return { ...base, hears: "host-refused" };
      case "unread":
        return { ...base, hears: "unread" };
    }
  }

  private cancel(caller: OpenRun, watchId: string): HostWatchResult {
    const record = this.watches.get(watchId);
    if (record === undefined || runKey(record.run) !== runKey(caller)) {
      return this.refuse("not_found", NOT_FOUND_DETAIL);
    }
    let detail = ENDED_DETAIL;
    if (record.status === "armed") {
      this.end(record, "cancelled");
      detail = CANCELLED_DETAIL;
      this.release();
    } else if (
      record.typing === true &&
      (record.delivery === "queued" || record.delivery === "held")
    ) {
      detail = TYPING_DETAIL;
    } else if (record.delivery === "queued" || record.delivery === "held") {
      record.delivery = "withdrawn";
      detail = WITHDRAWN_DETAIL;
    }
    return this.answer("ok", detail, {
      armed: false,
      watches: [this.view(record)],
      observed: null,
    });
  }

  private list(caller: OpenRun, hostId: string | undefined): HostWatchResult {
    const key = runKey(caller);
    const mine = [...this.watches.values()]
      .filter((record) => runKey(record.run) === key)
      .filter((record) => hostId === undefined || record.hostId === hostId);
    const armed = mine.filter((record) => record.status === "armed");
    const ended = mine
      .filter((record) => record.status !== "armed")
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    return this.answer("ok", null, {
      armed: armed.length > 0,
      watches: [...armed, ...ended].map((record) => this.view(record)),
      observed: null,
    });
  }

  /** Re-reads every armed watch against what is observed now. */
  private evaluate(): void {
    if (this.disposed) return;
    const now = this.deps.now();
    for (const record of this.watches.values()) {
      if (record.status !== "armed") continue;
      if (!this.deps.stillRunning(record.run)) {
        this.watches.delete(record.watchId);
        continue;
      }
      if (record.kind === "agents") {
        this.evaluateAgents(record, now);
        continue;
      }
      const host = this.host(record.hostId);
      if (host === undefined) {
        this.end(record, "lost", { lostReason: "host-removed", observed: null });
        continue;
      }
      if (!this.deps.controlOn(record.hostId)) {
        this.end(record, "lost", { lostReason: "control-off", observed: this.observe(host) });
        continue;
      }
      if (now >= record.expiresAt) {
        this.end(record, "expired", { observed: this.observe(host) });
        continue;
      }
      const want = record.condition.connection;
      if (want === null) continue;
      if (!linkHolds(host, want)) {
        delete record.holdingSince;
        continue;
      }
      record.holdingSince ??= now;
      if (now - record.holdingSince >= HOST_WATCH_CONNECTION_SETTLE_MS) {
        this.end(record, "fired", { observed: this.observe(host) });
      }
    }
    this.release();
  }

  /**
   * An agent watch on one host is lost with that host or its control, as a
   * link watch is. One on every host hears only those with control on, as
   * each wait arrives, so a switch turned off there just stops it hearing that host.
   */
  private evaluateAgents(record: AgentsRecord, now: number): void {
    const scoped = record.hostId !== null && record.hostId !== LOCAL_HOST_ID ? record.hostId : null;
    if (scoped !== null) {
      const host = this.host(scoped);
      if (host === undefined) {
        this.end(record, "lost", { lostReason: "host-removed" });
        return;
      }
      if (!this.deps.controlOn(scoped)) {
        this.end(record, "lost", { lostReason: "control-off" });
        return;
      }
    }
    if (record.flushAt !== null && now >= record.flushAt) {
      this.flush(record);
      if (record.status !== "armed") return;
    }
    if (now >= record.expiresAt) this.end(record, "expired");
  }

  /**
   * A summary just arrived for one host. A capacity watch reads only these:
   * a sample already held when it was armed, or cached across a reconnect,
   * never fires it.
   */
  private onSummary(hostId: HostId): void {
    if (this.disposed) return;
    this.evaluate();
    const host = this.host(hostId);
    if (host === undefined) return;
    for (const record of this.watches.values()) {
      if (record.kind !== "host" || record.status !== "armed" || record.hostId !== hostId) continue;
      if (record.condition.connection !== null) continue;
      const observed = this.observe(host);
      if (capacityHolds(observed, record.condition)) this.end(record, "fired", { observed });
    }
    this.release();
  }

  /**
   * An agent was seen starting to wait, or its reason changed while it
   * waited. The first one a watch's reasons match starts its settle; others
   * that land before it ends go in the same notice, each with its latest
   * reason, so a prompt that becomes an approval is told as the approval.
   */
  private onAgent(hostId: HostId, heard: AgentWaitingHeard): void {
    if (this.disposed) return;
    const now = this.deps.now();
    for (const record of this.watches.values()) {
      if (record.kind !== "agents" || record.status !== "armed") continue;
      if (!this.hears(record, hostId, heard)) continue;
      const key = agentKey(hostId, heard.terminalId);
      const matches = reasonMatches(record.reasons, heard.waitingReason);
      // One the settle holds whose reason changed to another it doesn't watch is kept, and dropped as it ends.
      if (!matches && !record.pending.has(key)) continue;
      if (!record.pending.has(key) && record.pending.size >= PENDING_AGENTS_MAX) {
        record.pendingOmitted += 1;
        continue;
      }
      record.pending.set(key, {
        hostId,
        projectId: heard.projectId,
        worktreeId: heard.worktreeId,
        terminalId: heard.terminalId,
        incarnation: heard.incarnation,
        agentIncarnation: heard.agentIncarnation,
        waitingReason: heard.waitingReason,
        seenAt: heard.seenAt,
      });
      if (matches && record.flushAt === null) record.flushAt = now + NOTIFY_TARGET_SETTLE_MS;
    }
    this.release();
  }

  private hears(record: AgentsRecord, hostId: HostId, heard: AgentWaitingHeard): boolean {
    if (record.hostId !== null && record.hostId !== hostId) return false;
    if (!this.reachable(hostId)) return false;
    if (record.projectId !== null && heard.projectId !== record.projectId) return false;
    if (isCallerTerminal(record.run, hostId, heard.terminalId)) return false;
    // The person's notice stands in only for a host too old to send its own.
    if (heard.source === "attention") {
      return anyReason(record.reasons) && record.olderHosts.has(hostId);
    }
    return true;
  }

  /** The settle ended: it fires on what still matches, or keeps watching when nothing does. */
  private flush(record: AgentsRecord): void {
    const seen = [...record.pending.values()].filter(
      (agent) => reasonMatches(record.reasons, agent.waitingReason) && this.reachable(agent.hostId)
    );
    const unheld = record.pendingOmitted;
    record.pending.clear();
    record.pendingOmitted = 0;
    record.flushAt = null;
    if (seen.length === 0) return;
    const shown = seen.slice(0, HOST_WATCH_AGENTS_MAX);
    record.fired = { seen: shown, omitted: seen.length - shown.length + unheld };
    this.end(record, "fired");
  }

  private end(
    record: WatchRecord,
    status: Exclude<HostWatchStatus, "armed">,
    detail: { observed?: HostWatchObserved | null; lostReason?: HostWatchLostReason } = {}
  ): void {
    record.status = status;
    record.endedAt = this.deps.now();
    if (record.kind === "host") {
      delete record.holdingSince;
    } else {
      record.pending.clear();
      record.flushAt = null;
    }
    if (detail.observed !== undefined) record.observed = detail.observed;
    if (detail.lostReason !== undefined) record.lostReason = detail.lostReason;
    if (status !== "cancelled") this.tell(record, status);
    this.trimHistory(record.run);
  }

  /** Queues the one line a watch ends with on its run's own notice line. */
  private tell(record: WatchRecord, event: "fired" | "expired" | "lost"): void {
    const queue = this.deps.queueNotice;
    if (queue === undefined) return;
    record.delivery = "queued";
    const fired = record.kind === "agents" ? record.fired : null;
    const notice: HostWatchNotice = {
      hostName: record.hostName,
      watchId: record.watchId,
      event,
      condition: record.condition,
      armedAt: record.armedAt,
      observed: record.observed,
      ...(record.note !== undefined ? { note: record.note } : {}),
      ...(record.lostReason !== null ? { lostReason: record.lostReason } : {}),
      ...(fired !== null
        ? {
            agents: {
              seen: fired.seen.map((agent) => ({ ...agent, hostName: this.nameOf(agent.hostId) })),
              omitted: fired.omitted,
            },
          }
        : {}),
    };
    const live = (): boolean =>
      !this.disposed &&
      this.watches.get(record.watchId) === record &&
      record.delivery !== "withdrawn" &&
      this.deps.stillRunning(record.run);
    const wake: LaneWake = {
      id: record.watchId,
      kind: "watch",
      hostWatch: notice,
      recheck: () => {
        if (record.delivery === "withdrawn") return { kind: "unavailable", reason: "cancelled" };
        if (!live()) return { kind: "unavailable", reason: "relaunched" };
        // What a host showed is never typed once the person turned its control off.
        if (notice.agents !== undefined) {
          notice.agents.seen = notice.agents.seen.filter((agent) => this.reachable(agent.hostId));
          if (notice.agents.seen.length === 0) {
            return { kind: "unavailable", reason: "control-off" };
          }
        }
        return { kind: "ready" };
      },
      beforeType: () => {
        if (!live()) return false;
        record.typing = true;
        // It is being typed now, whatever held it before.
        record.delivery = "queued";
        return true;
      },
      report: (outcome: LaneWakeOutcome) => {
        if (record.delivery === "withdrawn") return;
        record.delivery = outcome.kind;
        if (outcome.kind !== "held") this.trimHistory(record.run);
      },
    };
    try {
      queue(
        {
          helpSessionId: record.run.sessionId,
          terminalId: record.run.terminalId,
          projectId: record.run.projectId,
        },
        wake
      );
    } catch (error) {
      logger.warn("Couldn't queue a host watch's notice", { error });
      record.delivery = "unavailable";
    }
  }

  /** A run's ended watches past the history kept, oldest first; one whose notice is unsettled stays. */
  private trimHistory(run: OpenRun): void {
    const key = runKey(run);
    const ended = [...this.watches.values()]
      .filter((record) => runKey(record.run) === key && !this.holdsRoom(record))
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const record of ended.slice(0, Math.max(0, ended.length - HOST_WATCH_HISTORY_MAX))) {
      this.watches.delete(record.watchId);
    }
  }

  /** Armed, or ended with its notice still on the way: counted against the run's budget. */
  private holdsRoom(record: WatchRecord): boolean {
    return record.status === "armed" || record.delivery === "queued" || record.delivery === "held";
  }

  private armedCount(): number {
    let count = 0;
    for (const record of this.watches.values()) if (record.status === "armed") count += 1;
    return count;
  }

  private agentsArmed(): boolean {
    for (const record of this.watches.values()) {
      if (record.kind === "agents" && record.status === "armed") return true;
    }
    return false;
  }

  /** Forgets what runs no longer running remembered; a successor never sees them. */
  private prune(): void {
    for (const [watchId, record] of this.watches) {
      if (!this.deps.stillRunning(record.run)) this.watches.delete(watchId);
    }
    this.release();
  }

  private acquire(): void {
    if (this.unsubscribe === null && this.deps.observe !== undefined) {
      this.unsubscribe = this.deps.observe({
        changed: () => this.evaluate(),
        summary: (hostId) => this.onSummary(hostId),
      });
    }
    if (
      this.unsubscribeAgents === null &&
      this.deps.observeAgents !== undefined &&
      this.agentsArmed()
    ) {
      this.unsubscribeAgents = this.deps.observeAgents((hostId, heard) =>
        this.onAgent(hostId, heard)
      );
    }
    this.schedule();
  }

  /** Lets go of the listeners and the timer once nothing needs them; reschedules otherwise. */
  private release(): void {
    if (!this.agentsArmed() || this.disposed) {
      const unsubscribeAgents = this.unsubscribeAgents;
      this.unsubscribeAgents = null;
      unsubscribeAgents?.();
    }
    if (this.armedCount() > 0 && !this.disposed) {
      this.schedule();
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    unsubscribe?.();
  }

  /** One timer, to the next expiry, link settle or agent settle. */
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    let next = Number.POSITIVE_INFINITY;
    for (const record of this.watches.values()) {
      if (record.status !== "armed") continue;
      next = Math.min(next, record.expiresAt);
      if (record.kind === "host" && record.holdingSince !== undefined) {
        next = Math.min(next, record.holdingSince + HOST_WATCH_CONNECTION_SETTLE_MS);
      }
      if (record.kind === "agents" && record.flushAt !== null) {
        next = Math.min(next, record.flushAt);
      }
    }
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.evaluate();
      },
      Math.max(0, next - this.deps.now())
    );
    this.timer.unref?.();
  }

  private host(hostId: HostId): ObservedHost | undefined {
    if (hostId === LOCAL_HOST_ID) return undefined;
    return this.deps.hosts().find((host) => host.hostId === hostId);
  }

  /** This machine, or a host whose control is on now: whose agents a watch may name. */
  private reachable(hostId: HostId): boolean {
    return hostId === LOCAL_HOST_ID || this.deps.controlOn(hostId);
  }

  private localName(): string {
    return this.deps.localName?.() ?? "this machine";
  }

  private nameOf(hostId: HostId): string {
    if (hostId === LOCAL_HOST_ID) return this.localName();
    return this.host(hostId)?.name ?? hostId;
  }

  private observe(host: ObservedHost): HostWatchObserved {
    const now = this.deps.now();
    const stamp = this.deps.clock?.() ?? { wall: now, mono: performance.now() };
    const load = host.summary
      ? projectHostLoad(
          host.summary,
          sampleFreshness(host.summary, host.summaryReceipt ?? null, stamp)
        )
      : null;
    return {
      observedAt: now,
      link: projectHostLink(host.connection, host.disconnectedByPerson === true).status,
      lastSeenAt: host.lastSeenAt,
      sampledAt: load?.sampledAt ?? null,
      stale: load?.stale ?? false,
      memoryAvailableBytes: load?.memoryAvailableBytes ?? null,
      cpuIdleCores: load?.cpuIdleCores ?? null,
      memoryPressure: load?.memoryPressure ?? null,
    };
  }

  private view(record: WatchRecord): HostWatch {
    return {
      watchId: record.watchId,
      hostId: record.hostId,
      hostName: record.hostName,
      condition: { ...record.condition },
      note: record.note ?? null,
      armedAt: record.armedAt,
      expiresAt: record.expiresAt,
      status: record.status,
      endedAt: record.endedAt,
      lostReason: record.lostReason,
      observed: record.observed,
      delivery: record.delivery,
    };
  }

  private answer(
    outcome: HostControlOutcomeCode,
    detail: string | null,
    reply: Reply
  ): HostWatchResult {
    return { outcome, detail, retryAfterMs: null, ...reply };
  }

  private refuse(
    outcome: Exclude<HostControlOutcomeCode, "ok">,
    detail: string,
    observed: HostWatchObserved | null = null
  ): HostWatchResult {
    return this.answer(outcome, detail, { armed: false, watches: [], observed });
  }
}

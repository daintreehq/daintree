import {
  HOST_WATCHES_PER_RUN_MAX,
  HOST_WATCHES_TOTAL_MAX,
  HOST_WATCH_CONNECTION_SETTLE_MS,
  HOST_WATCH_EXPIRES_DEFAULT_S,
  HOST_WATCH_HISTORY_MAX,
  type HostControlOutcomeCode,
  type HostWatch,
  type HostWatchArgs,
  type HostWatchCondition,
  type HostWatchDelivery,
  type HostWatchLostReason,
  type HostWatchObserved,
  type HostWatchResult,
  type HostWatchStatus,
} from "../../../shared/types/hostControl.js";
import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import { sanitizeNotifyNote } from "../../../shared/types/terminalNotify.js";
import type { LaneWake, LaneWakeOutcome } from "../../services/mcp-server/terminalNotify.js";
import type { HostWatchNotice } from "../../services/mcp-server/noticeFormat.js";
import { createLogger } from "../../utils/logger.js";
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

export interface HostWatchesDeps {
  hosts(): ObservedHost[];
  controlOn(hostId: HostId): boolean;
  stillRunning(run: OpenRun): boolean;
  /**
   * Hears the link, the host list and summaries as they already arrive,
   * subscribed only while a watch is armed. Absent, no watch is armed.
   */
  observe?(listener: HostWatchListener): () => void;
  /** The run's own notice line. Absent, no watch is armed: nothing could tell it. */
  queueNotice?(
    lane: { helpSessionId: string; terminalId: string; projectId: string },
    wake: LaneWake
  ): void;
  now(): number;
  newId(): string;
}

interface WatchRecord {
  watchId: string;
  run: OpenRun;
  hostId: HostId;
  hostName: string;
  condition: HostWatchCondition;
  note?: string;
  armedAt: number;
  expiresAt: number;
  status: HostWatchStatus;
  endedAt: number | null;
  lostReason: HostWatchLostReason | null;
  observed: HostWatchObserved | null;
  delivery: HostWatchDelivery;
  /** A link watch: since when the watched state has held, by this Shell's clock. */
  holdingSince?: number;
}

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
const ENDED_DETAIL = "It had already ended; nothing changed.";

function runKey(run: OpenRun): string {
  return `${run.sessionId}\u0000${run.terminalId}\u0000${run.launchGeneration}`;
}

function conditionOf(args: HostWatchArgs): HostWatchCondition {
  return {
    connection: args.connection ?? null,
    memoryAvailableBytesAtLeast: args.memoryAvailableBytesAtLeast ?? null,
    cpuIdleCoresAtLeast: args.cpuIdleCoresAtLeast ?? null,
    memoryPressureAtMost: args.memoryPressureAtMost ?? null,
  };
}

function sameCondition(a: HostWatchCondition, b: HostWatchCondition): boolean {
  return (
    a.connection === b.connection &&
    a.memoryAvailableBytesAtLeast === b.memoryAvailableBytesAtLeast &&
    a.cpuIdleCoresAtLeast === b.cpuIdleCoresAtLeast &&
    a.memoryPressureAtMost === b.memoryPressureAtMost
  );
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
 * One-shot watches on a host's link or capacity for this Shell's assistants
 * (#14463). Each belongs to the exact run that armed it, and a run that
 * replaced it neither sees nor inherits it. A watch fires, expires or is lost
 * once, and says so on its run's own notice line; nothing it does reaches a
 * host. The link and summaries are only listened to while one is armed, and
 * there is no timer while none is.
 */
export class HostWatches {
  /** Every watch still remembered: armed ones, and ended ones a `list` still shows. */
  private readonly watches = new Map<string, WatchRecord>();
  private unsubscribe: (() => void) | null = null;
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
    return this.unsubscribe !== null || this.timer !== null;
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
    if (mine.filter((record) => this.holdsRoom(record)).length >= HOST_WATCHES_PER_RUN_MAX) {
      return this.refuse("conflict", BUDGET_DETAIL, observed);
    }
    if (this.armedCount() >= HOST_WATCHES_TOTAL_MAX) {
      return this.refuse("conflict", TOTAL_DETAIL, observed);
    }
    const now = this.deps.now();
    const note = sanitizeNotifyNote(args.note);
    const record: WatchRecord = {
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
      if (record.status !== "armed" || record.hostId !== hostId) continue;
      if (record.condition.connection !== null) continue;
      const observed = this.observe(host);
      if (capacityHolds(observed, record.condition)) this.end(record, "fired", { observed });
    }
    this.release();
  }

  private end(
    record: WatchRecord,
    status: Exclude<HostWatchStatus, "armed">,
    detail: { observed?: HostWatchObserved | null; lostReason?: HostWatchLostReason } = {}
  ): void {
    record.status = status;
    record.endedAt = this.deps.now();
    delete record.holdingSince;
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
    const notice: HostWatchNotice = {
      hostName: record.hostName,
      watchId: record.watchId,
      event,
      condition: record.condition,
      armedAt: record.armedAt,
      observed: record.observed,
      ...(record.note !== undefined ? { note: record.note } : {}),
      ...(record.lostReason !== null ? { lostReason: record.lostReason } : {}),
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
        return live() ? { kind: "ready" } : { kind: "unavailable", reason: "relaunched" };
      },
      beforeType: live,
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
    return (
      record.status === "armed" || record.delivery === "queued" || record.delivery === "held"
    );
  }

  private armedCount(): number {
    let count = 0;
    for (const record of this.watches.values()) if (record.status === "armed") count += 1;
    return count;
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
    this.schedule();
  }

  /** Lets go of the listener and the timer once nothing is armed; reschedules otherwise. */
  private release(): void {
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

  /** One timer, to the next expiry or link settle. */
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    let next = Number.POSITIVE_INFINITY;
    for (const record of this.watches.values()) {
      if (record.status !== "armed") continue;
      next = Math.min(next, record.expiresAt);
      if (record.holdingSince !== undefined) {
        next = Math.min(next, record.holdingSince + HOST_WATCH_CONNECTION_SETTLE_MS);
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

  private observe(host: ObservedHost): HostWatchObserved {
    const now = this.deps.now();
    const load = host.summary ? projectHostLoad(host.summary, now) : null;
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

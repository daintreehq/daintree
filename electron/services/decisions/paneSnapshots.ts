import {
  paneIdentityOf,
  targetOf,
  type DecisionsBridge,
  type LocalStore,
  type PaneSnapshotInput,
  type QuestionOrigin,
  type QuestionRow,
  type SnapshotRefreshRequest,
} from "@daintreehq/decisions-client";
import { AGENT_REGISTRY } from "../../../shared/config/agentRegistry.js";
import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import { composeTitledPanel } from "../../../shared/utils/terminalTitleDisplay.js";
import type { PtyClient } from "../PtyClient.js";
import { readPluginTerminalScreen } from "../plugin/pluginTerminalScreenRead.js";
import { redactSecrets } from "../redactSecrets.js";
import {
  identityMismatch,
  type DecisionGenerationReader,
  type DecisionIdentitySources,
} from "./decisionWake.js";

/** How many of the screen's newest lines a snapshot carries (#16230). */
export const SNAPSHOT_LINES = 40;
/**
 * How often a working agent's pane is read again, so the phone, which calls
 * a snapshot stale a minute after the relay took it, never does while the
 * agent works. Four a minute leaves most of the relay's 30 per question.
 */
export const WORKING_TICK_MS = 15_000;
/**
 * Least time between two snapshots of one question (the library's own is
 * 2 s): at most 24 a minute, so a refresh, which skips it, always has room.
 */
export const SNAPSHOT_MIN_INTERVAL_MS = 2_500;
/** Pane events that come together (a state change and a retitle) are read once. */
const SETTLE_MS = 200;
/** A read the pty host didn't answer in time is tried again this often, this many times in a row. */
const READ_RETRY_MS = 5_000;
const READ_RETRIES = 3;
/**
 * The questions the relay may hold a snapshot of from this store's device,
 * as a JSON list: each recorded before its first share and dropped once a
 * clear of it has gone through, so a restart takes back what a crash left.
 */
export const SNAPSHOTS_SHARED_META_KEY = "daintree:snapshots-shared";

/** The whole screen: no line or byte cut before redaction, which sees it all. */
const WHOLE_SCREEN = { scrollbackRows: 0, maxBytes: Number.MAX_SAFE_INTEGER };

/** The pty client calls a snapshot reads a pane with. */
export type PaneSnapshotPtyClient = DecisionGenerationReader &
  Pick<PtyClient, "getTerminalProjectId" | "getTerminalAsync" | "getSerializedStateAsync">;

type PaneRecord = NonNullable<Awaited<ReturnType<PtyClient["getTerminalAsync"]>>>;

/** What a snapshot needs from main. */
export interface PaneSnapshotSources extends DecisionIdentitySources {
  /**
   * Whether a pane may be read and its snapshot published now: the owner's
   * switch and consent (#16228), or what a Host's owner last said. Read at
   * each step, so it turns false the moment the switch does.
   */
  allowed(): boolean;
  getPtyClient(): PaneSnapshotPtyClient | null;
  /**
   * Calls `onPane` with the pane's id on each of main's events that can
   * change its snapshot, and its agent's new state when the event says.
   */
  watchPanes(onPane: (terminalId: string, state?: string) => void): () => void;
}

export interface PaneSnapshotsOptions extends PaneSnapshotSources {
  store: Pick<LocalStore, "listQuestions" | "getQuestion" | "getMeta" | "setMeta">;
  now?: () => number;
  tickMs?: number;
  settleMs?: number;
  retryMs?: number;
}

/**
 * The bridge calls a snapshot goes through: each attempt's bridge in turn.
 * Clears go to its publisher with the row, which queues them at once, where
 * `clearSnapshots` would first read the row and then wait on the relay.
 */
export type SnapshotBridge = Pick<DecisionsBridge, "publishSnapshot"> & {
  snapshots: Pick<DecisionsBridge["snapshots"], "clear">;
};

/** A question Daintree asked from one of this machine's panes, still waiting for its answer. */
interface Asking {
  row: QuestionRow;
  /** What was last queued for it on the current bridge; a read that finds the same sends nothing. */
  sent: string | null;
  /** Its pane's title as last read for the run that asked: an exited snapshot keeps it. */
  title: string | null;
}

interface PaneRead {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  again: boolean;
  /** Publish even what was published already: a phone asked, a working agent's tick, a new bridge. */
  force: boolean;
}

type Reading =
  { kind: "screen"; input: PaneSnapshotInput } | { kind: "exited" } | { kind: "unreadable" };

/**
 * Only an open question is shared: one queued here or open on the relay.
 * Once answered, its pane is the agent's again, whatever delivery does next.
 */
function isAsking(row: QuestionRow, hostId: string | null): boolean {
  return (
    !row.history_only &&
    (row.local_status === "queued" || row.local_status === "open") &&
    hostId !== null &&
    row.origin.host_id === hostId
  );
}

function sameRun(a: QuestionOrigin, b: QuestionOrigin): boolean {
  return (
    a.pane_id === b.pane_id &&
    a.terminal_generation === b.terminal_generation &&
    a.ownership_principal === b.ownership_principal &&
    a.agent_incarnation === b.agent_incarnation &&
    a.agent_session_id === b.agent_session_id &&
    a.worktree_id === b.worktree_id
  );
}

function agentName(agentId: string | undefined): string | null {
  if (!agentId || !Object.hasOwn(AGENT_REGISTRY, agentId)) return null;
  return AGENT_REGISTRY[agentId as BuiltInAgentId].name;
}

/** What the store records as shared; anything unreadable is nothing. */
function sharedIds(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** Whether the pane holds the very run `origin` names, by the checks delivery types an answer under. */
function verdict(
  sources: DecisionIdentitySources,
  origin: QuestionOrigin,
  info: PaneRecord | null
): "current" | "gone" | "unreadable" {
  const mismatch = identityMismatch(sources, targetOf(origin), info ?? undefined);
  // No host id, or no pty client: nothing here can say what the pane holds.
  if (mismatch === "unreadable" || mismatch === "host-offline") return "unreadable";
  if (mismatch !== null) return "gone";
  // Main still holds the run's generation, so a record that didn't come back is a read that failed.
  return info === null ? "unreadable" : "current";
}

/**
 * The pane as Daintree shows it: the title as its header composes it (a
 * user's title, then the agent's task, then the default), the observed state,
 * and the screen's newest lines. Both texts are redacted whole, before
 * anything cuts them, so no cut leaves part of a secret behind.
 */
export function snapshotOf(
  record: PaneRecord,
  screen: string,
  observedAt: number
): PaneSnapshotInput {
  const title = composeTitledPanel(
    {
      title: record.title ?? agentName(record.detectedAgentId ?? record.launchAgentId) ?? "",
      titleMode: record.titleMode,
      lastObservedTitle: record.lastObservedTitle,
      detectedAgentId: record.detectedAgentId,
      agentState: record.agentState,
      cwd: record.cwd,
    },
    "full"
  );
  const redacted = redactSecrets(screen);
  const state = record.agentState ?? "unknown";
  return {
    agentState: state,
    waitingReason: state === "waiting" ? (record.waitingReason ?? null) : null,
    paneTitle: redactSecrets(title),
    terminal: redacted === "" ? [] : redacted.split("\n").slice(-SNAPSHOT_LINES),
    observedAt,
  };
}

/**
 * Reads the pane for each origin that asked from it: its screen, only while
 * the pane holds that very run before and after the read; exited once it
 * doesn't, so a relaunched pane never shows the new run's screen as the old
 * one's; unreadable while nothing can say. A read that times out throws.
 */
export async function readAskers(
  sources: DecisionIdentitySources,
  client: PaneSnapshotPtyClient,
  paneId: string,
  origins: readonly QuestionOrigin[],
  now: () => number = Date.now
): Promise<Reading[]> {
  const settled = (state: "gone" | "unreadable"): Reading =>
    state === "gone" ? { kind: "exited" } : { kind: "unreadable" };
  const before = await client.getTerminalAsync(paneId, undefined, { strict: true });
  const first = origins.map((origin) => verdict(sources, origin, before));
  if (!first.includes("current")) {
    return first.map((state) => settled(state === "current" ? "unreadable" : state));
  }
  // Alt screen, ghost input and a respawn between its own reads are the plugin read's.
  const screen = await readPluginTerminalScreen(
    client,
    paneId,
    null,
    Number.MAX_SAFE_INTEGER,
    WHOLE_SCREEN,
    { dropGhostInput: true }
  );
  const observedAt = now();
  const after = await client.getTerminalAsync(paneId, undefined, { strict: true });
  return origins.map((origin, index) => {
    const was = first[index]!;
    if (was !== "current") return settled(was);
    const is = verdict(sources, origin, after);
    if (is !== "current") return settled(is);
    if (after === null || after.spawnedAt !== before?.spawnedAt) return { kind: "exited" };
    if (screen.status === "exited") return { kind: "exited" };
    if (screen.status !== "ok") return { kind: "unreadable" };
    return { kind: "screen", input: snapshotOf(after, screen.text, observedAt) };
  });
}

function keyOf(input: PaneSnapshotInput): string {
  return JSON.stringify([
    input.agentState,
    input.waitingReason ?? null,
    input.paneTitle,
    input.terminal,
  ]);
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

/**
 * Terminal snapshots (#16230) for one relay connection: for each pane with
 * an open question it asked, what the phone shows of it. Read on the
 * question being asked, on each of the pane's state changes, retitles,
 * relaunches and exits, on a phone's refresh, and every `WORKING_TICK_MS`
 * while its agent works; each read goes out through the attempt's bridge,
 * which coalesces and encrypts it. While snapshots are off nothing is read
 * and nothing listens: a refresh is answered "not shared", and what was
 * shared is taken back, here and after a restart, once a bridge can.
 *
 * One step at a time hands the bridge a record, and none waits on the relay,
 * so a clear handed over after a publish lands after it (the library sends a
 * question's newest record last) and a clear the relay keeps refusing holds
 * nothing up behind it.
 */
export class PaneSnapshots {
  private readonly o: PaneSnapshotsOptions;
  private readonly now: () => number;
  private readonly asking = new Map<string, Asking>();
  private readonly reads = new Map<string, PaneRead>();
  /** Each pane's agent state as last read or reported, so the tick reads only working ones. */
  private readonly states = new Map<string, string>();
  /** Reads that failed in a row, by pane, and the retry each has waiting. */
  private readonly failures = new Map<string, number>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Questions closed here, waiting for a bridge to take back what they shared. */
  private readonly toClear = new Set<string>();
  private bridge: SnapshotBridge | null = null;
  /** Rises with each bridge and each turn of the switch: a read begun before one sends nothing. */
  private epoch = 0;
  private sharing = false;
  /** The questions the relay may hold a snapshot of from this store, as it records them; null until read. */
  private shared: Set<string> | null = null;
  private offPanes: (() => void) | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private steps: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(options: PaneSnapshotsOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
  }

  /** The store's question rows after a write: questions asked, answered, closed or moved to another pane. */
  observe(rows: readonly QuestionRow[]): void {
    if (this.stopped) return;
    const hostId = this.o.hostId();
    const open = new Map<string, QuestionRow>();
    for (const row of rows) if (isAsking(row, hostId)) open.set(row.question_id, row);
    for (const [id, asking] of this.asking) {
      const row = open.get(id);
      if (row === undefined) {
        this.asking.delete(id);
        this.clear(id);
      } else if (!sameRun(row.origin, asking.row.origin)) {
        // Resumed elsewhere: the run it is bound to now is the one to read.
        this.asking.set(id, { row, sent: null, title: null });
        this.request(row.origin.pane_id, true);
      } else {
        asking.row = row;
      }
    }
    for (const [id, row] of open) {
      if (this.asking.has(id)) continue;
      this.asking.set(id, { row, sent: null, title: null });
      this.request(row.origin.pane_id, true);
    }
    this.follow();
  }

  /** The switch may have turned: on reads every asking pane, off takes back what was shared. */
  sharingChanged(): void {
    if (this.stopped) return;
    const allowed = this.o.allowed();
    if (allowed === this.sharing) return;
    this.sharing = allowed;
    this.epoch++;
    if (allowed) {
      this.requestAll();
    } else {
      this.cancelReads();
      this.clearAll();
    }
    this.follow();
  }

  /** An attempt's bridge started: what changed while none was up is caught up through it. */
  attach(bridge: SnapshotBridge): void {
    if (this.stopped) return;
    this.bridge = bridge;
    this.epoch++;
    this.sharing = this.o.allowed();
    for (const asking of this.asking.values()) asking.sent = null;
    this.enqueue(async () => {
      const rows = await this.o.store.listQuestions();
      const shared = await this.loadShared();
      if (this.bridge !== bridge) return;
      this.observe(rows);
      if (this.sharing) {
        // Shared before, by an earlier bridge or run, for a question that no longer asks.
        for (const id of shared) if (!this.asking.has(id)) this.toClear.add(id);
        this.requestAll();
        this.flushClears(bridge);
      } else if (shared.size > 0) {
        this.clearAll();
      }
    });
    this.follow();
  }

  /** The attempt retired: its bridge sends nothing more of ours. */
  detach(bridge: SnapshotBridge): void {
    if (this.bridge !== bridge) return;
    this.bridge = null;
    this.epoch++;
    this.cancelReads();
    this.follow();
  }

  /** A phone asked for a fresh snapshot of a question `bridge` published. */
  refreshRequested(bridge: SnapshotBridge, request: SnapshotRefreshRequest): void {
    if (this.stopped || this.bridge !== bridge) return;
    const asking = this.asking.get(request.questionId);
    if (asking !== undefined && this.o.allowed()) {
      this.request(asking.row.origin.pane_id, true);
      return;
    }
    // Not shared, or no longer asking: the phone shows so instead of waiting out its deadline.
    this.enqueue(async () => {
      const row = await this.o.store.getQuestion(request.questionId);
      if (row === null || this.bridge !== bridge) return;
      this.handOver(bridge.snapshots.clear(row));
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.bridge = null;
    this.epoch++;
    this.cancelReads();
    this.follow();
  }

  /** Listening and ticking only while something can be read and sent. */
  private follow(): void {
    const live = !this.stopped && this.sharing && this.bridge !== null && this.asking.size > 0;
    if (live && this.offPanes === null) {
      this.offPanes = this.o.watchPanes((paneId, state) => this.onPane(paneId, state));
    } else if (!live && this.offPanes !== null) {
      this.offPanes();
      this.offPanes = null;
    }
    const working = live && this.workingPanes().length > 0;
    if (working && this.tick === null) {
      this.tick = setInterval(() => {
        for (const paneId of this.workingPanes()) this.request(paneId, true);
      }, this.o.tickMs ?? WORKING_TICK_MS);
      this.tick.unref?.();
    } else if (!working && this.tick !== null) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }

  private panes(): Set<string> {
    return new Set([...this.asking.values()].map((asking) => asking.row.origin.pane_id));
  }

  private workingPanes(): string[] {
    return [...this.panes()].filter((paneId) => this.states.get(paneId) === "working");
  }

  private onPane(paneId: string, state: string | undefined): void {
    if (!this.panes().has(paneId)) return;
    // The state as reported, so the tick follows a working agent even when this read fails.
    if (state !== undefined) this.states.set(paneId, state);
    this.request(paneId, false);
    this.follow();
  }

  private requestAll(): void {
    for (const paneId of this.panes()) this.request(paneId, true);
  }

  private request(paneId: string, force: boolean): void {
    if (this.stopped || !this.sharing || this.bridge === null) return;
    let read = this.reads.get(paneId);
    if (read === undefined) {
      read = { timer: null, running: false, again: false, force: false };
      this.reads.set(paneId, read);
    }
    read.force ||= force;
    if (read.running) {
      read.again = true;
      return;
    }
    if (read.timer !== null) return;
    const scheduled = read;
    scheduled.timer = setTimeout(() => {
      scheduled.timer = null;
      void this.run(paneId, scheduled);
    }, this.o.settleMs ?? SETTLE_MS);
    scheduled.timer.unref?.();
  }

  private cancelReads(): void {
    for (const read of this.reads.values()) {
      if (read.timer !== null) clearTimeout(read.timer);
      read.timer = null;
      read.again = false;
    }
    for (const [paneId, read] of this.reads) if (!read.running) this.reads.delete(paneId);
    for (const retry of this.retries.values()) clearTimeout(retry);
    this.retries.clear();
    this.failures.clear();
  }

  private async run(paneId: string, read: PaneRead): Promise<void> {
    read.running = true;
    try {
      do {
        read.again = false;
        const force = read.force;
        read.force = false;
        await this.capture(paneId, force);
      } while (read.again && !this.stopped);
    } finally {
      read.running = false;
      if (this.reads.get(paneId) === read && read.timer === null) this.reads.delete(paneId);
    }
  }

  /** The pty host didn't answer in time: read again soon, a few times, rather than wait for the next event. */
  private retryLater(paneId: string): void {
    const failed = (this.failures.get(paneId) ?? 0) + 1;
    this.failures.set(paneId, failed);
    if (failed > READ_RETRIES || this.retries.has(paneId)) return;
    const retry = setTimeout(() => {
      this.retries.delete(paneId);
      this.request(paneId, true);
    }, this.o.retryMs ?? READ_RETRY_MS);
    retry.unref?.();
    this.retries.set(paneId, retry);
  }

  private async capture(paneId: string, force: boolean): Promise<void> {
    const bridge = this.bridge;
    const epoch = this.epoch;
    const client = this.o.getPtyClient();
    if (bridge === null || client === null || !this.o.allowed()) return;
    const askers = [...this.asking.entries()].filter(
      ([, asking]) => asking.row.origin.pane_id === paneId
    );
    if (askers.length === 0) return;
    let readings: Reading[];
    try {
      readings = await readAskers(
        this.o,
        client,
        paneId,
        askers.map(([, asking]) => asking.row.origin),
        this.now
      );
    } catch {
      if (this.bridge === bridge && this.epoch === epoch) this.retryLater(paneId);
      return;
    }
    this.failures.delete(paneId);
    let state: string | null = null;
    for (const [index, [id, asking]] of askers.entries()) {
      const reading = readings[index]!;
      if (reading.kind === "unreadable") continue;
      let input: PaneSnapshotInput;
      if (reading.kind === "screen") {
        input = reading.input;
        asking.title = input.paneTitle;
        state = input.agentState;
      } else {
        input = {
          agentState: "exited",
          waitingReason: null,
          paneTitle: asking.title ?? agentName(asking.row.origin.agent_kind) ?? "",
          terminal: [],
        };
      }
      this.publish(bridge, epoch, id, asking, input, force);
    }
    // The pane's agent as the run still in it shows it; none once every asker's run is gone.
    if (state !== null) this.states.set(paneId, state);
    else if (readings.some((reading) => reading.kind === "exited")) this.states.delete(paneId);
    this.follow();
  }

  private publish(
    bridge: SnapshotBridge,
    epoch: number,
    id: string,
    asking: Asking,
    input: PaneSnapshotInput,
    force: boolean
  ): void {
    const key = keyOf(input);
    if (!force && asking.sent === key) return;
    const stale = () =>
      this.stopped ||
      this.bridge !== bridge ||
      this.epoch !== epoch ||
      this.asking.get(id) !== asking ||
      !this.o.allowed();
    this.enqueue(async () => {
      if (stale()) return;
      const shared = await this.loadShared();
      if (!shared.has(id)) {
        // Recorded before anything goes, so a restart knows to take it back.
        shared.add(id);
        await this.saveShared();
        if (stale()) return;
      }
      const result = await bridge.publishSnapshot(id, input, paneIdentityOf(asking.row.origin));
      if (result === "queued") asking.sent = key;
    });
  }

  private clear(id: string): void {
    this.toClear.add(id);
    if (this.bridge !== null) this.flushClears(this.bridge);
  }

  /** Questions closed while shared: each one's snapshot is replaced with "not shared". */
  private flushClears(bridge: SnapshotBridge): void {
    if (this.toClear.size === 0) return;
    this.enqueue(async () => {
      const shared = await this.loadShared();
      for (const id of [...this.toClear]) {
        if (this.bridge !== bridge) return;
        this.toClear.delete(id);
        // Asking again (reopened), or nothing of it shared: nothing to take back.
        if (this.asking.has(id) || !shared.has(id)) continue;
        await this.takeBack(bridge, id);
      }
    });
  }

  /** Snapshots turned off, or found shared by an earlier run: every question that shared one takes it back. */
  private clearAll(): void {
    this.enqueue(async () => {
      const bridge = this.bridge;
      if (bridge === null) return;
      const shared = await this.loadShared();
      this.toClear.clear();
      for (const id of [...shared]) {
        if (this.bridge !== bridge || this.o.allowed()) return;
        await this.takeBack(bridge, id);
      }
    });
  }

  /**
   * Hands the bridge `id`'s sharing-off record, at once, without waiting on
   * the relay. Once the record settles through a bridge still attached, the
   * question is dropped from what the store records as shared, unless it was
   * shared again since; one left recorded is taken back by the next bridge.
   */
  private async takeBack(bridge: SnapshotBridge, id: string): Promise<void> {
    const row = await this.o.store.getQuestion(id);
    const shared = this.shared!;
    if (this.bridge !== bridge) {
      this.toClear.add(id);
      return;
    }
    if (row === null) {
      // Deleted here: the relay keeps nothing of a question gone from the store.
      shared.delete(id);
      await this.saveShared();
      return;
    }
    // A row given, the library queues the record before its first await.
    const settled = bridge.snapshots.clear(row);
    this.handOver(settled, () =>
      this.enqueue(async () => {
        if (this.bridge !== bridge || !shared.has(id)) return;
        if (this.asking.has(id) && this.o.allowed()) return;
        shared.delete(id);
        await this.saveShared();
      })
    );
  }

  /** Follows a record handed to the bridge without holding up the next step. */
  private handOver(settled: Promise<void>, then?: () => void): void {
    settled.then(then, (error: unknown) => {
      if (!this.stopped)
        console.warn(`[Decisions] A terminal snapshot wasn't cleared (${codeOf(error)})`);
    });
  }

  private async loadShared(): Promise<Set<string>> {
    if (this.shared === null) {
      this.shared = sharedIds(await this.o.store.getMeta(SNAPSHOTS_SHARED_META_KEY));
    }
    return this.shared;
  }

  private saveShared(): Promise<void> {
    return this.o.store.setMeta(SNAPSHOTS_SHARED_META_KEY, JSON.stringify([...this.shared!]));
  }

  private enqueue(step: () => Promise<void>): void {
    this.steps = this.steps.then(step).catch((error: unknown) => {
      // Never the content: only what kind of refusal it was.
      if (!this.stopped) {
        console.warn(`[Decisions] A terminal snapshot wasn't sent (${codeOf(error)})`);
      }
    });
  }
}

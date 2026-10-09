import type { FleetRunRow } from "../../../shared/types/ipc/fleet.js";
import {
  CANOPY_ATTENTION_THRESHOLD,
  CANOPY_URGENT_PRIORITY,
  type CanopyCard,
  type CanopyCategory,
  type CanopyDisposition,
  type CanopyGlance,
  type CanopyPlan,
  type CanopyRunGlance,
  type CanopySeen,
  type CanopySnapshot,
} from "../../../shared/types/ipc/canopy.js";
import {
  isSecretPrompt,
  prepareScreen,
  redactSecrets,
  sameScreenTail,
  scrolledSince,
  type PreparedScreen,
} from "./canopyScreen.js";
import {
  CanopyProviderError,
  combinePriority,
  type CanopyNote,
  type CanopyPartialDescription,
  type CanopyPreviousReading,
  type ClassifierResult,
  type DescriberResult,
  type CanopyScreenInput,
  type CanopyUserAction,
} from "./canopyProviders.js";
import { digestHistory, type CanopyDigest } from "./canopyDigest.js";
import type { TerminalAnswer } from "../../../shared/utils/terminalSubmission.js";
import { EMPTY_GLANCE, glanceScreen } from "./canopyGlance.js";
import { observedCaughtUp } from "../../../shared/utils/canopyObservedKind.js";

/** Screen rows read per run — the tail the cards are written from. */
export const CANOPY_SCREEN_LINES = 50;
/**
 * Rows of history read above the screen when a card is written, for the
 * user's requests and the agent's plan — both scroll off the screen within a
 * minute of work. Read only for a describer pass, never on a poll.
 */
export const CANOPY_HISTORY_ROWS = 400;
/**
 * A working agent's unchanged screen read longer ago than this is judged again
 * on the next scan, in case it is stuck. Nothing else is ever re-sent unchanged.
 */
export const CANOPY_REJUDGE_AFTER_MS = 60_000;
/**
 * A working agent's screen moves on every poll, so its progress is written at
 * most this often; between writes the row keeps the last words. Waiting runs
 * are described on every change, as before — they are what the user acts on.
 */
export const CANOPY_PROGRESS_DESCRIBE_MS = 15_000;
/**
 * The least time between two reads of a run whose screen keeps changing while
 * Daintree sees it in the same state: what the user sees holds still between
 * reads, and a busy agent's output is not sent on every poll.
 */
export const CANOPY_REREAD_MS = 10_000;
/**
 * How often an open panel re-reads every screen. Reading a screen is local and
 * cheap; only the ones whose tail changed since their card was written go on to
 * the providers, so a quiet or waiting fleet costs nothing between polls.
 */
export const CANOPY_POLL_MS = 3_000;
/**
 * How long after an agent's observed state changes an open panel looks at the
 * screens again — long enough for the screen to finish drawing what made the
 * state change, short enough that a new prompt is in the panel within a second.
 */
export const CANOPY_STATE_CHANGE_SCAN_MS = 400;
/**
 * How often screens are read with no panel open. Only the classifier reads
 * them then — it is what tells the user an agent is asking something, lights
 * the toolbar, and has the inbox in priority order the moment the panel opens
 * — and only the ones that changed; the describer waits for the panel to open.
 * A classifier-only read is the service's light request (`/v1/classify`, its
 * own lane on the workers, ~50 ms of work).
 * An observed state change still scans within a second, so this is the net
 * for the waits Daintree's own state misses.
 */
export const CANOPY_BACKGROUND_POLL_MS = 15_000;

/** A close this soon after an open is a bounce, not the panel going away. */
export const CANOPY_CLOSE_GRACE_MS = 300;
/** A working run's screen still this long is shown as stalled. */
export const CANOPY_STALL_MS = 10 * 60_000;
/** A screen still for less than this is not reported to the readers as still. */
const SCREEN_STILL_REPORTED_MS = 60_000;
/**
 * Reads in flight at once. Canopy's service batches on one worker and slows
 * for everyone past a handful at a time, so the rest wait here, where waiting
 * costs nothing, rather than there, where it times out.
 */
const CONCURRENCY = { classifier: 8, describer: 6 } as const;
const SCREEN_READ_CONCURRENCY = 8;
/**
 * How long reads may keep failing for reasons that pass — a rate limit, a
 * worker waking, a timeout — before it is reported. Until then a run keeps
 * what it last said and is tried again on the next scan.
 */
export const CANOPY_TRANSIENT_GRACE_MS = 60_000;
/**
 * The most a spell of passing failures is kept quiet in all, however many
 * times the service is woken in it: a cold start takes about a minute, so this
 * covers one and its grace, and a service that never comes up is reported.
 */
export const CANOPY_COLD_START_GRACE_MS = 180_000;
/**
 * The priority each classifier reading gives, before any words are written:
 * the describer's own anchors for the same situations, so a run keeps its
 * place when the words land. The classifier can't tell a finished turn with
 * loose ends (55) from a clean one (40), so it sits between them.
 */
export const CANOPY_CLASSIFIER_ANCHORS = {
  approval: 92,
  question: 86,
  stuck: 70,
  error: 70,
  finished: 50,
  notable: 30,
  idle: 20,
  busy: 5,
} as const;
/**
 * How an ask's priority follows the classifier's probability that the agent
 * is blocked on a person: the finished anchor at `from` or below, the ask's
 * own anchor at `to` or above, and a straight line between. Measured on the
 * gold set, real approvals and questions read 0.91–0.98 and finished turns
 * 0.30 at most, so only a confident ask reaches the urgent band.
 */
export const CANOPY_BLOCKED_SCALE = { from: 0.5, to: 0.9 } as const;
/** Below this category confidence the classifier's approval or question is not taken as one. */
const ASK_CONFIDENCE = 0.5;
/** A busy run the classifier gives at least this attention probability is read as stuck. */
const STUCK_ATTENTION = 0.8;
/** A busy run the classifier gives at least this notable probability is worth a look. */
const NOTABLE_PROBABILITY = 0.5;
const BROADCAST_DEBOUNCE_MS = 40;

export interface CanopyServiceDeps {
  /** Whether the user turned Canopy on, and on which tier; absent, on and priority. */
  plan?: CanopyPlan;
  /** The fleet's current runs, or null while the fleet is unknown. */
  getRuns: () => readonly FleetRunRow[] | null;
  /**
   * The run's current screen as plain text, with the pane's width when known
   * (to put rows the agent wrapped back together), or null when it can't be read.
   */
  readScreen: (runId: string, lines: number) => Promise<ScreenRead | string | null>;
  /** The screen and `rows` of scrollback above it, or null; absent, no history is read. */
  readHistory?: (runId: string, rows: number) => Promise<string | null>;
  classify: (input: CanopyScreenInput, signal: AbortSignal) => Promise<ClassifierResult>;
  /**
   * The run's card. A describer that streams calls `onPartial` with what the
   * card says so far, for the row to show before the card is finished.
   */
  describe: (
    input: CanopyScreenInput,
    classifierSays: CanopyCategory,
    signal: AbortSignal,
    onPartial?: (partial: CanopyPartialDescription) => void
  ) => Promise<DescriberResult>;
  broadcast: (snapshot: CanopySnapshot) => void;
  now?: () => number;
  /** How long a close waits for a reopen before it abandons the scan; 0 closes at once. */
  closeGraceMs?: number;
  /** How often an open panel re-reads screens, over `CANOPY_POLL_MS`; 0 never polls. */
  pollMs?: number;
  /** The least time between two reads of a busy run's changing screen; see `CANOPY_REREAD_MS`. */
  rereadMs?: number;
  /** How long after an observed state change an open panel scans; see `CANOPY_STATE_CHANGE_SCAN_MS`. */
  stateChangeScanMs?: number;
  /** How often screens are read with no panel open, over `CANOPY_BACKGROUND_POLL_MS`; 0 reads nothing then. */
  backgroundPollMs?: number;
  /**
   * The classifier read a run as newly asking the user something — an
   * approval or a question — while it sits in the inbox. Called once per ask:
   * again only after it stopped asking, or the agent worked in between.
   */
  onAsk?: (run: FleetRunRow, ask: CanopyAsk) => void;
  /**
   * The service is known to be starting from cold. Transient failures meanwhile
   * are its start, not a fault, so the grace before one is reported waits for it.
   */
  serviceWaking?: () => boolean;
}

export interface ScreenRead {
  text: string;
  cols?: number;
}

export interface CanopyAsk {
  kind: "approval" | "question";
  /** The prompt line the classifier picked, verbatim; null when it picked none. */
  question: string | null;
}

/**
 * The user put the run aside — archived it, or replied to it — for the screen
 * it was showing then. It stays aside until the agent has something new to
 * say: see `returnsToInbox`.
 */
interface Disposition {
  kind: "archived" | "replied";
  at: number;
  /**
   * Orders the action against scans: a scan that began before it carries a
   * lower mark, so what it read predates the action. A counter, not a clock —
   * two events in one millisecond still order.
   */
  mark: number;
  /** The screen text when the user acted, or null when it had not been read yet. */
  contentHash: string | null;
  /** The prompt on screen when the user acted, normalised; null when none. */
  question: string | null;
  /** The agent has worked, or been read as not needing anyone, since the action. */
  sawWork: boolean;
}

/** What a card is written from: the pass that read the run's screen. */
interface CardRead {
  run: FleetRunRow;
  seq: number;
  screen: PreparedScreen;
  input: CanopyScreenInput;
  classified: ClassifierResult;
  /** Words about a busy run's progress, not about a prompt. */
  progress: boolean;
  earlier: CanopyPreviousReading | null;
}

interface RunEntry {
  /** The terminal incarnation this entry is for; ids are reused across respawns. */
  spawnedAt: number;
  /** Hash of the screen the current card (or in-flight pass) was built from. */
  hash: string | null;
  /**
   * The screen the card was last read from, kept through a failed read (which
   * clears `hash`): what tells a screen that moved during a backoff.
   */
  readKey: string | null;
  /** Hash of the screen text alone at the last read, for telling a changed screen. */
  contentHash: string | null;
  /** When `contentHash` last changed (epoch ms): how long the screen has stood still. */
  contentChangedAt: number;
  disposition: Disposition | null;
  /** Bumped per new screen, so a pass for an older screen can't land. */
  seq: number;
  /**
   * Bumped only when the screen itself moved: the card's `revision`, which
   * tells a new prompt from the same one. A retry of an unchanged screen
   * bumps `seq` but not this, so an acknowledged prompt stays acknowledged.
   */
  revision: number;
  card: CanopyCard | null;
  /** A pass for this run is in flight. */
  pending: boolean;
  /** A read whose words were due while no panel was open, for the open to write. */
  wordsWaiting: CardRead | null;
  /** Aborts the card being written for this run, once a newer screen supersedes it. */
  cardAbort: AbortController | null;
  /** The card being written is about a busy run's progress, not a prompt. */
  cardProgress: boolean;
  /** The card being written may show its words as they stream: the row had none. */
  cardStreams: boolean;
  /** Failed passes in a row, for the backoff before the next try. */
  failures: number;
  /** No pass for this run starts before this (epoch ms): a failing service is not hammered. */
  retryAt: number;
  /** When the classifier last read this screen (epoch ms), 0 before it has. */
  readAt: number;
  /** What Daintree observed of the run at that read (`observedKey`). */
  readState: string;
  /**
   * The last read of this run failed, and where; its card, if any, is from
   * before. Each stage's success clears only its own failure.
   */
  failure: { stage: "classifier" | "describer"; message: string } | null;
  /** When the describer last wrote this run's words (epoch ms), 0 before it has. */
  describedAt: number;
  /**
   * When the user last had this terminal in front of them — focused in its
   * pane, or open in the panel (epoch ms); null when not since Daintree started.
   */
  seenAt: number | null;
  /**
   * The user's request the card's task title was written for, normalised. The
   * title is the row's name: it stays put until the user asks for other work,
   * since a name that is reworded on every read is never learned.
   */
  taskRequest: string | null;
  /**
   * The describer's private note on this terminal from its last reading, and
   * when it was written: what has scrolled off the screen since — the user's
   * goal and constraints, what was finished, failures that keep coming back.
   * Handed back on every describe; it never reaches the renderer.
   */
  note: { text: string; at: number } | null;
  /**
   * The screen the last describe read, and the failure count it gave: where
   * the next one looks for what scrolled away since, and an unchanged screen
   * shows no new failed run.
   */
  lastDescribed: {
    lines: string[];
    hash: string;
    failureRepeats: number;
    /** What the classifier made of the screen the words were written for (`verdictOf`). */
    verdict: string;
    /** The choices those words offered, for a re-read that keeps them. */
    options: string[];
  } | null;
  /** The urgent ask the classifier read on the current screen; null when it read none. */
  ask: CanopyAsk | null;
  /** What the newest screen read says at a glance; null before one was read. */
  glance: CanopyGlance | null;
  /** `onAsk` was told about the ask on screen; cleared once it stops asking, goes back to work, or is suppressed. */
  asking: boolean;
}

/**
 * Keeps one card per agent run, rebuilt only when that run's screen changes.
 *
 * Every changed screen goes to the classifier; only runs that need the user (or
 * that the classifier is unsure about) go on to the describer, which is the
 * expensive call. With a panel open every screen is watched closely and
 * described; with none open, changed screens go to the classifier alone, every
 * `backgroundPollMs` and on observed state changes, so an agent asking
 * something is still noticed.
 */
export class CanopyService {
  private readonly entries = new Map<string, RunEntry>();
  private readonly now: () => number;
  private readonly closeGraceMs: number;
  private plan: CanopyPlan;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stateChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stateChangeScanMs: number;
  /** Each run's observed state at the last fleet change, to tell when one moved. */
  private observedStates = new Map<string, string>();
  /** Whether the fleet showed each run (`runId:spawnedAt`) busy at its last change, to tell when one starts work. */
  private wasBusy = new Map<string, boolean>();
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private scanning: Promise<void> | null = null;
  private rescanRequested = false;
  /** The next scan reads every changed screen, held or not: the user pressed Refresh. */
  private forceNextScan = false;
  private inFlight = 0;
  private refreshedAt: number | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last snapshot sent, as sent, so a quiet poll sends nothing. */
  private lastBroadcast: string | null = null;
  private sequence = 0;
  /** Cards being written, apart from the scan that read their screens. */
  private readonly cardJobs = new Set<Promise<void>>();
  private abort = new AbortController();
  /**
   * Bumped whenever in-flight work stops being wanted — the last panel closed,
   * or Canopy was turned off — so a pass started before it can't land or go on
   * to the describer.
   */
  private epoch = 0;
  private classifierSlots: Semaphore;
  private describerSlots: Semaphore;
  /**
   * When each run's classifier or describer reads began failing for reasons
   * that pass, by `runId:stage`; cleared when that same read next succeeds,
   * so one stage's successes never hide the other's failures.
   */
  private readonly transientSince = new Map<string, { since: number; graceFrom: number }>();
  private disposed = false;
  /** Only runs in this workspace are read; null reads every workspace. */
  private scope: string | null = null;
  /** Bumped by every scan start and every disposition, to order the two. */
  private marks = 0;

  constructor(private readonly deps: CanopyServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.closeGraceMs = deps.closeGraceMs ?? CANOPY_CLOSE_GRACE_MS;
    this.plan = deps.plan ?? { activated: true, tier: "priority" };
    this.stateChangeScanMs = deps.stateChangeScanMs ?? CANOPY_STATE_CHANGE_SCAN_MS;
    this.classifierSlots = new Semaphore(CONCURRENCY.classifier);
    this.describerSlots = new Semaphore(CONCURRENCY.describer);
    this.startPolling();
    if (this.watching) void this.scan();
  }

  /** Abandon every pass in flight: abort its requests and let none of it land. */
  private invalidateInFlight(): void {
    this.epoch++;
    this.abort.abort();
    this.abort = new AbortController();
    for (const entry of this.entries.values()) {
      // A read kept for the panel was made under what is now invalidated.
      entry.wordsWaiting = null;
      if (!entry.pending) continue;
      // Its screen was never finished, so the next scan must look again.
      entry.pending = false;
      entry.hash = null;
      if (entry.card?.describing) entry.card = { ...entry.card, describing: false };
    }
  }

  /** Screens are read: the user turned Canopy on. */
  get isRunning(): boolean {
    return this.plan.activated;
  }

  private get pollMs(): number {
    return this.deps.pollMs ?? CANOPY_POLL_MS;
  }

  private get rereadMs(): number {
    return this.deps.rereadMs ?? CANOPY_REREAD_MS;
  }

  private get backgroundPollMs(): number {
    return this.deps.backgroundPollMs ?? CANOPY_BACKGROUND_POLL_MS;
  }

  /** Screens are being read: a panel is open, or the background watch is on. */
  private get watching(): boolean {
    return !this.disposed && this.isRunning && (this.active || this.backgroundPollMs > 0);
  }

  /**
   * The user turned Canopy on or off, or changed tier. Turned off, nothing in
   * flight lands and every card goes: they were read off screens the user has
   * since withdrawn.
   */
  setPlan(plan: CanopyPlan): void {
    if (this.disposed) return;
    const wasRunning = this.isRunning;
    this.plan = plan;
    this.restartPolling();
    if (!this.isRunning) {
      this.invalidateInFlight();
      for (const entry of this.entries.values()) {
        entry.card = null;
        entry.hash = null;
      }
    }
    this.scheduleBroadcast();
    if (this.watching && !wasRunning) void this.scan();
  }

  getSnapshot(): CanopySnapshot {
    const cards: CanopyCard[] = [];
    for (const entry of this.entries.values()) if (entry.card) cards.push(entry.card);
    const dispositions: CanopyDisposition[] = [];
    const seen: CanopySeen[] = [];
    const glances: CanopyRunGlance[] = [];
    const wordsDue: string[] = [];
    for (const [runId, entry] of this.entries) {
      if (entry.wordsWaiting !== null) wordsDue.push(runId);
      if (entry.seenAt !== null) seen.push({ runId, spawnedAt: entry.spawnedAt, at: entry.seenAt });
      if (entry.card === null && entry.glance !== null) {
        glances.push({ runId, spawnedAt: entry.spawnedAt, glance: entry.glance });
      }
      if (entry.disposition) {
        dispositions.push({
          runId,
          spawnedAt: entry.spawnedAt,
          kind: entry.disposition.kind,
          at: entry.disposition.at,
        });
      }
    }
    return {
      sequence: ++this.sequence,
      activated: this.plan.activated,
      tier: this.plan.tier,
      dispositions,
      seen,
      scope: this.scope,
      active: this.active,
      busy: this.scanning !== null || this.inFlight > 0,
      refreshedAt: this.refreshedAt,
      cards,
      glances,
      // Only runs still failing speak: another run's success says nothing
      // about them, and a run that left takes its failure with it.
      lastError:
        [...this.entries.values()].find((entry) => entry.failure !== null)?.failure?.message ??
        null,
      failedRuns: [...this.entries]
        .filter(([, entry]) => entry.failure !== null)
        .map(([runId]) => runId),
      ...(wordsDue.length > 0 ? { wordsDue } : {}),
    };
  }

  /**
   * A panel opened or closed. Opening scans at once, then every `pollMs` while
   * it stays open; Refresh scans on demand. A poll costs a provider call only
   * for a screen whose tail changed since its card was written.
   *
   * `immediate` is for a view that went away (crashed, reloaded, destroyed)
   * rather than a panel the user closed: nothing will reopen it, so there is
   * no bounce to wait out.
   */
  setActive(active: boolean, immediate = false): void {
    if (this.disposed) return;
    if (active) {
      if (this.closeTimer !== null) {
        // Reopened before the close took effect: the scan under way carries on.
        clearTimeout(this.closeTimer);
        this.closeTimer = null;
        return;
      }
      if (this.active) return;
      this.active = true;
      this.wordsDueOnOpen();
      // A background scan under way reads for the classifier alone; the open
      // asks for a full one straight after it.
      void this.scan();
      this.restartPolling();
      this.scheduleBroadcast();
      return;
    }
    if (!this.active) return;
    if (immediate) {
      if (this.closeTimer !== null) clearTimeout(this.closeTimer);
      this.closeTimer = null;
      this.deactivate();
      return;
    }
    if (this.closeTimer !== null) return;
    // A close straight followed by an open — React replaying the panel's
    // effect in development, or the user reopening it — must not abort the
    // scan the open started and then start a second one.
    if (this.closeGraceMs <= 0) {
      this.deactivate();
      return;
    }
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      this.deactivate();
    }, this.closeGraceMs);
  }

  /**
   * Runs that need words the background watch did not write — the describer
   * only reads with a panel open — get them now: an ask, or a busy agent whose
   * progress went unwritten. One whose screen the watch already read is
   * written from that read; the rest are read again. Their rows keep the old
   * words meanwhile.
   */
  private wordsDueOnOpen(): void {
    const runs = this.isRunning ? this.deps.getRuns() : null;
    for (const [runId, entry] of this.entries) {
      const card = entry.card;
      if (entry.pending || entry.disposition?.kind === "archived") continue;
      if (card !== null && card.stage === "described" && !card.wordsFromEarlierRead) continue;
      // The run as the fleet shows it now: the read's own row may be older.
      const run = runs?.find((row) => row.runId === runId && row.spawnedAt === entry.spawnedAt);
      // Not shown by the panel that opened: left, cached read and all, for the
      // watch or for a panel that shows it.
      if (run !== undefined && this.scope !== null && run.workspaceId !== this.scope) continue;
      const waiting = entry.wordsWaiting;
      entry.wordsWaiting = null;
      // Still the screen that read was of, read without failing since, and
      // still owed words: a run answered or put aside since is owed only
      // progress.
      if (
        waiting !== null &&
        run !== undefined &&
        card !== null &&
        waiting.seq === entry.seq &&
        entry.hash !== null &&
        (entry.disposition === null || waiting.progress)
      ) {
        entry.pending = true;
        entry.card = { ...card, describing: true };
        // How long it has waited is as of now, not as of the read.
        const read: CardRead = {
          ...waiting,
          run,
          input: {
            ...waiting.input,
            observed: this.observed(run, entry),
            userAction: this.userAction(entry, waiting.screen),
          },
          earlier: waiting.progress ? previousReading(card, entry.describedAt, this.now()) : null,
        };
        this.startCard(entry, read, this.epoch, this.abort.signal);
        continue;
      }
      if (
        card === null ||
        needsAttention(card.attentionProbability) ||
        busyCategory(card.category)
      ) {
        entry.hash = null;
      }
    }
  }

  private restartPolling(): void {
    this.stopPolling();
    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollTimer !== null || !this.watching) return;
    const ms = this.active ? this.pollMs : this.backgroundPollMs;
    if (ms <= 0) return;
    // A scan still running when the next tick comes absorbs it instead of
    // queueing a second one behind it.
    // A panel closing, inside its reopen grace, starts nothing new: the grace
    // keeps the scan under way, not the polling.
    this.pollTimer = setInterval(() => {
      if (this.scanning === null && this.closeTimer === null) void this.scan();
    }, ms);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private deactivate(): void {
    this.active = false;
    if (this.stateChangeTimer !== null) clearTimeout(this.stateChangeTimer);
    this.stateChangeTimer = null;
    // Closing drops the work the panel queued, describer calls included; the
    // background watch, if on, carries on reading for the classifier alone.
    this.invalidateInFlight();
    this.restartPolling();
    this.scheduleBroadcast();
  }

  /**
   * The user asked for a fresh look. Every screen is re-read, but only the ones
   * that changed since their card was written go to the providers — an
   * unchanged screen would get the same card back for the price of a call.
   */
  async refresh(): Promise<void> {
    const behind = this.scanning !== null;
    this.forceNextScan = true;
    await this.scan();
    // A scan already under way when the press came ends first; the one asked
    // for follows straight after it. Only that one: later rescans are not
    // this press's to wait for.
    if (behind && this.scanning) await this.scanning;
    // The cards that scan set going are part of what was asked for.
    await Promise.all([...this.cardJobs]);
  }

  /**
   * The user sent something to the run from the panel: it is answered for the
   * screen it was showing. It leaves the queue — priority 0, under Everything
   * else — until the agent has something new to say.
   */
  markHandled(runId: string, spawnedAt: number): void {
    const entry = this.setDisposition(runId, spawnedAt, "replied");
    if (entry?.card) entry.card = { ...entry.card, handledAt: entry.disposition!.at, priority: 0 };
  }

  /**
   * Input answered the run's terminal from anywhere — its pane in the grid,
   * the composer, a fleet broadcast, an agent driving it. Return answers
   * whatever the screen asked, as a reply from the panel does; so does a key
   * that answers an approval menu by itself (a digit, Y, Esc). Typing an
   * answer to a question is not an answer until it is sent.
   */
  noteInput(runId: string, answer: TerminalAnswer): void {
    if (this.disposed) return;
    const entry = this.entries.get(runId);
    const card = entry?.card;
    // Only a run waiting on the user: a message to a working agent leaves its
    // card as the readers wrote it.
    if (!entry || !card || card.handledAt !== null || busyCategory(card.category)) return;
    if (answer === "submit" || card.category === "approval") {
      this.markHandled(runId, entry.spawnedAt);
    }
  }

  /**
   * The user archived the run: it leaves the inbox for the Archived section,
   * and comes back the way mail does — when the agent has something new to say.
   */
  archive(runId: string, spawnedAt: number): void {
    const entry = this.setDisposition(runId, spawnedAt, "archived");
    if (entry?.card?.handledAt != null) entry.card = { ...entry.card, handledAt: null };
  }

  /**
   * Back to the inbox, by the user's hand. Its screen is read afresh, since
   * nothing new was written about it while it was aside.
   */
  unarchive(runId: string, spawnedAt: number): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.spawnedAt !== spawnedAt || entry.disposition?.kind !== "archived") return;
    entry.disposition = null;
    // Words were not written while it was aside. Only a run that needs the user
    // and lacks words for the screen it shows now is read again; an unchanged,
    // described screen keeps its card and costs nothing.
    const card = entry.card;
    const stale =
      card === null ||
      (needsAttention(card.attentionProbability) &&
        (card.stage !== "described" || card.wordsFromEarlierRead));
    if (stale && !entry.pending) entry.hash = null;
    this.scheduleBroadcast();
    if (stale && this.watching) void this.scan();
  }

  private setDisposition(
    runId: string,
    spawnedAt: number,
    kind: Disposition["kind"]
  ): RunEntry | null {
    if (this.disposed) return null;
    // Only the incarnation the fleet shows now; an action on a respawned id
    // must not carry over to the new terminal.
    const runs = this.deps.getRuns();
    if (runs !== null && !runs.some((run) => run.runId === runId && run.spawnedAt === spawnedAt)) {
      return null;
    }
    let entry = this.entries.get(runId);
    if (!entry || entry.spawnedAt !== spawnedAt) {
      entry = newEntry(spawnedAt);
      this.entries.set(runId, entry);
    }
    entry.disposition = {
      kind,
      at: this.now(),
      mark: ++this.marks,
      contentHash: entry.contentHash,
      question: entry.card?.question ? normalize(entry.card.question) : null,
      sawWork: false,
    };
    this.scheduleBroadcast();
    return entry;
  }

  /**
   * The user had the run's terminal in front of them just now. Recorded for
   * the incarnation the fleet shows, and kept while the panel is closed: most
   * looking happens in the terminal's own pane, not here. Broadcast only to an
   * open panel; a closed one reads it with the next snapshot it asks for.
   */
  markSeen(runId: string): void {
    if (this.disposed) return;
    const run = this.deps.getRuns()?.find((candidate) => candidate.runId === runId);
    if (!run) return;
    let entry = this.entries.get(runId);
    if (!entry || entry.spawnedAt !== run.spawnedAt) {
      entry = newEntry(run.spawnedAt);
      this.entries.set(runId, entry);
    }
    entry.seenAt = this.now();
    if (this.active) this.scheduleBroadcast();
  }

  /** Read only one workspace's runs, or every workspace's (null). */
  setScope(workspaceId: string | null): void {
    if (this.disposed || this.scope === workspaceId) return;
    this.scope = workspaceId;
    // Queued passes check scope before they reach a provider (`stillWanted`)
    // and are dropped; the screens they were for are read again once back in
    // scope, rather than trusted as read.
    for (const run of this.deps.getRuns() ?? []) {
      if (workspaceId === null || run.workspaceId === workspaceId) continue;
      const entry = this.entries.get(run.runId);
      if (!entry?.pending) continue;
      entry.pending = false;
      entry.hash = null;
      if (entry.card?.describing) entry.card = { ...entry.card, describing: false };
    }
    this.scheduleBroadcast();
    // A panel closing, inside its reopen grace, starts nothing new.
    if (this.watching && this.closeTimer === null) void this.scan();
  }

  /**
   * The fleet changed shape. Cards for runs that left are dropped at once; an
   * observed state change scans soon after, and the rest wait for the next poll.
   */
  onFleetChanged(): void {
    const runs = this.deps.getRuns();
    if (this.pruneDeparted(runs ?? undefined)) this.scheduleBroadcast();
    // An agent that just stopped (or started) is what the user opened the panel
    // for: its screen is read now rather than at the next poll, so a new prompt
    // is in the list within a second of appearing.
    if (runs !== null && this.observedStatesMoved(runs)) this.scheduleStateChangeScan();
    // Work seen between polls, or while the panel is closed, still counts: an
    // agent put aside that ran and stopped again in between has something new
    // to say, even though no scan saw it busy.
    const busy = new Map<string, boolean>();
    for (const run of runs ?? []) {
      const id = `${run.runId}:${run.spawnedAt}`;
      busy.set(id, isBusy(run));
      if (!isBusy(run)) continue;
      const entry = this.entries.get(run.runId);
      if (!entry || entry.spawnedAt !== run.spawnedAt) continue;
      if (entry.disposition) entry.disposition.sawWork = true;
      // Starting work after an ask: whatever it asks next is a new ask, even
      // if no scan saw the screen in between. Only a start seen counts — an
      // agent whose ask Daintree's own state missed keeps calling busy.
      if (this.wasBusy.get(id) === false) entry.asking = false;
    }
    if (runs !== null) this.wasBusy = busy;
  }

  private observedStatesMoved(runs: readonly FleetRunRow[]): boolean {
    const next = new Map<string, string>();
    let moved = false;
    for (const run of runs) {
      const state = `${run.spawnedAt}:${run.agentState ?? ""}:${run.waitingReason ?? ""}`;
      next.set(run.runId, state);
      if (this.observedStates.get(run.runId) !== state) moved = true;
    }
    this.observedStates = next;
    return moved;
  }

  private scheduleStateChangeScan(): void {
    if (!this.watching || this.stateChangeTimer !== null) return;
    this.stateChangeTimer = setTimeout(() => {
      this.stateChangeTimer = null;
      if (this.closeTimer === null) void this.scan();
    }, this.stateChangeScanMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.stateChangeTimer !== null) clearTimeout(this.stateChangeTimer);
    this.stateChangeTimer = null;
    this.active = false;
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.stopPolling();
    this.abort.abort();
    if (this.broadcastTimer !== null) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
  }

  /** One pass over every run. Overlapping requests coalesce into one follow-up. */
  scan(): Promise<void> {
    // Not watching, no requests: a refresh or an action's follow-up scan that
    // arrives after the last panel closed, with no background watch, sends nothing.
    if (!this.watching) return Promise.resolve();
    if (this.scanning) {
      this.rescanRequested = true;
      return this.scanning;
    }
    this.scanning = this.scanOnce().finally(() => {
      this.scanning = null;
      this.scheduleBroadcast();
      if (this.rescanRequested && this.watching) {
        this.rescanRequested = false;
        void this.scan();
      }
    });
    this.scheduleBroadcast();
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    const fleet = this.deps.getRuns();
    if (fleet === null) return;
    this.pruneDeparted(fleet);
    const scope = this.scope;
    const runs = scope === null ? fleet : fleet.filter((run) => run.workspaceId === scope);
    const force = this.forceNextScan;
    this.forceNextScan = false;
    const epoch = this.epoch;
    // A disposition set after this scan began acts on screens read later; what
    // this scan saw predates it.
    const readMark = ++this.marks;
    const reads = new Semaphore(SCREEN_READ_CONCURRENCY);
    const passes: Promise<void>[] = [];
    await Promise.all(
      runs.map((run) =>
        reads.run(async () => {
          const read = await this.deps.readScreen(run.runId, CANOPY_SCREEN_LINES).catch(() => null);
          if (read === null || this.disposed || epoch !== this.epoch) return;
          const raw = typeof read === "string" ? read : read.text;
          const cols = typeof read === "string" ? undefined : read.cols;
          // The run may have left — or been respawned under the same id — while
          // its screen was being read. Only the incarnation still in the fleet
          // gets an entry.
          if (!this.isLive(run)) return;
          // Scope changed while the screen was read: this run is no longer
          // shown, and its screen is read when it is again.
          if (this.scope !== null && run.workspaceId !== this.scope) return;
          const screen = prepareScreen(raw, cols);
          // Nothing drawn yet — a pane still starting, or cleared. A reader
          // given nothing invents something (an empty screen was once carded
          // as a terminal multiplexer error), so nothing is sent.
          if (screen.text.trim() === "") {
            this.clearedScreen(run, screen);
            return;
          }
          const existing = this.entries.get(run.runId);
          const entry =
            existing && existing.spawnedAt === run.spawnedAt ? existing : newEntry(run.spawnedAt);
          this.entries.set(run.runId, entry);
          if (entry.contentHash !== screen.hash) {
            entry.contentChangedAt = this.now();
            entry.glance = glanceScreen(screen.lines);
            // The screen's own words are current at once, ahead of the
            // classifier's turn. Its line pick stays while the screen still
            // shows that line — dropped on every change, the row swapped to
            // other words and back each poll — and goes with the line.
            if (entry.card !== null) {
              const pick = entry.card.statusLine;
              entry.card = {
                ...entry.card,
                glance: entry.glance,
                statusLine: pick !== null && screen.text.includes(pick) ? pick : null,
              };
            }
            this.scheduleBroadcast();
          }
          entry.contentHash = screen.hash;
          const disposition = entry.disposition;
          if (disposition && disposition.mark < readMark) {
            // Put aside before its screen was ever read: the first read is the
            // screen the user acted on, not a change since.
            if (disposition.contentHash === null) disposition.contentHash = screen.hash;
            // Output flowing since the user put the run aside: whatever it
            // stops on next is the agent saying something new.
            if (isBusy(run)) disposition.sawWork = true;
          }
          // The observed state and the terminal's incarnation are part of what
          // the card was built from, so either changing rebuilds it even when
          // the screen text did not move.
          const key = `${screen.hash}:${run.spawnedAt}:${run.agentState ?? ""}:${run.waitingReason ?? ""}`;
          if (entry.hash === key) {
            this.refreshActivity(entry, screen, run);
            // The same reading, but whether it may be told can change on its
            // own: a snooze running out, an unpark, work in between.
            if (!entry.pending) this.announce(run.runId, entry);
            // Unchanged, but time is part of a working agent's reading: one on
            // the same step for minutes may be stuck rather than busy, so its
            // screen is judged again, as the same prompt. A waiting or idle run
            // whose screen has not moved has nothing new to say.
            if (
              isBusy(run) &&
              !entry.pending &&
              entry.card !== null &&
              this.now() - entry.readAt >= CANOPY_REJUDGE_AFTER_MS
            ) {
              passes.push(this.pass(run, entry, epoch, screen, readMark, true));
            }
            return;
          }
          // A working agent's progress card is let finish: its screen moves on
          // every poll, and cancelling each card for the next would leave it
          // no words at all. The new screen is read once the card lands.
          if (entry.cardAbort !== null && entry.cardProgress && isBusy(run)) {
            this.refreshActivity(entry, screen, run);
            return;
          }
          // A busy run read lately, that Daintree still sees as it did then
          // and whose screen still shows it at work: its next screen waits for
          // the floor. An agent that stops — its working line gone, a dialog in
          // its place — is read at once, before Daintree's own state catches
          // up, as is an answer setting it working, and everything after
          // Refresh. A waiting run is read at once whenever its screen moves:
          // a dialog replaced by another must never wear the last one's command
          // and choices.
          if (
            !force &&
            isBusy(run) &&
            showsWork(screen) &&
            entry.card !== null &&
            entry.readState === observedKey(run) &&
            this.now() - entry.readAt < this.rereadMs
          ) {
            this.refreshActivity(entry, screen, run);
            return;
          }
          // Daintree only caught up with what the card already says — the
          // same screen, in a state that now matches a card read while it
          // still lagged — is the same prompt, not a new one.
          const content = `${screen.hash}:${run.spawnedAt}`;
          const caughtUp =
            entry.readKey !== null &&
            entry.readKey.startsWith(`${content}:`) &&
            entry.card !== null &&
            stateCaughtUp(entry.card, run);
          const moved = entry.readKey !== key && !caughtUp;
          entry.readKey = key;
          if (moved) entry.revision++;
          // Failing lately: wait out the backoff rather than ask again on every
          // poll. The card still says its screen has moved on.
          if (this.now() < entry.retryAt) {
            if (moved) this.markMoved(entry, true);
            this.refreshActivity(entry, screen, run);
            return;
          }
          entry.hash = key;
          entry.seq++;
          this.supersedeCard(entry);
          if (moved) this.markMoved(entry);
          passes.push(this.pass(run, entry, epoch, screen, readMark));
        })
      )
    );
    await Promise.all(passes);
    // Only a scan that read something new moves the list's ranking on, and
    // only once its cards are written too (see the card jobs); a quiet poll
    // leaves the snapshot as it was, and so sends nothing.
    if (epoch === this.epoch && passes.length > 0 && this.cardJobs.size === 0) {
      this.refreshedAt = this.now();
    }
  }

  private isLive(run: FleetRunRow): boolean {
    const runs = this.deps.getRuns();
    return (
      runs !== null &&
      runs.some((current) => current.runId === run.runId && current.spawnedAt === run.spawnedAt)
    );
  }

  /** Whether a pass started for `seq` in `epoch` may still act on `entry`. */
  private stillWanted(run: FleetRunRow, entry: RunEntry, seq: number, epoch: number): boolean {
    return (
      this.watching &&
      epoch === this.epoch &&
      entry.seq === seq &&
      this.entries.get(run.runId) === entry &&
      (this.scope === null || run.workspaceId === this.scope) &&
      this.isLive(run)
    );
  }

  /**
   * A pass whose result is no longer wanted: its screen is read afresh next
   * time rather than trusted as read, and the run is free for the next pass.
   */
  private abandon(entry: RunEntry, seq: number): void {
    if (entry.seq !== seq) return;
    entry.pending = false;
    entry.hash = null;
    if (entry.card?.describing) entry.card = { ...entry.card, describing: false };
  }

  /**
   * The screen moved on from the one the card read. Its question and choices
   * go at once: a dialog that changed must never offer the last one's answers.
   * Its words, facts and priority stay until the next reading replaces them —
   * cleared first, they blinked out and back a second later — unless that
   * reading is put off (`wordsOld`), when the words say they are from before.
   */
  private markMoved(entry: RunEntry, wordsOld = false): void {
    if (!entry.card) return;
    entry.card = {
      ...entry.card,
      question: null,
      options: [],
      ...(wordsOld
        ? {
            // Streamed words a card never finished are about the old screen too.
            wordsFromEarlierRead: entry.card.stage === "described" || entry.card.headline !== null,
          }
        : {}),
    };
  }

  private supersedeCard(entry: RunEntry): void {
    entry.cardAbort?.abort();
    entry.cardAbort = null;
  }

  /** What Daintree observed of the run, as of now. */
  private observed(run: FleetRunRow, entry: RunEntry): CanopyScreenInput["observed"] {
    return {
      agentState: run.agentState ?? null,
      waitingReason: run.waitingReason ?? null,
      secondsInState:
        run.since !== undefined ? Math.max(0, Math.round((this.now() - run.since) / 1000)) : null,
      // Only once it says something: a screen that moved within the last
      // poll or two is the ordinary case and not worth the reader's attention.
      ...(this.now() - entry.contentChangedAt >= SCREEN_STILL_REPORTED_MS &&
      entry.contentChangedAt > 0
        ? { screenUnchangedSeconds: Math.round((this.now() - entry.contentChangedAt) / 1000) }
        : {}),
    };
  }

  /**
   * One run's pass. Whatever goes wrong in it is that run's failure, never the
   * scan's: a pass that threw would otherwise leave the run pending for good.
   */
  private pass(
    run: FleetRunRow,
    entry: RunEntry,
    epoch: number,
    screen: PreparedScreen,
    screenReadAt: number,
    rejudge = false
  ): Promise<void> {
    const seq = entry.seq;
    return this.rebuild(run, entry, seq, epoch, screen, screenReadAt, rejudge).catch(
      (error: unknown) => this.recordFailure(run, entry, seq, epoch, error)
    );
  }

  private async rebuild(
    run: FleetRunRow,
    entry: RunEntry,
    seq: number,
    epoch: number,
    screen: PreparedScreen,
    /** The mark of the scan that read `screen`; a disposition marked later postdates it. */
    screenReadAt: number,
    rejudge = false
  ): Promise<void> {
    const input: CanopyScreenInput = {
      runId: run.runId,
      agent: run.agentId ?? run.launchAgentId ?? "terminal",
      // Titles are agent-set (OSC) text, so they leave the machine redacted too.
      title: redactSecrets(run.lastObservedTitle ?? run.title ?? ""),
      screen: screen.text,
      lines: screen.lines,
      observed: this.observed(run, entry),
      userAction: this.userAction(entry, screen),
      // The describer's private note, so the classifier reads the screen
      // knowing what the user asked for and what already happened.
      note: noteFor(entry, this.now()),
    };
    // Taken before this pass replaces the card, for a working run's next words.
    const earlier =
      entry.card?.spawnedAt === run.spawnedAt
        ? previousReading(entry.card, entry.describedAt, this.now())
        : null;
    // A re-judged screen is the one the user may already have opened; it keeps
    // the time it was first read, so it neither reads as new nor as unread.
    // A retry of a screen the card was already read from keeps that time too:
    // the same prompt read again is neither new nor unread.
    const sameScreen =
      entry.card?.spawnedAt === run.spawnedAt && entry.card.revision === entry.revision;
    const observedAt = (rejudge || sameScreen) && entry.card ? entry.card.observedAt : this.now();
    // What Daintree saw at that read goes with it.
    const observedWhenRead =
      (rejudge || sameScreen) && entry.card?.observedWhenRead
        ? entry.card.observedWhenRead
        : { agentState: run.agentState ?? null, waitingReason: run.waitingReason ?? null };
    const signal = this.abort.signal;

    entry.pending = true;
    this.inFlight++;
    let classified: ClassifierResult;
    try {
      classified = await this.classifierSlots.run(() => {
        // Checked again once a slot frees up: the queue can outlast the panel.
        if (!this.stillWanted(run, entry, seq, epoch)) throw new StaleCanopyPass();
        return this.deps.classify(input, signal);
      });
    } catch (error) {
      this.recordFailure(run, entry, seq, epoch, error);
      return;
    } finally {
      this.inFlight--;
    }
    if (!this.stillWanted(run, entry, seq, epoch)) {
      this.abandon(entry, seq);
      return;
    }
    entry.readAt = this.now();
    entry.readState = observedKey(run);
    if (entry.failure?.stage === "classifier") entry.failure = null;
    this.transientSince.delete(`${run.runId}:classifier`);

    // The classifier's probability is the gate: only a run likely to need the
    // user is worth a describer call — and only one in the inbox. A run the
    // user put aside is described again once it comes back.
    const needs = needsAttention(classified.attention);
    const disposition = entry.disposition;
    // Only a reading of a screen read after the user acted says anything about
    // what happened since.
    if (disposition && disposition.mark < screenReadAt) {
      if (!needs) disposition.sawWork = true;
      else if (returnsToInbox(disposition, screen.hash, classified.question)) {
        entry.disposition = null;
      }
    }
    const aside = entry.disposition !== null;
    const previous = entry.card;
    const sameRun = previous !== null && previous.spawnedAt === run.spawnedAt;
    // A busy agent is described too — the user checks on progress, not only
    // on prompts — but at most every CANOPY_PROGRESS_DESCRIBE_MS, since its screen moves on every
    // poll. Between writes it keeps the words it has, while they were written
    // about work: words about a prompt it has left are never fresh progress,
    // and the readers telling working from running apart is no new state.
    const progress = !needs && (busyCategory(classified.category) || isBusy(run));
    // Judged again on an unchanged screen, a run still busy has nothing new
    // for words to say: the describer would only reword it.
    const progressFresh =
      sameRun &&
      busyCategory(previous.wordsCategory) &&
      (this.now() - entry.describedAt < CANOPY_PROGRESS_DESCRIBE_MS ||
        (rejudge &&
          previous.category === classified.category &&
          entry.lastDescribed?.hash === screen.hash));
    // The words already describe this very screen and verdict: a re-read that
    // only caught Daintree's state up with what the screen showed, or judged an
    // unchanged one the same, gives the describer nothing to add but rewording.
    const wordsCurrent =
      sameRun &&
      previous.stage === "described" &&
      !previous.describing &&
      entry.lastDescribed?.hash === screen.hash &&
      entry.lastDescribed.verdict === verdictOf(classified, run);
    // A reply holds the run's priority down, not its words: the work the reply
    // set going is read like any other. The screen it answered is not read
    // again, and an archived run is read for nothing until it comes back.
    const wordsDue =
      !wordsCurrent &&
      (needs ? !aside : entry.disposition?.kind !== "archived" && progress && !progressFresh);
    // Words are written for an open panel only: the background watch is the
    // service's light classifier read, leaves the words due, and the open
    // reads the run again (`wordsDueOnOpen`).
    const describe = wordsDue && this.active;
    const handledAt = entry.disposition?.kind === "replied" ? entry.disposition.at : null;
    // A card whose screen moved keeps its old words until new ones land, so a
    // row never blanks between readings: they are replaced, not cleared. A run
    // put aside keeps the words it had, as archived mail does. A run the
    // describer is skipped for otherwise must not wear words written about an
    // earlier screen.
    const keepWords = (wordsDue || aside || wordsCurrent || (progress && progressFresh)) && sameRun;
    const sameState = keepWords && previous.category === classified.category;
    // The describer's score outlives a screen that moved without leaving its
    // state — a recap line drawn under a finished turn, a dialog redrawn —
    // until it reads the run again: the classifier's coarser anchor standing
    // in meanwhile moved a run in and out of "needs you" as the two readings
    // took turns. A busy run's re-read is the classifier's to judge (stuck or
    // not), so only a re-judge with the panel open keeps its score.
    // An ask keeps it only while its new card is on its way: a new approval or
    // question in the same state may be a different one, so the card replaces
    // the score once it lands, rather than the classifier's anchor and then the
    // card each moving it. With no card coming the anchor stands.
    const keepScore =
      sameState &&
      previous.attentionScore !== null &&
      (wordsCurrent ||
        (rejudge && this.active) ||
        (previous.stage === "described" &&
          !busyCategory(classified.category) &&
          (describe ||
            (classified.category !== "approval" && classified.category !== "question"))));
    entry.card = {
      runId: run.runId,
      spawnedAt: run.spawnedAt,
      revision: entry.revision,
      category: classified.category,
      confidence: classified.confidence,
      attentionProbability: classified.attention,
      // An old score stands in only while new words for the same state are
      // due (see `keepScore`); otherwise the priority is the classifier's alone.
      attentionScore: keepScore ? previous.attentionScore : null,
      // A re-judged screen is the one the words were kept for, so they are as
      // current — or as old — as they were before it. Re-judged in the
      // background, they are due again, and an open reads the run afresh.
      // Kept for the same state while new words are on their way, they stand
      // as they are until those replace them whole: flagged old meanwhile, the
      // row dropped its facts and choices for the second the describer took.
      wordsFromEarlierRead:
        keepWords &&
        !wordsCurrent &&
        !(sameState && describe) &&
        (rejudge && this.active
          ? previous.wordsFromEarlierRead
          : previous.stage === "described" || previous.headline !== null),
      priorityFromEarlierRead: false,
      priority:
        handledAt !== null
          ? 0
          : keepScore && previous.attentionScore !== null
            ? Math.max(readingFloor(classified, run), previous.attentionScore)
            : classifierPriority(classified, run),
      stage: keepWords ? previous.stage : "classified",
      // The overall task outlives a quiet phase: kept until a describe says otherwise.
      task: previous?.spawnedAt === run.spawnedAt ? previous.task : null,
      // So is how far along it is and what it last reported, until read again.
      progress: sameRun ? previous.progress : null,
      steps: sameRun ? previous.steps : null,
      tests: sameRun ? previous.tests : "unknown",
      changes: sameRun ? previous.changes : "unknown",
      risk: sameState ? previous.risk : "unknown",
      riskReason: sameState ? previous.riskReason : null,
      action: sameState ? previous.action : null,
      // A reply answers one screen, and stays answered until the agent has
      // something new to say (`returnsToInbox`).
      handledAt,
      describing: describe,
      headline: keepWords ? previous.headline : null,
      summary: keepWords ? previous.summary : null,
      wordsCategory: keepWords ? previous.wordsCategory : null,
      question: classified.question,
      // Only the old options this screen still draws: a menu that moved on
      // must not keep offering the last one's answers. A run read in the
      // background shows the options written the last time a panel was open.
      options: sameState
        ? optionsInScreenOrder(
            wordsCurrent ? entry.lastDescribed!.options : previous.options,
            screen.text
          )
        : [],
      secretPrompt: isSecretPrompt(classified.question),
      activity: screen.activity,
      glance: glanceScreen(screen.lines),
      statusLine: classified.status ?? null,
      contextLeft: screen.contextLeft,
      stalledSince: this.stalledSince(run, entry),
      observedAt,
      observedWhenRead,
    };
    const kind = blockedOn(classified, run);
    entry.ask = kind === null ? null : { kind, question: classified.question };
    this.announce(run.runId, entry);
    this.scheduleBroadcast();
    if (!describe || !this.isRunning) {
      entry.pending = false;
      entry.failures = 0;
      entry.retryAt = 0;
      // Words due with no panel open: the open writes them from this read
      // rather than asking the classifier about the same screen again.
      entry.wordsWaiting =
        wordsDue && !this.active
          ? { run, seq, screen, input, classified, progress, earlier }
          : null;
      if (describe) entry.card = { ...entry.card, describing: false };
      return;
    }

    entry.wordsWaiting = null;
    this.startCard(
      entry,
      { run, seq, screen, input, classified, progress, earlier },
      epoch,
      signal
    );
  }

  /**
   * Writes a run's card from the pass that read its screen. Written apart from
   * the scan: a slow card must not hold up the classifier's watch over every
   * other terminal. A newer screen of this run aborts it (`supersedeCard`).
   */
  private startCard(entry: RunEntry, read: CardRead, epoch: number, signal: AbortSignal): void {
    const { run, seq, screen, input, classified, progress, earlier } = read;
    const cardAbort = new AbortController();
    entry.cardAbort = cardAbort;
    entry.cardProgress = progress;
    entry.cardStreams = entry.card?.headline == null;
    const cardSignal = AbortSignal.any([signal, cardAbort.signal]);
    const job = (async (): Promise<void> => {
      this.inFlight++;
      let described: DescriberResult;
      // Set inside the slot below; typed by assertion so the closure write is seen.
      let digestRead = null as CanopyDigest | null;
      const last = entry.lastDescribed;
      try {
        described = await this.describerSlots.run(() => {
          if (!this.stillWanted(run, entry, seq, epoch) || !this.isRunning) {
            throw new StaleCanopyPass();
          }
          return this.readDigest(run.runId, input.agent, screen).then((read) => {
            if (!this.stillWanted(run, entry, seq, epoch)) throw new StaleCanopyPass();
            if (read === "moved") {
              // The terminal moved on while its history was read: what it shows
              // now is read afresh rather than described from mismatched parts.
              entry.hash = null;
              this.scheduleStateChangeScan();
              throw new StaleCanopyPass();
            }
            const digest = read?.digest ?? null;
            digestRead = digest;
            return this.deps.describe(
              {
                ...input,
                ...(progress ? { previousReading: earlier } : {}),
                digest,
                currentTask: this.lockedTask(entry, digest),
                note: noteFor(entry, this.now()),
                sinceLastReading:
                  last !== null && read !== null
                    ? scrolledSince(last.lines, read.history, screen.lines)
                    : null,
                failureRepeatsCap:
                  last !== null && last.hash === screen.hash ? last.failureRepeats : null,
              },
              classified.category,
              cardSignal,
              (partial) => this.applyPartial(run, entry, seq, epoch, partial)
            );
          });
        });
      } catch (error) {
        this.recordFailure(run, entry, seq, epoch, error, "describer");
        return;
      } finally {
        this.inFlight--;
      }
      if (!this.stillWanted(run, entry, seq, epoch)) {
        this.abandon(entry, seq);
        return;
      }
      this.transientSince.delete(`${run.runId}:describer`);
      entry.failure = null;
      entry.pending = false;
      entry.failures = 0;
      entry.retryAt = 0;
      entry.describedAt = this.now();
      entry.lastDescribed = {
        lines: screen.lines,
        hash: screen.hash,
        failureRepeats: described.failureRepeats ?? 0,
        verdict: verdictOf(classified, run),
        options:
          described.category === "approval"
            ? optionsInScreenOrder(described.options, screen.text)
            : [],
      };
      // A reading that wrote no note keeps the last one: losing the goal to one
      // terse reply is worse than a note a reading old.
      if (described.note) {
        entry.note = {
          text: redactSecrets(described.note),
          at: entry.describedAt,
        };
      }

      // The pass set this run's card before the describer ran; it is still
      // that card, since a pass that lost it would no longer be wanted.
      const card = entry.card;
      if (card === null) return;
      const question = onScreen(described.question, screen.text) ?? card.question;
      const asks = described.category === "approval" || described.category === "question";
      entry.card = {
        ...card,
        category: described.category,
        attentionScore: described.attentionScore,
        // The classifier reading an ask keeps the run at the top whatever the
        // describer scores: an agent asking is what Canopy pages the user for.
        priority:
          card.handledAt !== null
            ? 0
            : Math.max(
                readingFloor(classified, run),
                combinePriority(card.attentionProbability, described.attentionScore)
              ),
        task: this.settleTask(entry, digestRead, described.task),
        steps: digestRead?.todo ?? null,
        progress: progressOf(digestRead, described),
        tests: described.tests,
        changes: described.changes,
        risk: described.category === "approval" ? described.risk : "unknown",
        riskReason: described.category === "approval" ? described.riskReason : null,
        // Only words the screen really shows: an action the reader paraphrased
        // would invite approving something nobody asked for.
        action: described.category === "approval" ? onScreen(described.action, screen.text) : null,
        stage: "described",
        describing: false,
        wordsFromEarlierRead: false,
        headline: described.headline || null,
        summary: described.summary || null,
        wordsCategory: described.category,
        question: asks ? question : null,
        options:
          described.category === "approval"
            ? optionsInScreenOrder(described.options, screen.text)
            : [],
        secretPrompt: asks && isSecretPrompt(question),
      };
      this.scheduleBroadcast();
    })()
      .catch((error: unknown) => this.recordFailure(run, entry, seq, epoch, error, "describer"))
      .finally(() => {
        if (entry.cardAbort === cardAbort) entry.cardAbort = null;
        this.cardJobs.delete(job);
        // The last card of a batch landed: the list may re-rank on its scores,
        // as it did when the scan waited for them.
        if (this.cardJobs.size === 0 && !this.disposed) {
          this.refreshedAt = this.now();
          this.scheduleBroadcast();
        }
      });
    this.cardJobs.add(job);
  }

  /**
   * What a card still being written already says, shown as it lands for a row
   * with no words yet: its headline, then its summary. Its state and rank stay
   * as they were until the card is finished — a score taken early moves once the facts it is held to
   * arrive, and the row would jump. The card stays `describing` until then,
   * and nothing that acts on a prompt is taken from a partial.
   */
  private applyPartial(
    run: FleetRunRow,
    entry: RunEntry,
    seq: number,
    epoch: number,
    partial: CanopyPartialDescription
  ): void {
    const card = entry.card;
    if (card === null || !card.describing || !this.stillWanted(run, entry, seq, epoch)) return;
    // A row with words keeps them until the whole new card replaces them:
    // streamed in, they changed headline, then summary, then everything again.
    // Only a row with nothing to say yet shows words as they come.
    if (!entry.cardStreams) return;
    // Headline and summary land together, once the summary has begun: one
    // change to the row rather than one per field.
    if (partial.headline === undefined || partial.summary === undefined) return;
    if (card.headline === partial.headline && card.summary === partial.summary) return;
    entry.card = {
      ...card,
      headline: partial.headline,
      summary: partial.summary,
      wordsCategory: partial.category ?? card.wordsCategory,
      wordsFromEarlierRead: false,
    };
    this.scheduleBroadcast();
  }

  /**
   * Tells `onAsk` once per ask: the classifier read an urgent approval or
   * question on a run in the inbox — not archived, not answered, and, as the
   * fleet shows it now, not snoozed or parked. A suppressed ask is told once
   * the suppression lifts.
   */
  private announce(runId: string, entry: RunEntry): void {
    const run = this.deps
      .getRuns()
      ?.find((current) => current.runId === runId && current.spawnedAt === entry.spawnedAt);
    const ask = entry.ask;
    const eligible =
      ask !== null &&
      run !== undefined &&
      !run.snooze &&
      !run.park &&
      entry.disposition === null &&
      entry.card?.handledAt == null;
    if (!eligible) {
      entry.asking = false;
      return;
    }
    if (entry.asking) return;
    entry.asking = true;
    try {
      this.deps.onAsk?.(run, ask);
    } catch {
      // Telling the user is best effort; the reading stands either way.
    }
  }

  /**
   * The history above a run's screen, digested, with its cleaned rows; null
   * when it can't be read, and "moved" when its bottom no longer shows the
   * screen the pass is for.
   */
  private async readDigest(
    runId: string,
    agent: string,
    screen: PreparedScreen
  ): Promise<{ digest: CanopyDigest; history: string[] } | null | "moved"> {
    if (!this.deps.readHistory) return null;
    const raw = await this.deps.readHistory(runId, CANOPY_HISTORY_ROWS).catch(() => null);
    if (raw === null) return null;
    if (!sameScreenTail(screen, raw)) return "moved";
    return {
      digest: digestHistory(raw, agent),
      history: prepareScreen(raw, screen.cols).lines,
    };
  }

  /**
   * A run whose screen went blank: cleared, or redrawing. Nothing is sent, but
   * what its card offered to act on was on the screen that is gone.
   */
  private clearedScreen(run: FleetRunRow, screen: PreparedScreen): void {
    const entry = this.entries.get(run.runId);
    if (!entry || entry.spawnedAt !== run.spawnedAt || entry.contentHash === screen.hash) return;
    entry.contentHash = screen.hash;
    entry.contentChangedAt = this.now();
    entry.hash = null;
    entry.readKey = null;
    // A pass or card still under way was for the screen that is gone: none of
    // it may land, the agent's note included.
    entry.seq++;
    entry.pending = false;
    this.supersedeCard(entry);
    // The prompt is gone with the screen: whatever it asks next is a new ask.
    entry.ask = null;
    entry.asking = false;
    // What the screen said at a glance went with it.
    entry.glance = null;
    if (entry.card) {
      entry.card = {
        ...entry.card,
        question: null,
        options: [],
        glance: EMPTY_GLANCE,
        statusLine: null,
        wordsFromEarlierRead: entry.card.stage === "described",
        priorityFromEarlierRead: true,
      };
    }
    this.scheduleBroadcast();
  }

  /** The task title the describer must keep: the one written for the request still current. */
  private lockedTask(entry: RunEntry, digest: CanopyDigest | null): string | null {
    const task = entry.card?.task ?? null;
    if (task === null) return null;
    return keepsTask(entry.taskRequest ?? latestRequest(digest), latestRequest(digest))
      ? task
      : null;
  }

  /**
   * The row's name after a describe. Written once from the user's request and
   * kept — the describer is not allowed to reword it — until the user sends a
   * request for other work.
   */
  private settleTask(
    entry: RunEntry,
    digest: CanopyDigest | null,
    described: string | null
  ): string | null {
    const current = entry.card?.task ?? null;
    const request = latestRequest(digest);
    // A title written before any request was seen (the request had scrolled
    // away, or was never echoed) takes the first one seen as its own, so the
    // next request for other work can still replace it.
    if (current !== null && entry.taskRequest === null && request !== null) {
      entry.taskRequest = request;
    }
    if (current !== null && keepsTask(entry.taskRequest, request)) return current;
    if (described === null) return current;
    // A title is only ever made from a request Daintree saw the user send: with
    // the history read and no request in it, a title would be the reader's guess
    // (a folder name, a dialog), not the user's words.
    if (digest?.requests != null && digest.requests.length === 0) return current;
    if (request !== null) entry.taskRequest = request;
    return described;
  }

  private userAction(entry: RunEntry, screen: PreparedScreen): CanopyUserAction | null {
    const disposition = entry.disposition;
    if (!disposition) return null;
    return {
      kind: disposition.kind,
      secondsAgo: Math.max(0, Math.round((this.now() - disposition.at) / 1000)),
      screenChangedSince: disposition.contentHash !== screen.hash,
    };
  }

  private refreshActivity(entry: RunEntry, screen: PreparedScreen, run: FleetRunRow): void {
    const card = entry.card;
    if (!card) return;
    const stalledSince = this.stalledSince(run, entry);
    const glance = glanceScreen(screen.lines);
    if (
      !sameGlance(card.glance, glance) ||
      card.activity !== screen.activity ||
      card.contextLeft !== screen.contextLeft ||
      card.stalledSince !== stalledSince
    ) {
      entry.card = {
        ...card,
        activity: screen.activity,
        glance,
        contextLeft: screen.contextLeft,
        stalledSince,
      };
      this.scheduleBroadcast();
    }
  }

  /** When the run's screen last moved, if it is working and has been still past `CANOPY_STALL_MS`. */
  private stalledSince(run: FleetRunRow, entry: RunEntry): number | null {
    if (!isBusy(run) || entry.contentChangedAt === 0) return null;
    return this.now() - entry.contentChangedAt >= CANOPY_STALL_MS ? entry.contentChangedAt : null;
  }

  private recordFailure(
    run: FleetRunRow,
    entry: RunEntry,
    seq: number,
    epoch: number,
    error: unknown,
    /** Whose failure an error that names no provider is. */
    stage: "classifier" | "describer" = "classifier"
  ): void {
    if (this.disposed) return;
    // Abandoned on purpose (panel closed, Canopy turned off, run left): not a
    // provider failure, and `invalidateInFlight` already reset the entry.
    if (error instanceof StaleCanopyPass || !this.stillWanted(run, entry, seq, epoch)) {
      this.abandon(entry, seq);
      return;
    }
    // A read kept for the panel is older than this failure.
    entry.wordsWaiting = null;
    // The screen moved on from the card's and no reading of the new one is
    // coming soon: its words say they are from before. Its priority stands.
    const card = entry.card;
    if (
      card !== null &&
      (card.revision !== entry.revision ||
        (card.stage === "described" &&
          entry.lastDescribed !== null &&
          entry.lastDescribed.hash !== entry.contentHash))
    ) {
      this.markMoved(entry, true);
    }
    // Each failure in a row doubles the wait before this run is tried again.
    entry.failures++;
    entry.retryAt = this.now() + failureBackoffMs(entry.failures);
    if (error instanceof CanopyProviderError && error.transient) {
      const key = `${run.runId}:${error.provider}`;
      const now = this.now();
      const spell = this.transientSince.get(key) ?? { since: now, graceFrom: now };
      // A cold start runs about as long as the grace, so the grace begins once it ends.
      if (this.deps.serviceWaking?.()) spell.graceFrom = now;
      this.transientSince.set(key, spell);
      if (
        now - spell.graceFrom < CANOPY_TRANSIENT_GRACE_MS &&
        now - spell.since < CANOPY_COLD_START_GRACE_MS
      ) {
        // Not a failure yet: the run keeps what it said, and the next scan
        // tries this screen again.
        entry.pending = false;
        if (entry.seq === seq) {
          entry.hash = null;
          if (entry.card?.describing) entry.card = { ...entry.card, describing: false };
        }
        this.scheduleBroadcast();
        return;
      }
    }
    entry.pending = false;
    entry.failure =
      error instanceof CanopyProviderError
        ? {
            stage: error.provider,
            message: `${error.provider === "classifier" ? "Classifier" : "Describer"}: ${error.message}`,
          }
        : { stage, message: "Canopy request failed" };
    // Forget the hash so the next scan retries this screen instead of trusting
    // a card that was never finished.
    if (entry.seq === seq) {
      entry.hash = null;
      if (entry.card) entry.card = { ...entry.card, describing: false };
    }
    this.scheduleBroadcast();
  }

  private pruneDeparted(runs = this.deps.getRuns()): boolean {
    if (runs === null) return false;
    // By incarnation, not id: a terminal respawned under the same id must not
    // inherit the old one's card, even for the moment before it is re-read.
    const live = new Map(runs.map((run) => [run.runId, run.spawnedAt]));
    let changed = false;
    for (const [runId, entry] of this.entries) {
      const spawnedAt = live.get(runId);
      if (spawnedAt === undefined || entry.spawnedAt !== spawnedAt) {
        this.supersedeCard(entry);
        this.entries.delete(runId);
        this.transientSince.delete(`${runId}:classifier`);
        this.transientSince.delete(`${runId}:describer`);
        changed = true;
      }
    }
    return changed;
  }

  private scheduleBroadcast(): void {
    if (this.disposed || this.broadcastTimer !== null) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      if (this.disposed) return;
      const snapshot = this.getSnapshot();
      // `busy` alone flips on every poll and nothing shows it: a scan that
      // changed nothing else is not news to any view.
      const sent = JSON.stringify({ ...snapshot, busy: false, sequence: 0 });
      if (sent === this.lastBroadcast) return;
      this.lastBroadcast = sent;
      this.deps.broadcast(snapshot);
    }, BROADCAST_DEBOUNCE_MS);
  }
}

function sameGlance(a: CanopyGlance | undefined, b: CanopyGlance): boolean {
  return (
    a !== undefined &&
    a.recap === b.recap &&
    a.said === b.said &&
    a.doing === b.doing &&
    a.action === b.action
  );
}

function newEntry(spawnedAt: number): RunEntry {
  return {
    spawnedAt,
    hash: null,
    readKey: null,
    contentHash: null,
    contentChangedAt: 0,
    disposition: null,
    seq: 0,
    revision: 0,
    card: null,
    pending: false,
    wordsWaiting: null,
    cardAbort: null,
    cardProgress: false,
    cardStreams: false,
    failures: 0,
    retryAt: 0,
    readAt: 0,
    readState: "",
    failure: null,
    describedAt: 0,
    seenAt: null,
    taskRequest: null,
    note: null,
    lastDescribed: null,
    ask: null,
    asking: false,
    glance: null,
  };
}

function noteFor(entry: RunEntry, now: number): CanopyNote | null {
  if (entry.note === null) return null;
  return {
    text: entry.note.text,
    secondsAgo: Math.max(0, Math.round((now - entry.note.at) / 1000)),
  };
}

/** The newest request in the history that sets work, normalised; null when none shows. */
function latestRequest(digest: CanopyDigest | null): string | null {
  if (digest?.requests == null) return null;
  for (let i = digest.requests.length - 1; i >= 0; i--) {
    const request = normalize(digest.requests[i]!);
    if (!isFollowUp(request)) return request;
  }
  return null;
}

/**
 * A reply that carries on the work rather than setting new work: "continue
 * where you left off", "yes", "2", "go ahead and commit", "go with option 2".
 * Recognised by how it opens, since "add dark mode" is just as short and is
 * new work.
 */
const FOLLOW_UP =
  /^(?:please |ok(?:ay)?,? |yes,? |yeah,? |great,? |thanks,? |perfect,? )*(?:y|yes|yep|yeah|no|nope|ok|okay|sure|lgtm|thanks|thank you|\d+|[a-d]|continue|carry on|keep going|proceed|go ahead|go on|do it|do that|retry|try again|again|resume|commit(?: it| that| this| the changes| them)?|push(?: it)?|sounds good|looks good|go with|use option|option \d+|the (?:first|second|third) one|either)\b/;

function isFollowUp(request: string): boolean {
  return FOLLOW_UP.test(
    request
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Whether a title written for `titled` still names the work: nothing newer has
 * scrolled into view, or the newest request is the one it was written for.
 */
function keepsTask(titled: string | null, latest: string | null): boolean {
  return latest === null || latest === titled;
}

/**
 * How much of the task is done: the agent's own checklist when it draws one,
 * counted exactly with half credit for the item in progress, else the
 * describer's estimate.
 */
function progressOf(digest: CanopyDigest | null, described: DescriberResult): number | null {
  const todo = digest?.todo ?? null;
  if (todo === null || todo.total === 0) return described.progress;
  const done = todo.done + (todo.current !== null ? 0.5 : 0);
  return Math.round(Math.min(100, (100 * done) / todo.total));
}

/**
 * What the describer last wrote about a working run, so its next words can say
 * what moved since rather than restate the task.
 */
function previousReading(
  card: CanopyCard | null,
  describedAt: number,
  now: number
): CanopyPreviousReading | null {
  if (card === null || card.wordsCategory === null || describedAt === 0) return null;
  if (card.headline === null && card.summary === null) return null;
  return {
    // What the words were written about, which may be a state the run has left.
    category: card.wordsCategory,
    task: card.task,
    headline: card.headline,
    summary: card.summary,
    secondsAgo: Math.max(0, Math.round((now - describedAt) / 1000)),
  };
}

/**
 * Whether a run the user put aside has something new to say, the way a new
 * reply brings a thread back into a mail inbox. Its screen must have changed
 * and now need the user — and either the agent worked in between (so this is
 * a new stop, not the one the user saw), or it is asking a different question.
 * A screen that only scrolled, an echoed reply, or the same prompt still
 * drawn never brings it back.
 */
function returnsToInbox(
  disposition: Disposition,
  contentHash: string,
  question: string | null
): boolean {
  if (contentHash === disposition.contentHash) return false;
  if (disposition.sawWork) return true;
  return question !== null && normalize(question) !== disposition.question;
}

function busyCategory(category: CanopyCategory | null): boolean {
  return category === "working" || category === "running";
}

/**
 * What a reading made of a screen, as far as its words go: its state, whether
 * it needs the user, and whether a busy run looks stuck. Not the finer score:
 * on a screen that has not moved, how notable it reads drifts as it ages, and
 * that is no reason to write its words again.
 */
function verdictOf(classified: ClassifierResult, run: FleetRunRow): string {
  const stuck = busyCategory(classified.category) && classified.attention >= STUCK_ATTENTION;
  return `${classified.category}:${needsAttention(classified.attention)}:${stuck}:${blockedOn(classified, run) !== null}`;
}

/** Daintree now sees the run as the card read it, where at the read it still saw otherwise. */
function stateCaughtUp(card: CanopyCard, run: FleetRunRow): boolean {
  const then = card.observedWhenRead;
  return then !== undefined && observedCaughtUp(card.category, then, run, card.observedAt);
}

/** A busy agent's working line, as Claude Code, Codex and Gemini draw it under their output. */
const WORKING_LINE = /esc to interrupt|\(esc to cancel, \d/i;

/** The bottom of the screen still shows the agent at work. */
function showsWork(screen: PreparedScreen): boolean {
  return screen.lines.slice(-6).some((line) => WORKING_LINE.test(line));
}

/** What Daintree observes of a run, as far as reading it goes: its state and why it waits. */
function observedKey(run: FleetRunRow): string {
  return `${run.agentState ?? ""}:${run.waitingReason ?? ""}`;
}

function isBusy(run: FleetRunRow): boolean {
  return run.agentState === "working" || run.agentState === "directing";
}

/**
 * The priority of an approval or a question the classifier read, scaled by
 * how sure it is the agent is blocked on a person; null for any other
 * reading. Daintree's own state seeing the same approval counts as sure.
 */
function askScore(classified: ClassifierResult, run: FleetRunRow): number | null {
  const category = classified.category;
  if (category !== "approval" && category !== "question") return null;
  if (!needsAttention(classified.attention) || classified.confidence < ASK_CONFIDENCE) return null;
  const blocked =
    category === "approval" && run.waitingReason === "approval"
      ? Math.max(classified.blocked, CANOPY_BLOCKED_SCALE.to)
      : classified.blocked;
  const { from, to } = CANOPY_BLOCKED_SCALE;
  const scale = Math.min(1, Math.max(0, (blocked - from) / (to - from)));
  const low = CANOPY_CLASSIFIER_ANCHORS.finished;
  return Math.round(low + (CANOPY_CLASSIFIER_ANCHORS[category] - low) * scale);
}

/** What the agent is blocked on, when the classifier's reading of it is urgent; null otherwise. */
function blockedOn(classified: ClassifierResult, run: FleetRunRow): "approval" | "question" | null {
  const score = askScore(classified, run);
  if (score === null || score < CANOPY_URGENT_PRIORITY) return null;
  return classified.category as "approval" | "question";
}

/**
 * A run's priority from the classifier alone: fixed by what it read and how
 * sure it is, so the same reading always ranks the same.
 */
function classifierPriority(classified: ClassifierResult, run: FleetRunRow): number {
  const anchors = CANOPY_CLASSIFIER_ANCHORS;
  const ask = askScore(classified, run);
  if (ask !== null) return ask;
  const needs = needsAttention(classified.attention);
  switch (classified.category) {
    case "approval":
    case "question":
    case "finished":
      return needs ? anchors.finished : anchors.idle;
    case "error":
      return needs ? anchors.error : anchors.finished;
    case "idle":
      return anchors.idle;
    case "working":
    case "running":
      if (classified.attention >= STUCK_ATTENTION) return anchors.stuck;
      return (classified.notable ?? 0) >= NOTABLE_PROBABILITY ? anchors.notable : anchors.busy;
  }
}

/**
 * The lowest priority a described run can have: an urgent ask the classifier
 * read keeps its place whatever the describer scores, and the describer's
 * score stands above it.
 */
function askFloor(classified: ClassifierResult, run: FleetRunRow): number {
  return blockedOn(classified, run) === null ? 0 : (askScore(classified, run) ?? 0);
}

/**
 * The lowest a described run ranks, by what the classifier read: an ask keeps
 * its place, and a busy agent showing something notable keeps the notable
 * band, whatever lower score the describer gives it.
 */
function readingFloor(classified: ClassifierResult, run: FleetRunRow): number {
  const busy = classified.category === "working" || classified.category === "running";
  const notable =
    busy && (classified.notable ?? 0) >= NOTABLE_PROBABILITY
      ? CANOPY_CLASSIFIER_ANCHORS.notable
      : 0;
  return Math.max(askFloor(classified, run), notable);
}

function needsAttention(probability: number): boolean {
  return probability >= CANOPY_ATTENTION_THRESHOLD;
}

function normalize(text: string): string {
  return text
    .replace(/[❯›>▶●⏺•✦]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * `text` when it is on the screen, else null — the describer may only quote.
 * A trailing key hint like "(esc)" or "(y)" is allowed to differ.
 */
function onScreen(text: string | null | undefined, screen: string): string | null {
  if (text == null) return null;
  const wanted = normalize(text.replace(/\s*\((?:esc|[a-z])\)\s*$/i, ""));
  if (wanted.length === 0) return null;
  return normalize(screen).includes(wanted) ? text : null;
}

/**
 * The options that are really on screen, in the order the CLI draws them — the
 * panel numbers its buttons, and a "1" that isn't the CLI's own 1 misleads.
 */
function optionsInScreenOrder(options: readonly string[], screen: string): string[] {
  // Each option is placed by the row that draws it, found from the bottom —
  // where a dialog's choices are — so "No" is placed by its own row, not by
  // "No files changed" in the output above it. A row that is the option itself
  // wins over one that only starts with it ("Yes" over "Yes, and don't ask
  // again"), an option wrapped over rows is placed by the row it starts on,
  // and choices drawn inline on one row keep their order within it.
  const rows = screen.split("\n").map((row) =>
    normalize(row)
      .replace(/^\d+[.)]\s*/, "")
      .replace(/\s*\((?:esc|[a-z])\)$/, "")
  );
  const lastRow = (test: (row: string) => boolean) => {
    for (let i = rows.length - 1; i >= 0; i--) if (test(rows[i]!)) return i;
    return -1;
  };
  return options
    .map((option) => {
      if (onScreen(option, screen) === null) return { option, row: -1, at: -1 };
      const wanted = normalize(option.replace(/\s*\((?:esc|[a-z])\)\s*$/i, ""));
      let row = lastRow((candidate) => candidate === wanted);
      if (row < 0) row = lastRow((candidate) => candidate.startsWith(wanted));
      if (row < 0) row = lastRow((candidate) => candidate.includes(wanted));
      if (row < 0) {
        row = lastRow((candidate) => candidate.length >= 3 && wanted.startsWith(candidate));
      }
      const at = row < 0 ? -1 : Math.max(0, rows[row]!.indexOf(wanted));
      return { option, row, at };
    })
    .filter((entry) => entry.row >= 0)
    .sort((a, b) => a.row - b.row || a.at - b.at)
    .map((entry) => entry.option);
}

/** The longest a failing run waits before it is tried again. */
export const CANOPY_FAILURE_BACKOFF_MAX_MS = 30_000;

/**
 * The wait after the nth failure in a row: a poll's length, doubling, capped,
 * with jitter so a fleet that failed together does not retry together.
 */
function failureBackoffMs(failures: number): number {
  const base = Math.min(
    CANOPY_FAILURE_BACKOFF_MAX_MS,
    CANOPY_POLL_MS * 2 ** Math.max(0, failures - 1)
  );
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** Thrown inside a slot when the pass that queued it is no longer wanted. */
class StaleCanopyPass extends Error {}

class Semaphore {
  private available: number;
  private readonly waiting: Array<() => void> = [];

  constructor(size: number) {
    this.available = size;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.available === 0) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.available--;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.available++;
    }
  }
}

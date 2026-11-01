import type { FleetRunRow, RunCanopyRefinement } from "../../../shared/types/ipc/fleet.js";
import {
  type CanopyCard,
  type CanopyDisposition,
  type CanopyGlance,
  type CanopyModelState,
  type CanopyLookPlace,
  type CanopyPlan,
  type CanopyReadMark,
  type CanopyReaderLink,
  type CanopyReadRestore,
  type CanopyReadTarget,
  type CanopyRunGlance,
  type CanopySeen,
  type CanopySnapshot,
  type CanopyTrashEntry,
} from "../../../shared/types/ipc/canopy.js";
import {
  isSecretPrompt,
  normalizeScreenText,
  onScreen,
  optionsInScreenOrder,
  prepareScreen,
  promptKey,
  sameScreenTail,
  type PreparedScreen,
} from "./canopyScreen.js";
import { redactSecrets } from "../redactSecrets.js";
import {
  CanopyProviderError,
  combinePriority,
  type ClassifierResult,
  type DescriberResult,
  type CanopyScreenInput,
  type CanopyUserAction,
} from "./canopyProviders.js";
import { digestHistory, type CanopyDigest } from "./canopyDigest.js";
import type { CanopyReading } from "./canopyLocalReader.js";
import type { TerminalAnswer } from "../../../shared/utils/terminalSubmission.js";
import { EMPTY_GLANCE, glanceScreen } from "./canopyGlance.js";
import { CANOPY_REFLOW_MS, reflowPrint, sameAfterReflow } from "./canopyReflow.js";
import { observedCaughtUp } from "../../../shared/utils/canopyObservedKind.js";
import { heldCanopyPriority } from "../../../shared/utils/canopyPriorityTier.js";
import {
  CANOPY_READ_DWELL_MS,
  CANOPY_TURN_HOLD_MS,
  adoptAsk,
  advanceTurn,
  isUnread,
  look,
  lookingSince,
  markRead,
  markUnread,
  newReadTrack,
  observeAsk,
  observeFleet,
  observeTurn,
  readMarkOf,
  restoreRead,
  type ReadTrack,
} from "./canopyReads.js";
import {
  blockedOn,
  busyCategory,
  classifierPriority,
  isBusy,
  needsAttention,
  observedKey,
  readingFloor,
  readingIgnoresState,
  refinementOf,
  returnsToInbox,
  verdictOf,
  type CanopyEvidence,
} from "./canopyVerdict.js";

export { CANOPY_BLOCKED_SCALE, CANOPY_CLASSIFIER_ANCHORS } from "./canopyVerdict.js";

/** Screen rows read per run — the tail the cards are written from. */
export const CANOPY_SCREEN_LINES = 50;
/**
 * Rows of history read above the screen when a card is written, for the
 * user's requests and the agent's plan — both scroll off the screen within a
 * minute of work. Read only when a run's words are set, never on a poll.
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
 * The least time between two reads, with a panel showing it, of a run at work
 * whose screen keeps changing while Daintree sees it in the same state: what
 * the user sees holds still between reads, and a busy agent's output is not
 * sent on every poll. With no panel showing it, such a run is not read at all
 * while its working line shows (see `heldRead`).
 */
export const CANOPY_REREAD_MS = 10_000;
/**
 * How often an open panel re-reads every screen. Reading a screen is local and
 * cheap; only the ones whose tail changed since their card was written go on to
 * the model, so a quiet or waiting fleet costs nothing between polls.
 */
export const CANOPY_POLL_MS = 3_000;
/**
 * How long after an agent's observed state changes an open panel looks at the
 * screens again — long enough for the screen to finish drawing what made the
 * state change, short enough that a new prompt is in the panel within a second.
 */
export const CANOPY_STATE_CHANGE_SCAN_MS = 400;
/**
 * How often screens are read with no panel open, and only the ones that
 * changed. Each reading carries the row whole — its place, its ask, its words —
 * so the panel opens on every run already where it belongs; it is also what
 * tells the user an agent is asking something and lights the toolbar. A
 * reading is ~10 ms of one CPU core, and an unchanged screen costs none.
 * An observed state change still scans within a second, so this is the net
 * for the waits Daintree's own state misses. It is also each run's own pace:
 * a scan another run's state change set going sends a run no sooner than this
 * after its last read, unless Daintree saw that run change state too.
 */
export const CANOPY_BACKGROUND_POLL_MS = 5_000;
/**
 * How long after an agent stops every move of its screen is read: the stop
 * itself, the recap Claude Code draws a minute later, one dialog answered and
 * the next drawn. Past it, a stopped agent's redraws — one row changed in
 * place, a status line's clock or a footer, each flipping Daintree's state for
 * a moment without the agent saying anything — are not read until it works,
 * changes state or is answered. Anything more drawn is read as ever.
 */
export const CANOPY_SETTLE_MS = 120_000;

/** How much sooner than a whole pace a regular poll may come round to a run, its screens read faster. */
const BACKGROUND_PACE_SLACK_MS = 1_000;
/** How many of the latest reads of each kind the status bar's mean time is taken over. */
const LINK_TIMES_KEPT = 10;
/** How long a resize of a run not read yet is kept: past its redraw and the blank after it. */
const EARLY_RESIZE_KEPT_MS = 2 * CANOPY_REFLOW_MS;

/** A close this soon after an open is a bounce, not the panel going away. */
export const CANOPY_CLOSE_GRACE_MS = 300;
/** A working run's screen still this long is shown as stalled. */
export const CANOPY_STALL_MS = 10 * 60_000;
/** A screen still for less than this is not reported to the readers as still. */
const SCREEN_STILL_REPORTED_MS = 60_000;
/**
 * Readings in flight at once. The local model reads one screen at a time, so
 * more only queue in its process; two keeps it busy without a backlog there
 * that a closed panel or a moved screen could not take back.
 */
const READ_CONCURRENCY = 2;
/** Card jobs at once: each only reads the run's history, then sets its words. */
const WORDS_CONCURRENCY = 6;
const SCREEN_READ_CONCURRENCY = 8;
/**
 * How long reads may keep failing for reasons that pass — the model loading,
 * a reader process restarting — before it is reported. Until then a run keeps
 * what it last said and is tried again on the next scan.
 */
export const CANOPY_TRANSIENT_GRACE_MS = 60_000;
/**
 * The most a spell of passing failures is kept quiet in all: a model that
 * keeps failing to load or read is reported, however often it is restarted.
 */
export const CANOPY_COLD_START_GRACE_MS = 180_000;
const BROADCAST_DEBOUNCE_MS = 40;

export interface CanopyServiceDeps {
  /** Whether the user turned Canopy on; absent, on. */
  plan?: CanopyPlan;
  /** The fleet's current runs, or null while the fleet is unknown. */
  getRuns: () => readonly FleetRunRow[] | null;
  /** Agent runs in the host's trash, newest first: Canopy's Trash rides its snapshot. */
  getTrash?: () => CanopyTrashEntry[];
  /**
   * The run's current screen as plain text, with the pane's width when known
   * (to put rows the agent wrapped back together), or null when it can't be read.
   */
  readScreen: (runId: string, lines: number) => Promise<ScreenRead | string | null>;
  /** The screen and `rows` of scrollback above it, or null; absent, no history is read. */
  readHistory?: (runId: string, rows: number) => Promise<string | null>;
  /** One reading of a screen by the local model: its verdict and its words together. */
  read: (input: CanopyScreenInput, signal: AbortSignal) => Promise<CanopyReading>;
  /**
   * The model is on this machine and screens can be read. While it isn't —
   * downloading, or not chosen yet — rows show the screen's own words and
   * nothing is read. Absent, always.
   */
  readerReady?: () => boolean;
  /** The model's name, for the status bar. */
  readerName?: () => string;
  /** Where the chosen model stands, for Settings and the panel. */
  modelState?: () => CanopyModelState | undefined;
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
  /** What `getRefinement` answers changed for at least one run, removals included. */
  onRefinementsChanged?: () => void;
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
  /** A fingerprint of the prompt on screen when the user acted (`promptKey`); null when none. */
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
  /** The words the same reading gives. */
  words: CanopyReading["words"];
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
  /** `contentHash`'s screen as `reflowPrint` reads it: what a redraw at another size is matched against. */
  print: string | null;
  /** When the terminal was last resized (epoch ms), until its redraw has been told from a change; null when not. */
  resizedAt: number | null;
  /**
   * The screen is one redrawn at another size since it last changed: what the
   * row shows of it at a glance stays as first read, rather than as cut short
   * or spread out by the new width.
   */
  redrawn: boolean;
  /** The hash of the screen last adopted as redrawn: words in flight for it are for the screen now shown. */
  redrawnFrom: string | null;
  disposition: Disposition | null;
  /** Bumped per new screen, so a pass for an older screen can't land. */
  seq: number;
  /**
   * Bumped when the screen moved, or what Daintree observed of the run did
   * (unless it only caught up with the reading): the card's `revision`, which
   * tells a new prompt from the same one. A retry of an unchanged screen bumps
   * `seq` but not this, so an acknowledged prompt stays acknowledged.
   */
  revision: number;
  card: CanopyCard | null;
  /** A pass for this run is in flight. */
  pending: boolean;
  /** Aborts the card being written for this run, once a newer screen supersedes it. */
  cardAbort: AbortController | null;
  /** The card being written is about a busy run's progress, not a prompt. */
  cardProgress: boolean;
  /** Failed passes in a row, for the backoff before the next try. */
  failures: number;
  /** No pass for this run starts before this (epoch ms): a failing reader is not hammered. */
  retryAt: number;
  /** When the classifier last read this screen (epoch ms), 0 before it has. */
  readAt: number;
  /** When the last read was sent (epoch ms), 0 before one was: what the watch's pace counts from. */
  sentAt: number;
  /** The rows of the screen last sent to be read, for telling a redraw from anything drawn since. */
  readLines: string[] | null;
  /**
   * When Daintree last saw the run's work end — work that held past a flicker
   * — or, before that, when Canopy first saw the run or began reading again
   * (epoch ms): what `CANOPY_SETTLE_MS` counts from.
   */
  stoppedAt: number;
  /** The last scan found the run at work, past a flicker: a scan finding it otherwise saw its work end. */
  seenAtWork: boolean;
  /** What Daintree observed of the run at that read (`observedKey`). */
  readState: string;
  /**
   * The last read of this run failed, and where; its card, if any, is from
   * before. Each stage's success clears only its own failure.
   */
  failure: { stage: "classifier" | "describer"; message: string } | null;
  /** When this run's words were last set (epoch ms), 0 before they have been. */
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
  /** What the classifier made of the screen the card was last read from; null before a read. */
  classified: ClassifierResult | null;
  /** What the newest screen read says at a glance; null before one was read. */
  glance: CanopyGlance | null;
  /** `onAsk` was told about the ask on screen; cleared once it stops asking, goes back to work, or is suppressed. */
  asking: boolean;
  /**
   * The ask `onAsk` was last told of — its kind and prompt, and the screen it
   * was on — so the same ask is not told twice: not while its screen moves on
   * around it, nor after a flicker of work cleared `asking` on the very screen.
   */
  announced: { prompt: string; hash: string | null } | null;
  /** What the user has seen of what the run did; see `ReadTrack`. */
  reads: ReadTrack;
  /**
   * The screen (`contentHash`) the user asked to have read again, words
   * included; null when not asked. A rebuild of that same screen describes it
   * whatever the usual gates say, as a correction rather than news; a screen
   * that moved since is read as any other.
   */
  rereadOf: string | null;
  /**
   * What the reading refines of where the run lands, held for the turn it was
   * read in (`reads.turn`) so a re-read can't flip it back and forth; null
   * while nothing has qualified this turn.
   */
  refinement: { turn: number; value: RunCanopyRefinement } | null;
  /**
   * What the classifier's newest reading quoted that is really on the screen
   * it read, and the turn that reading speaks for; null before a reading, or
   * once the screen it was of has gone. A failed read leaves it as it was, so
   * the turn tells a reading of this stop from one of the stop before.
   */
  evidence: CanopyEvidence | null;
  /** The screen now showing is blank: nothing on it to quote, whatever the card last said. */
  cleared: boolean;
}

/**
 * Keeps one card per agent run, rebuilt only when that run's screen changes.
 *
 * A changed screen goes to the local reader unless nothing on it can be new —
 * an agent visibly at work, or one long stopped whose screen only redrew (see
 * `heldRead`). Each reading gives the verdict and the row's words together;
 * the words are set for runs that need the user, and for busy ones at most
 * every `CANOPY_PROGRESS_DESCRIBE_MS`. With a panel open every screen is
 * watched closely; with none open, changed screens are read every
 * `backgroundPollMs` and on observed state changes, so the panel opens on every
 * row already in place and an agent asking something is still noticed.
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
  /** Readings under way, and the times of the latest that came back. */
  private readonly link = {
    inFlight: 0,
    times: [] as number[],
  };
  private refreshedAt: number | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  /** A scan due once the redraws after a resize have settled, and when. */
  private reflowTimer: { at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Resizes of runs whose screens were not read yet, so a first read still waits out the redraw. */
  private readonly earlyResizes = new Map<string, number>();
  /** The last snapshot sent, as sent, so a quiet poll sends nothing. */
  private lastBroadcast: string | null = null;
  /** Whether the last snapshot sent said a scan was under way. */
  private lastBroadcastBusy = false;
  /** Every run's refinement as last told to `onRefinementsChanged`, so an unchanged settle tells nothing. */
  private refinementKey = "";
  private sequence = 0;
  /** Cards being written, apart from the scan that read their screens. */
  private readonly cardJobs = new Set<Promise<void>>();
  private abort = new AbortController();
  /**
   * Bumped whenever in-flight work stops being wanted — the last panel closed,
   * or Canopy was turned off, or its model changed — so a pass started before
   * it can't land.
   */
  private epoch = 0;
  private readSlots: Semaphore;
  private wordsSlots: Semaphore;
  /**
   * When each run's readings, or the setting of its words, began failing for
   * reasons that pass, by `runId:stage`; cleared when that same stage next
   * succeeds, so one stage's successes never hide the other's failures.
   */
  private readonly transientSince = new Map<
    string,
    { since: number; graceFrom: number; lastAt: number }
  >();
  private disposed = false;
  /**
   * The workspace an open panel shows, whose runs are read at its pace and
   * given words; null, every workspace. Runs outside it stay under the
   * background watch's terms while the panel is open.
   */
  private scope: string | null = null;
  /** When runs outside the panel's scope were last read: they go at the background watch's pace. */
  private backgroundReadAt = 0;
  /** The next scan reads every workspace's runs: an observed state change is the watch's cue too. */
  private wideNextScan = false;
  /** Bumped by every scan start and every disposition, to order the two. */
  private marks = 0;
  /** For each run someone just started looking at, the moment the look will have read it. */
  private readonly dwellTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: CanopyServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.closeGraceMs = deps.closeGraceMs ?? CANOPY_CLOSE_GRACE_MS;
    this.plan = deps.plan ?? { mode: "on", activated: true };
    this.stateChangeScanMs = deps.stateChangeScanMs ?? CANOPY_STATE_CHANGE_SCAN_MS;
    this.readSlots = new Semaphore(READ_CONCURRENCY);
    this.wordsSlots = new Semaphore(WORDS_CONCURRENCY);
    this.startPolling();
    if (this.watching) void this.scan();
  }

  /** Abandon every pass in flight: abort its requests and let none of it land. */
  private invalidateInFlight(): void {
    this.epoch++;
    this.abort.abort();
    this.abort = new AbortController();
    for (const entry of this.entries.values()) {
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

  /**
   * Longer than a run that keeps failing ever waits between two tries — its
   * backoff with jitter, the poll that next reads it, a queue at the reader —
   * so a run's passing failures further apart than this are two spells.
   */
  private get spellGapMs(): number {
    return (
      2 * Math.max(CANOPY_FAILURE_BACKOFF_MAX_MS * 1.25, this.pollMs, this.backgroundPollMs) +
      60_000
    );
  }

  /** Screens are being read: a panel is open, or the background watch is on. */
  private get watching(): boolean {
    return !this.disposed && this.isRunning && (this.active || this.backgroundPollMs > 0);
  }

  /** The model can read: it is here. Until then rows show the screen's own words. */
  private get readerReady(): boolean {
    return this.deps.readerReady?.() ?? true;
  }

  /**
   * The model came, went or changed: every reading made with the last one is
   * let go, and once one is here every screen is read at once.
   */
  readerChanged(): void {
    if (this.disposed) return;
    this.invalidateInFlight();
    for (const entry of this.entries.values()) {
      // What one model read is never passed off as another's, nor kept once
      // its model is gone: the verdict, its words and what was held from it
      // all go. The screen's own words stay, as do what the user did to the
      // run (archive, read marks).
      entry.card = null;
      entry.hash = null;
      entry.readKey = null;
      entry.taskRequest = null;
      entry.lastDescribed = null;
      entry.ask = null;
      entry.asking = false;
      entry.announced = null;
      entry.classified = null;
      entry.failure = null;
      entry.failures = 0;
      entry.retryAt = 0;
      this.supersedeCard(entry);
      entry.cardProgress = false;
      entry.rereadOf = null;
      entry.refinement = null;
      entry.evidence = null;
    }
    this.transientSince.clear();
    this.scheduleBroadcast();
    if (this.watching && this.readerReady) void this.scan();
  }

  /** Where the model stands changed — a download moving on — with nothing read differently. */
  modelChanged(): void {
    if (!this.disposed) this.scheduleBroadcast();
  }

  /** The host's trash changed: every view's Trash is told, whether or not Canopy reads. */
  trashChanged(): void {
    if (!this.disposed) this.scheduleBroadcast();
  }

  /**
   * The user turned Canopy on or off. Turned off, nothing in
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
        // Everything read off the screen goes, not just the card: the user was
        // told turning reading off deletes every reading. What they did to the
        // run (archive, read marks) is theirs, not the screen's, and stays.
        entry.card = null;
        entry.hash = null;
        entry.readKey = null;
        entry.contentHash = null;
        entry.print = null;
        entry.readLines = null;
        entry.glance = null;
        entry.taskRequest = null;
        entry.lastDescribed = null;
        entry.ask = null;
        entry.asking = false;
        entry.announced = null;
        entry.classified = null;
        entry.failure = null;
        entry.failures = 0;
        entry.retryAt = 0;
        // A card job still awaiting history must not hold the run's next read
        // once reading comes back on.
        this.supersedeCard(entry);
        entry.cardProgress = false;
        entry.rereadOf = null;
        entry.refinement = null;
        entry.evidence = null;
        // No view tells main a look ended once reading stops, so the looks go
        // now: one left to its lease would read the next turn after reading
        // comes back on.
        entry.reads.lookers.clear();
      }
      for (const timer of this.dwellTimers.values()) clearTimeout(timer);
      this.dwellTimers.clear();
      this.transientSince.clear();
      this.earlyResizes.clear();
    }
    this.scheduleBroadcast();
    if (this.isRunning && !wasRunning) {
      // Reading again from nothing: every run settles anew from now.
      for (const entry of this.entries.values()) {
        entry.stoppedAt = this.now();
        entry.seenAtWork = false;
      }
    }
    if (this.watching && !wasRunning) void this.scan();
  }

  getSnapshot(): CanopySnapshot {
    const cards: CanopyCard[] = [];
    for (const entry of this.entries.values()) if (entry.card) cards.push(entry.card);
    const dispositions: CanopyDisposition[] = [];
    const seen: CanopySeen[] = [];
    const reads: CanopyReadMark[] = [];
    const glances: CanopyRunGlance[] = [];
    for (const [runId, entry] of this.entries) {
      if (entry.seenAt !== null) seen.push({ runId, spawnedAt: entry.spawnedAt, at: entry.seenAt });
      reads.push(readMarkOf(runId, entry.spawnedAt, entry.reads));
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
      mode: this.plan.mode,
      modeRevision: this.plan.modeRevision ?? 0,
      ...(this.plan.hostEpoch === undefined ? {} : { hostEpoch: this.plan.hostEpoch }),
      activated: this.plan.activated,
      ...this.modelState(),
      dispositions,
      seen,
      reads,
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
      ...this.waitingState(),
      ...this.linkState(),
      trash: this.deps.getTrash?.() ?? [],
    };
  }

  private modelState(): { model?: CanopyModelState } {
    if (!this.isRunning) return {};
    const model = this.deps.modelState?.();
    return model === undefined ? {} : { model };
  }

  /** What the status bar says of the reader: only while Canopy reads at all. */
  private linkState(): { reader?: CanopyReaderLink } {
    if (!this.isRunning || !this.deps.readerName) return {};
    const times = this.link.times;
    return {
      reader: {
        model: this.deps.readerName(),
        inFlight: this.link.inFlight,
        readMs:
          times.length === 0
            ? null
            : Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length),
      },
    };
  }

  /**
   * One reading, counted while it is under way and timed when it comes back.
   * A failed or abandoned one says nothing about how fast the model reads, so
   * only answers are timed.
   */
  private async timed<T>(request: () => Promise<T>): Promise<T> {
    const started = this.now();
    this.link.inFlight++;
    this.linkChanged();
    try {
      const result = await request();
      const times = this.link.times;
      times.push(this.now() - started);
      if (times.length > LINK_TIMES_KEPT) times.shift();
      return result;
    } finally {
      this.link.inFlight--;
      this.linkChanged();
    }
  }

  /** Only an open panel shows the requests: a closed one is not woken for them. */
  private linkChanged(): void {
    if (this.active) this.scheduleBroadcast();
  }

  /**
   * A panel opened or closed. Opening scans at once, then every `pollMs` while
   * it stays open; Refresh scans on demand. A poll costs a reading only for a
   * screen whose tail changed since its card was written.
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
      // The open reads at the panel's pace straight away.
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
    // Closing drops the work the panel queued; the background watch, if on,
    // carries on reading at its own pace.
    this.invalidateInFlight();
    this.restartPolling();
    this.scheduleBroadcast();
  }

  /** Reads are held up for a reason that passes: failed reads are being tried again before any is reported. */
  private waitingState(): { waiting?: "retrying" } {
    if (!this.isRunning) return {};
    // Only a retry still to come: a failure kept quiet, its run waiting out
    // the backoff. One whose words are no longer due has nothing to wait for.
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.failure === null && entry.failures > 0 && entry.retryAt > now) {
        return { waiting: "retrying" };
      }
    }
    return {};
  }

  /**
   * The user asked for one run to be read again, its words included: for a
   * reading they think is wrong, of a screen that hasn't moved and so would
   * never be read again on its own. The same prompt, so nothing reads as new;
   * a failing run is tried at once rather than after its backoff.
   */
  async reread(runId: string, spawnedAt: number): Promise<boolean> {
    const entry = this.entries.get(runId);
    if (!entry || entry.spawnedAt !== spawnedAt || !this.isRunning) return false;
    entry.hash = null;
    entry.failures = 0;
    entry.retryAt = 0;
    entry.rereadOf = entry.contentHash;
    // Whatever is in flight for the run is from the reading the user doubts:
    // a new sequence makes it stale, so its end — the abort below included —
    // counts as neither an answer nor a failure, and the scan reads afresh.
    entry.seq++;
    entry.pending = false;
    if (entry.card?.describing) entry.card = { ...entry.card, describing: false };
    this.supersedeCard(entry);
    entry.cardProgress = false;
    await this.refresh();
    return true;
  }

  /**
   * The user asked for a fresh look. Every screen is re-read, but only the ones
   * that changed since their card was written are read again — an unchanged
   * screen would get the same card back for the price of a reading.
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
    // An answer reopens a stopped run's settling: the next dialog it draws can
    // follow without Daintree seeing work that held in between.
    if (entry) entry.stoppedAt = this.now();
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
  archive(runId: string, spawnedAt: number, expectTurn?: number): CanopyReadMark | null {
    // An undo of "Move to inbox" archives only a run that has done nothing
    // since: archiving it then would hide, and read, what it did.
    if (expectTurn !== undefined) {
      const held = this.entries.get(runId);
      if (!held || held.spawnedAt !== spawnedAt || held.reads.turn !== expectTurn) return null;
    }
    const entry = this.setDisposition(runId, spawnedAt, "archived");
    if (!entry) return null;
    if (entry.card?.handledAt != null) entry.card = { ...entry.card, handledAt: null };
    // Put aside having seen it: whatever brings it back is the news.
    markRead(entry.reads);
    return readMarkOf(runId, spawnedAt, entry.reads);
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
      entry = newEntry(spawnedAt, this.now());
      this.entries.set(runId, entry);
    }
    entry.disposition = {
      kind,
      at: this.now(),
      mark: ++this.marks,
      contentHash: entry.contentHash,
      // The classifier's pick, as what brings the run back is compared with:
      // the words' own quote of the same prompt can differ by a row.
      question:
        entry.classified?.question != null
          ? promptKey(entry.classified.question)
          : entry.card?.question
            ? promptKey(entry.card.question)
            : null,
      sawWork: false,
    };
    // Put aside, the run asks nothing of the user: whatever it asks once it is
    // back is told again.
    entry.asking = false;
    entry.announced = null;
    this.scheduleBroadcast();
    return entry;
  }

  /**
   * The user had the run's terminal in front of them just now. Recorded for
   * the incarnation the fleet shows, and kept while the panel is closed: most
   * looking happens in the terminal's own pane, not here. Broadcast only to an
   * open panel; a closed one reads it with the next snapshot it asks for.
   */
  markSeen(
    runId: string,
    view?: { viewId: number; place: CanopyLookPlace; looking: boolean }
  ): void {
    if (this.disposed) return;
    const entry = this.liveEntry(runId);
    if (!entry) return;
    entry.seenAt = this.now();
    if (view) this.noteLook(runId, entry, `${view.viewId}:${view.place}`, view.looking);
    if (this.active) this.scheduleBroadcast();
  }

  /** The entry for the incarnation of the run the fleet shows now, made if it has none; null when it shows none. */
  private liveEntry(runId: string, spawnedAt?: number): RunEntry | null {
    const run = this.deps.getRuns()?.find((candidate) => candidate.runId === runId);
    if (!run || (spawnedAt !== undefined && run.spawnedAt !== spawnedAt)) return null;
    let entry = this.entries.get(runId);
    if (!entry || entry.spawnedAt !== run.spawnedAt) {
      entry = newEntry(run.spawnedAt, this.now());
      this.entries.set(runId, entry);
    }
    return entry;
  }

  /**
   * A view began or stopped showing the run to the user. A look that lasts
   * `CANOPY_READ_DWELL_MS` reads it — at that moment, if it is still going, or
   * as it ends — so arrowing past a row or switching through panes reads nothing.
   */
  private noteLook(runId: string, entry: RunEntry, looker: string, looking: boolean): void {
    const step = look(entry.reads, looker, looking, this.now());
    if (step.ended !== null && markRead(entry.reads, { lookedSince: step.ended })) {
      this.scheduleBroadcast();
    }
    if (step.readsAt !== null) this.readAfterDwell(runId, entry.spawnedAt, step.readsAt);
  }

  private readAfterDwell(runId: string, spawnedAt: number, at: number): void {
    const pending = this.dwellTimers.get(runId);
    if (pending !== undefined) clearTimeout(pending);
    const timer = setTimeout(
      () => {
        this.dwellTimers.delete(runId);
        const entry = this.entries.get(runId);
        if (this.disposed || !entry || entry.spawnedAt !== spawnedAt) return;
        const since = lookingSince(entry.reads, this.now());
        if (since === null) return;
        // A look that may read it, begun later than the one that set this going.
        if (this.now() - since < CANOPY_READ_DWELL_MS) {
          this.readAfterDwell(runId, spawnedAt, since + CANOPY_READ_DWELL_MS);
          return;
        }
        if (markRead(entry.reads, { lookedSince: since })) this.scheduleBroadcast();
      },
      Math.max(0, at - this.now())
    );
    this.dwellTimers.set(runId, timer);
  }

  /** A view went away: whatever it showed is no longer in front of anyone. */
  forgetViewer(viewId: number): void {
    const prefix = `${viewId}:`;
    for (const entry of this.entries.values()) {
      for (const looker of [...entry.reads.lookers.keys()]) {
        if (looker.startsWith(prefix)) entry.reads.lookers.delete(looker);
      }
    }
  }

  /**
   * The user read the run, or marked it unread. A read goes through the turn
   * the panel showed, never one that landed since.
   */
  setRead(
    runId: string,
    spawnedAt: number,
    read: boolean,
    throughTurn?: number
  ): CanopyReadMark | null {
    if (this.disposed) return null;
    const entry = this.liveEntry(runId, spawnedAt);
    if (!entry) return null;
    if (read) markRead(entry.reads, throughTurn !== undefined ? { throughTurn } : {});
    else markUnread(entry.reads, this.now());
    this.scheduleBroadcast();
    return readMarkOf(runId, spawnedAt, entry.reads);
  }

  /**
   * Every run the panel listed, read through the turn it showed; anything
   * newer stays unread. Returns each run's mark as it left it, for an undo.
   */
  markAllRead(targets: readonly CanopyReadTarget[]): CanopyReadMark[] {
    if (this.disposed) return [];
    const marks: CanopyReadMark[] = [];
    for (const target of targets) {
      const entry = this.entries.get(target.runId);
      if (!entry || entry.spawnedAt !== target.spawnedAt) continue;
      markRead(entry.reads, { throughTurn: target.turn });
      marks.push(readMarkOf(target.runId, target.spawnedAt, entry.reads));
    }
    this.scheduleBroadcast();
    return marks;
  }

  /**
   * Undo: what the user had read before, for each run left as the change
   * being undone left it — a new turn, or a change from another view, stands.
   */
  restoreReads(restores: readonly CanopyReadRestore[]): CanopyReadMark[] {
    if (this.disposed) return [];
    const restored: CanopyReadMark[] = [];
    for (const { mark, expectVersion } of restores) {
      const entry = this.entries.get(mark.runId);
      if (!entry || entry.spawnedAt !== mark.spawnedAt) continue;
      if (restoreRead(entry.reads, mark, expectVersion)) {
        restored.push(readMarkOf(mark.runId, mark.spawnedAt, entry.reads));
      }
    }
    this.scheduleBroadcast();
    return restored;
  }

  /**
   * The user sent the run something from the panel. The work it starts is
   * their own doing, so it stays read even once the panel has moved on.
   */
  noteUserSent(runId: string, spawnedAt: number): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.spawnedAt !== spawnedAt) return;
    entry.reads.userSentAt = this.now();
  }

  /**
   * The user sent the run something from its own pane — Enter typed in it, or
   * its composer — as its view saw it happen. Only a view's own input entry
   * points report this: input from an action, an agent, a broadcast or a
   * plugin never does, so the work those start stays news.
   */
  noteUserSentTo(runId: string): void {
    if (this.disposed) return;
    const entry = this.liveEntry(runId);
    if (entry) entry.reads.userSentAt = this.now();
  }

  /**
   * The run's terminal was resized — the panel holding it at its own size, the
   * user's layout changing. The agent redraws for the new size, which moves
   * every row of its screen without it saying anything new; see `CANOPY_REFLOW_MS`.
   */
  noteResize(runId: string): void {
    if (this.disposed || !this.isRunning) return;
    const now = this.now();
    const entry = this.entries.get(runId);
    if (entry) {
      entry.resizedAt = now;
      return;
    }
    // Every terminal's resizes arrive here, shells' included: one is kept only
    // while a first read could still land inside the redraw it set going.
    for (const [id, at] of this.earlyResizes) {
      if (now - at > EARLY_RESIZE_KEPT_MS) this.earlyResizes.delete(id);
    }
    this.earlyResizes.set(runId, now);
  }

  /** A scan at `at`, unless one is due sooner: once a redraw has settled, or a state change has held. */
  private scanAt(at: number): void {
    if (this.reflowTimer !== null && this.reflowTimer.at <= at) return;
    if (this.reflowTimer !== null) clearTimeout(this.reflowTimer.timer);
    const timer = setTimeout(
      () => {
        this.reflowTimer = null;
        if (this.watching && this.closeTimer === null) void this.scan();
      },
      Math.max(0, at - this.now())
    );
    this.reflowTimer = { at, timer };
  }

  /**
   * The screen redrawn at a new size says what it said before: it becomes the
   * screen every key and read is of, with nothing read again and no time it
   * changed. What the row shows at a glance stays the old screen's, which a
   * narrower pane may only have cut short.
   */
  private adoptRedraw(entry: RunEntry, screen: PreparedScreen, print: string): void {
    const before = entry.contentHash;
    if (before === null) return;
    const swap = (key: string | null) =>
      key !== null && key.startsWith(`${before}:`) ? screen.hash + key.slice(before.length) : key;
    entry.hash = swap(entry.hash);
    entry.readKey = swap(entry.readKey);
    if (entry.lastDescribed?.hash === before) {
      entry.lastDescribed = { ...entry.lastDescribed, hash: screen.hash };
    }
    if (entry.disposition?.contentHash === before) entry.disposition.contentHash = screen.hash;
    if (entry.rereadOf === before) entry.rereadOf = screen.hash;
    if (entry.reads.hash === before) entry.reads.hash = screen.hash;
    if (entry.announced?.hash === before) {
      entry.announced = { ...entry.announced, hash: screen.hash };
    }
    // A redraw since is told from this drawing of the screen that was read.
    if (entry.hash?.startsWith(`${screen.hash}:`)) entry.readLines = screen.lines;
    entry.contentHash = screen.hash;
    entry.print = print;
    entry.redrawn = true;
    entry.redrawnFrom = before;
  }

  /**
   * Show only one workspace's runs in the open panel, or every workspace's
   * (null). Runs outside it are still read, under the background watch's terms.
   */
  setScope(workspaceId: string | null): void {
    if (this.disposed || this.scope === workspaceId) return;
    this.scope = workspaceId;
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
    const now = this.now();
    for (const run of runs ?? []) {
      const id = `${run.runId}:${run.spawnedAt}`;
      busy.set(id, isBusy(run));
      const entry = this.entries.get(run.runId);
      if (!entry || entry.spawnedAt !== run.spawnedAt) continue;
      // Work seen between reads of the screen, for a stop read after it.
      // Timed by when main heard of it: a run's own state times can be stale.
      const startedAt = entry.reads.busySince;
      observeFleet(entry.reads, isBusy(run), now);
      // Work that held past a flicker ended: output alone, a recap drawn under
      // a finished turn, flips Daintree's state to working for a moment.
      const workEnded =
        !isBusy(run) && startedAt !== null && now - startedAt >= CANOPY_TURN_HOLD_MS;
      // Whatever the run asks after real work is news, even the ask it showed before.
      if (workEnded) {
        entry.asking = false;
        entry.announced = null;
      }
      // A stop after work, or after work this entry was made too late to time.
      if (workEnded || (!isBusy(run) && startedAt === null && this.wasBusy.get(id) === true)) {
        entry.stoppedAt = now;
      }
      // Work since the user put the run aside: whatever it stops on next is
      // the agent saying something new. After a reply any start counts — it is
      // the agent taking the reply up — but after an archive only work that
      // held past a flicker does.
      const disposition = entry.disposition;
      if (disposition && (workEnded || (isBusy(run) && disposition.kind === "replied"))) {
        this.workSinceAside(entry);
      }
      if (!isBusy(run)) continue;
      // Starting work after an ask: whatever it asks next is a new ask, even
      // if no scan saw the screen in between. Only a start seen counts — an
      // agent whose ask Daintree's own state missed keeps calling busy. A
      // start that was only a flicker leaves the same ask, already told.
      if (this.wasBusy.get(id) === false) entry.asking = false;
    }
    if (runs !== null) this.wasBusy = busy;
  }

  /**
   * The agent worked since the user put the run aside: whatever it stops on
   * next is news. Its screen may have been read while that work went on,
   * before the work counted, and an archived run's reading of it kept it
   * aside: it is read again, and can come back with what it says now.
   */
  private workSinceAside(entry: RunEntry): void {
    const disposition = entry.disposition;
    if (!disposition || disposition.sawWork) return;
    disposition.sawWork = true;
    if (disposition.kind === "archived" && entry.contentHash !== disposition.contentHash) {
      entry.hash = null;
    }
  }

  /**
   * One read of the run for what the user has seen: a stop or start the
   * screen backs up is a turn, once it has held; until then it is looked at
   * again when it will have.
   */
  private takeTurn(entry: RunEntry, run: FleetRunRow, hash: string): void {
    const step = observeTurn(entry.reads, {
      busy: isBusy(run),
      agentState: run.agentState ?? null,
      since: run.since ?? null,
      hash,
      now: this.now(),
    });
    if (step.kind === "moved") this.scheduleBroadcast();
    else if (step.kind === "wait" && this.watching) this.scanAt(step.at);
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
      if (this.closeTimer !== null) return;
      this.wideNextScan = true;
      void this.scan();
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
    if (this.reflowTimer !== null) clearTimeout(this.reflowTimer.timer);
    this.reflowTimer = null;
    for (const timer of this.dwellTimers.values()) clearTimeout(timer);
    this.dwellTimers.clear();
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
    const force = this.forceNextScan;
    this.forceNextScan = false;
    // With a panel showing one project, every other project stays under the
    // background watch: read at its pace, or on an observed state change, and
    // for the classifier alone (see `rebuild`) — so its asks still page the
    // user and light the toolbar in every window.
    const now = this.now();
    const wide =
      scope === null ||
      this.wideNextScan ||
      (this.backgroundPollMs > 0 && now - this.backgroundReadAt >= this.backgroundPollMs);
    this.wideNextScan = false;
    if (wide) this.backgroundReadAt = now;
    const runs = wide ? fleet : fleet.filter((run) => run.workspaceId === scope);
    const epoch = this.epoch;
    // A disposition set after this scan began acts on screens read later; what
    // this scan saw predates it.
    const readMark = ++this.marks;
    const reads = new Semaphore(SCREEN_READ_CONCURRENCY);
    const passes: Promise<void>[] = [];
    // One run's screen going wrong is that run's: the scan, and every other
    // run in it, carries on, and the run is read again next time.
    const read = await Promise.allSettled(
      runs.map((run) =>
        reads.run(async () => {
          // Queued behind other reads while reading was turned off: never read.
          if (this.disposed || epoch !== this.epoch) return;
          const read = await this.deps.readScreen(run.runId, CANOPY_SCREEN_LINES).catch(() => null);
          if (read === null || this.disposed || epoch !== this.epoch) return;
          const raw = typeof read === "string" ? read : read.text;
          const cols = typeof read === "string" ? undefined : read.cols;
          // The run may have left — or been respawned under the same id — while
          // its screen was being read. Only the incarnation still in the fleet
          // gets an entry.
          if (!this.isLive(run)) return;
          const screen = prepareScreen(raw, cols);
          // Resized lately and still redrawing: what is on screen now may be
          // half the old size's drawing and half the new's, or blank between
          // the two. It is read once the redraw has settled.
          const held = this.entries.get(run.runId);
          const known = held?.spawnedAt === run.spawnedAt ? held : undefined;
          const resizedAt = known ? known.resizedAt : (this.earlyResizes.get(run.runId) ?? null);
          this.earlyResizes.delete(run.runId);
          if (resizedAt !== null && known?.contentHash !== screen.hash) {
            const settled = resizedAt + CANOPY_REFLOW_MS;
            // Blank just past the wait is still the redraw, not a cleared
            // screen: the comparison waits for what it draws.
            const blank = screen.text.trim() === "";
            if (this.now() < settled || (blank && this.now() < settled + CANOPY_REFLOW_MS)) {
              if (known) known.resizedAt = resizedAt;
              else this.earlyResizes.set(run.runId, resizedAt);
              this.scanAt(blank ? settled + CANOPY_REFLOW_MS : settled);
              return;
            }
            if (known) {
              known.resizedAt = null;
              const print = reflowPrint(screen.text);
              if (known.print !== null && sameAfterReflow(known.print, print)) {
                this.adoptRedraw(known, screen, print);
              }
            }
          } else if (known?.resizedAt != null && this.now() >= known.resizedAt + CANOPY_REFLOW_MS) {
            known.resizedAt = null;
          }
          // Nothing drawn yet — a pane still starting, or cleared. A reader
          // given nothing invents something (an empty screen was once carded
          // as a terminal multiplexer error), so nothing is sent.
          if (screen.text.trim() === "") {
            this.clearedScreen(run, screen);
            return;
          }
          const existing = this.entries.get(run.runId);
          const entry =
            existing && existing.spawnedAt === run.spawnedAt
              ? existing
              : newEntry(run.spawnedAt, this.now());
          this.entries.set(run.runId, entry);
          entry.cleared = false;
          // A stop the fleet's own callbacks can't time — the run was first
          // seen at work, or no busy change reached them — as the scans saw it.
          const atWork = isBusy(run) && !flickering(run, this.now());
          if (entry.seenAtWork && !atWork) entry.stoppedAt = this.now();
          entry.seenAtWork = atWork;
          if (entry.contentHash !== screen.hash) {
            entry.contentChangedAt = this.now();
            entry.print = reflowPrint(screen.text);
            entry.redrawn = false;
            entry.redrawnFrom = null;
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
          this.takeTurn(entry, run, screen.hash);
          const disposition = entry.disposition;
          if (disposition && disposition.mark < readMark) {
            // Put aside before its screen was ever read: the first read is the
            // screen the user acted on, not a change since.
            if (disposition.contentHash === null) disposition.contentHash = screen.hash;
            // Work since the user put the run aside (after an archive, held
            // past a flicker): whatever it stops on next is the agent saying
            // something new.
            if (
              isBusy(run) &&
              (disposition.kind === "replied" ||
                run.since === undefined ||
                this.now() - run.since >= CANOPY_TURN_HOLD_MS)
            ) {
              this.workSinceAside(entry);
            }
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
            // whose screen has not moved has nothing new to say. Only for a
            // panel showing it: stuck pages no one, a still screen is marked
            // stalled without a reading, and the open reads busy runs afresh.
            if (
              isBusy(run) &&
              !entry.pending &&
              entry.card !== null &&
              this.active &&
              this.inScope(run) &&
              this.now() - entry.readAt >= CANOPY_REJUDGE_AFTER_MS
            ) {
              entry.sentAt = this.now();
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
          // A moved screen with nothing in it yet worth a request (see
          // `heldRead`) is left for a later scan; what the row shows of it at
          // a glance is current meanwhile. Everything after Refresh is read.
          const waits = force || entry.card === null ? null : this.heldRead(run, entry, screen);
          if (waits !== null) {
            this.keepWhatShows(entry, screen);
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
          // Only Daintree catching up, on a screen already read to the end:
          // the reading stands, and it is not asked again. Only a reading that
          // needs the user, since what a busy or quiet one goes on to write
          // turns on whether Daintree sees it working; and a read is still
          // made where the state would change what it concluded — an approval
          // the classifier was unsure blocks the agent ranks higher once
          // Daintree sees it waiting on one.
          const reading = entry.classified;
          if (
            caughtUp &&
            entry.hash !== null &&
            entry.hash === entry.readKey &&
            !entry.pending &&
            entry.failure === null &&
            this.now() >= entry.retryAt &&
            reading !== null &&
            needsAttention(reading.attention) &&
            readingIgnoresState(reading)
          ) {
            entry.readKey = key;
            entry.hash = key;
            entry.readState = observedKey(run);
            // The ask a stopped run shows, as a read of it records.
            if (
              !isBusy(run) &&
              reading.question !== null &&
              observeAsk(entry.reads, promptKey(reading.question), screen.hash, this.now())
            ) {
              this.scheduleBroadcast();
            }
            // Deliberately a reading of this stop: the same screen, read moments
            // before Daintree saw the agent settle on it, is what the stop shows.
            if (entry.evidence !== null && entry.evidence.turn !== entry.reads.turn) {
              entry.evidence = {
                ...entry.evidence,
                turn: entry.reads.turn,
                state: entry.readState,
              };
              this.scheduleBroadcast();
            }
            this.refreshActivity(entry, screen, run);
            this.announce(run.runId, entry);
            return;
          }
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
          entry.sentAt = this.now();
          entry.readLines = screen.lines;
          passes.push(this.pass(run, entry, epoch, screen, readMark));
        })
      )
    );
    for (const result of read) {
      if (result.status === "fulfilled") continue;
      const error: unknown = result.reason;
      console.warn(
        "[Canopy] Reading an agent's screen failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
    await Promise.all(passes);
    // Only a scan that read something new moves the list's ranking on, and
    // only once its cards are written too (see the card jobs); a quiet poll
    // leaves the snapshot as it was, and so sends nothing.
    if (epoch === this.epoch && passes.length > 0 && this.cardJobs.size === 0) {
      this.refreshedAt = this.now();
    }
  }

  /**
   * Why a run's moved screen waits rather than being read now; null
   * when it goes. A run whose last read failed or was given up (no `hash`), or
   * that Daintree saw settle into another state — a stop, a start that held, a
   * new kind of wait — is always read. Otherwise:
   * - a run at work whose screen shows its working line has nothing a reading
   *   would add with no panel showing it — a reading of such a screen has
   *   never said anything but working — and is read at most every `rereadMs`
   *   with one; once the line goes, a dialog may be in its place, and it is
   *   read before Daintree's state catches up;
   * - a run stopped longer than `CANOPY_SETTLE_MS` whose screen only redrew one
   *   row in place since its last read — a status line's clock, a footer — is
   *   "redrawn", and not read until it works, changes state, is answered, or
   *   draws anything more;
   * - with no panel showing it, no run is read more often than the watch's
   *   pace, however many other runs' state changes start a scan.
   */
  private heldRead(
    run: FleetRunRow,
    entry: RunEntry,
    screen: PreparedScreen
  ): "redrawn" | "held" | null {
    if (entry.hash === null) return null;
    const now = this.now();
    const atWork = isBusy(run) && !flickering(run, now);
    if (entry.readState !== observedKey(run) && (atWork || !isBusy(run))) return null;
    const shown = this.active && this.inScope(run);
    if (atWork && showsWork(screen)) {
      return !shown || now - entry.readAt < this.rereadMs ? "held" : null;
    }
    if (
      !atWork &&
      now - entry.stoppedAt >= CANOPY_SETTLE_MS &&
      onlyRedrawn(entry.readLines, screen.lines)
    ) {
      return "redrawn";
    }
    // Timed from when the last read was sent, so a regular poll a whole pace
    // later, its screens read a little sooner or later, is never the one held.
    return !shown && now - entry.sentAt < this.backgroundPollMs - BACKGROUND_PACE_SLACK_MS
      ? "held"
      : null;
  }

  /**
   * A held screen's card offers only the prompt and the choices still drawn on
   * it: a dialog that moved on must never wear the last one's.
   */
  private keepWhatShows(entry: RunEntry, screen: PreparedScreen): void {
    const card = entry.card;
    if (card === null || (card.question === null && card.options.length === 0)) return;
    const question =
      card.question !== null && onScreen(card.question, screen.text) !== null
        ? card.question
        : null;
    const options = optionsInScreenOrder(card.options, screen.text);
    if (
      question === card.question &&
      options.length === card.options.length &&
      options.every((option, i) => option === card.options[i])
    ) {
      return;
    }
    entry.card = {
      ...card,
      question,
      options,
      secretPrompt: question !== null && card.secretPrompt,
    };
    this.scheduleBroadcast();
  }

  private isLive(run: FleetRunRow): boolean {
    const runs = this.deps.getRuns();
    return (
      runs !== null &&
      runs.some((current) => current.runId === run.runId && current.spawnedAt === run.spawnedAt)
    );
  }

  /**
   * Whether a pass started for `seq` in `epoch` may still act on `entry`.
   * `forWords`: the pass is writing the run's words, which only a panel
   * showing the run is owed; the classifier reads every project's runs.
   */
  private stillWanted(run: FleetRunRow, entry: RunEntry, seq: number, epoch: number): boolean {
    return (
      this.watching &&
      epoch === this.epoch &&
      entry.seq === seq &&
      this.entries.get(run.runId) === entry &&
      this.isLive(run)
    );
  }

  /** The run is one an open panel shows, as far as its scope goes. */
  private inScope(run: FleetRunRow): boolean {
    return this.scope === null || run.workspaceId === this.scope;
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
    // No model here yet: the row keeps the screen's own words, and the screen
    // is read once the model arrives (`readerChanged`).
    if (!this.readerReady) {
      entry.hash = null;
      return Promise.resolve();
    }
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
      // Agent-set (OSC) text, redacted like the screen.
      title: redactSecrets(run.lastObservedTitle ?? run.title ?? ""),
      screen: screen.text,
      lines: screen.lines,
      observed: this.observed(run, entry),
      userAction: this.userAction(entry, screen),
    };
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
    let reading: CanopyReading;
    try {
      reading = await this.readSlots.run(() => {
        // Checked again once a slot frees up: the queue can outlast the panel.
        if (!this.stillWanted(run, entry, seq, epoch)) throw new StaleCanopyPass();
        return this.timed(() => this.deps.read(input, signal));
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
    const classified = reading.classifier;
    entry.readAt = this.now();
    entry.readState = observedKey(run);
    if (entry.failure?.stage === "classifier") entry.failure = null;
    this.transientSince.delete(`${run.runId}:classifier`);

    // The reading's attention is the gate: a run likely to need the user takes
    // the reading's words — but only one in the inbox. A run the user put
    // aside keeps the words it had until it comes back.
    const needs = needsAttention(classified.attention);
    const disposition = entry.disposition;
    // Only a reading of a screen read after the user acted says anything about
    // what happened since.
    if (disposition && disposition.mark < screenReadAt) {
      if (!needs) disposition.sawWork = true;
      else if (returnsToInbox(disposition, screen.hash, classified.question)) {
        entry.disposition = null;
        // Back with something new to say: it comes back unread.
        if (!isUnread(entry.reads)) advanceTurn(entry.reads, this.now(), false);
        this.scheduleBroadcast();
      }
    }
    // Asked for by the user: this read corrects the last reading of the same
    // screen, so it describes whatever the usual gates say, and it is no news.
    const forced = entry.rereadOf !== null && entry.rereadOf === screen.hash;
    // Kept until a description of that screen lands: a failed one is tried
    // again as the same correction. A screen that moved since is news anyway.
    if (!forced) entry.rereadOf = null;
    // A new ask on a stopped run, with no start Daintree saw in between: one
    // dialog answered and the next drawn in its place.
    // Only a correction of a reading the card already holds is no news: a
    // re-read asked for on a screen whose first reading never landed is that
    // screen's first reading, and a new ask on it is news like any other.
    const correction = forced && entry.card?.revision === entry.revision;
    // A correction to no question at all is adopted too: a mistaken ask left
    // behind would make that question, really drawn later, read as old news.
    if (correction && !isBusy(run)) {
      const corrected = classified.question !== null ? promptKey(classified.question) : null;
      adoptAsk(entry.reads, corrected, screen.hash);
      // A reply or archive made on this very screen was made to the
      // corrected ask: the same one drawn again must not bring it back.
      if (entry.disposition !== null && entry.disposition.contentHash === screen.hash) {
        entry.disposition.question = corrected;
      }
    }
    if (
      !correction &&
      !isBusy(run) &&
      classified.question !== null &&
      observeAsk(entry.reads, promptKey(classified.question), screen.hash, this.now())
    ) {
      this.scheduleBroadcast();
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
    // for words to say: new ones would only reword it.
    const progressFresh =
      !forced &&
      sameRun &&
      busyCategory(previous.wordsCategory) &&
      (this.now() - entry.describedAt < CANOPY_PROGRESS_DESCRIBE_MS ||
        (rejudge &&
          previous.category === classified.category &&
          entry.lastDescribed?.hash === screen.hash));
    // The words already describe this very screen and verdict: a re-read that
    // only caught Daintree's state up with what the screen showed, or judged an
    // unchanged one the same, gives new words nothing to add but rewording.
    const wordsCurrent =
      !forced &&
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
      (forced
        ? entry.disposition?.kind !== "archived"
        : needs
          ? !aside
          : entry.disposition?.kind !== "archived" && progress && !progressFresh);
    // The words come with every reading, so they are written whether or not a
    // panel shows the run: the background watch's rows are as full as the open
    // panel's.
    const shown = this.active && this.inScope(run);
    const describe = wordsDue;
    const handledAt = entry.disposition?.kind === "replied" ? entry.disposition.at : null;
    // A card whose screen moved keeps its old words until new ones land, so a
    // row never blanks between readings: they are replaced, not cleared. A run
    // put aside keeps the words it had, as archived mail does. A run whose
    // words are not set otherwise must not wear words written about an
    // earlier screen.
    const keepWords = (wordsDue || aside || wordsCurrent || (progress && progressFresh)) && sameRun;
    const sameState = keepWords && previous.category === classified.category;
    // The words' score outlives a screen that moved without leaving its
    // state — a recap line drawn under a finished turn, a dialog redrawn —
    // until words are set again: the attention's coarser anchor standing
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
        (rejudge && shown) ||
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
      // row dropped its facts and choices for the moment the words took.
      wordsFromEarlierRead:
        keepWords &&
        !wordsCurrent &&
        !(sameState && describe) &&
        (rejudge && shown
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
    entry.classified = classified;
    // Quoted only as far as the screen bears it out: a paraphrase is not evidence.
    entry.evidence = {
      turn: entry.reads.turn,
      hash: entry.contentHash,
      state: entry.readState,
      question: onScreen(classified.question, screen.text),
      status: onScreen(classified.status, screen.text),
    };
    const kind = blockedOn(classified, run);
    entry.ask = kind === null ? null : { kind, question: classified.question };
    this.announce(run.runId, entry);
    this.scheduleBroadcast();
    if (!describe || !this.isRunning) {
      entry.pending = false;
      entry.failures = 0;
      entry.retryAt = 0;
      // No words are owed for this screen any more — put aside, answered, or
      // already current — so a failure writing them is over too.
      if (!wordsDue && entry.failure?.stage === "describer") {
        entry.failure = null;
        this.transientSince.delete(`${run.runId}:describer`);
      }
      return;
    }

    this.startCard(
      entry,
      { run, seq, screen, input, classified, progress, words: reading.words },
      epoch
    );
  }

  /**
   * Sets a run's words from the reading of its screen, once the history above
   * the screen is read for the task and checklist. Apart from the scan: a slow
   * history read must not hold up the watch over every other terminal. A newer
   * screen of this run aborts it (`supersedeCard`).
   */
  private startCard(entry: RunEntry, read: CardRead, epoch: number): void {
    const read_ = read;
    const { run, seq, screen, input, classified, progress } = read;
    const cardAbort = new AbortController();
    entry.cardAbort = cardAbort;
    entry.cardProgress = progress;
    const job = (async (): Promise<void> => {
      this.inFlight++;
      let described: DescriberResult;
      // Set inside the slot below; typed by assertion so the closure write is seen.
      let digestRead = null as CanopyDigest | null;
      const last = entry.lastDescribed;
      try {
        described = await this.wordsSlots.run(() => {
          if (!this.stillWanted(run, entry, seq, epoch) || !this.isRunning) {
            throw new StaleCanopyPass();
          }
          // A redraw at another size adopted since this screen was read: the
          // history ends in that drawing, not this one.
          const redrawn = entry.redrawnFrom === screen.hash ? entry.print : null;
          return this.readDigest(run.runId, input.agent, screen, redrawn).then((read) => {
            if (!this.stillWanted(run, entry, seq, epoch)) throw new StaleCanopyPass();
            if (read === "moved") {
              // The terminal moved on while its history was read: what it shows
              // now is read afresh rather than described from mismatched parts.
              entry.hash = null;
              this.scheduleStateChangeScan();
              throw new StaleCanopyPass();
            }
            if (cardAbort.signal.aborted) throw new StaleCanopyPass();
            digestRead = read?.digest ?? null;
            // An unchanged screen shows no new failed run: the count cannot rise.
            const cap = last !== null && last.hash === screen.hash ? last.failureRepeats : null;
            return read_.words().then((words) => {
              const repeats = Math.min(words.failureRepeats ?? 0, cap ?? Infinity);
              return repeats === words.failureRepeats
                ? words
                : { ...words, failureRepeats: repeats };
            });
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
      // The re-read asked for is done.
      if (entry.rereadOf === screen.hash) entry.rereadOf = null;
      entry.lastDescribed = {
        lines: screen.lines,
        // Read before a redraw at another size was adopted: the same words,
        // under the hash the screen goes by now.
        hash: screen.hash === entry.redrawnFrom ? (entry.contentHash ?? screen.hash) : screen.hash,
        failureRepeats: described.failureRepeats ?? 0,
        verdict: verdictOf(classified, run),
        options:
          described.category === "approval"
            ? optionsInScreenOrder(described.options, screen.text)
            : [],
      };
      // The pass set this run's card before its words were set; it is still
      // that card, since a pass that lost it would no longer be wanted.
      const card = entry.card;
      if (card === null) return;
      const question = onScreen(described.question, screen.text) ?? card.question;
      const asks = described.category === "approval" || described.category === "question";
      entry.card = {
        ...card,
        category: described.category,
        attentionScore: described.attentionScore,
        // An ask the reading saw keeps the run at the top whatever score its
        // words carry: an agent asking is what Canopy pages the user for.
        // A score a point or two from the one shown, in the same step, leaves
        // the shown one standing: words landing must not nudge the number.
        priority:
          card.handledAt !== null
            ? 0
            : heldCanopyPriority(
                card.priority,
                Math.max(
                  readingFloor(classified, run),
                  combinePriority(card.attentionProbability, described.attentionScore)
                )
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
      // Put aside, snoozed, or no longer asking: once it is told again, it is
      // told as a new ask — a snooze running out is a reminder.
      entry.asking = false;
      entry.announced = null;
      return;
    }
    const prompt = `${ask.kind}\u0000${ask.question === null ? "" : promptKey(ask.question)}`;
    const told = entry.announced;
    // Still the ask that was told, its screen moving on around it.
    if (entry.asking && told?.prompt === prompt) return;
    entry.asking = true;
    // The very ask on the very screen, its latch cleared by a flicker of work.
    if (told?.prompt === prompt && told.hash === entry.contentHash) return;
    entry.announced = { prompt, hash: entry.contentHash };
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
    screen: PreparedScreen,
    /** The print of a redraw of `screen` adopted since it was read, which the history may end in instead. */
    redrawn: string | null = null
  ): Promise<{ digest: CanopyDigest; history: string[] } | null | "moved"> {
    if (!this.deps.readHistory) return null;
    const raw = await this.deps.readHistory(runId, CANOPY_HISTORY_ROWS).catch(() => null);
    if (raw === null) return null;
    const history = prepareScreen(raw, screen.cols);
    if (
      !sameScreenTail(screen, raw) &&
      (redrawn === null || !sameAfterReflow(redrawn, reflowPrint(history.text)))
    ) {
      return "moved";
    }
    return {
      digest: digestHistory(raw, agent),
      history: history.lines,
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
    entry.print = null;
    entry.readLines = null;
    entry.redrawn = false;
    entry.redrawnFrom = null;
    entry.hash = null;
    entry.readKey = null;
    // A pass or card still under way was for the screen that is gone: none of
    // it may land, the agent's note included.
    entry.seq++;
    entry.pending = false;
    this.supersedeCard(entry);
    // The prompt is gone with the screen: whatever it asks next is a new ask.
    entry.ask = null;
    entry.classified = null;
    entry.evidence = null;
    entry.cleared = true;
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
        // The card being written was for the screen that is gone, and is not coming.
        describing: false,
        wordsFromEarlierRead: entry.card.stage === "described",
        priorityFromEarlierRead: true,
      };
    }
    this.scheduleBroadcast();
  }

  /**
   * The row's name once words are set. Written once from the user's request and
   * kept — a later reading is not allowed to reword it — until the user sends a
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
    const glance = entry.redrawn ? card.glance : glanceScreen(screen.lines);
    // A redraw keeps the activity line it had where the new one is only that
    // line cut at another width; a retry counter moving on still shows.
    const activity =
      entry.redrawn && sameLineCut(card.activity, screen.activity)
        ? card.activity
        : screen.activity;
    if (
      !sameGlance(card.glance, glance) ||
      card.activity !== activity ||
      card.contextLeft !== screen.contextLeft ||
      card.stalledSince !== stalledSince
    ) {
      entry.card = {
        ...card,
        activity,
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
      const held = this.transientSince.get(key);
      // A spell nothing has failed in for longer than a failing run ever waits
      // between tries ended — the run stopped being read — so this failure
      // starts anew.
      const current = held !== undefined && now - held.lastAt <= this.spellGapMs;
      const spell = current ? held : { since: now, graceFrom: now, lastAt: now };
      // What the spell retired had reported is old news: this one reports anew.
      if (!current && entry.failure?.stage === error.provider) entry.failure = null;
      spell.lastAt = now;
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
    entry.failure = {
      stage: error instanceof CanopyProviderError ? error.provider : stage,
      message: failureMessage(error),
    };
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
        const dwell = this.dwellTimers.get(runId);
        if (dwell !== undefined) clearTimeout(dwell);
        this.dwellTimers.delete(runId);
        this.transientSince.delete(`${runId}:classifier`);
        this.transientSince.delete(`${runId}:describer`);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Canopy's refinement of where the run lands, for the incarnation given, or
   * undefined when there is none: Canopy off or its model not here, the user put
   * the run aside, or nothing this turn read as an ask, a false alarm or a
   * stall. Reads only what is held — it never reads a screen.
   */
  getRefinement(runId: string, spawnedAt: number): RunCanopyRefinement | undefined {
    if (!this.refines) return undefined;
    const entry = this.entries.get(runId);
    // Archived or replied to is the user's own call on what the run showed,
    // and it outranks what the reader made of it.
    if (!entry || entry.spawnedAt !== spawnedAt || entry.disposition !== null) return undefined;
    const held = entry.refinement;
    if (held === null || held.turn !== entry.reads.turn) return undefined;
    // The verdict is held for the turn; whether the user has read that turn
    // is not, and every read or mark since settles through here.
    return held.value.kind === "stalled" ? held.value : { ...held.value, seen: !isUnread(entry.reads) };
  }

  /** Readings refine attention only for a user who turned Canopy on and has its model. */
  private get refines(): boolean {
    return !this.disposed && this.plan.mode === "on" && this.plan.activated && this.readerReady;
  }

  /**
   * Latches each run's first qualifying verdict for its turn, and tells
   * `onRefinementsChanged` when what `getRefinement` answers has moved.
   */
  private settleRefinements(): void {
    const runs = this.deps.getRuns();
    const refines = this.refines;
    const byId = runs === null ? null : new Map(runs.map((run) => [run.runId, run]));
    const parts: string[] = [];
    for (const [runId, entry] of this.entries) {
      if (!refines) {
        entry.refinement = null;
        continue;
      }
      const run = byId?.get(runId);
      if (run !== undefined && run.spawnedAt === entry.spawnedAt) {
        const turn = entry.reads.turn;
        const held = entry.refinement;
        // A stall is an observation of a still screen: once it moves, there is
        // nothing left to quote, whatever turn it is. Checked live rather than
        // off the card, which keeps the stall it last showed through a cleared
        // screen or a read still under way.
        const stalledSince = this.stalledSince(run, entry);
        const stallEnded = held !== null && held.value.kind === "stalled" && stalledSince === null;
        if (held === null || held.turn !== turn || stallEnded) {
          const value = refinementOf(entry, run, stalledSince, this.now());
          entry.refinement = value === null ? null : { turn, value };
        }
      }
      const value = this.getRefinement(runId, entry.spawnedAt);
      if (value !== undefined) parts.push(`${runId}:${entry.spawnedAt}:${JSON.stringify(value)}`);
    }
    const key = parts.join("\n");
    if (key === this.refinementKey) return;
    this.refinementKey = key;
    this.deps.onRefinementsChanged?.();
  }

  private scheduleBroadcast(): void {
    if (this.disposed || this.broadcastTimer !== null) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      if (this.disposed) return;
      // Every change worth a broadcast passes here — a new reading, a turn, a
      // stall, a run gone — whether or not a panel is open to be sent it.
      this.settleRefinements();
      const snapshot = this.getSnapshot();
      // `busy` alone flips on every poll and nothing shows it: a scan that
      // changed nothing else is not news to any view.
      // The requests are shown only by an open panel, which a closed one's
      // reads must not wake every view for.
      const sent = JSON.stringify({
        ...snapshot,
        busy: false,
        sequence: 0,
        ...(this.active ? {} : { link: undefined }),
      });
      // A view that was told a scan was under way must still hear it ended.
      if (sent === this.lastBroadcast && !(this.lastBroadcastBusy && !snapshot.busy)) return;
      this.lastBroadcast = sent;
      this.lastBroadcastBusy = snapshot.busy;
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

/** The same line, one cut shorter at the pane's edge than the other. */
function sameLineCut(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const bare = (line: string) => line.replace(/…\s*$/, "").trimEnd();
  return bare(a).startsWith(bare(b)) || bare(b).startsWith(bare(a));
}

function newEntry(spawnedAt: number, now: number): RunEntry {
  return {
    spawnedAt,
    hash: null,
    readKey: null,
    contentHash: null,
    contentChangedAt: 0,
    print: null,
    resizedAt: null,
    redrawn: false,
    redrawnFrom: null,
    disposition: null,
    seq: 0,
    revision: 0,
    card: null,
    pending: false,
    cardAbort: null,
    cardProgress: false,
    failures: 0,
    retryAt: 0,
    readAt: 0,
    sentAt: 0,
    readLines: null,
    stoppedAt: now,
    seenAtWork: false,
    readState: "",
    failure: null,
    describedAt: 0,
    seenAt: null,
    taskRequest: null,
    lastDescribed: null,
    ask: null,
    classified: null,
    asking: false,
    announced: null,
    glance: null,
    reads: newReadTrack(),
    rereadOf: null,
    refinement: null,
    evidence: null,
    cleared: false,
  };
}

/** The newest request in the history that sets work, normalised; null when none shows. */
function latestRequest(digest: CanopyDigest | null): string | null {
  if (digest?.requests == null) return null;
  for (let i = digest.requests.length - 1; i >= 0; i--) {
    const request = normalizeScreenText(digest.requests[i]!);
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
 * reading's estimate.
 */
function progressOf(digest: CanopyDigest | null, described: DescriberResult): number | null {
  const todo = digest?.todo ?? null;
  if (todo === null || todo.total === 0) return described.progress;
  const done = todo.done + (todo.current !== null ? 0.5 : 0);
  return Math.round(Math.min(100, (100 * done) / todo.total));
}

/** Daintree now sees the run as the card read it, where at the read it still saw otherwise. */
function stateCaughtUp(card: CanopyCard, run: FleetRunRow): boolean {
  const then = card.observedWhenRead;
  return then !== undefined && observedCaughtUp(card.category, then, run, card.observedAt);
}

/**
 * A busy agent's working line, as each CLI draws it under its output: Codex's
 * "esc to interrupt", Gemini's "(esc to cancel, 4s)" or "(4s, esc to cancel)",
 * and Claude Code's spinner, which stopped printing "esc to interrupt": one
 * word trailing off in "…" ("✽ Nesting…"), or its words then the timer
 * ("· Adding a test… (32s · ↓ 3.2k tokens)"). A finished turn's "✻ Crunched
 * for 9m 33s" has no "…", and a list item ending in one has no timer.
 */
const WORKING_LINE =
  /esc to interrupt|\(esc to cancel, \d|\(\d+s,?\s*esc to cancel|^[·✢✳✶✻✽✺*]\s+(?:\p{L}+…|\S.*…\s*\(\d+[smh]\b[^()]*\))$/iu;
/** An ask drawn below a working line that still shows: Codex's queued question. */
const ASKING_LINE = /shift\+← to answer|^\?\s*\d+ questions?$/i;

/** The bottom of the screen still shows the agent at work, and asking nothing. */
function showsWork(screen: PreparedScreen): boolean {
  const tail = screen.lines.slice(-6);
  return (
    tail.some((line) => WORKING_LINE.test(line)) && !tail.some((line) => ASKING_LINE.test(line))
  );
}

/**
 * The run's busy state began too lately to have held past a flicker: output
 * alone — a status line redrawn — flips Daintree's state to working for a
 * moment, and such a start is still the stop it broke into. A time from the
 * future, or none that can be read, is never a flicker.
 */
function flickering(run: FleetRunRow, now: number): boolean {
  const held = run.since === undefined ? Number.NaN : now - run.since;
  return held >= 0 && held < CANOPY_TURN_HOLD_MS;
}

/**
 * `after` is `before` with at most one row changed in place: a redraw — a
 * status line's clock, a footer — rather than anything new drawn.
 */
function onlyRedrawn(before: readonly string[] | null, after: readonly string[]): boolean {
  if (before === null || before.length !== after.length) return false;
  let changed = 0;
  for (let i = 0; i < after.length; i++) {
    if (before[i] !== after[i] && ++changed > 1) return false;
  }
  return true;
}

/**
 * A failed read in words for the user: what happened, never the provider's
 * own terms — no stage names, status codes or stream codes.
 */
export function failureMessage(error: unknown): string {
  if (!(error instanceof CanopyProviderError)) return "Canopy couldn't read some screens.";
  const message = error.message;
  if (/model not downloaded/.test(message)) return "Canopy's model isn't downloaded yet.";
  if (/newer version/.test(message)) return "Canopy's model needs a newer version of Daintree.";
  if (/keeps failing|stopped/.test(message)) {
    return "Canopy's model stopped running. Turn Canopy off and on to try again.";
  }
  if (/timed out|too long/.test(message)) return "Canopy's model took too long to read a screen.";
  return "Canopy's model couldn't read some screens.";
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

/**
 * What the canopy panel says about each agent run, built in main from the run's
 * screen by a classifier pass (every run whose screen changed) and, while the
 * panel is open, a describer pass (the runs that need the user, and the ones
 * still working at the progress pace).
 *
 * Everything here is derived from screen text and is a reading, not a fact:
 * the panel shows it beside the agent state Daintree observed, never instead of
 * it.
 */

/** The screen's current state, as the classifier read it. */
export type CanopyCategory =
  "approval" | "question" | "finished" | "error" | "working" | "running" | "idle";

export const CANOPY_CATEGORIES: readonly CanopyCategory[] = [
  "approval",
  "question",
  "finished",
  "error",
  "working",
  "running",
  "idle",
];

/**
 * Below this classifier probability a run is not treated as needing the user:
 * it is not counted as needing you, and is described only as a working run
 * is, for its progress, whatever category it was given.
 */
export const CANOPY_ATTENTION_THRESHOLD = 0.5;

/**
 * At or over this priority a run needs the user now — an agent blocked on an
 * approval or a question, read with confidence — and the toolbar lights. A
 * finished turn or an error ranks below it: worth a look, not a page.
 */
export const CANOPY_URGENT_PRIORITY = 85;

/** The lowest score band that leaves the user something to do: loose ends on a finished turn. */
export const CANOPY_NEEDS_YOU_PRIORITY = 55;

/** Categories where the run is stopped until the user does something. */
export const CANOPY_ATTENTION_CATEGORIES: ReadonlySet<CanopyCategory> = new Set([
  "approval",
  "question",
  "finished",
  "error",
]);

/** What the screen last reported about the task's tests. An observation, not a check Daintree ran. */
export type CanopyTests = "passing" | "failing" | "not_run" | "unknown";

/** What the screen last reported about the task's code changes. */
export type CanopyChanges = "uncommitted" | "committed" | "pushed" | "none" | "unknown";

/** The agent's own checklist, counted off its screen exactly. */
export interface CanopySteps {
  done: number;
  total: number;
  /** The item it marks in progress, verbatim; null when none is. */
  current: string | null;
}

/**
 * What a run's screen says at a glance, lifted verbatim with no model, on every
 * read — the background watch's included. A row shows it until the readers
 * have written its card, so it has real words the moment the panel opens.
 * Screen text picked by its shape: an observation, never a reading.
 */
export interface CanopyGlance {
  /** Claude Code's session recap ("※ recap: …"), when one is on screen below the newest request. */
  recap: string | null;
  /** The opening of the agent's newest message to the user: its report, or what it is about to do. */
  said: string | null;
  /** For a working agent, the step it is on: a status line that names one, or its newest tool call. */
  doing: string | null;
  /** The command an open approval would run, as the dialog shows it. */
  action: string | null;
}

export interface CanopyCard {
  runId: string;
  /** The terminal incarnation the card was read from; ids are reused across respawns. */
  spawnedAt: number;
  /**
   * Bumped each time the run's screen really changes. Stable while a prompt
   * sits unanswered, so it identifies "this prompt" across re-reads and
   * describer refinements.
   */
  revision: number;
  category: CanopyCategory;
  /** Classifier confidence in `category`, 0–1. */
  confidence: number;
  /** The classifier's probability that the terminal needs the user now, 0–1. */
  attentionProbability: number;
  /** The describer's 0–100 attention score; null until described. */
  attentionScore: number | null;
  /**
   * 0–100, and the order the panel lists runs in: the describer's score once it
   * has written the card, the classifier's probability before.
   */
  priority: number;
  /** `described` once the describer has written the card's text. */
  stage: "classified" | "described";
  /**
   * The words (headline, summary, task, risk) were written about an earlier
   * screen of this run and are kept only until the describer re-reads it — or
   * for good, if that read fails. The priority meanwhile is the classifier's alone.
   */
  wordsFromEarlierRead: boolean;
  /**
   * The screen moved since `priority` was worked out and it has not been
   * scored again yet; the panel neither shows nor sorts by it until it is.
   */
  priorityFromEarlierRead: boolean;
  /**
   * The state the describer wrote the words (headline, summary, task) for;
   * null before it has written any. A run that has since moved to another state
   * keeps words written for this one only until it is described again, and a
   * busy run never shows words written about a prompt it has left behind.
   */
  wordsCategory: CanopyCategory | null;
  /** True while a describer pass for this run is in flight. */
  describing: boolean;
  /**
   * What the agent is working on overall, at most ~8 words; the row's subject.
   * Null until described, or when the screen does not show it.
   */
  task: string | null;
  /**
   * How much of the user's task is done, 0–100: the agent's checklist when it
   * draws one, else the describer's estimate. Null until described, or when
   * nothing on screen shows it.
   */
  progress: number | null;
  /** The agent's checklist, counted exactly from its screen; null when it draws none. */
  steps: CanopySteps | null;
  tests: CanopyTests;
  changes: CanopyChanges;
  /** What the user needs to do, at most ~10 words and naming the decision; null until described. */
  headline: string | null;
  /** At most ~25 words; null until described. */
  summary: string | null;
  /** The prompt the program is asking, verbatim from the screen. */
  question: string | null;
  /** Option labels for a menu or y/n prompt, verbatim, in screen order. */
  options: string[];
  /** The prompt asks for a secret; the panel must not offer an inline reply. */
  secretPrompt: boolean;
  /**
   * The describer's caution about what an approval would do — irreversible, or
   * reaching outside the project. `unknown` when it could not tell or never read
   * the screen; `none` claims nothing beyond "no caution seen".
   */
  risk: "none" | "caution" | "unknown";
  /** Why the describer flagged caution, at most ~8 words; null otherwise. */
  riskReason: string | null;
  /**
   * What an approval would let the agent do — the command, file or folder —
   * verbatim from the screen; null for anything else, or when the reader's
   * words were not on screen.
   */
  action: string | null;
  /**
   * When the user last sent something to this run from the panel, for the
   * screen revision it was sent against. A handled run's priority is 0 until a
   * new screen is read for it; null when it has not been answered here.
   */
  handledAt: number | null;
  /** The newest meaningful line on screen, verbatim. An observation, not a reading. */
  activity: string | null;
  /** The screen's own words at a glance, read with no model; see `CanopyGlance`. */
  glance: CanopyGlance;
  /**
   * The line the classifier picked as saying most about the run at a glance,
   * verbatim; null when it picked none or has not read this screen. Shown until
   * the describer has written words, where Daintree's own glance has none.
   */
  statusLine: string | null;
  /**
   * The share of its context window the agent's own footer says is left, in
   * percent; null when it shows none. An observation, not a reading.
   */
  contextLeft: number | null;
  /**
   * When a working run's screen last changed, once it has stood still — ticking
   * timers and spinners aside — for long enough to look stalled; null while it
   * moves, or for a run that is not working. An observation: Daintree's own
   * quiet tracking cannot see this stall, since the spinner's timer keeps
   * redrawing.
   */
  stalledSince: number | null;
  /** When the screen this card was built from was read (epoch ms). */
  observedAt: number;
  /**
   * What Daintree observed of the run when it was read. A state change after
   * the read that only brings Daintree in line with the card — it often sees
   * an agent stop on a dialog seconds after the screen shows it — leaves the
   * card current.
   */
  observedWhenRead?: { agentState: string | null; waitingReason: string | null };
}

/** A terminal the canopy panel is showing live: where its stream starts. */
export interface CanopyTerminalView {
  /**
   * Tags every chunk of this stream; chunks from an older watch are dropped.
   * Null when the request was overtaken or cancelled before the stream began.
   */
  watchId: number | null;
  /** The screen as it was when the stream began; null when the host had none. */
  snapshot: {
    data: string;
    cols: number;
    rows: number;
    /** What the snapshot covers up to; chunks at or before it are already in it. */
    continuation?: import("../terminal.js").SnapshotContinuation;
  } | null;
}

/** What a watched terminal's stream carries, in order. */
export type CanopyTerminalData =
  | {
      kind: "data";
      watchId: number;
      runId: string;
      data: string | Uint8Array;
      /** End offset in the terminal's output stream, for fencing against the snapshot. */
      streamEnd?: number;
    }
  /** The PTY took a new size from the pane that owns it. */
  | { kind: "resize"; watchId: number; runId: string; cols: number; rows: number }
  /** The terminal exited or its host went down; the stream takes no more input. */
  | { kind: "ended"; watchId: number; runId: string };

/**
 * Canopy asks the views that own a terminal to trash its pane. The pane's own
 * trash path moves it to the trash and tells the PTY host, exactly as closing
 * it in place would; the host trashing it alone leaves the pane on the grid,
 * since a view ignores a host trash it did not start.
 */
export interface CanopyTrashRequest {
  runId: string;
}

/**
 * The user put a run aside from the panel, for the screen it showed then:
 * `replied` sits under Everything else, `archived` in the Archived section.
 * Main brings it back to the inbox once the agent has something new to say.
 */
export interface CanopyDisposition {
  runId: string;
  /** The incarnation it was put aside in; a respawn starts in the inbox. */
  spawnedAt: number;
  kind: "archived" | "replied";
  at: number;
}

/**
 * When the user last had a run's terminal in front of them: focused in its own
 * pane, or open in the panel. An observation, not a reading — the panel ranks
 * a working agent up the longer it goes unseen.
 */
export interface CanopySeen {
  runId: string;
  /** The incarnation it was seen in; a respawn has not been seen. */
  spawnedAt: number;
  at: number;
}

/**
 * Whether the user has seen what a run has done since they last looked, the
 * way mail is read or unread. Each thing the agent did that would be news to
 * someone looking away is one turn — a stop, a start nobody here sent it, a
 * new ask — taken from what Daintree observed and the screen showed, never
 * from a reading's words.
 */
export interface CanopyReadMark {
  runId: string;
  /** The incarnation it is for; a respawn starts with nothing to read. */
  spawnedAt: number;
  turn: number;
  /** The turn the user has read through; unread while below `turn`. */
  readTurn: number;
  /** When the user marked it unread themselves; null when not. */
  markedUnreadAt: number | null;
  /** Rises with every change to what is read, so an undo can tell nothing changed since. */
  version: number;
}

/**
 * Undo of a read change: what the run was before (`mark`), put back only while
 * it still is as the change left it (`expectVersion`).
 */
export interface CanopyReadRestore {
  mark: CanopyReadMark;
  expectVersion: number;
}

/** Where in a view a terminal is in front of the user: its own pane, or Canopy's panel. */
export type CanopyLookPlace = "pane" | "panel";

/** A run to mark read, through the turn the panel showed — never a turn that landed since. */
export interface CanopyReadTarget {
  runId: string;
  spawnedAt: number;
  turn: number;
}

/** Unread: a turn the user hasn't read, or marked unread by hand. */
export function isCanopyUnread(mark: CanopyReadMark | null | undefined): boolean {
  if (!mark) return false;
  return mark.markedUnreadAt !== null || mark.readTurn < mark.turn;
}

/**
 * Whether the user pays for Canopy. Screens are read alike on both: the tier
 * changes only what the panel tells them.
 */
export type CanopyTier = "free" | "priority";

/**
 * Where the user stands on Canopy. `unset`: never turned on, or turned off —
 * its ways in offer it, and nothing is read. `on`: screens are read. `hidden`:
 * the user doesn't want it — no way in but Settings, and nothing is read.
 */
export type CanopyMode = "unset" | "on" | "hidden";

export const CANOPY_MODES: readonly CanopyMode[] = ["unset", "on", "hidden"];

/** What the user has signed up for: whether screens are read at all, and how. */
export interface CanopyPlan {
  mode: CanopyMode;
  /**
   * Rises with every change of mode since launch, from any view, so an Undo of
   * one hide can tell a later hide from its own.
   */
  modeRevision?: number;
  /** The user turned Canopy on, agreeing to send screens off the machine to be read: `mode` is `on`. */
  activated: boolean;
  tier: CanopyTier;
}

/** What a run's screen says at a glance, for a run the readers have not carded yet. */
export interface CanopyRunGlance {
  runId: string;
  /** The incarnation it was read from; a respawn has not been read. */
  spawnedAt: number;
  glance: CanopyGlance;
}

export interface CanopySnapshot {
  /**
   * Rises with every snapshot main hands out, pulled or pushed, so a view
   * never lets a late reply paint over a newer push.
   */
  sequence?: number;
  mode: CanopyMode;
  /** The plan's mode revision: see `CanopyPlan.modeRevision`. */
  modeRevision?: number;
  /** The user turned Canopy on; nothing is read until they do. */
  activated: boolean;
  tier: CanopyTier;
  /** Runs the user archived or replied to and that have said nothing new since. */
  dispositions: CanopyDisposition[];
  /** When the user last looked at each run, for the runs looked at since Daintree started. */
  seen: CanopySeen[];
  /** What the user has read of each run Canopy knows. A run with none has nothing unread. */
  reads: CanopyReadMark[];
  /** The workspace main reads screens in, or null for every workspace. */
  scope: string | null;
  /** A panel is open and main is watching screens. */
  active: boolean;
  /** A scan or a classifier/describer pass is in flight. */
  busy: boolean;
  /** When the last full scan finished (epoch ms). */
  refreshedAt: number | null;
  cards: CanopyCard[];
  /**
   * The screen's own words for runs with no card yet — read, but still queued
   * for the classifier, or its read failed — so they have words from the first
   * frame. A run with a card carries them on it.
   */
  glances: CanopyRunGlance[];
  /** The last provider failure, without any screen content. */
  lastError: string | null;
  /** Runs whose last read failed; their cards, if any, are from an earlier read. */
  failedRuns: string[];
  /**
   * Runs read with no panel open whose words the next open writes: their
   * cards, and so their place in the list, are about to change.
   */
  wordsDue?: string[];
}

/**
 * The run an action is meant for: the terminal incarnation the panel showed,
 * so main refuses one respawned under the same id since. A host will join it
 * when runs on remote hosts are read too.
 */
export interface CanopyTarget {
  spawnedAt: number;
}

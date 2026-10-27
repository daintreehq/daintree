/**
 * What the canopy panel says about each agent run, built in main from the run's
 * screen by the local reader: every run whose screen changed is read, and the
 * reading's words are set for the runs that need the user and, at the progress
 * pace, the ones still working. Every word is a line copied off the screen.
 *
 * Everything here is derived from screen text and is a reading, not a fact:
 * the panel shows it beside the agent state Daintree observed, never instead of
 * it.
 */

import type { FleetRunRow } from "./fleet.js";

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
   * readings.
   */
  revision: number;
  category: CanopyCategory;
  /** The reader's confidence in `category`, 0–1. */
  confidence: number;
  /** The reader's probability that the terminal needs the user now, 0–1. */
  attentionProbability: number;
  /** The reading's 0–100 attention score on Canopy's anchors; null until its words are set. */
  attentionScore: number | null;
  /**
   * 0–100, and the order the panel lists runs in: the reading's score once its
   * words are set, its attention probability before.
   */
  priority: number;
  /** `described` once the reading's words are set on the card. */
  stage: "classified" | "described";
  /**
   * The words (headline, summary, task, risk) were written about an earlier
   * screen of this run and are kept only until it is read again — or for good,
   * if that read fails. The priority meanwhile is the attention probability's alone.
   */
  wordsFromEarlierRead: boolean;
  /**
   * The screen moved since `priority` was worked out and it has not been
   * scored again yet; the panel neither shows nor sorts by it until it is.
   */
  priorityFromEarlierRead: boolean;
  /**
   * The state the words (headline, summary, task) were set for; null before
   * any were. A run that has since moved to another state keeps words set for
   * this one only until it is read again, and a
   * busy run never shows words written about a prompt it has left behind.
   */
  wordsCategory: CanopyCategory | null;
  /** True while this run's words are being set from its reading. */
  describing: boolean;
  /**
   * What the agent is working on overall, at most ~8 words; the row's subject.
   * Null until described, or when the screen does not show it.
   */
  task: string | null;
  /**
   * How much of the user's task is done, 0–100: the agent's checklist when it
   * draws one, else the reading's estimate. Null until described, or when
   * nothing on screen shows it.
   */
  progress: number | null;
  /** The agent's checklist, counted exactly from its screen; null when it draws none. */
  steps: CanopySteps | null;
  tests: CanopyTests;
  changes: CanopyChanges;
  /**
   * The card's first line under the terminal's own title: the line on screen
   * that says most, verbatim; null until described, or when no line does.
   */
  headline: string | null;
  /** The card's second line, verbatim, when one is worth reading; null until described. */
  summary: string | null;
  /** The prompt the program is asking, verbatim from the screen. */
  question: string | null;
  /** Option labels for a menu or y/n prompt, verbatim, in screen order. */
  options: string[];
  /** The prompt asks for a secret; the panel must not offer an inline reply. */
  secretPrompt: boolean;
  /**
   * The reading's caution about what an approval would do — irreversible, or
   * reaching outside the project. `unknown` when it could not tell or never read
   * the screen; `none` claims nothing beyond "no caution seen".
   */
  risk: "none" | "caution" | "unknown";
  /** Why caution was flagged, at most ~8 words; null otherwise (the local reader writes none). */
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
   * The line the reader picked as saying most about the run at a glance,
   * verbatim; null when it picked none or has not read this screen. Shown until
   * the words are set, where Daintree's own glance has none.
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
  /**
   * The host holds the PTY at the size the view asks for while it may drive
   * the run (#14497). Absent from a host that predates it, which a view on
   * another machine then never asks to size.
   */
  holdsSize?: boolean;
}

/**
 * Where "Open in Assistant" lands: the exact lane of a project, or the global
 * session, with the run it was resolved against. A lane is never defaulted and
 * the global session never names a project.
 */
export type AssistantOpenDestination =
  | {
      scope: "project";
      hostId: string;
      projectId: string;
      lane: number;
      terminalId: string;
      incarnation: number;
    }
  | { scope: "global"; hostId: string; terminalId: string; incarnation: number };

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
 * The user took back a trash made from Canopy. The view holding the pane puts
 * it back from the trash as its own Undo would, host restore included.
 */
export interface CanopyRestoreRequest {
  runId: string;
}

/**
 * The user removed a trashed run for good from Canopy's Trash. The view holding
 * its pane in the trash drops it as its own Remove would, ending the process.
 */
export interface CanopyRemoveRequest {
  runId: string;
}

/**
 * Canopy asks one view of a closed run's project to resume its session, the
 * way the Resume Sessions palette does, and to answer with `resumeSettled`.
 */
export interface CanopyResumeRequest {
  requestId: string;
  /** How long main waits for the answer: a request still unstarted after that is stale. */
  answerWithinMs: number;
  session: import("./agentSessionHistory.js").AgentSessionRecord;
}

/** A view's answer to a {@link CanopyResumeRequest}: the pane running the session, or why none is. */
export type CanopyResumeAnswer = { runId: string } | { error: string };

/**
 * The user renamed a run from Canopy. The view that holds its pane renames the
 * pane as the user's own rename there would; an empty title puts back the one
 * Daintree gives it.
 */
export interface CanopyRenameRequest {
  runId: string;
  title: string;
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
  /**
   * Names the host process `modeRevision` counts in: the counter starts over
   * when the host restarts, so a revision means nothing without it.
   */
  hostEpoch?: string;
  /** The user turned Canopy on: `mode` is `on`. */
  activated: boolean;
}

/** Who publishes Canopy's models on Hugging Face, and what they are called there. */
export const CANOPY_MODEL_AUTHOR = "daintreehq";
export const CANOPY_MODEL_PREFIX = "canopy-reader-";
/** The model Canopy reads with. */
export const CANOPY_MODEL = `${CANOPY_MODEL_AUTHOR}/${CANOPY_MODEL_PREFIX}17m`;

const CANOPY_MODEL_ID = new RegExp(
  `^${CANOPY_MODEL_AUTHOR}/${CANOPY_MODEL_PREFIX}[a-z0-9][a-z0-9-]*$`
);

/**
 * One of the publisher's reader repos. Only `CANOPY_MODEL` is fetched; an
 * earlier Daintree could choose among them, and a host on one still names its pick.
 */
export function isCanopyModelId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 120 && CANOPY_MODEL_ID.test(value);
}

/** What the status bar and Settings call a model. */
export function canopyModelName(id: string): string {
  if (id === CANOPY_MODEL) return "Light";
  return id
    .slice(id.lastIndexOf("/") + 1)
    .replace(CANOPY_MODEL_PREFIX, "")
    .toUpperCase();
}

/** The model on this machine, as Settings shows it. */
export interface CanopyModelInfo {
  /** Its Hugging Face repo. */
  id: string;
  name: string;
  /** What it takes on this machine once installed, else what a download fetches. */
  bytes: number;
  /** On this machine and checked. */
  installed: boolean;
}

/** Where the model stands on this machine. */
export type CanopyModelState =
  | { id: string; status: "missing" }
  | { id: string; status: "downloading"; received: number; total: number }
  | { id: string; status: "ready" }
  | { id: string; status: "failed"; error: string };

/** What a run's screen says at a glance, for a run the readers have not carded yet. */
export interface CanopyRunGlance {
  runId: string;
  /** The incarnation it was read from; a respawn has not been read. */
  spawnedAt: number;
  glance: CanopyGlance;
}

/** Canopy's local reader, as the status bar shows it. */
export interface CanopyReaderLink {
  /** The model's name, as Settings shows it. */
  model: string;
  /** Screens being read now. */
  inFlight: number;
  /** The mean time of the latest reads, in ms; null before the first. */
  readMs: number | null;
}

/**
 * One agent run the user closed on this host, whichever project it is in:
 * Canopy's Trash. A closed run has left the fleet, so it carries the run as
 * the host had it when it was closed: its name, agent and place, never its
 * state. Inside the trash's window its process lives on and Restore takes it
 * back; after it, the entry is `ended` and Restore resumes its session.
 */
export interface CanopyTrashEntry {
  run: FleetRunRow;
  trashedAt: number;
  /** When the trash lets it go; it also names which trash of the run this is. */
  expiresAt: number;
  /** The trash let its process go. Absent while the process lives on. */
  ended?: CanopyEndedTrash;
}

export interface CanopyEndedTrash {
  /** The worktree it ran in is gone, so there is nowhere to resume it. */
  worktreeRemoved?: boolean;
}

/**
 * What a restore from Canopy's Trash did. `runId` is the run to show now: the
 * same terminal put back, a pane already running the session, or a new one
 * resuming it. `open` means no view of the run's project is open on its host
 * to resume it in: the caller opens the project, as Go to terminal would, and
 * asks there.
 */
export type CanopyRestoreOutcome = { runId: string } | { open: { workspaceId: string } };

export interface CanopySnapshot {
  /**
   * Rises with every snapshot main hands out, pulled or pushed, so a view
   * never lets a late reply paint over a newer push.
   */
  sequence?: number;
  mode: CanopyMode;
  /** The plan's mode revision: see `CanopyPlan.modeRevision`. */
  modeRevision?: number;
  /** The plan's host epoch: see `CanopyPlan.hostEpoch`. */
  hostEpoch?: string;
  /** The user turned Canopy on; nothing is read until they do. */
  activated: boolean;
  /** The model and whether it is here; absent while Canopy is off. */
  model?: CanopyModelState;
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
  /** A scan or a reading is in flight. */
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
   * Reads are held up for a reason that passes, not yet reported as a
   * failure: a read is waiting to be tried again. Absent while nothing is held up.
   */
  waiting?: "retrying";
  /** The local reader; absent while Canopy is off. */
  reader?: CanopyReaderLink;
  /** Agent runs in this host's trash, any project's, newest first. Absent from older hosts. */
  trash?: CanopyTrashEntry[];
}

/**
 * The run an action is meant for: the terminal incarnation the panel showed,
 * so main refuses one respawned under the same id since. A host will join it
 * when runs on remote hosts are read too.
 */
export interface CanopyTarget {
  spawnedAt: number;
}

/** A trashed run an action is meant for: the incarnation, and which trash of it. */
export interface CanopyTrashTarget extends CanopyTarget {
  expiresAt: number;
}

/**
 * A run the panel's search asks about, with the words of the query nothing
 * else on the run held: main looks for them on its terminal, which never
 * leaves the machine it runs on.
 */
export interface CanopyScreenSearchTarget extends CanopyTarget {
  runId: string;
  terms: string[];
}

/**
 * A snapshot from a host on a Daintree from before Canopy read locally (#14448):
 * those always say a tier, and still send screens to the former hosted
 * service. A Shell shows none of their readings and offers to turn none on.
 */
export function readsWithHostedService(snapshot: CanopySnapshot): boolean {
  return "tier" in snapshot;
}

/**
 * What the triage panel says about each agent run, built in main from the run's
 * screen by a classifier pass (every run) and a describer pass (only the runs
 * that need the user).
 *
 * Everything here is derived from screen text and is a reading, not a fact:
 * the panel shows it beside the agent state Daintree observed, never instead of
 * it.
 */

/** The screen's current state, as the classifier read it. */
export type TriageCategory =
  "approval" | "question" | "finished" | "error" | "working" | "running" | "idle";

export const TRIAGE_CATEGORIES: readonly TriageCategory[] = [
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
 * it is never sent to the describer and never listed under "needs you",
 * whatever category it was given.
 */
export const TRIAGE_ATTENTION_THRESHOLD = 0.5;

/** Categories where the run is stopped until the user does something. */
export const TRIAGE_ATTENTION_CATEGORIES: ReadonlySet<TriageCategory> = new Set([
  "approval",
  "question",
  "finished",
  "error",
]);

export interface TriageCard {
  runId: string;
  /** The terminal incarnation the card was read from; ids are reused across respawns. */
  spawnedAt: number;
  /**
   * Bumped each time the run's screen really changes. Stable while a prompt
   * sits unanswered, so it identifies "this prompt" across re-reads and
   * describer refinements.
   */
  revision: number;
  category: TriageCategory;
  /** Classifier confidence in `category`, 0–1. */
  confidence: number;
  /** The classifier's probability that the terminal needs the user now, 0–1. */
  attentionProbability: number;
  /** The describer's 0–100 attention score; null until described. */
  attentionScore: number | null;
  /**
   * The two readings combined, 0–100, and the order the panel lists runs in.
   * Two independent models averaged, so one model's overreaction is damped by
   * the other.
   */
  priority: number;
  /** `described` once the describer has written the card's text. */
  stage: "classified" | "described";
  /** True while a describer pass for this run is in flight. */
  describing: boolean;
  /** At most ~10 words; null until described. */
  headline: string | null;
  /** At most ~25 words; null until described. */
  summary: string | null;
  /** The prompt the program is asking, verbatim from the screen. */
  question: string | null;
  /** Option labels for a menu or y/n prompt, verbatim, in screen order. */
  options: string[];
  /** The prompt asks for a secret; the panel must not offer an inline reply. */
  secretPrompt: boolean;
  /** The newest meaningful line on screen, verbatim. An observation, not a reading. */
  activity: string | null;
  /** When the screen this card was built from was read (epoch ms). */
  observedAt: number;
}

/** A terminal the triage panel is showing live: where its stream starts. */
export interface TriageTerminalView {
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
export type TriageTerminalData =
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

export interface TriageSnapshot {
  /** Both provider keys are present in main's environment. */
  configured: boolean;
  /** Names of the environment variables that are missing. */
  missingKeys: string[];
  /** A panel is open and main is watching screens. */
  active: boolean;
  /** A scan or a classifier/describer pass is in flight. */
  busy: boolean;
  /** When the last full scan finished (epoch ms). */
  refreshedAt: number | null;
  /** The describer model the cards are written by. */
  describerModel: string;
  cards: TriageCard[];
  /** The last provider failure, without any screen content. */
  lastError: string | null;
}

/**
 * The run an action is meant for: the terminal incarnation the panel showed,
 * so main refuses one respawned under the same id since. A host will join it
 * when runs on remote hosts are triaged too.
 */
export interface TriageTarget {
  spawnedAt: number;
}

/** The two provider keys the triage panel uses until it moves to Daintree's backend. */
export type TriageKeyId = "classifier" | "describer";

export interface TriageKeyStatus {
  /** `saved` in Daintree's encrypted store, or read from the environment it was started with. */
  source: "saved" | "environment" | "none";
  /** The key's last four characters, enough to recognise it by. Never the key. */
  hint: string | null;
}

export interface TriageKeysStatus {
  /** Whether a key can be saved at all: there must be an OS keychain to encrypt it with. */
  storage: "keychain" | "unavailable";
  keys: Record<TriageKeyId, TriageKeyStatus>;
}

export interface TriageKeyCheck {
  valid: boolean;
  error?: string;
}

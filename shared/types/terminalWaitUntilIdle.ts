import type { WaitingReason } from "./agent.js";

/**
 * Default wait is a bounded long-poll, not an open-ended block. A tool call
 * held open freezes an interactive Claude Code session (the user can't talk
 * to the assistant until it returns), so the default is sized for "wait a
 * beat, then return `timedOut: true` and let the agent re-poll or schedule a
 * wakeup" — the idiom agent harnesses already expect.
 */
export const DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS = 60 * 1000;
/**
 * Hard ceiling applied server-side to interactive help sessions regardless of
 * the requested `timeoutMs`. Headless/external (api-key) sessions are exempt
 * — a scripted one-shot flow blocking for hours is fine when no human is
 * waiting on the conversation.
 */
export const INTERACTIVE_WAIT_UNTIL_IDLE_TIMEOUT_CAP_MS = 60 * 1000;
export const MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Shared by the single and batched results so the two can never drift — they
 * carried verbatim copies of this union before, which typechecked fine while
 * silently desyncing.
 */
export type WaitUntilIdleIdleReason =
  "idle" | "waiting_for_user" | "completed" | "exited" | "unknown";

/** Literal values of {@link WaitUntilIdleIdleReason}, for the raw JSON schemas. */
export const WAIT_UNTIL_IDLE_IDLE_REASONS: readonly WaitUntilIdleIdleReason[] = [
  "idle",
  "waiting_for_user",
  "completed",
  "exited",
  "unknown",
];

/**
 * Whether a session is still tracked for this terminal, so a reconciler can
 * tell an agent that finished from one whose terminal is gone — both of which
 * report `busyState: "idle"` (#12339).
 *
 * Deliberately three values, not a boolean. `"closed"` is decisive (reap the
 * session); `"unknown"` is not (an id can be unknown because a poll raced the
 * spawn, or because another window replaced the store singleton), and
 * collapsing them would push a caller into guessing.
 *
 * Named for tracking, not liveness, because that is all this observes:
 * `"tracked"` means an agent-session mapping is still held. It is not a claim
 * that a panel is on screen, and a plain shell that never launched an agent is
 * `"unknown"` while being perfectly alive.
 *
 * Two known lags, both one call wide, because every arm is reported from what
 * main has processed so far rather than from a live probe:
 *
 * - A kill reaches main as two messages — the `idle` state change, then
 *   `agent:killed` — so a wait already in flight settles on the first and can
 *   answer `"tracked"` while the kill notice is still in transit. The next call
 *   reports `"closed"`.
 * - Restarting an agent in the same panel reuses the terminal id, and the
 *   record is only revived when main processes the new `agent:spawned`. A call
 *   landing in that window reports `"closed"` for a terminal that is coming
 *   back up.
 *
 * So `"closed"` means a kill was observed for this id and no spawn has been
 * seen since — not that the id can never be live again. Treat it as decisive
 * only where a restart under the same id is not in play, or confirm with a
 * second call. Closing either window means carrying the kill and the spawn
 * generation on the transition itself, which is a pty-host change.
 */
export type WaitUntilIdleTrackingState = "tracked" | "closed" | "unknown";

/** Literal values of {@link WaitUntilIdleTrackingState}, for the raw JSON schemas. */
export const WAIT_UNTIL_IDLE_TRACKING_STATES: readonly WaitUntilIdleTrackingState[] = [
  "tracked",
  "closed",
  "unknown",
];

// Carried on both wait tools, so every byte here is spent twice on the
// advertised surface — keep it to the three arms and what separates them.
const TRACKING_STATE_DESCRIPTION =
  "Separates an idle agent from a session that is gone: 'tracked' = a mapping is held, which is not proof of liveness or completion; 'closed' = a kill was observed; 'unknown' = no record kept (a plain shell, a poll that raced the spawn, or evicted history).";

export type WaitUntilIdleResult = {
  terminalId: string;
  agentId?: string;
  busyState: "working" | "idle";
  idleReason?: WaitUntilIdleIdleReason;
  /**
   * Distinguishes "the agent finished" from "this terminal is gone", which
   * both surface as `busyState: "idle"`. Always present.
   */
  trackingState: WaitUntilIdleTrackingState;
  /**
   * Only present when `idleReason === "waiting_for_user"`. Distinguishes a safe
   * auto-drive moment (`"prompt"` — empty input prompt) from an agent actively
   * asking the user a question (`"question"`).
   */
  waitingReason?: WaitingReason;
  previousBusyState?: "working" | "idle";
  lastTransitionAt?: number;
  /**
   * Numeric process exit code, present only when `idleReason` is `"completed"`
   * or `"exited"`. `null` when the process was terminated by a signal without a
   * numeric code. Lets a conductor verify a real success before gating an
   * irreversible follow-up action.
   */
  exitCode?: number | null;
  /**
   * Raw OS signal number that terminated the process, when applicable (present
   * only on completed/exited). No POSIX 128+signum decoding (wrong on Windows).
   */
  exitSignal?: number;
  timedOut: boolean;
};

export const WAIT_UNTIL_IDLE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    terminalId: {
      type: "string",
      description:
        "Identifies the terminal to watch, using a panel id from the terminal-listing capability. A closed or unknown id resolves immediately as idle rather than failing — read `trackingState` to tell that apart from an agent that is genuinely at rest.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 0,
      maximum: MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
      description: `Pass 0 for an immediate non-blocking snapshot — the recommended mode for status checks and parallel polling. Omitted, it long-polls for ${DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS / 1000}s and returns \`timedOut: true\` if the agent is still working — re-call to keep waiting. Interactive sessions are capped at ${INTERACTIVE_WAIT_UNTIL_IDLE_TIMEOUT_CAP_MS / 1000}s server-side (a longer block would freeze the conversation); headless sessions may block up to ${MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS / 60_000 / 60} hours.`,
    },
  },
  required: ["terminalId"],
  additionalProperties: false,
};

export const WAIT_UNTIL_IDLE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    terminalId: { type: "string" },
    agentId: { type: "string" },
    busyState: { type: "string", enum: ["working", "idle"] },
    idleReason: {
      type: "string",
      enum: [...WAIT_UNTIL_IDLE_IDLE_REASONS],
      description:
        "Why the terminal is not working: 'idle' at rest, 'waiting_for_user' blocked on input, 'completed' or 'exited' once the process ended, 'unknown' when the terminal is not tracked. Only the ended states carry an exit code.",
    },
    trackingState: {
      type: "string",
      enum: [...WAIT_UNTIL_IDLE_TRACKING_STATES],
      description: TRACKING_STATE_DESCRIPTION,
    },
    waitingReason: {
      type: "string",
      enum: ["prompt", "question", "approval", "error"],
      description:
        "Present only when idleReason is 'waiting_for_user'. 'prompt' = empty input prompt (safe to auto-drive); 'question' = agent is asking the user a question; 'approval' = a permission/approval selector needs a specific choice; 'error' = agent stopped after a blocking error (auth/rate limit/network/failed command).",
    },
    previousBusyState: { type: "string", enum: ["working", "idle"] },
    lastTransitionAt: { type: "number" },
    exitCode: {
      type: ["number", "null"],
      description:
        "Process exit code, present only when idleReason is 'completed' or 'exited'. null = signal-terminated with no numeric code.",
    },
    exitSignal: {
      type: "number",
      description:
        "OS signal number that terminated the process, when applicable (completed/exited only).",
    },
    timedOut: {
      type: "boolean",
      description:
        "True when the wait elapsed with the agent still working. Call again to keep waiting — it is not a failure.",
    },
  },
  required: ["terminalId", "busyState", "trackingState", "timedOut"],
};

export const WAIT_UNTIL_IDLE_DESCRIPTION =
  // Kept under the 400-byte tool-description budget (mcpWireBudget.test.ts).
  "Block until the agent in one terminal stops working, so the next step sees finished output. Use the batched wait for several terminals, or a status snapshot to poll without blocking. It can hold open for a minute interactively, far longer headless. Timing out is normal and means still working. A closed terminal also reads as idle, so check `trackingState` before trusting it.";

// === Batched wait (fan-out orchestration) ===

/** Upper bound on terminals a single batched wait may watch. Matches `terminal.getStatus`. */
export const MAX_WAIT_UNTIL_IDLE_BATCH_TERMINALS = 256;

/**
 * `"first"` resolves as soon as ANY watched terminal leaves `working` — the
 * fan-out primitive ("wake me when the first of my agents finishes so I can
 * dispatch its next step"). `"all"` resolves only once EVERY watched terminal is
 * non-working (a join barrier). Either way the call still returns early on the
 * timeout/abort, with `timedOut` flagging an unmet predicate.
 */
export type WaitUntilIdleBatchMode = "first" | "all";

export type WaitUntilIdleBatchEntry = {
  terminalId: string;
  agentId?: string;
  busyState: "working" | "idle";
  idleReason?: WaitUntilIdleIdleReason;
  /**
   * Same discriminator as the single-terminal result. Load-bearing here: a
   * closed row still reports `settled: true`, so this is the only thing that
   * separates it from an agent that genuinely finished.
   */
  trackingState: WaitUntilIdleTrackingState;
  waitingReason?: WaitingReason;
  previousBusyState?: "working" | "idle";
  lastTransitionAt?: number;
  exitCode?: number | null;
  exitSignal?: number;
  /**
   * True once this terminal left `working` (or was never working / untracked).
   *
   * Stays `true` for closed and unknown rows on purpose: it latches "this row
   * satisfied the wait", so `mode: "all"` cannot hang on a terminal that is
   * gone. It is not a claim that any work completed — read `trackingState` for
   * that — nor that nothing further can happen to the terminal, since a row
   * that settled while the batch was still running may close before it returns.
   */
  settled: boolean;
};

export type WaitUntilIdleBatchResult = {
  mode: WaitUntilIdleBatchMode;
  /** One entry per requested terminal, in request order (duplicates de-duped). */
  results: WaitUntilIdleBatchEntry[];
  /** Terminals that satisfied the wait (the settled subset). */
  settledTerminalIds: string[];
  /** True when the mode predicate (first/all) was NOT met before the wait ended. */
  timedOut: boolean;
};

export const WAIT_UNTIL_IDLE_BATCH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["first", "all"] },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          terminalId: { type: "string" },
          agentId: { type: "string" },
          busyState: { type: "string", enum: ["working", "idle"] },
          idleReason: {
            type: "string",
            enum: [...WAIT_UNTIL_IDLE_IDLE_REASONS],
          },
          trackingState: {
            type: "string",
            enum: [...WAIT_UNTIL_IDLE_TRACKING_STATES],
            description: TRACKING_STATE_DESCRIPTION,
          },
          waitingReason: { type: "string", enum: ["prompt", "question", "approval", "error"] },
          previousBusyState: { type: "string", enum: ["working", "idle"] },
          lastTransitionAt: { type: "number" },
          exitCode: { type: ["number", "null"] },
          exitSignal: { type: "number" },
          settled: {
            type: "boolean",
            description:
              "True once this row satisfied the wait. Gone terminals settle so the batch cannot hang; that is not a claim work completed, so read trackingState.",
          },
        },
        required: ["terminalId", "busyState", "trackingState", "settled"],
      },
    },
    settledTerminalIds: { type: "array", items: { type: "string" } },
    timedOut: { type: "boolean" },
  },
  required: ["mode", "results", "settledTerminalIds", "timedOut"],
};

export const WAIT_UNTIL_IDLE_BATCH_DESCRIPTION =
  "Block until the first of several agents stops working, or until all of them do; the fan-out primitive when agents finish at different speeds. Use this rather than waiting on each terminal in turn, or a status snapshot to poll without blocking. It can hold open for a minute interactively, far longer headless. Timing out means not met yet; a gone terminal settles too, so read `trackingState`.";

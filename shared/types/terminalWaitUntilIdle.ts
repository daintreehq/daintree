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

export type WaitUntilIdleResult = {
  terminalId: string;
  agentId?: string;
  busyState: "working" | "idle";
  idleReason?: "idle" | "waiting_for_user" | "completed" | "exited" | "unknown";
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
        "Identifies the terminal to watch, using a panel id from the terminal-listing capability. An id no longer tracked resolves immediately as idle with an unknown reason rather than failing.",
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
      enum: ["idle", "waiting_for_user", "completed", "exited", "unknown"],
      description:
        "Why the terminal is not working: 'idle' at rest, 'waiting_for_user' blocked on input, 'completed' or 'exited' once the process ended, 'unknown' when the terminal is not tracked. Only the ended states carry an exit code.",
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
  required: ["terminalId", "busyState", "timedOut"],
};

export const WAIT_UNTIL_IDLE_DESCRIPTION =
  "Block until the agent in one terminal stops working, so the next step sees finished output. Use the batched wait for several terminals, or a status snapshot to poll without blocking. It can hold open for a minute interactively, far longer headless. Timing out is normal and means still working; an exit code appears only once the process ends, so confirm success there before acting irreversibly.";

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
  idleReason?: "idle" | "waiting_for_user" | "completed" | "exited" | "unknown";
  waitingReason?: WaitingReason;
  previousBusyState?: "working" | "idle";
  lastTransitionAt?: number;
  exitCode?: number | null;
  exitSignal?: number;
  /** True once this terminal left `working` (or was never working / untracked). */
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
            enum: ["idle", "waiting_for_user", "completed", "exited", "unknown"],
          },
          waitingReason: { type: "string", enum: ["prompt", "question", "approval", "error"] },
          previousBusyState: { type: "string", enum: ["working", "idle"] },
          lastTransitionAt: { type: "number" },
          exitCode: { type: ["number", "null"] },
          exitSignal: { type: "number" },
          settled: { type: "boolean" },
        },
        required: ["terminalId", "busyState", "settled"],
      },
    },
    settledTerminalIds: { type: "array", items: { type: "string" } },
    timedOut: { type: "boolean" },
  },
  required: ["mode", "results", "settledTerminalIds", "timedOut"],
};

export const WAIT_UNTIL_IDLE_BATCH_DESCRIPTION =
  "Block until the first of several agents stops working, or until all of them do; the fan-out primitive when agents finish at different speeds. Use this rather than waiting on each terminal in turn, or a status snapshot to poll without blocking. It can hold the call open for a minute interactively, far longer headless. Timing out means not met yet; untracked terminals count as finished.";

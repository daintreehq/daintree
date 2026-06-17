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
      description: "Panel UUID returned by `terminal.list` (the `id` field).",
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
    },
    waitingReason: {
      type: "string",
      enum: ["prompt", "question"],
      description:
        "Present only when idleReason is 'waiting_for_user'. 'prompt' = empty input prompt (safe to auto-drive); 'question' = agent is asking the user a question.",
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
    timedOut: { type: "boolean" },
  },
  required: ["terminalId", "busyState", "timedOut"],
};

export const WAIT_UNTIL_IDLE_DESCRIPTION =
  "Check whether the agent in one terminal has left the working state, with an optional bounded wait. Args: `terminalId` is a panel UUID from `terminal.list` (the `id` field); `timeoutMs` is optional (0 = immediate non-blocking snapshot — the recommended mode; otherwise max ms to long-poll, default 60s). Returns { terminalId, busyState ('working'|'idle'), idleReason, waitingReason ('prompt'|'question', only while waiting_for_user), exitCode (number|null, only on 'completed'|'exited' — verify a real success before an irreversible follow-up), exitSignal (where available), timedOut }. `timedOut: true` means still working — re-call to keep waiting. Interactive sessions are capped at 60s server-side regardless of `timeoutMs`; headless sessions may block up to 2 hours. An untracked `terminalId` returns immediately as { busyState: 'idle', idleReason: 'unknown', timedOut: false }. Do NOT poll many terminals — use `terminal.getStatus` for fleet-wide state.";

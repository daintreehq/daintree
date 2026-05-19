import type { WaitingReason } from "./agent.js";

export const DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
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
      description: `Pass 0 for an immediate non-blocking snapshot — the recommended mode when polling multiple terminals in parallel. Otherwise, the maximum time to block in milliseconds; defaults to ${DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS} ms (${DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS / 60_000} minutes) and clamped to ${MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS} ms (${MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS / 60_000 / 60} hours).`,
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
    timedOut: { type: "boolean" },
  },
  required: ["terminalId", "busyState", "timedOut"],
};

export const WAIT_UNTIL_IDLE_DESCRIPTION =
  "Block until the agent in one terminal leaves the working state (or the timeout elapses), then return its resolved state. Args: `terminalId` is a panel UUID from `terminal.list` (the `id` field); `timeoutMs` is optional (0 = immediate non-blocking snapshot, otherwise max ms to block, default 30 minutes, clamped to 2 hours). Returns { terminalId, busyState ('working'|'idle'), idleReason, waitingReason ('prompt'|'question', present only while waiting_for_user), timedOut }. Errors when `terminalId` is unknown. Do NOT use this to poll many terminals — call `terminal.getStatus` for fleet-wide state, or pass timeoutMs:0 here for a single non-blocking check.";

/**
 * Native assistant-host protocol (#10649).
 *
 * Defines the typed boundary between a future `daintree-assistant` runtime
 * hosted as an Electron utility process and Daintree's main/renderer surfaces.
 * Today the assistant runs as a CLI/Ink child wrapped in an xterm pane, with
 * the only structured signals being the MCP-server events in `mcpServer.ts`
 * (tool-call started/settled, turn-outcome alerts, figure rail). This module
 * is the *contract* the native host will speak so conversation turns, tool
 * calls, and approvals can be rendered natively instead of scraped from
 * terminal bytes — without rebuilding Daintree's confirmation/audit surfaces.
 *
 * This file is intentionally runtime-free: it declares the message shapes and
 * the descriptor handed to the host at fork time. The CLI/Ink path stays the
 * default and fallback; nothing here wires a process. Runtime wiring is gated
 * on two unbuilt prerequisites called out in the issue — the workflow ledger
 * and the `@daintreehq/daintree-assistant` package emitting these structured
 * turn events — so the protocol lands first and the host plugs in later.
 *
 * Design rules baked into the shapes below:
 * - Every event and command carries `sessionId` so the main process can pin
 *   delivery to the WebContents that minted the session, never broadcast
 *   (lesson #7003).
 * - The descriptor handed to the host over `parentPort` carries no bearer
 *   token. The MCP URL and token reach the host through env vars
 *   (`DAINTREE_MCP_URL` / `DAINTREE_MCP_TOKEN` / `DAINTREE_WINDOW_ID`), mirroring
 *   the existing `daintree-assistant` env-only injection — so a leaked port
 *   message can never carry the secret.
 * - Outcome/result/decision fields reuse the audit-aligned vocabularies from
 *   `mcpServer.ts` so the native timeline and the audit log can never drift.
 */

import type {
  McpAuditResult,
  McpAuditSeverity,
  McpConfirmationDecision,
  TurnOutcomeClass,
} from "./mcpServer.js";

/**
 * Wire-format version for the host↔Daintree protocol. Bumped on any breaking
 * change to {@link AssistantHostEvent} or {@link AssistantHostCommand}. The
 * host announces the version it speaks in `host:ready`; Daintree refuses a
 * mismatch rather than guessing at an unknown shape.
 */
export const ASSISTANT_HOST_PROTOCOL_VERSION = 1;

/** Author of a conversation turn in the native timeline. */
export type AssistantTurnRole = "user" | "assistant";

/**
 * Non-secret session descriptor handed to the assistant host process at fork
 * time over `parentPort`. Deliberately excludes the bearer token and MCP URL —
 * those reach the host through environment variables, never a structured
 * message, so the descriptor stays safe to log and forward.
 */
export interface AssistantHostSessionDescriptor {
  /** Stable help-session id minted by `HelpSessionService` at provision. */
  sessionId: string;
  /** Owning window; correlates to the pinned `WebContents` for delivery. */
  windowId: number;
  /** Project the assistant is bound to for this session. */
  projectId: string;
  /** Working directory the runtime starts in (the bound worktree path). */
  cwd: string;
  /** Source-tier classification of the session's MCP connection. */
  tier: string;
  /** Protocol version Daintree expects the host to speak. */
  protocolVersion: number;
  /**
   * Resume handle captured at the prior hibernation, if this descriptor is
   * re-spawning a hibernated session. Absent for a cold start.
   */
  resumeSessionId?: string;
}

// ============================================================================
// Host → Daintree events
// ============================================================================

/** Host has booted, connected to the MCP server, and is ready for commands. */
export interface AssistantHostReadyEvent {
  type: "host:ready";
  sessionId: string;
  /** Protocol version the host actually speaks. */
  protocolVersion: number;
  /** Resume handle the runtime adopted, echoed back for correlation. */
  resumedSessionId?: string;
}

/** A new conversation turn began. */
export interface AssistantTurnStartEvent {
  type: "turn:start";
  sessionId: string;
  turnId: string;
  role: AssistantTurnRole;
  startedAt: number;
}

/**
 * An incremental text chunk for an in-flight `assistant` turn. Streamed
 * frequently; consumers should accumulate into the active turn's buffer and
 * avoid placing per-token state in a global store (re-render cost).
 */
export interface AssistantTurnTokenEvent {
  type: "turn:token";
  sessionId: string;
  turnId: string;
  chunk: string;
}

/** A conversation turn completed. */
export interface AssistantTurnEndEvent {
  type: "turn:end";
  sessionId: string;
  turnId: string;
  endedAt: number;
  /** Audit-aligned classification of how the turn resolved, when known. */
  outcome?: TurnOutcomeClass;
}

/**
 * A tool dispatch entered the call path. Shape mirrors
 * `McpToolCallStartedPayload` plus a stable `toolCallId` so the native
 * timeline can correlate the matching settle event without racing on `toolId`.
 */
export interface AssistantToolStartedEvent {
  type: "tool:started";
  sessionId: string;
  toolCallId: string;
  toolId: string;
  argsSummary: string;
  startedAt: number;
  turnId?: string;
  danger: boolean;
}

/** A tool dispatch settled. Carries audit-aligned outcome fields. */
export interface AssistantToolSettledEvent {
  type: "tool:settled";
  sessionId: string;
  toolCallId: string;
  toolId: string;
  durationMs: number;
  result: McpAuditResult;
  severity: McpAuditSeverity;
  errorCode?: string;
  turnId?: string;
}

/**
 * The runtime is awaiting a user decision for a `danger: "confirm"` dispatch.
 * Daintree surfaces this through its existing `ConfirmDialog`, then answers
 * with an `approval:decide` command — the host never renders its own modal.
 */
export interface AssistantApprovalRequestedEvent {
  type: "approval:requested";
  sessionId: string;
  approvalId: string;
  toolId: string;
  /** Redacted, single-level summary of what the tool will do. */
  summary: string;
  requestedAt: number;
  turnId?: string;
}

/** A previously requested approval was resolved (by user or timeout). */
export interface AssistantApprovalDecidedEvent {
  type: "approval:decided";
  sessionId: string;
  approvalId: string;
  decision: McpConfirmationDecision;
  decidedAt: number;
}

/** The host hit a non-fatal error it wants surfaced to the user. */
export interface AssistantHostErrorEvent {
  type: "host:error";
  sessionId: string;
  /** Stable, machine-readable failure code. */
  code: string;
  message: string;
}

/** The host is shutting down (graceful hibernate, revoke, or crash drain). */
export interface AssistantHostShutdownEvent {
  type: "host:shutdown";
  sessionId: string;
  reason: AssistantHostShutdownReason;
  /** Resume handle captured for a later cold re-spawn, when hibernating. */
  resumeSessionId?: string;
}

export type AssistantHostShutdownReason = "hibernate" | "revoke" | "error" | "exit";

/**
 * Discriminated union of every message the host pushes to Daintree. The main
 * process validates each against the Zod schema before forwarding to the
 * pinned renderer.
 */
export type AssistantHostEvent =
  | AssistantHostReadyEvent
  | AssistantTurnStartEvent
  | AssistantTurnTokenEvent
  | AssistantTurnEndEvent
  | AssistantToolStartedEvent
  | AssistantToolSettledEvent
  | AssistantApprovalRequestedEvent
  | AssistantApprovalDecidedEvent
  | AssistantHostErrorEvent
  | AssistantHostShutdownEvent;

export type AssistantHostEventType = AssistantHostEvent["type"];

// ============================================================================
// Daintree → host commands
// ============================================================================

/** Submit a user prompt to start a new turn. */
export interface AssistantPromptCommand {
  type: "prompt";
  sessionId: string;
  text: string;
}

/** Answer an outstanding `approval:requested` event. */
export interface AssistantApprovalDecideCommand {
  type: "approval:decide";
  sessionId: string;
  approvalId: string;
  decision: McpConfirmationDecision;
}

/** Interrupt the in-flight turn (user pressed stop). */
export interface AssistantInterruptCommand {
  type: "interrupt";
  sessionId: string;
}

/** Capture a resume handle and wind the runtime down for hibernation. */
export interface AssistantHibernateCommand {
  type: "hibernate";
  sessionId: string;
}

/** Tear the runtime down for good (session revoked / project closed). */
export interface AssistantShutdownCommand {
  type: "shutdown";
  sessionId: string;
}

/**
 * Discriminated union of every control message Daintree sends the host. The
 * session descriptor is handed over at fork time, not as a command, so these
 * are all post-handshake control signals.
 */
export type AssistantHostCommand =
  | AssistantPromptCommand
  | AssistantApprovalDecideCommand
  | AssistantInterruptCommand
  | AssistantHibernateCommand
  | AssistantShutdownCommand;

export type AssistantHostCommandType = AssistantHostCommand["type"];

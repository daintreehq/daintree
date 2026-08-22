/**
 * Native assistant-host protocol, version 3.
 *
 * The typed boundary between the Daintree Assistant engine — the Go binary vendored
 * at `vendor/daintree-assistant` — and Daintree's main/renderer surfaces. The engine
 * is headless: Daintree spawns it as `daintree-assistant host --stdio` and renders
 * the entire conversation natively in React.
 *
 * ## Why v3 and not v1
 *
 * This file previously described v1: an npm package (`@daintreehq/daintree-assistant`)
 * whose `dist/host.js` would be run by `utilityProcess.fork()` and driven with
 * structured-clone `postMessage`. All three of those are wrong now. The engine is a Go
 * binary (so `utilityProcess.fork`, which runs a Node script, cannot execute it), and
 * the transport is stdio NDJSON. The engine moved to v2 for the framing change and
 * v3 for the semantics below; Daintree's half stayed at v1 as dead code and drifted.
 *
 * That drift is the reason this file now says, loudly, what the contract is. The
 * engine's `internal/host/wire.go` is the other half and the two MUST move together:
 * {@link ASSISTANT_HOST_PROTOCOL_VERSION} equals its `ProtocolVersion`, and the engine
 * refuses a descriptor whose version it does not recognise.
 *
 * ## What v3 changed
 *
 * v2 described a TERMINAL SESSION for a parent that drew an activity strip beside an
 * xterm. v3 describes a CONVERSATION for a parent that renders the whole thing:
 *
 * 1. **Every event carries a monotonic `seq`.** v2 dropped frames silently when its
 *    writer queue filled — survivable for a strip, not for a transcript. The engine
 *    now applies backpressure to stream traffic, and any residual gap is visible in
 *    `seq` instead of invisible. A consumer that sees a gap knows its transcript is
 *    incomplete and can say so rather than presenting corrupted prose as the answer.
 * 2. **`turn:end` carries the authoritative FINAL-ROUND `content`.** Accumulate
 *    `turn:token` for liveness, then replace the LAST prose segment with this. A lost
 *    token frame self-heals instead of leaving mangled text on screen forever.
 *
 *    It is the final round, not the whole turn: the engine hands `AssistantEnd` the
 *    last message's content, so any prose the model produced before it called a tool
 *    is not in here. A consumer that replaces the whole turn with it deletes the part
 *    that explains why the tool was called.
 * 3. **The event set covers what the runtime actually produces** — phase, reasoning,
 *    interjections, the whole tool batch, tool state and progress, usage, cost and
 *    notices — instead of the subset an activity strip needed.
 *
 * ## Design rules baked into the shapes below
 *
 * - Every event and command carries `sessionId` so the main process can pin delivery
 *   to the WebContents that minted the session, never broadcast (lesson #7003).
 * - The descriptor handed to the engine carries NO bearer token. The MCP URL and
 *   token reach it through `DAINTREE_MCP_URL` / `DAINTREE_MCP_TOKEN` /
 *   `DAINTREE_WINDOW_ID`, so a leaked descriptor can never carry the secret.
 * - Outcome/result/decision fields reuse the audit-aligned vocabularies from
 *   `mcpServer.ts`, so the native timeline and the audit log cannot drift.
 */

import type {
  McpAuditResult,
  McpAuditSeverity,
  McpConfirmationDecision,
  TurnOutcomeClass,
} from "./mcpServer.js";

/**
 * Wire-format version. MUST equal `ProtocolVersion` in the engine's
 * `internal/host/wire.go`. Daintree sends it in the session descriptor and the engine
 * refuses a mismatch rather than guessing at an unknown shape.
 */
export const ASSISTANT_HOST_PROTOCOL_VERSION = 3;

/** Author of a conversation turn in the native timeline. */
export type AssistantTurnRole = "user" | "assistant";

/**
 * Non-secret session descriptor sent as the FIRST line on the engine's stdin, before
 * any command. Deliberately excludes the bearer token and MCP URL — those travel as
 * environment variables, never as a structured message.
 */
export interface AssistantHostSessionDescriptor {
  /** Stable help-session id minted by `HelpSessionService` at provision. */
  sessionId: string;
  /** Owning window; correlates to the pinned `WebContents` for delivery. */
  windowId: number;
  /** Project the assistant is bound to for this session. */
  projectId: string;
  /** Working directory the engine starts in (the project root). */
  cwd: string;
  /** Source-tier classification of the session's MCP connection. */
  tier: string;
  /** Protocol version Daintree expects the engine to speak. */
  protocolVersion: number;
  /** Resume handle from a prior hibernation. Absent for a cold start. */
  resumeSessionId?: string;
}

// ============================================================================
// Engine → Daintree events
// ============================================================================

/**
 * Fields every event carries. `seq` is monotonic from 1 across the whole session; see
 * the v3 notes above for why a consumer should track it.
 */
interface AssistantHostEventBase {
  sessionId: string;
  seq: number;
}

/** Engine has booted, connected to MCP, and is ready for commands. */
export interface AssistantHostReadyEvent extends AssistantHostEventBase {
  type: "host:ready";
  /** Protocol version the engine actually speaks. */
  protocolVersion: number;
  /** Resume handle the engine adopted, echoed back for correlation. */
  resumedSessionId?: string;
  /** Engine build string — distinct from the protocol version, and what a
   *  "your assistant is out of date" prompt or a bug report keys on. */
  version?: string;
  /** True when this session runs mutating tools with NO confirmation prompt
   *  (`DAINTREE_ASSISTANT_AUTO_APPROVE`). Surface it: approvals being switched off is
   *  exactly the state a user most needs to be able to see. */
  autoApprove: boolean;
  /**
   * Masthead facts, resolved by the ENGINE (internal/host/masthead.go).
   *
   * Each is a policy judgement that depends on constants the engine owns — which
   * backend URL counts as "the deployed one", what the local endpoint is called, which
   * routing policy is the default, what a tier permits. Re-deriving them here would
   * mean a second copy of all of it, wrong the first time any of it changes. Absent
   * means "the default, which needs no announcement" — except `logFile`, where absent
   * means debug logging is off.
   */
  tier?: string;
  /** Plain-language reading of `tier`, e.g. "terminals, projects, external". */
  tierGloss?: string;
  /** A NON-DEFAULT backend endpoint, already named and sanitized. */
  backend?: string;
  /** A NON-DEFAULT endpoint-routing policy, as one compact line. */
  routing?: string;
  /** Absolute path of this session's debug log. The engine picks the filename, so
   *  nothing outside the engine can work it out. */
  logFile?: string;
  /**
   * The command set this engine accepts.
   *
   * Sent by the engine rather than hardcoded here: a host with its own list drifts the
   * first time a command is added or renamed, and offers the user something the engine
   * will refuse.
   */
  commands?: AssistantCommandMeta[];
}

/** One entry in the engine's command catalog. */
export interface AssistantCommandMeta {
  name: string;
  syntax: string;
  palette: string;
}

/**
 * Whether the Daintree control plane is reachable.
 *
 * Emitted at boot and again after anything that may reconnect it. The engine being up
 * says nothing about whether it can act: a session that answers questions but cannot
 * spawn an agent, under a status line reading "Connected", is the most misleading
 * state this protocol can produce.
 */
export interface AssistantMcpStatusEvent extends AssistantHostEventBase {
  type: "mcp:status";
  connected: boolean;
  /** Absent until the tool catalog has been fetched. */
  toolCount?: number;
  /** Why it is not connected, when there is a reason. */
  error?: string;
}

/**
 * The output of a slash command the host routed through the engine.
 *
 * Commands are not conversation. `/status` sent as a prompt produces an answer about
 * the WORD status, spends a turn doing it, and leaves the user believing they ran
 * something — so recognized slash input goes through `command`, never `prompt`.
 */
export interface AssistantCommandResultEvent extends AssistantHostEventBase {
  type: "command:result";
  command: string;
  text: string;
  /** The command asked the session to end (`/quit`). */
  quit?: boolean;
  /** Looked like a command but names none that exists. */
  unknown?: boolean;
  turnId?: string;
}

/** One labelled choice in a question. The label is engine-assigned. */
export interface AssistantQuestionOption {
  label: string;
  text: string;
}

/**
 * The model asked the user a multiple-choice question and the turn is BLOCKED until
 * the host answers with `question:answer` naming this `questionId`.
 *
 * Labels (A, B, C…) come from the engine so every surface shows the same letter for
 * the same option, and so the model never spells them itself.
 */
export interface AssistantQuestionRequestedEvent extends AssistantHostEventBase {
  type: "question:requested";
  questionId: string;
  toolCallId?: string;
  turnId?: string;
  question: string;
  options: AssistantQuestionOption[];
  /** 0-based index highlighted first. */
  default: number;
  requestedAt: number;
}

/** A question settled. `index` is -1 when it was dismissed without choosing. */
export interface AssistantQuestionAnsweredEvent extends AssistantHostEventBase {
  type: "question:answered";
  questionId: string;
  turnId?: string;
  index: number;
  label?: string;
  text?: string;
}

/** A new conversation turn began. */
export interface AssistantTurnStartEvent extends AssistantHostEventBase {
  type: "turn:start";
  turnId: string;
  role: AssistantTurnRole;
  startedAt: number;
}

/**
 * An incremental text chunk for an in-flight assistant turn. Streamed frequently —
 * accumulate into the active turn's buffer, coalesce per animation frame, and keep
 * per-token state out of any global store.
 */
export interface AssistantTurnTokenEvent extends AssistantHostEventBase {
  type: "turn:token";
  turnId: string;
  chunk: string;
}

/**
 * A conversation turn completed.
 *
 * `content` is AUTHORITATIVE for the FINAL ROUND: replace the last prose segment with
 * it, not the whole turn — see the note at the top of this file. It is
 * absent (not `""`) when the turn produced no visible text at all — a cancel before
 * the first token, or a tool-only round — so "nothing was said" stays distinguishable
 * from "the answer was empty".
 */
export interface AssistantTurnEndEvent extends AssistantHostEventBase {
  type: "turn:end";
  turnId: string;
  endedAt: number;
  outcome?: TurnOutcomeClass;
  content?: string;
}

/**
 * The explicit run lifecycle. Render liveness from THIS, never from "has any token
 * arrived yet" — that heuristic is what the phase vocabulary exists to replace.
 */
export interface AssistantTurnPhaseEvent extends AssistantHostEventBase {
  type: "turn:phase";
  turnId?: string;
  phase: string;
}

/** The model's reasoning for the round, delivered whole just before `turn:end`. */
export interface AssistantTurnReasoningEvent extends AssistantHostEventBase {
  type: "turn:reasoning";
  turnId: string;
  text: string;
}

/**
 * A message the user typed WHILE the turn was running, reported at the moment the
 * engine folded it into history. Daintree sent the text, but only the engine knows
 * when it landed — and a transcript that places the steer wrongly misrepresents what
 * the model actually saw when it answered.
 */
export interface AssistantTurnInterjectionEvent extends AssistantHostEventBase {
  type: "turn:interjection";
  turnId?: string;
  text: string;
}

/** One entry in a `tool:batch` announcement. */
export interface AssistantBatchedCall {
  toolCallId: string;
  toolId: string;
  argsSummary: string;
  danger: boolean;
}

/**
 * The whole tool batch, announced as queued before sequential dispatch begins.
 * Without it a UI can only reveal calls one at a time as each starts, which reads as
 * the assistant improvising rather than working through a plan it already made.
 */
export interface AssistantToolBatchEvent extends AssistantHostEventBase {
  type: "tool:batch";
  turnId?: string;
  calls: AssistantBatchedCall[];
}

/** Lifecycle of one announced call. */
/**
 * Lifecycle of one announced call.
 *
 * "waiting" means blocked on the USER. "cancelled" and "not-run" are the terminal
 * states an interrupt produces: a call that WAS running versus one announced but never
 * started. Both exist because a stopped turn must not leave rows describing work that
 * is not happening, and because the difference tells a reader what the stop actually
 * interrupted.
 */
export type AssistantToolState =
  "queued" | "active" | "waiting" | "done" | "failed" | "cancelled" | "not-run";

/**
 * Promotes one announced call. `waiting` is the load-bearing value: it means blocked
 * on the USER, not on the tool. Rendering it as ordinary progress leaves someone
 * watching a spinner that is waiting for their own unanswered approval.
 */
export interface AssistantToolStateEvent extends AssistantHostEventBase {
  type: "tool:state";
  toolCallId: string;
  state: AssistantToolState;
  turnId?: string;
}

/**
 * An in-tool substep ("launching terminal") so a long call does not look frozen.
 * `message` is `""` when a beat carries only liveness — keep the prior message rather
 * than blanking the row.
 */
export interface AssistantToolProgressEvent extends AssistantHostEventBase {
  type: "tool:progress";
  toolCallId: string;
  message: string;
  turnId?: string;
}

/** A tool dispatch entered the call path. */
export interface AssistantToolStartedEvent extends AssistantHostEventBase {
  type: "tool:started";
  toolCallId: string;
  toolId: string;
  argsSummary: string;
  startedAt: number;
  turnId?: string;
  danger: boolean;
}

/**
 * A tool dispatch settled.
 *
 * `asyncId` marks an ACCEPTED-but-still-running background operation: the call
 * settled, the work continues. Never render it as a finished success.
 */
export interface AssistantToolSettledEvent extends AssistantHostEventBase {
  type: "tool:settled";
  toolCallId: string;
  toolId: string;
  durationMs: number;
  result: McpAuditResult;
  severity: McpAuditSeverity;
  errorCode?: string;
  turnId?: string;
  asyncId?: string;
  /**
   * The tool's OWN human line for what it did ("Pushed 3 commits to origin/main").
   *
   * Engine-authored and redacted on the way out — never raw arguments — and it is what
   * the terminal cockpit showed in place of a bare tool id. Without it a panel can only
   * display the identifier and hope the reader knows what it means.
   */
  /**
   * Names the work an accepted async call handed off ("migrate the schema in wt_db").
   *
   * Present only alongside `asyncId`. The completion arrives later as its own wake
   * turn, never as a late result for this call, so this is the only chance to say WHAT
   * is running rather than only that something is.
   */
  asyncTitle?: string;
  summary?: string;
  /** The human sentence behind `errorCode`. A code alone says something failed, not what. */
  errorMessage?: string;
}

/**
 * Per-round token accounting. `contextTokens` against `contextWindow` drives a
 * context meter and `contextThreshold` is where auto-compaction fires — none of which
 * Daintree can compute for itself. Optional fields are absent when the provider
 * reported nothing; show "no data", never a misleading zero.
 */
export interface AssistantUsageEvent extends AssistantHostEventBase {
  type: "usage";
  turnId?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  cacheHitRatio?: number;
  contextTokens: number;
  contextThreshold: number;
  contextWindow: number;
}

/**
 * What the session has spent, in the provider's own figures.
 *
 * Two rules that must not be flattened, because getting either wrong under-reports
 * spend while looking like a receipt: `complete: false` means `total` is a FLOOR (a
 * call ran whose cost could not be measured), and an ABSENT cost event means unknown,
 * never free. Render an incomplete total as "≥ $x".
 */
export interface AssistantCostEvent extends AssistantHostEventBase {
  type: "cost";
  turnId?: string;
  total: number;
  complete: boolean;
}

/** A non-fatal notice the engine wants surfaced (a repeating tool failure, a pinned
 *  skill the backend could not honour, a degraded MCP connection). */
export interface AssistantNoticeEvent extends AssistantHostEventBase {
  type: "notice";
  level: "info" | "warning";
  message: string;
  turnId?: string;
}

/** The provider throttled us after the retry budget was exhausted. A health cue that
 *  clears on the next usage event — not a turn failure. */
export interface AssistantModelRateLimitedEvent extends AssistantHostEventBase {
  type: "model:rate-limited";
  turnId?: string;
}

/**
 * The engine is awaiting a decision for a dangerous dispatch.
 *
 * `needsTypedConfirm` is the SAFETY LAYER'S OWN verdict that the action is
 * irreversible and must not be approvable by a click. Honour it; do not re-derive it
 * from `riskClass`. Re-deriving forks a security rule into a second codebase where it
 * can drift silently and permissively.
 */
export interface AssistantApprovalRequestedEvent extends AssistantHostEventBase {
  type: "approval:requested";
  approvalId: string;
  toolId: string;
  /** Redacted, single-level summary of what the tool will do. */
  summary: string;
  requestedAt: number;
  turnId?: string;
  riskClass?: string;
  consequence?: string;
  argsSummary?: string;
  needsTypedConfirm: boolean;
}

/** A previously requested approval resolved (by user or timeout). */
export interface AssistantApprovalDecidedEvent extends AssistantHostEventBase {
  type: "approval:decided";
  approvalId: string;
  decision: McpConfirmationDecision;
  decidedAt: number;
}

/** The engine hit a non-fatal error it wants surfaced. */
export interface AssistantHostErrorEvent extends AssistantHostEventBase {
  type: "host:error";
  code: string;
  message: string;
}

export type AssistantHostShutdownReason = "hibernate" | "revoke" | "error" | "exit";

/**
 * The engine is winding down. Emitted FIRST in teardown, and the engine drains its
 * writer queue before sending it — so this is genuinely the last event of the session
 * rather than one that overtook the tail of the turn.
 */
export interface AssistantHostShutdownEvent extends AssistantHostEventBase {
  type: "host:shutdown";
  reason: AssistantHostShutdownReason;
  resumeSessionId?: string;
}

/** Discriminated union of every message the engine pushes to Daintree. */
export type AssistantHostEvent =
  | AssistantHostReadyEvent
  | AssistantTurnStartEvent
  | AssistantTurnTokenEvent
  | AssistantTurnEndEvent
  | AssistantTurnPhaseEvent
  | AssistantTurnReasoningEvent
  | AssistantTurnInterjectionEvent
  | AssistantToolBatchEvent
  | AssistantToolStateEvent
  | AssistantToolProgressEvent
  | AssistantToolStartedEvent
  | AssistantToolSettledEvent
  | AssistantUsageEvent
  | AssistantCostEvent
  | AssistantNoticeEvent
  | AssistantCommandResultEvent
  | AssistantMcpStatusEvent
  | AssistantQuestionRequestedEvent
  | AssistantQuestionAnsweredEvent
  | AssistantModelRateLimitedEvent
  | AssistantApprovalRequestedEvent
  | AssistantApprovalDecidedEvent
  | AssistantHostErrorEvent
  | AssistantHostShutdownEvent;

export type AssistantHostEventType = AssistantHostEvent["type"];

// ============================================================================
// Daintree → engine commands
// ============================================================================

/**
 * Submit a user prompt.
 *
 * Sending one while a turn is already running is not an error and not a queued second
 * turn: the engine folds it into the RUNNING turn at the next tool-iteration boundary
 * and reports it back as `turn:interjection`. That is how a user steers work in
 * flight, so a UI should keep the composer live during a turn rather than disabling it.
 */
export interface AssistantPromptCommand {
  type: "prompt";
  sessionId: string;
  text: string;
}

/** Answer an outstanding `approval:requested`. */
export interface AssistantApprovalDecideCommand {
  type: "approval:decide";
  sessionId: string;
  approvalId: string;
  decision: McpConfirmationDecision;
}

/** Run a slash command. The engine answers with `command:result`. */
export interface AssistantCommandCommand {
  type: "command";
  sessionId: string;
  /** The raw slash line, e.g. "/status". */
  line: string;
}

/**
 * Answer an outstanding `question:requested`.
 *
 * `index` is -1 to DISMISS without choosing. There is deliberately no "default"
 * answer the host can send blind: answering on the user's behalf is the one thing a
 * question surface must never do.
 */
export interface AssistantQuestionAnswerCommand {
  type: "question:answer";
  sessionId: string;
  questionId: string;
  index: number;
}

/** Interrupt the in-flight turn (user pressed stop). */
export interface AssistantInterruptCommand {
  type: "interrupt";
  sessionId: string;
}

/** Capture a resume handle and wind the engine down for hibernation. */
export interface AssistantHibernateCommand {
  type: "hibernate";
  sessionId: string;
}

/** Tear the engine down for good (session revoked / project closed). */
export interface AssistantShutdownCommand {
  type: "shutdown";
  sessionId: string;
}

/** Discriminated union of every control message Daintree sends the engine. The
 *  session descriptor is handed over at spawn time, not as a command, so these are
 *  all post-handshake signals. */
export type AssistantHostCommand =
  | AssistantPromptCommand
  | AssistantApprovalDecideCommand
  | AssistantQuestionAnswerCommand
  | AssistantCommandCommand
  | AssistantInterruptCommand
  | AssistantHibernateCommand
  | AssistantShutdownCommand;

export type AssistantHostCommandType = AssistantHostCommand["type"];

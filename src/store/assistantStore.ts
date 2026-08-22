import { create } from "zustand";
import type {
  AssistantCommandMeta,
  AssistantHostEvent,
  AssistantToolState,
} from "@shared/types/ipc/assistantHost";
import type { McpAuditSeverity, TurnOutcomeClass } from "@shared/types/ipc/mcpServer";

/**
 * Renderer-side model of an assistant session, built by reducing the host event
 * stream (protocol v3).
 *
 * This is a plain Zustand store rather than a chat-UI library on purpose. The
 * objects that matter here — tool calls with risk classes, approvals that may demand
 * a typed phrase, a context meter, spend — are Daintree's domain, not generic
 * chat-with-tools. Adopting a library's message model would make those second-class
 * `data-*` parts fighting an abstraction built for something else, and would pull in
 * component styling that fights the theme system.
 *
 * ## Ordering and authority
 *
 * Events arrive in `seq` order over one pipe. Two rules keep the transcript honest:
 *
 * 1. `turn:token` is LIVENESS, `turn:end.content` is AUTHORITY. Tokens are
 *    accumulated for streaming, then replaced wholesale when the turn ends. A frame
 *    lost to backpressure therefore self-heals instead of leaving mangled prose.
 * 2. A `seq` gap means the transcript is incomplete. It is recorded and surfaced
 *    rather than absorbed — showing a partial answer as if it were the whole one is
 *    worse than admitting the loss.
 */

/** A tool call as the transcript knows it. */
export interface AssistantToolCall {
  toolCallId: string;
  toolId: string;
  argsSummary: string;
  danger: boolean;
  state: AssistantToolState;
  /** Latest in-tool substep; kept when a progress beat carries only liveness. */
  progress?: string;
  startedAt?: number;
  durationMs?: number;
  severity?: McpAuditSeverity;
  errorCode?: string;
  /** Set when the call was accepted but the work continues in the background. */
  asyncId?: string;
  /** Names the background work an accepted async call handed off. */
  asyncTitle?: string;
  /** The tool's own human line for what it did. */
  summary?: string;
  /** The human sentence behind `errorCode`. */
  errorMessage?: string;
}

/** An approval the engine is parked on. */
export interface AssistantApproval {
  approvalId: string;
  toolId: string;
  summary: string;
  consequence?: string;
  argsSummary?: string;
  riskClass?: string;
  /** The safety layer's own verdict. Never re-derive this from riskClass. */
  needsTypedConfirm: boolean;
  requestedAt: number;
}

/**
 * One ordered piece of a turn.
 *
 * A turn is a SEQUENCE — prose, then a batch of tools, then more prose reacting to
 * their results, with mid-turn steers wherever the engine folded them in. Storing a
 * turn as one text blob plus a flat list of tool ids threw that order away, so the
 * panel always drew tools first and prose last no matter what actually happened, and
 * a turn that explained itself before acting read as if it had acted in silence.
 */
export type AssistantTurnSegment =
  | { kind: "text"; text: string }
  | { kind: "tools"; toolCallIds: string[] }
  | { kind: "interjection"; text: string };

export interface AssistantTurn {
  turnId: string;
  role: "user" | "assistant";
  startedAt: number;
  endedAt?: number;
  /**
   * The turn in the order it happened.
   *
   * Segments are cut by ARRIVAL: tokens extend the open text segment, a tool batch
   * closes it and opens a tool segment, and the next token opens a fresh one. That is
   * exactly the engine's round structure, which is why no extra protocol is needed to
   * reconstruct it.
   */
  segments: AssistantTurnSegment[];
  /**
   * The turn's prose, joined across segments.
   *
   * Kept for callers that want the whole answer as one string (copy, search, a user
   * turn's single message). The panel renders from `segments`.
   */
  text: string;
  reasoning?: string;
  outcome?: TurnOutcomeClass;
  /** Tool calls in the order they were announced. */
  toolCallIds: string[];
  /** Mid-turn steers, at the point the engine folded them in. */
  interjections: string[];
  /** True once turn:end arrived — drives the streaming caret. */
  complete: boolean;
}

export interface AssistantNotice {
  id: string;
  level: "info" | "warning" | "error";
  message: string;
  at: number;
  /**
   * The turn this notice belongs to, when the engine attributed it to one.
   *
   * Carried so a notice can be drawn WHERE IT HAPPENED. The cockpit rendered these as
   * standalone transcript cells in sequence; dropping the id forced them into an
   * undated footer strip instead, which is how a retry storm — the engine warns once
   * per round that it is replaying a turn — reached a user as an unexplained run of
   * repeated tool calls.
   */
  turnId: string | null;
}

/** An outstanding multiple-choice question. The turn is blocked until it settles. */
export interface AssistantQuestion {
  questionId: string;
  turnId: string | null;
  toolCallId: string | null;
  question: string;
  options: { label: string; text: string }[];
  /** 0-based index to highlight first. */
  defaultIndex: number;
  requestedAt: number;
}

/** A settled question, kept so the transcript records what was chosen. */
export interface AssistantAnsweredQuestion {
  questionId: string;
  turnId: string | null;
  question: string;
  /** -1 when dismissed without choosing. */
  index: number;
  label: string | null;
  text: string | null;
}

export interface AssistantUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  cacheHitRatio?: number;
  contextTokens: number;
  contextThreshold: number;
  contextWindow: number;
}

export interface AssistantCost {
  total: number;
  /** false ⇒ `total` is a FLOOR. Render "≥ $x", never as a settled figure. */
  complete: boolean;
}

export type AssistantConnectionState = "idle" | "starting" | "ready" | "error" | "stopped";

export interface AssistantSessionState {
  sessionId: string | null;
  connection: AssistantConnectionState;
  /** Engine build, from host:ready. Distinct from the protocol version. */
  engineVersion: string | null;
  /** Engine-resolved masthead facts (see AssistantHostReadyEvent). */
  tier: string | null;
  tierGloss: string | null;
  backend: string | null;
  routing: string | null;
  logFile: string | null;
  /**
   * Why this session has no Daintree control plane, or null when it has one.
   *
   * Held as state rather than only pushed as a notice because the footer must not say
   * "Connected" unqualified: the engine being up says nothing about whether it can
   * reach Daintree, and an assistant that cannot spawn an agent while reporting itself
   * connected is the most misleading thing this panel could say.
   */
  mcpUnavailable: string | null;
  /** Tools the control plane is offering, once its catalog has been fetched. */
  mcpToolCount: number | null;
  /** The engine's command catalog, for the composer palette. */
  commands: AssistantCommandMeta[];
  /**
   * The question currently blocking the turn, if any.
   *
   * Singular because the engine blocks the dispatch until it settles — a second
   * question cannot arrive while one is outstanding, and modelling a list would
   * invite a UI that shows two answerable sheets for one blocked call.
   */
  /**
   * Text typed while a turn was running, not yet folded in by the engine.
   *
   * Held separately rather than appended as a user turn, because the engine will fold
   * it into the RUNNING turn as an interjection — appending it here as well showed the
   * same message twice, the second time below the answer it was meant to steer. The
   * cockpit showed it as a queued follow-up for exactly this window, then let the
   * engine move it into place.
   */
  queuedInterjection: string | null;
  /**
   * When the running turn last produced anything, for the stall cue.
   *
   * The engine going quiet for a while is normal — a slow model, a long tool — but it
   * is indistinguishable from a hang unless the panel says which it thinks it is.
   */
  lastActivityAt: number | null;
  /** When the running turn started, for the cumulative elapsed readout. */
  turnStartedAt: number | null;
  pendingQuestion: AssistantQuestion | null;
  /** Questions that have settled, in order, for the transcript. */
  answeredQuestions: AssistantAnsweredQuestion[];
  /** True when this session runs mutating tools with NO confirmation prompt. */
  autoApprove: boolean;
  /** Why the engine stopped, when it did. */
  stoppedReason: string | null;
  /** Fatal error that prevented (or ended) the session. */
  error: string | null;

  turns: AssistantTurn[];
  toolCalls: Record<string, AssistantToolCall>;
  approvals: AssistantApproval[];
  notices: AssistantNotice[];

  /** Current run phase (`generating`, `tool-running`, …) or null when idle. */
  phase: string | null;
  usage: AssistantUsage | null;
  cost: AssistantCost | null;
  rateLimited: boolean;

  /** Total frames the transport reported missing. Non-zero ⇒ incomplete transcript. */
  droppedFrames: number;
}

interface AssistantStoreActions {
  /** Reduce one host event into the session. */
  applyEvent: (event: AssistantHostEvent) => void;
  /** Record a sequence gap reported by the main process. */
  recordGap: (missing: number) => void;
  /** Optimistically append the user's prompt (the engine does not echo it back). */
  /**
   * Records locally-typed text.
   *
   * Returns the local turn id when it became a user turn, or null when it was queued
   * as an interjection instead — the caller uses that to know whether there is
   * anything to take back if delivery fails.
   */
  appendUserTurn: (text: string) => string | null;
  /** Drops a locally-appended user turn the engine never received. */
  dropLocalTurn: (turnId: string) => void;
  /** A local, non-protocol notice (a spawn failure, a command that could not send). */
  pushNotice: (level: AssistantNotice["level"], message: string) => void;
  setMcpUnavailable: (reason: string | null) => void;
  setConnection: (state: AssistantConnectionState, error?: string | null) => void;
  /** Wipe the transcript for a new session. */
  reset: (sessionId: string | null) => void;
}

export type AssistantStore = AssistantSessionState & AssistantStoreActions;

const EMPTY: AssistantSessionState = {
  sessionId: null,
  connection: "idle",
  engineVersion: null,
  tier: null,
  tierGloss: null,
  backend: null,
  routing: null,
  logFile: null,
  mcpUnavailable: null,
  mcpToolCount: null,
  commands: [],
  queuedInterjection: null,
  lastActivityAt: null,
  turnStartedAt: null,
  pendingQuestion: null,
  answeredQuestions: [],
  autoApprove: false,
  stoppedReason: null,
  error: null,
  turns: [],
  toolCalls: {},
  approvals: [],
  notices: [],
  phase: null,
  usage: null,
  cost: null,
  rateLimited: false,
  droppedFrames: 0,
};

let noticeCounter = 0;
function noticeId(): string {
  noticeCounter += 1;
  return `n${noticeCounter}`;
}

/** Caps the notice list so a chatty session cannot grow it without bound. */
const MAX_NOTICES = 50;

/**
 * Finds the open assistant turn, if any. Only one can be open at a time — the engine
 * runs a single-flight turn loop — so scanning from the end is both correct and cheap.
 */
function openTurnIndex(turns: AssistantTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn && turn.role === "assistant" && !turn.complete) return i;
  }
  return -1;
}

function patchTurn(
  turns: AssistantTurn[],
  turnId: string,
  patch: (turn: AssistantTurn) => AssistantTurn
): AssistantTurn[] {
  const index = turns.findIndex((t) => t.turnId === turnId);
  const target = turns[index];
  if (index === -1 || !target) return turns;
  const next = turns.slice();
  next[index] = patch(target);
  return next;
}

/** Appends text to the open text segment, or opens one. */
function appendText(segments: AssistantTurnSegment[], chunk: string): AssistantTurnSegment[] {
  const last = segments[segments.length - 1];
  if (last?.kind === "text") {
    return [...segments.slice(0, -1), { kind: "text", text: last.text + chunk }];
  }
  return [...segments, { kind: "text", text: chunk }];
}

/** The turn's prose, joined across segments. */
function joinText(segments: AssistantTurnSegment[]): string {
  return segments
    .filter((seg): seg is { kind: "text"; text: string } => seg.kind === "text")
    .map((seg) => seg.text)
    .join("");
}

/**
 * Applies the engine's authoritative `turn:end` content.
 *
 * It carries the FINAL round only (internal/agent/session.go hands AssistantEnd
 * `result.Message.Content`), so it replaces the LAST text segment rather than the whole
 * turn. Replacing everything deleted any prose the model produced before it called a
 * tool — the part that explains why it did.
 */
function applyFinalContent(
  segments: AssistantTurnSegment[],
  content: string
): AssistantTurnSegment[] {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]?.kind === "text") {
      const next = segments.slice();
      next[i] = { kind: "text", text: content };
      return next;
    }
  }
  // A tool-only round said nothing until now.
  return content ? [...segments, { kind: "text", text: content }] : segments;
}

/**
 * A locally-minted user turn.
 *
 * The engine does not echo prompts back, so the store's own list is the only place a
 * user turn exists. The id is prefixed so it can never collide with an engine-minted
 * `turn_…`.
 */
function localUserTurn(text: string): AssistantTurn {
  return {
    turnId: `local_${crypto.randomUUID()}`,
    role: "user",
    startedAt: Date.now(),
    segments: [{ kind: "text", text }],
    text,
    toolCallIds: [],
    interjections: [],
    complete: true,
  };
}

export const useAssistantStore = create<AssistantStore>((set, get) => ({
  ...EMPTY,

  reset: (sessionId) => set({ ...EMPTY, sessionId }),

  setMcpUnavailable: (reason) => set({ mcpUnavailable: reason }),

  setConnection: (connection, error) =>
    set((s) => ({ connection, error: error === undefined ? s.error : error })),

  pushNotice: (level, message) =>
    set((s) => ({
      notices: [
        ...s.notices,
        { id: noticeId(), level, message, at: Date.now(), turnId: null },
      ].slice(-MAX_NOTICES),
    })),

  recordGap: (missing) =>
    set((s) => ({
      droppedFrames: s.droppedFrames + missing,
      notices: [
        ...s.notices,
        {
          id: noticeId(),
          level: "warning" as const,
          message:
            `${missing} update${missing === 1 ? "" : "s"} were lost in transit. ` +
            `This part of the conversation may be incomplete.`,
          at: Date.now(),
          turnId: null,
        },
      ].slice(-MAX_NOTICES),
    })),

  appendUserTurn: (text) => {
    // Mid-turn input is an INTERJECTION, and the engine owns where it lands.
    if (get().turns.some((t) => t.role === "assistant" && !t.complete)) {
      set({ queuedInterjection: text });
      return null;
    }
    // Returned so a caller that learns the prompt was never delivered can take it
    // back out again.
    const turn = localUserTurn(text);
    set((s) => ({ turns: [...s.turns, turn] }));
    return turn.turnId;
  },

  dropLocalTurn: (turnId) => set((s) => ({ turns: s.turns.filter((t) => t.turnId !== turnId) })),

  applyEvent: (event) => {
    switch (event.type) {
      case "host:ready":
        set({
          connection: "ready",
          sessionId: event.sessionId,
          engineVersion: event.version ?? null,
          autoApprove: event.autoApprove,
          tier: event.tier ?? null,
          tierGloss: event.tierGloss ?? null,
          backend: event.backend ?? null,
          routing: event.routing ?? null,
          logFile: event.logFile ?? null,
          commands: event.commands ?? [],
          error: null,
        });
        return;

      case "host:shutdown":
        set({ connection: "stopped", stoppedReason: event.reason, phase: null });
        return;

      case "host:error":
        set((s) => ({
          notices: [
            ...s.notices,
            {
              id: noticeId(),
              level: "error" as const,
              message: event.message,
              at: Date.now(),
              turnId: null,
            },
          ].slice(-MAX_NOTICES),
        }));
        return;

      case "turn:start": {
        if (event.role !== "assistant") return;
        set((s) => ({
          turns: [
            ...s.turns,
            {
              turnId: event.turnId,
              role: "assistant" as const,
              startedAt: event.startedAt,
              segments: [],
              text: "",
              toolCallIds: [],
              interjections: [],
              complete: false,
            },
          ],
          rateLimited: false,
          turnStartedAt: Date.now(),
          lastActivityAt: Date.now(),
        }));
        return;
      }

      case "turn:token":
        set((s) => ({
          lastActivityAt: Date.now(),
          turns: patchTurn(s.turns, event.turnId, (t) => {
            const segments = appendText(t.segments, event.chunk);
            return { ...t, segments, text: joinText(segments) };
          }),
        }));
        return;

      case "turn:end":
        set((s) => {
          const turns = patchTurn(s.turns, event.turnId, (t) => ({
            ...t,
            // AUTHORITATIVE. Replacing rather than trusting the accumulated stream is
            // what makes a dropped token frame self-healing. `undefined` means the
            // turn produced no visible text at all, which is not the same as "" —
            // keep whatever streamed rather than blanking a tool-only round.
            ...(event.content !== undefined
              ? (() => {
                  const segments = applyFinalContent(t.segments, event.content);
                  return { segments, text: joinText(segments) };
                })()
              : {}),
            endedAt: event.endedAt,
            outcome: event.outcome,
            complete: true,
          }));
          // A turn that ended without ever folding the queued text in never carried
          // it. Promote it to a user turn of its own rather than letting the card
          // vanish with the turn it was waiting on: losing something the user typed is
          // worse than showing it a beat later than they expected.
          if (!s.queuedInterjection) {
            return { phase: null, turns, turnStartedAt: null, lastActivityAt: null };
          }
          return {
            phase: null,
            turnStartedAt: null,
            lastActivityAt: null,
            queuedInterjection: null,
            turns: [...turns, localUserTurn(s.queuedInterjection)],
          };
        });
        return;

      case "turn:phase":
        // A phase change is activity: the engine moving between stages is exactly the
        // signal that it has not hung, even when no prose is flowing.
        set({ phase: event.phase, lastActivityAt: Date.now() });
        return;

      case "turn:reasoning":
        set((s) => ({
          turns: patchTurn(s.turns, event.turnId, (t) => ({ ...t, reasoning: event.text })),
        }));
        return;

      case "turn:interjection":
        set((s) => {
          const index = event.turnId
            ? s.turns.findIndex((t) => t.turnId === event.turnId)
            : openTurnIndex(s.turns);
          const target = s.turns[index];
          if (index === -1 || !target) return s;
          const turns = s.turns.slice();
          turns[index] = {
            ...target,
            segments: [...target.segments, { kind: "interjection", text: event.text }],
            interjections: [...target.interjections, event.text],
          };
          // Folded in — the queued card has MOVED into the turn, so clear it rather
          // than leaving a copy standing beside its own destination.
          const stillQueued = s.queuedInterjection === event.text ? null : s.queuedInterjection;
          return { turns, queuedInterjection: stillQueued };
        });
        return;

      case "tool:batch": {
        set((s) => {
          const toolCalls = { ...s.toolCalls };
          const ids: string[] = [];
          for (const call of event.calls) {
            ids.push(call.toolCallId);
            toolCalls[call.toolCallId] = {
              toolCallId: call.toolCallId,
              toolId: call.toolId,
              argsSummary: call.argsSummary,
              danger: call.danger,
              state: "queued",
            };
          }
          const index = event.turnId
            ? s.turns.findIndex((t) => t.turnId === event.turnId)
            : openTurnIndex(s.turns);
          const target = s.turns[index];
          if (index === -1 || !target) return { toolCalls };
          const turns = s.turns.slice();
          // Announced ids join the turn in batch order; a call that somehow arrives
          // twice must not appear twice in the timeline.
          const existing = new Set(target.toolCallIds);
          const fresh = ids.filter((id) => !existing.has(id));
          turns[index] = {
            ...target,
            // The batch CLOSES the open prose segment: whatever the model said before
            // reaching for a tool belongs before the tool, and the next token starts a
            // new segment reacting to the result.
            segments: fresh.length
              ? [...target.segments, { kind: "tools", toolCallIds: fresh }]
              : target.segments,
            toolCallIds: [...target.toolCallIds, ...fresh],
          };
          return { toolCalls, turns };
        });
        return;
      }

      case "tool:started":
        set((s) => {
          const prior = s.toolCalls[event.toolCallId];
          const toolCalls = {
            ...s.toolCalls,
            [event.toolCallId]: {
              ...prior,
              toolCallId: event.toolCallId,
              toolId: event.toolId,
              argsSummary: event.argsSummary,
              danger: event.danger,
              startedAt: event.startedAt,
              state: "active" as AssistantToolState,
            },
          };
          // A call that was never announced in a batch still has to reach the
          // timeline, or it runs invisibly.
          if (prior) return { toolCalls };
          const index = event.turnId
            ? s.turns.findIndex((t) => t.turnId === event.turnId)
            : openTurnIndex(s.turns);
          const target = s.turns[index];
          if (index === -1 || !target) return { toolCalls };
          const turns = s.turns.slice();
          turns[index] = {
            ...target,
            toolCallIds: [...target.toolCallIds, event.toolCallId],
          };
          return { toolCalls, turns };
        });
        return;

      case "tool:state":
        set((s) => {
          const prior = s.toolCalls[event.toolCallId];
          if (!prior) return s;
          // An accepted async call keeps running after its own call settles, and the
          // engine emits `tool:state(done)` for every successful result regardless —
          // so the frame that means "the dispatch succeeded" arrives looking exactly
          // like "the work finished". Taking it at face value collapses the row and
          // reports a spawned agent as complete the instant it starts. Only a later
          // FAILURE can move an async row off `active`.
          if (prior.asyncId && event.state === "done") return s;
          return {
            toolCalls: { ...s.toolCalls, [event.toolCallId]: { ...prior, state: event.state } },
          };
        });
        return;

      case "tool:progress":
        set((s) => {
          const prior = s.toolCalls[event.toolCallId];
          if (!prior) return s;
          return {
            toolCalls: {
              ...s.toolCalls,
              [event.toolCallId]: {
                ...prior,
                // "" carries only liveness — keep the previous message rather than
                // blanking the row to nothing.
                progress: event.message === "" ? prior.progress : event.message,
              },
            },
          };
        });
        return;

      case "tool:settled":
        set((s) => {
          const prior = s.toolCalls[event.toolCallId];
          return {
            toolCalls: {
              ...s.toolCalls,
              [event.toolCallId]: {
                ...prior,
                toolCallId: event.toolCallId,
                toolId: event.toolId,
                argsSummary: prior?.argsSummary ?? "",
                danger: prior?.danger ?? false,
                durationMs: event.durationMs,
                severity: event.severity,
                errorCode: event.errorCode,
                asyncId: event.asyncId,
                asyncTitle: event.asyncTitle,
                summary: event.summary,
                errorMessage: event.errorMessage,
                // An accepted-but-running async call is NOT done. Rendering it as a
                // finished success would claim work completed that is still going.
                state: event.asyncId
                  ? ("active" as AssistantToolState)
                  : event.result === "success" || event.result === "dedup"
                    ? ("done" as AssistantToolState)
                    : ("failed" as AssistantToolState),
                progress: prior?.progress,
              },
            },
          };
        });
        return;

      case "approval:requested":
        set((s) => ({
          approvals: [
            ...s.approvals,
            {
              approvalId: event.approvalId,
              toolId: event.toolId,
              summary: event.summary,
              consequence: event.consequence,
              argsSummary: event.argsSummary,
              riskClass: event.riskClass,
              needsTypedConfirm: event.needsTypedConfirm,
              requestedAt: event.requestedAt,
            },
          ],
        }));
        return;

      case "approval:decided":
        set((s) => ({
          approvals: s.approvals.filter((a) => a.approvalId !== event.approvalId),
        }));
        return;

      case "usage":
        set({
          usage: {
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
            cachedTokens: event.cachedTokens,
            cacheHitRatio: event.cacheHitRatio,
            contextTokens: event.contextTokens,
            contextThreshold: event.contextThreshold,
            contextWindow: event.contextWindow,
          },
          rateLimited: false,
        });
        return;

      case "cost":
        set((s) => ({
          cost: {
            total: event.total,
            // Completeness is STICKY-FALSE across a session: once any request could
            // not be fully measured, the running total is a floor forever after.
            complete: (s.cost?.complete ?? true) && event.complete,
          },
        }));
        return;

      case "notice":
        set((s) => ({
          notices: [
            ...s.notices,
            {
              id: noticeId(),
              level: event.level,
              message: event.message,
              at: Date.now(),
              turnId: event.turnId ?? null,
            },
          ].slice(-MAX_NOTICES),
        }));
        return;

      case "mcp:status":
        // The AUTHORITATIVE reading, replacing whatever provisioning reported at
        // start: this one is the engine saying whether it can actually reach Daintree
        // now, and it updates after a /reconnect.
        set({
          mcpUnavailable: event.connected
            ? null
            : (event.error ?? "The Daintree control plane is not reachable."),
          mcpToolCount: event.connected ? (event.toolCount ?? null) : null,
        });
        return;

      case "command:result":
        set((s) => ({
          notices: [
            ...s.notices,
            {
              id: noticeId(),
              // An unknown command is the user's typo, not an engine fault: say so
              // without dressing it as an error.
              level: event.unknown ? ("warning" as const) : ("info" as const),
              message: event.unknown
                ? `${event.command} isn't a command. Type /help to see what is.`
                : `${event.command}\n${event.text}`.trimEnd(),
              at: Date.now(),
              turnId: event.turnId ?? null,
            },
          ].slice(-MAX_NOTICES),
        }));
        return;

      case "question:requested":
        set({
          pendingQuestion: {
            questionId: event.questionId,
            turnId: event.turnId ?? null,
            toolCallId: event.toolCallId ?? null,
            question: event.question,
            options: event.options,
            defaultIndex: event.default,
            requestedAt: event.requestedAt,
          },
        });
        return;

      case "question:answered":
        set((s) => ({
          // Cleared only if it is THIS question: a late `answered` for one already
          // superseded must not dismiss the sheet the user is currently looking at.
          pendingQuestion:
            s.pendingQuestion?.questionId === event.questionId ? null : s.pendingQuestion,
          answeredQuestions: [
            ...s.answeredQuestions,
            {
              questionId: event.questionId,
              turnId: event.turnId ?? null,
              question:
                s.pendingQuestion?.questionId === event.questionId
                  ? s.pendingQuestion.question
                  : "",
              index: event.index,
              label: event.label ?? null,
              text: event.text ?? null,
            },
          ],
        }));
        return;

      case "model:rate-limited":
        set({ rateLimited: true });
        return;

      default: {
        // Exhaustiveness: a new event variant must be handled here explicitly rather
        // than silently ignored.
        const _never: never = event;
        void _never;
      }
    }
  },
}));

/** Selector: the tool calls belonging to a turn, in announcement order. */
export function selectTurnToolCalls(
  state: AssistantSessionState,
  turn: AssistantTurn
): AssistantToolCall[] {
  const calls: AssistantToolCall[] = [];
  for (const id of turn.toolCallIds) {
    const call = state.toolCalls[id];
    if (call) calls.push(call);
  }
  return calls;
}

/** Selector: true when a turn is streaming right now. */
export function selectIsStreaming(state: AssistantSessionState): boolean {
  return state.turns.some((t) => t.role === "assistant" && !t.complete);
}

export { EMPTY as ASSISTANT_EMPTY_STATE };

/** Test-only reset of the module-level notice counter, so ids stay deterministic. */
export function __resetNoticeCounterForTest(): void {
  noticeCounter = 0;
}

/** Re-exported for consumers that need the raw getter outside React. */
export const getAssistantState = (): AssistantStore => useAssistantStore.getState();
export type { AssistantToolState };

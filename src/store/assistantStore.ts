import { create } from "zustand";
import type { AssistantHostEvent, AssistantToolState } from "@shared/types/ipc/assistantHost";
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

export interface AssistantTurn {
  turnId: string;
  role: "user" | "assistant";
  startedAt: number;
  endedAt?: number;
  /** Streamed text; replaced by the authoritative content at turn:end. */
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
  appendUserTurn: (text: string) => string;
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

export const useAssistantStore = create<AssistantStore>((set) => ({
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
    // The engine does not echo the prompt back, so this id is local. Prefixed so it can
    // never collide with an engine-minted `turn_…`. Returned so a caller that learns
    // the prompt was never delivered can take it back out again.
    const turnId = `local_${crypto.randomUUID()}`;
    set((s) => ({
      turns: [
        ...s.turns,
        {
          turnId,
          role: "user" as const,
          startedAt: Date.now(),
          text,
          toolCallIds: [],
          interjections: [],
          complete: true,
        },
      ],
    }));
    return turnId;
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
              text: "",
              toolCallIds: [],
              interjections: [],
              complete: false,
            },
          ],
          rateLimited: false,
        }));
        return;
      }

      case "turn:token":
        set((s) => ({
          turns: patchTurn(s.turns, event.turnId, (t) => ({ ...t, text: t.text + event.chunk })),
        }));
        return;

      case "turn:end":
        set((s) => ({
          phase: null,
          turns: patchTurn(s.turns, event.turnId, (t) => ({
            ...t,
            // AUTHORITATIVE. Replacing rather than trusting the accumulated stream is
            // what makes a dropped token frame self-healing. `undefined` means the
            // turn produced no visible text at all, which is not the same as "" —
            // keep whatever streamed rather than blanking a tool-only round.
            text: event.content !== undefined ? event.content : t.text,
            endedAt: event.endedAt,
            outcome: event.outcome,
            complete: true,
          })),
        }));
        return;

      case "turn:phase":
        set({ phase: event.phase });
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
          turns[index] = { ...target, interjections: [...target.interjections, event.text] };
          return { turns };
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
          turns[index] = {
            ...target,
            toolCallIds: [...target.toolCallIds, ...ids.filter((id) => !existing.has(id))],
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

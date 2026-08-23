import { create } from "zustand";
import type {
  AssistantAgentRow,
  AssistantAsyncRow,
  AssistantAuditRow,
  AssistantCommandMeta,
  AssistantInboxRow,
  AssistantTimerRow,
  AssistantWorkflowRow,
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
  /**
   * The engine's human label for this call and its object — what the cockpit drew in
   * place of the internal tool id. Absent for a tool its presentation table does not
   * know, which is the signal to show `toolId` rather than invent a verb.
   */
  verb?: string;
  activeVerb?: string;
  target?: string;
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
  /** May be added to the session "don't ask again" list. Engine's verdict. */
  rememberable: boolean;
  /**
   * The identity the gates were applied to — what a grant is keyed on.
   *
   * Falls back to `toolId` only when the engine sent none. Never the display name
   * when an identity exists: two actions can share a label.
   */
  grantKey: string;
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
  | { kind: "interjection"; text: string }
  // What the user chose when the model asked. Part of the turn because the answer is
  // why the turn went the way it did — a transcript that omits it cannot explain the
  // decision that followed.
  | { kind: "answer"; question: string; label: string | null; text: string | null };

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
  /**
   * The assistant started this turn itself, so Stop cannot reach it.
   *
   * The engine aborts command turns only; a wake has already claimed its attention
   * events and aborting would strand them.
   */
  wake?: boolean;
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

/** One reading of the operations deck, with when it was taken. */
export interface AssistantOperations {
  inbox: AssistantInboxRow[];
  workflows: AssistantWorkflowRow[];
  agents: AssistantAgentRow[];
  async: AssistantAsyncRow[];
  timers: AssistantTimerRow[];
  audit: AssistantAuditRow[];
  /** When this reading was taken, so the deck can say how stale it is. */
  at: number;
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
   * The last operations reading, or null before one is asked for.
   *
   * Requested rather than streamed, as the cockpit rebuilt its deck on open: pushing
   * every store change to a panel that may not be showing the deck is a lot of traffic
   * for a view nobody is looking at.
   */
  operations: AssistantOperations | null;
  /**
   * Tools the user has said not to ask about again this session, and how many uses
   * remain (`Infinity` for "always").
   *
   * Session-scoped and in memory only: a standing approval must not outlive the
   * conversation it was given in, and must never be written anywhere it could be
   * restored into a session the user did not grant it for.
   */
  toolGrants: Record<string, number>;
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
   * A QUEUE, not a slot: someone can send two steers before the engine folds either
   * one in, and a single slot silently discarded the first. They fold in order, so the
   * first one folded clears the first one queued.
   *
   * Held separately rather than appended as a user turn, because the engine will fold
   * it into the RUNNING turn as an interjection — appending it here as well showed the
   * same message twice, the second time below the answer it was meant to steer. The
   * cockpit showed it as a queued follow-up for exactly this window, then let the
   * engine move it into place.
   */
  queuedInterjections: string[];
  /**
   * A follow-up the engine just handed back, waiting for the composer to pick it up.
   * Cleared by `takeRetractedDraft` so it is delivered exactly once — leaving it set
   * would re-fill the composer on every later render.
   */
  retractedDraft: string | null;
  /**
   * When the running turn last produced anything, for the stall cue.
   *
   * The engine going quiet for a while is normal — a slow model, a long tool — but it
   * is indistinguishable from a hang unless the panel says which it thinks it is.
   */
  lastActivityAt: number | null;
  /** When the running turn started, for the cumulative elapsed readout. */
  turnStartedAt: number | null;
  /** The current phase belongs to a turn the assistant started itself. */
  phaseIsWake: boolean;
  pendingQuestion: AssistantQuestion | null;
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
  /**
   * Drops one queued steer the engine never received.
   *
   * The counterpart to `dropLocalTurn` for mid-turn input, which is queued rather
   * than appended — so a failed delivery had nothing to take back, and the entry was
   * later promoted into a user turn for a message that never arrived.
   */
  /**
   * Drops text the engine never received, wherever it currently sits.
   *
   * A rejection can arrive after the engine exited, by which point `endLiveState` has
   * already promoted the queued entry to a turn — so searching the queue alone left an
   * undelivered message sitting in the transcript as though it had been sent.
   */
  dropUndeliveredText: (text: string) => void;
  /** Take the handed-back follow-up, clearing it so it is consumed once. */
  takeRetractedDraft: () => string | null;
  dropQueuedInterjection: (text: string) => void;
  /** A local, non-protocol notice (a spawn failure, a command that could not send). */
  pushNotice: (level: AssistantNotice["level"], message: string) => void;
  setMcpUnavailable: (reason: string | null) => void;
  /** Records a session grant. `uses` of Infinity means "always". */
  grantTool: (toolId: string, uses: number) => void;
  /** Revokes every standing grant. */
  clearGrants: () => void;
  /**
   * Spends one use of a standing grant, if this approval is covered by one.
   *
   * Returns true when the caller should approve WITHOUT showing a card. Refuses — and
   * spends nothing — for an approval the engine marked non-rememberable or as needing
   * a typed confirmation, so a grant given for something ordinary can never be spent
   * on a git push or a system action.
   */
  consumeGrant: (approval: {
    grantKey: string;
    rememberable: boolean;
    needsTypedConfirm: boolean;
  }) => boolean;
  setConnection: (state: AssistantConnectionState, error?: string | null) => void;
  /** Settles phase, open turns, live calls, approvals and questions after an exit. */
  endLiveState: () => void;
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
  operations: null,
  toolGrants: {},
  queuedInterjections: [],
  retractedDraft: null,
  lastActivityAt: null,
  turnStartedAt: null,
  phaseIsWake: false,
  pendingQuestion: null,
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
  const last = segments[segments.length - 1];
  // Only the TRAILING text segment is the final round's own prose. Searching backwards
  // past a tool segment would reach an EARLIER round and overwrite it — so a final
  // round that streamed nothing (empty content, or every token frame lost) would
  // delete the prose that explained why a tool was called, which is exactly the bug
  // whole-turn replacement had.
  if (last?.kind === "text") {
    const next = segments.slice();
    next[next.length - 1] = { kind: "text", text: content };
    return next;
  }
  // The last thing that happened was a tool call, so this content is a new round.
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

  grantTool: (toolId, uses) => set((s) => ({ toolGrants: { ...s.toolGrants, [toolId]: uses } })),

  clearGrants: () => set({ toolGrants: {} }),

  consumeGrant: ({ grantKey, rememberable, needsTypedConfirm }) => {
    // Both gates, independently. `rememberable` is the engine's own verdict and is
    // already false for git/system; the typed-confirm check is belt-and-braces so a
    // future risk class that is somehow both cannot slip through.
    if (!rememberable || needsTypedConfirm) return false;
    const remaining = get().toolGrants[grantKey];
    if (remaining === undefined || remaining <= 0) return false;
    if (remaining !== Infinity) {
      set((s) => {
        const next = { ...s.toolGrants };
        const left = (next[grantKey] ?? 0) - 1;
        if (left > 0) next[grantKey] = left;
        else delete next[grantKey];
        return { toolGrants: next };
      });
    }
    return true;
  },

  /**
   * Settles everything a dead engine left mid-flight.
   *
   * `connection` alone said the session had stopped while the phase line still read
   * "Working", an approval card still waited for an answer nothing would receive, and
   * an open turn still streamed a caret. Every one of those describes an engine that
   * no longer exists.
   */
  endLiveState: () =>
    set((s) => ({
      phase: null,
      phaseIsWake: false,
      turnStartedAt: null,
      lastActivityAt: null,
      pendingQuestion: null,
      // Nothing is queued once the engine is gone. The words are kept — they were
      // typed — but as ordinary turns rather than as a promise of delivery that will
      // never be honoured.
      queuedInterjections: [],
      // Dropped rather than auto-declined: this surface cannot answer for an engine
      // that is gone, and leaving a card implies someone still can.
      approvals: [],
      turns: [
        ...s.turns.map((t) =>
          t.complete ? t : { ...t, complete: true, outcome: t.outcome ?? "unknown" }
        ),
        ...s.queuedInterjections.map((text) => localUserTurn(text)),
      ],
      toolCalls: Object.fromEntries(
        Object.entries(s.toolCalls).map(([id, call]) =>
          call.state === "queued" || call.state === "active" || call.state === "waiting"
            ? [
                id,
                {
                  ...call,
                  // FAILED, not "cancelled". Cancelled is worded as the user's own
                  // deliberate stop; the engine dying is not something they chose, and
                  // saying so blames them for it.
                  state: "failed" as AssistantToolState,
                  errorMessage: "The assistant stopped before this finished.",
                },
              ]
            : [id, call]
        )
      ),
    })),

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
      set((s) => ({ queuedInterjections: [...s.queuedInterjections, text] }));
      return null;
    }
    // Returned so a caller that learns the prompt was never delivered can take it
    // back out again.
    const turn = localUserTurn(text);
    set((s) => ({ turns: [...s.turns, turn] }));
    return turn.turnId;
  },

  dropLocalTurn: (turnId) => set((s) => ({ turns: s.turns.filter((t) => t.turnId !== turnId) })),

  takeRetractedDraft: () => {
    const text = get().retractedDraft;
    if (text !== null) set({ retractedDraft: null });
    return text;
  },

  dropUndeliveredText: (text) =>
    set((s) => {
      // The queue first: this is the ordinary case, and one entry only, since two
      // identical steers are two messages and only one of them failed.
      const at = s.queuedInterjections.indexOf(text);
      if (at !== -1) {
        return {
          queuedInterjections: [
            ...s.queuedInterjections.slice(0, at),
            ...s.queuedInterjections.slice(at + 1),
          ],
        };
      }
      // Otherwise the engine exited first and `endLiveState` already promoted it to a
      // turn. The rejection arrives after that, so searching only the queue left an
      // undelivered message sitting in the transcript as though it had been sent.
      for (let i = s.turns.length - 1; i >= 0; i--) {
        const turn = s.turns[i];
        if (turn?.role === "user" && turn.text === text && turn.turnId.startsWith("local_")) {
          return { turns: [...s.turns.slice(0, i), ...s.turns.slice(i + 1)] };
        }
      }
      return s;
    }),

  dropQueuedInterjection: (text) =>
    set((s) => {
      // One entry, not all: two identical steers are two messages, and only one of
      // them failed to arrive.
      const at = s.queuedInterjections.indexOf(text);
      if (at === -1) return s;
      return {
        queuedInterjections: [
          ...s.queuedInterjections.slice(0, at),
          ...s.queuedInterjections.slice(at + 1),
        ],
      };
    }),

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
              wake: event.wake,
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
          if (s.queuedInterjections.length === 0) {
            return { phase: null, turns, turnStartedAt: null, lastActivityAt: null };
          }
          return {
            phase: null,
            turnStartedAt: null,
            lastActivityAt: null,
            queuedInterjections: [],
            // EVERY stranded message is promoted, in order. Losing something the user
            // typed is worse than showing it a beat later than they expected.
            turns: [...turns, ...s.queuedInterjections.map((t) => localUserTurn(t))],
          };
        });
        return;

      case "turn:phase":
        // A phase change is activity: the engine moving between stages is exactly the
        // signal that it has not hung, even when no prose is flowing.
        //
        // `phaseIsWake` is tracked separately from the turn because a wake's first
        // phase arrives BEFORE its turn opens: without it there is a window where the
        // panel knows work is happening but not that Stop cannot reach it.
        set({ phase: event.phase, phaseIsWake: event.wake === true, lastActivityAt: Date.now() });
        return;

      case "interject:retracted": {
        // The engine took the message back out of its buffer, so the transcript's copy
        // has to go too — the panel appended it optimistically when it was typed. A
        // failed retract removes nothing: the message is still queued and still true.
        if (!event.retracted || !event.text) return;
        get().dropUndeliveredText(event.text);
        // Handed to the composer rather than dropped. Escape here means "let me edit
        // that", not "delete it", and a retract that vanished the text would be a
        // worse outcome than never offering one.
        set({ retractedDraft: event.text });
        return;
      }
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
          // Folded in — that card has MOVED into the turn, so drop ONE matching entry
          // rather than leaving a copy beside its own destination. One, not all: two
          // identical steers are two messages, and clearing both would lose one.
          const at = s.queuedInterjections.indexOf(event.text);
          const queuedInterjections =
            at === -1
              ? s.queuedInterjections
              : [...s.queuedInterjections.slice(0, at), ...s.queuedInterjections.slice(at + 1)];
          return { turns, queuedInterjections };
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
              verb: call.verb,
              activeVerb: call.activeVerb,
              target: call.target,
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
          // A segment too, not just the id list. The panel renders from SEGMENTS, so
          // an unannounced call that only joined `toolCallIds` ran completely
          // invisibly — the one case this branch exists to prevent.
          const lastSeg = target.segments[target.segments.length - 1];
          const segments =
            lastSeg?.kind === "tools"
              ? [
                  ...target.segments.slice(0, -1),
                  {
                    kind: "tools" as const,
                    toolCallIds: [...lastSeg.toolCallIds, event.toolCallId],
                  },
                ]
              : [...target.segments, { kind: "tools" as const, toolCallIds: [event.toolCallId] }];
          turns[index] = {
            ...target,
            segments,
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
          // UPSERT by id, not append. A re-request for an id already on screen is the
          // engine restating a dispatch that is still parked, and appending it drew a
          // SECOND card with the same React key: duplicate keys, and — worse on this
          // surface — a freshly mounted card carrying a fresh one-shot guard, so the
          // pair could send two contradicting answers for one dispatch. Replacing the
          // row keeps one card, one guard, one answer.
          approvals: [
            ...s.approvals.filter((a) => a.approvalId !== event.approvalId),
            {
              approvalId: event.approvalId,
              toolId: event.toolId,
              summary: event.summary,
              consequence: event.consequence,
              argsSummary: event.argsSummary,
              riskClass: event.riskClass,
              needsTypedConfirm: event.needsTypedConfirm,
              rememberable: event.rememberable ?? false,
              grantKey: event.toolKey ?? event.toolId,
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

      case "operations:snapshot":
        set({
          operations: {
            inbox: event.inbox,
            workflows: event.workflows,
            agents: event.agents,
            async: event.async,
            timers: event.timers,
            audit: event.audit,
            at: Date.now(),
          },
        });
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
        // /clear wipes the engine's conversation, so the transcript above it is no
        // longer the history of anything — the model cannot see it, and leaving it on
        // screen invites a follow-up ("as you said earlier") that will not land. The
        // cockpit cleared the screen for exactly this reason; here the panel drops the
        // turns and keeps only the result line, so what remains is the fresh start.
        // The ENGINE's verdict, not the command's spelling.
        //
        // `/clear` is refused while a turn is in flight, and that refusal arrives as an
        // ordinary command result. Matching on the text wiped the transcript, the
        // activity rows and every live readout while the engine kept the conversation
        // and carried on working in it — leaving the user talking to a model whose
        // context they could no longer see, with the two disagreeing about what had
        // been said. A destructive reset needs an authoritative answer, and this is it.
        if (event.conversationCleared === true) {
          set((s) => ({
            turns: [],
            toolCalls: {},
            approvals: [],
            queuedInterjections: [],
            // The LIVE state goes too. The transcript was the only thing being cleared,
            // so a `/clear` issued while a turn was still settling left "Integrating
            // results · 13s" and its ticking clock under an empty conversation —
            // describing work belonging to a turn that no longer exists anywhere, with
            // no way to make it go away short of restarting the session.
            phase: null,
            phaseIsWake: false,
            turnStartedAt: null,
            lastActivityAt: null,
            pendingQuestion: null,
            // A gap belongs to a transcript. Cleared with it, or the panel keeps
            // reporting frames missing from a conversation nobody can read.
            droppedFrames: 0,
            // STANDING GRANTS go too. "Always allow this" was answered about a specific
            // conversation — this tool, in this piece of work, for these reasons. Once
            // that conversation is gone the grant is authority with nothing left to
            // justify it, silently approving calls in a fresh context the user never
            // saw when they gave it. Permission does not outlive the thing it was
            // granted for.
            toolGrants: {},
            // The deck describes what the ENGINE is watching, and /clear tells the
            // engine to drop its watchers, async operations and inbox (its own result
            // line says so). Keeping the last reading would show work that has just
            // been deleted, as though it were still running.
            operations: null,
            notices: [
              {
                id: noticeId(),
                level: "info" as const,
                message: `${event.command}\n${event.text}`.trimEnd(),
                at: Date.now(),
                turnId: null,
              },
            ],
            // The spend so far is still true and still the user's money; only the
            // conversation was cleared.
            usage: s.usage,
          }));
          return;
        }
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
        set((s) => {
          const asked =
            s.pendingQuestion?.questionId === event.questionId ? s.pendingQuestion : null;
          const answer: AssistantTurnSegment = {
            kind: "answer",
            question: asked?.question ?? "",
            label: event.label ?? null,
            text: event.text ?? null,
          };
          const turnId = event.turnId ?? asked?.turnId ?? null;
          return {
            // Cleared only if it is THIS question: a late `answered` for one already
            // superseded must not dismiss the sheet the user is currently looking at.
            pendingQuestion: asked ? null : s.pendingQuestion,
            // Recorded in the TURN, at the point the decision was made.
            turns: turnId
              ? patchTurn(s.turns, turnId, (t) => ({
                  ...t,
                  segments: [...t.segments, answer],
                }))
              : s.turns,
          };
        });
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

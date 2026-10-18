import { randomUUID } from "node:crypto";
import { MAX_ASSISTANT_SLOTS } from "../../../shared/config/assistantSlots.js";
import type { AgentLastMessageObserved } from "../../../shared/types/agentLastMessage.js";
import {
  ASSISTANT_TARGET_REFUSALS,
  type AssistantEntry,
  type AssistantListResult,
  type AssistantStartArgs,
  type AssistantStartResult,
} from "../../../shared/types/assistantControl.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import type { TerminalHandback } from "../../../shared/types/handback.js";
import { readTailSnapshot } from "../../../shared/utils/artifactParser.js";
import { stampAssistantPrompt } from "../../../shared/utils/assistantProvenance.js";
import { appendHandbackInstruction, mintHandbackCode } from "../../../shared/utils/handback.js";
import { assessInterruptCandidate } from "../../../shared/utils/terminalInterrupt.js";
import { buildTerminalSendCommandReceipt } from "../../../shared/utils/terminalSendCommandResult.js";
import { evaluateWakeGate, type WakeGateVerdict } from "../../../shared/utils/terminalWakeGate.js";
import type {
  HelpSessionStartedBy,
  RunningLane,
  RunningLaneSession,
} from "../HelpSessionService.js";
import type { PtyClient } from "../PtyClient.js";
import type { AssistantLaunchRequest, AssistantLaunchResult } from "./assistantLaunch.js";

/**
 * An assistant addressing another (#13496), as main established it from the
 * caller's own session and never from anything it sent: one of this
 * machine's help sessions, or another machine's assistant reaching this one
 * through its Shell's `host.call`. Either reaches only the assistants of the
 * project its session works in.
 */
export type AssistantCaller =
  | { kind: "local"; helpSessionId: string; projectId: string; machineName: string }
  | {
      kind: "relay";
      senderId: string;
      linkSessionId: string;
      helpSessionId: string;
      projectId: string;
      /** The Shell's machine name from its handshake: display only. */
      machineName: string;
    };

/** A running assistant a caller named. */
export interface AssistantTarget {
  projectId: string;
  slot: number;
  sessionId: string;
  terminalId: string;
  attached: boolean;
  startedBy?: HelpSessionStartedBy;
}

/** The pty-host record fields the control reads. */
export interface AssistantTerminalRecord {
  detectedAgentId?: BuiltInAgentId;
  launchAgentId?: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  lastTypedInputAt?: number;
  isExited?: boolean;
  hasPty?: boolean;
  isTrashed?: boolean;
  lastHandback?: TerminalHandback;
}

export interface AssistantTerminalControlDeps {
  listRunningLanes(): RunningLane[];
  getRunningLaneSession(projectId: string, slot: number): RunningLaneSession | null;
  getTerminal(terminalId: string): Promise<AssistantTerminalRecord | null>;
  getLiveGeneration(terminalId: string): number | null;
  serializedState(
    terminalId: string,
    options?: { tailRows: number }
  ): Promise<{ data: string; partial?: true } | null>;
  /** Under the settled-prompt guard, so the lane admits it only while the gate still holds. */
  submit(terminalId: string, text: string, submissionToken: string, handbackCode?: string): void;
  doubleEscape(terminalId: string): void;
  launch(request: AssistantLaunchRequest): Promise<AssistantLaunchResult>;
  /** Ends the session, which kills its PTY. */
  revoke(sessionId: string): Promise<void>;
  /** The reply a screen shows, ending at the handback marker observed when there is one. */
  extractReply(
    serialized: string,
    lines: number,
    endAt: { message: string | null } | false,
    /** A first cut in characters; the read fits the result to its byte budget after. */
    maxChars: number
  ): { reply: { text: string; truncated: boolean } | null; reachedHandback: boolean };
}

/** A refusal an assistant tool or target answers with: fixed words, never a screen's. */
export class AssistantTargetError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AssistantTargetError";
  }
}

/** Rows the reply read quotes at most. */
const REPLY_READ_LINES = 400;
/** Rows of screen searched for a reply. */
const REPLY_SEARCH_ROWS = 500;

/** Bytes `text` costs as a JSON string's contents. */
function escapedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

/** The newest end of `text` that costs at most `maxBytes` once JSON-escaped. */
function newestWithinEscapedBytes(text: string, maxBytes: number): string {
  if (escapedBytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  // The shortest cut from the front that fits, found by halving.
  while (low < high) {
    const mid = (low + high) >> 1;
    if (escapedBytes(text.slice(mid)) <= maxBytes) high = mid;
    else low = mid + 1;
  }
  let start = low;
  // Never start on the second half of a surrogate pair.
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

function startedByCaller(caller: AssistantCaller): HelpSessionStartedBy {
  return caller.kind === "local"
    ? { kind: "local", askingHelpSessionId: caller.helpSessionId }
    : {
        kind: "relay",
        senderId: caller.senderId,
        linkSessionId: caller.linkSessionId,
        askingHelpSessionId: caller.helpSessionId,
      };
}

/**
 * Whether `caller` started this run. Another machine's assistant is the same
 * one across link sessions: its sender and help session, never the link it
 * happened to come over.
 */
export function wasStartedBy(target: AssistantTarget, caller: AssistantCaller): boolean {
  const startedBy = target.startedBy;
  if (startedBy === undefined || startedBy.kind !== caller.kind) return false;
  if (startedBy.askingHelpSessionId !== caller.helpSessionId) return false;
  return (
    startedBy.kind === "local" ||
    (caller.kind === "relay" && startedBy.senderId === caller.senderId)
  );
}

function busyMessage(verdict: Exclude<WakeGateVerdict, { kind: "ready" }>): string {
  switch (verdict.reason) {
    case "working":
      return "The assistant is mid-turn. Nothing was sent; send once it is waiting at its prompt.";
    case "typing":
      return "Someone has typed into the assistant's prompt since it settled. Nothing was sent, so their draft stays; send once it has settled again.";
    case "approval":
    case "question":
      return "The assistant is waiting on a question only a person in its pane can answer. Nothing was sent.";
    case "error":
      return "The assistant stopped on an error. Nothing was sent.";
    case "no-agent":
      return "The assistant's agent isn't running. Nothing was sent.";
    case "not-at-prompt":
      return "The assistant isn't waiting at its prompt. Nothing was sent; send once it is.";
  }
}

/**
 * Main's side of one assistant addressing another (#13496): finding and
 * starting one, and the agent messaging tools run against one. Every call
 * resolves the target from the caller's own project and this machine's
 * running lanes, so a terminal id from anywhere else is no assistant here.
 */
export class AssistantTerminalControl {
  constructor(private readonly deps: AssistantTerminalControlDeps) {}

  /** Whether `terminalId` is any running assistant on this machine, whoever asks. */
  isAssistantTerminal(terminalId: string): boolean {
    return this.deps
      .listRunningLanes()
      .some(
        (lane) =>
          this.deps.getRunningLaneSession(lane.projectId, lane.slot)?.terminalId === terminalId
      );
  }

  /**
   * The assistant `terminalId` names in the caller's project, other than the
   * caller itself; null for anything else.
   */
  resolve(caller: AssistantCaller, terminalId: string): AssistantTarget | null {
    for (const lane of this.deps.listRunningLanes()) {
      if (lane.projectId !== caller.projectId) continue;
      const running = this.deps.getRunningLaneSession(lane.projectId, lane.slot);
      if (running?.terminalId !== terminalId) continue;
      if (caller.kind === "local" && running.sessionId === caller.helpSessionId) return null;
      return {
        projectId: lane.projectId,
        slot: lane.slot,
        sessionId: running.sessionId,
        terminalId,
        attached: lane.attached !== false,
        ...(running.startedBy ? { startedBy: running.startedBy } : {}),
      };
    }
    return null;
  }

  /** Refuses a target no longer running as the caller named it. */
  require(caller: AssistantCaller, terminalId: string): AssistantTarget {
    const target = this.resolve(caller, terminalId);
    if (!target) {
      throw new AssistantTargetError(
        ASSISTANT_TARGET_REFUSALS.notFound,
        `No assistant in this project runs as terminal '${terminalId}'. List them with 'assistant.list'.`
      );
    }
    return target;
  }

  async list(caller: AssistantCaller): Promise<AssistantListResult> {
    const assistants: AssistantEntry[] = [];
    const occupied = new Set<number>();
    for (const lane of this.deps.listRunningLanes()) {
      if (lane.projectId !== caller.projectId) continue;
      occupied.add(lane.slot);
      const running = this.deps.getRunningLaneSession(lane.projectId, lane.slot);
      if (!running) continue;
      if (caller.kind === "local" && running.sessionId === caller.helpSessionId) continue;
      const entry = await this.entryFor(
        {
          projectId: lane.projectId,
          slot: lane.slot,
          sessionId: running.sessionId,
          terminalId: running.terminalId,
          attached: lane.attached !== false,
          ...(running.startedBy ? { startedBy: running.startedBy } : {}),
        },
        caller,
        lane.agentId
      );
      if (entry) assistants.push(entry);
    }
    assistants.sort((a, b) => a.slot - b.slot);
    const vacantSlots = Array.from({ length: MAX_ASSISTANT_SLOTS }, (_, slot) => slot).filter(
      (slot) => !occupied.has(slot)
    );
    return { projectId: caller.projectId, assistants, vacantSlots };
  }

  async start(caller: AssistantCaller, args: AssistantStartArgs): Promise<AssistantStartResult> {
    const result = await this.deps.launch({
      projectId: caller.projectId,
      ...(args.slot !== undefined ? { slot: args.slot } : {}),
      ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
      startedBy: startedByCaller(caller),
    });
    if (result.status === "refused") {
      const message =
        result.reason === "no-project"
          ? "This machine has no such project. Nothing was started."
          : result.reason === "no-slot"
            ? args.slot !== undefined
              ? `Slot ${args.slot} already runs an assistant. Nothing was started; use it, or start in another slot.`
              : `This project already runs ${MAX_ASSISTANT_SLOTS} assistants, its limit. Nothing was started; use one of them.`
            : "The assistant couldn't be started here, or that agent can't run as one. Nothing is running for it.";
      throw new AssistantTargetError(ASSISTANT_TARGET_REFUSALS.startRefused, message);
    }
    const target: AssistantTarget = {
      projectId: caller.projectId,
      slot: result.slot,
      sessionId: result.sessionId,
      terminalId: result.terminalId,
      attached: false,
      startedBy: startedByCaller(caller),
    };
    const entry = (await this.entryFor(target, caller, result.agentId)) ?? {
      terminalId: result.terminalId,
      generation: this.deps.getLiveGeneration(result.terminalId) ?? 0,
      slot: result.slot,
      agentId: result.agentId,
      agentState: null,
      waitingReason: null,
      attached: false,
      startedByYou: true,
    };
    return { assistant: entry, ready: result.ready, notReadyReason: result.notReadyReason };
  }

  /**
   * Submit a prompt to an assistant (#13496): to the run `generation` names
   * and no other, stamped with where it came from, and only while it waits at
   * its prompt with nothing typed there since it settled. Refused rather than
   * queued otherwise, so a person's draft is never sent along with it or
   * interleaved with it, whichever machine asks. The settled-prompt guard
   * closes the gap between that read and the write.
   */
  async submit(
    caller: AssistantCaller,
    target: AssistantTarget,
    request: { command: string; generation: number | undefined; handback: boolean }
  ): Promise<ReturnType<typeof buildTerminalSendCommandReceipt>> {
    this.requireGeneration(caller, target, request.generation);
    const record = await this.deps.getTerminal(target.terminalId);
    if (!record) {
      throw new AssistantTargetError(
        ASSISTANT_TARGET_REFUSALS.notFound,
        `Assistant terminal '${target.terminalId}' can't be read right now. Nothing was sent.`
      );
    }
    const verdict = evaluateWakeGate(record, { acceptWorking: false });
    if (verdict.kind !== "ready") {
      throw new AssistantTargetError(
        ASSISTANT_TARGET_REFUSALS.busy,
        `${busyMessage(verdict)} (state: ${record.agentState ?? "unknown"}${
          record.waitingReason ? `, ${record.waitingReason}` : ""
        })`
      );
    }
    // The read was async: the run must still be the one the caller named.
    this.requireGeneration(caller, target, request.generation);
    const stamped = stampAssistantPrompt(request.command, caller.machineName);
    const submissionToken = randomUUID();
    if (request.handback) {
      const handbackCode = mintHandbackCode();
      this.deps.submit(
        target.terminalId,
        appendHandbackInstruction(stamped, handbackCode),
        submissionToken,
        handbackCode
      );
    } else {
      this.deps.submit(target.terminalId, stamped, submissionToken);
    }
    return buildTerminalSendCommandReceipt(target.terminalId, request.command, submissionToken);
  }

  async interrupt(target: AssistantTarget): Promise<{
    terminalId: string;
    agentId: string;
    agentStateAtDispatch: string | undefined;
    status: "requested" | "requested-unverified";
  }> {
    const record = await this.deps.getTerminal(target.terminalId);
    const assessment = assessInterruptCandidate(
      record
        ? {
            isPty: true,
            trashed: record.isTrashed === true,
            ...(record.hasPty !== undefined ? { hasPty: record.hasPty } : {}),
            exited: record.isExited === true,
            agentId: record.detectedAgentId,
            ...(record.agentState !== undefined ? { agentState: record.agentState } : {}),
            ...(record.waitingReason !== undefined ? { waitingReason: record.waitingReason } : {}),
          }
        : undefined,
      target.terminalId
    );
    if (!assessment.eligible) {
      throw new AssistantTargetError("VALIDATION_ERROR", assessment.reason);
    }
    this.deps.doubleEscape(target.terminalId);
    return {
      terminalId: target.terminalId,
      agentId: assessment.agentId,
      agentStateAtDispatch: assessment.agentState,
      status: assessment.support === "advertised" ? "requested" : "requested-unverified",
    };
  }

  /** Ends an assistant this caller started, and only that one: its session goes, and its PTY. */
  async close(caller: AssistantCaller, target: AssistantTarget): Promise<{ closedIds: string[] }> {
    if (!wasStartedBy(target, caller)) {
      throw new AssistantTargetError(
        ASSISTANT_TARGET_REFUSALS.notStarter,
        `Assistant terminal '${target.terminalId}' wasn't started by you, so you can't close it. Only the assistant that started one, or the person, can.`
      );
    }
    await this.deps.revoke(target.sessionId);
    return { closedIds: [target.terminalId] };
  }

  /**
   * An assistant's reply as its pane shows it (#13496), whatever agent it
   * runs: read off the screen, never a transcript, ending at the handback
   * marker for its current prompt when the pty-host saw one. The marker is
   * matched by what it said, so an earlier turn's left on screen never ends
   * the quote. Without one the latest screen is quoted, marked as such.
   * `maxBytes` is measured as the text costs once JSON-escaped, as the
   * transcript read measures its own, and the newest text is kept.
   */
  async readReply(target: AssistantTarget, maxBytes: number): Promise<AgentLastMessageObserved> {
    const record = await this.deps.getTerminal(target.terminalId);
    const handback = record?.lastHandback;
    let snapshot: { data: string } | null;
    try {
      snapshot = await readTailSnapshot(
        (options) => this.deps.serializedState(target.terminalId, options),
        REPLY_SEARCH_ROWS
      );
    } catch {
      snapshot = null;
    }
    const extracted = snapshot
      ? this.deps.extractReply(
          snapshot.data,
          REPLY_READ_LINES,
          handback !== undefined ? { message: handback.message } : false,
          maxBytes
        )
      : { reply: null, reachedHandback: false };
    let text = extracted.reply?.text ?? "";
    let truncated = extracted.reply?.truncated ?? false;
    let source: AgentLastMessageObserved["source"] = extracted.reachedHandback
      ? "handback"
      : "screen";
    // The marker scrolled away, or the screen couldn't be read: its summary is what is left.
    if (!extracted.reachedHandback && handback !== undefined && handback.message !== null) {
      text = handback.message;
      truncated = handback.truncated === true;
      source = "handback";
    }
    const fitted = newestWithinEscapedBytes(text, maxBytes);
    return { status: "observed", source, text: fitted, truncated: truncated || fitted !== text };
  }

  private requireGeneration(
    caller: AssistantCaller,
    target: AssistantTarget,
    generation: number | undefined
  ): void {
    if (generation === undefined) {
      throw new AssistantTargetError(
        "VALIDATION_ERROR",
        `Sending to an assistant needs its 'generation' from 'assistant.list'. Nothing was sent.`
      );
    }
    const now = this.resolve(caller, target.terminalId);
    const live = this.deps.getLiveGeneration(target.terminalId);
    if (
      now === null ||
      now.sessionId !== target.sessionId ||
      live === null ||
      live !== generation
    ) {
      throw new AssistantTargetError(
        ASSISTANT_TARGET_REFUSALS.restarted,
        `Assistant terminal '${target.terminalId}' isn't the run that generation named; it was restarted or replaced. Nothing was sent. List the assistants again.`
      );
    }
  }

  private async entryFor(
    target: AssistantTarget,
    caller: AssistantCaller,
    laneAgentId: string | null
  ): Promise<AssistantEntry | null> {
    const generation = this.deps.getLiveGeneration(target.terminalId);
    if (generation === null) return null;
    const record = await this.deps.getTerminal(target.terminalId).catch(() => null);
    const agentState = record?.agentState ?? null;
    return {
      terminalId: target.terminalId,
      generation,
      slot: target.slot,
      agentId: record?.detectedAgentId ?? record?.launchAgentId ?? laneAgentId,
      agentState,
      waitingReason: agentState === "waiting" ? (record?.waitingReason ?? null) : null,
      attached: target.attached,
      startedByYou: wasStartedBy(target, caller),
    };
  }
}

/** The control as the app runs it, over the help sessions and the pty-host. */
export function liveAssistantTerminalControl(deps: {
  help: {
    listRunningLanes(): RunningLane[];
    getRunningLaneSession(projectId: string, slot: number): RunningLaneSession | null;
    revokeSession(sessionId: string): Promise<void>;
  };
  pty: () => PtyClient | null;
  extractReply: AssistantTerminalControlDeps["extractReply"];
}): AssistantTerminalControl {
  return new AssistantTerminalControl({
    listRunningLanes: () => deps.help.listRunningLanes(),
    getRunningLaneSession: (projectId, slot) => deps.help.getRunningLaneSession(projectId, slot),
    getTerminal: async (terminalId) => (await deps.pty()?.getTerminalAsync(terminalId)) ?? null,
    getLiveGeneration: (terminalId) => deps.pty()?.getLiveGeneration(terminalId) ?? null,
    serializedState: (terminalId, options) =>
      deps.pty()?.getSerializedStateAsync(terminalId, options) ?? Promise.resolve(null),
    submit: (terminalId, text, submissionToken, handbackCode) =>
      deps.pty()?.submit(terminalId, text, submissionToken, handbackCode, "settled-prompt"),
    doubleEscape: (terminalId) => deps.pty()?.batchDoubleEscape([terminalId]),
    launch: async (request) => {
      const { liveAssistantLaunchDeps, startAssistantWithoutView } =
        await import("./assistantLaunch.js");
      return startAssistantWithoutView(request, await liveAssistantLaunchDeps());
    },
    revoke: (sessionId) => deps.help.revokeSession(sessionId),
    extractReply: deps.extractReply,
  });
}

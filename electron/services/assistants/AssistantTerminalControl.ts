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
import { readTailSnapshot, tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import { stampAssistantPrompt } from "../../../shared/utils/assistantProvenance.js";
import { appendHandbackInstruction, mintHandbackCode } from "../../../shared/utils/handback.js";
import { assessInterruptCandidate } from "../../../shared/utils/terminalInterrupt.js";
import { buildTerminalSendCommandReceipt } from "../../../shared/utils/terminalSendCommandResult.js";
import { planChoice } from "../../../shared/utils/terminalChoice.js";
import {
  CHOOSE_SCREEN_LINES,
  keySequence,
  SEND_KEYS_GAP_MS,
  SEND_KEYS_SCREEN_LINES,
  SEND_KEYS_SETTLE_MS,
} from "../../../shared/utils/terminalKeys.js";
import {
  foreignInputMoved,
  foreignTypedInputAt,
  typedSinceSettle,
} from "../../../shared/utils/terminalInputProvenance.js";
import {
  evaluateWakeGate,
  ASSISTANT_SEND_GATE,
  type WakeBlockReason,
  type WakeGateVerdict,
} from "../../../shared/utils/terminalWakeGate.js";
import {
  helpOwnershipPrincipal,
  principalOwnerKey,
  relayOwnershipPrincipal,
} from "../mcp-server/resourceOwnership.js";
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
  lastOwnedInput?: { owner: string; at: number };
  lastForeignInputAt?: number;
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
  /** Under the strict settled-prompt guard, so the lane admits it only while the gate still holds. */
  /**
   * `promptAsWritten` is the brief before its provenance stamp and handback
   * instruction, for the run's first-prompt record (#15521).
   */
  submit(
    terminalId: string,
    text: string,
    submissionToken: string,
    handbackCode: string | undefined,
    promptAsWritten: string
  ): void;
  /** `inputOwner` files the keys under the caller in the pty host (#16094). */
  doubleEscape(terminalId: string, inputOwner: string): void;
  /** Raw bytes, as a person's keystrokes arrive, filed under `inputOwner`. */
  write(terminalId: string, data: string, inputOwner: string): void;
  launch(request: AssistantLaunchRequest): Promise<AssistantLaunchResult>;
  /** Ends the session, which kills its PTY. */
  revoke(sessionId: string): Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

/** How long a started assistant gets, once its screen is ready, to settle where a send is admitted. */
const START_SETTLE_WAIT_MS = 20_000;
const START_SETTLE_POLL_MS = 250;
/** What a started assistant's screen can show that no amount of waiting clears. */
const WAITING_WONT_CLEAR: ReadonlySet<WakeBlockReason> = new Set(["approval", "error"]);

/** A read that gives up, as unread, once `ms` pass; the timer never outlives it. */
function readWithin<T>(read: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([read.catch(() => null), late]).finally(() => clearTimeout(timer));
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

/**
 * Whose keys a caller's are to the pty host (#16094): the owner key its
 * session's ownership is held under, which outlives its MCP and link sessions.
 */
function inputOwnerOf(caller: AssistantCaller): string {
  return principalOwnerKey(
    caller.kind === "local"
      ? helpOwnershipPrincipal(caller.helpSessionId)
      : relayOwnershipPrincipal(caller.senderId, caller.helpSessionId)
  );
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

const OWN_KEYS_HELD_MESSAGE =
  "The only input at the assistant's prompt since it settled is keys you sent, which can leave text there. Nothing was sent; send once it has settled again.";

function busyMessage(verdict: Exclude<WakeGateVerdict, { kind: "ready" }>): string {
  switch (verdict.reason) {
    case "working":
      return "The assistant is mid-turn. Nothing was sent; send once it is waiting at its prompt.";
    case "typing":
      return "Someone has typed into the assistant's prompt since it settled. Nothing was sent, so their draft stays; send once it has settled again.";
    case "approval":
    case "question":
      return "The assistant is waiting on a dialog in its pane that only a person can answer. Nothing was sent.";
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
    const settled = result.ready ? await this.untilSendAdmitted(result.terminalId) : null;
    const ready = settled === "ready";
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
    return {
      assistant: entry,
      ready,
      notReadyReason: ready ? null : (settled ?? result.notReadyReason ?? "timed-out"),
    };
  }

  /**
   * Ready by its screen is not yet where a send is admitted: the greeting's
   * turn can still be finishing under a prompt the CLI already draws, and a
   * send then is refused as busy. Waits, bounded, for the gate `submit` asks,
   * so a send right after a start goes in. An approval or error on screen
   * won't clear by waiting. Each read counts against the same bound.
   */
  private async untilSendAdmitted(
    terminalId: string
  ): Promise<"ready" | NonNullable<AssistantStartResult["notReadyReason"]>> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = now() + START_SETTLE_WAIT_MS;
    for (;;) {
      const left = deadline - now();
      if (left <= 0) return "timed-out";
      const record = await readWithin(this.deps.getTerminal(terminalId), left);
      if (record) {
        const verdict = evaluateWakeGate(record, ASSISTANT_SEND_GATE);
        if (verdict.kind === "ready") return "ready";
        if (verdict.kind === "blocked" && WAITING_WONT_CLEAR.has(verdict.reason)) {
          return verdict.reason === "error" ? "agent-error" : "timed-out";
        }
      }
      if (now() >= deadline) return "timed-out";
      await sleep(START_SETTLE_POLL_MS);
    }
  }

  /**
   * Submit a prompt to an assistant (#13496): to the run `generation` names
   * and no other, stamped with where it came from, and only while it waits at
   * its prompt with nothing typed there since it settled. Refused rather than
   * queued otherwise, so a person's draft is never sent along with it or
   * interleaved with it, whichever machine asks. The strict settled-prompt
   * guard closes the gap between that read and the write, mid-turn included,
   * so a second brief sent alongside the first never lands in its turn.
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
    const verdict = evaluateWakeGate(record, ASSISTANT_SEND_GATE);
    if (verdict.kind !== "ready") {
      // Keys can leave text in the input that the send's Enter would take along (#16094).
      const ownKeys =
        verdict.reason === "typing" &&
        typedSinceSettle(record, inputOwnerOf(caller)) === "own-keys";
      throw new AssistantTargetError(
        ASSISTANT_TARGET_REFUSALS.busy,
        `${ownKeys ? OWN_KEYS_HELD_MESSAGE : busyMessage(verdict)} (state: ${record.agentState ?? "unknown"}${
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
        handbackCode,
        request.command
      );
    } else {
      this.deps.submit(target.terminalId, stamped, submissionToken, undefined, request.command);
    }
    return buildTerminalSendCommandReceipt(target.terminalId, request.command, submissionToken);
  }

  /**
   * Press keys in an assistant (#14548): to the run `generation` names, to
   * answer what its screen asks (an approval, a numbered choice). Unlike a
   * prompt this is admitted while it waits on such a question, but refused,
   * with nothing pressed, once anyone else typed there since its state last
   * changed: a person's draft is never edited or submitted by these keys. The
   * caller's own earlier keys don't count (#16094), and the receipt says so.
   */
  async sendKeys(
    caller: AssistantCaller,
    target: AssistantTarget,
    request: {
      keys: string[] | undefined;
      choose: string | undefined;
      generation: number | undefined;
    }
  ): Promise<{
    terminalId: string;
    keys: string[];
    screen?: string;
    inputSinceSettle?: "own-keys";
  }> {
    this.requireGeneration(caller, target, request.generation);
    const inputOwner = inputOwnerOf(caller);
    let record = await this.deps.getTerminal(target.terminalId);
    if (!record) {
      throw new AssistantTargetError(
        ASSISTANT_TARGET_REFUSALS.notFound,
        `Assistant terminal '${target.terminalId}' can't be read right now. Nothing was pressed.`
      );
    }
    this.requireKeysAdmitted(target, record, inputOwner);
    const readScreen = async (lines: number) => {
      const snapshot = await readTailSnapshot(
        (options) => this.deps.serializedState(target.terminalId, options),
        lines
      );
      return snapshot === null ? null : tailCapturedOutput(snapshot.data, lines, true).content;
    };
    let keys = request.keys;
    if (request.choose !== undefined) {
      const plan = planChoice((await readScreen(CHOOSE_SCREEN_LINES)) ?? "", request.choose);
      if (!plan.ok) {
        throw new AssistantTargetError("VALIDATION_ERROR", `${plan.reason} Nothing was pressed.`);
      }
      keys = plan.keys;
    }
    if (keys === undefined) {
      throw new AssistantTargetError(
        "VALIDATION_ERROR",
        "Pass `choose` or `keys`. Nothing was pressed."
      );
    }
    // The reads were async: the run must still be the one the caller named,
    // and nobody may have typed since, or the Enter would submit their draft.
    this.requireGeneration(caller, target, request.generation);
    if (request.choose !== undefined) {
      const fresh = await this.deps.getTerminal(target.terminalId);
      if (!fresh) {
        throw new AssistantTargetError(
          ASSISTANT_TARGET_REFUSALS.notFound,
          `Assistant terminal '${target.terminalId}' can't be read right now. Nothing was pressed.`
        );
      }
      this.requireKeysAdmitted(target, fresh, inputOwner);
      this.requireGeneration(caller, target, request.generation);
      record = fresh;
    }
    // Read before the first key, never after one: anyone else's input since
    // stops the rest, which our own keys stamping the record no longer hide.
    const foreignBefore = foreignTypedInputAt(record, inputOwner);
    const admittedOver =
      typedSinceSettle(record, inputOwner) === "own-keys"
        ? { inputSinceSettle: "own-keys" as const }
        : {};
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pressed: string[] = [];
    for (const [index, key] of keys.entries()) {
      if (index > 0) {
        await sleep(SEND_KEYS_GAP_MS);
        // A replaced run must not get the rest of the sequence.
        this.requireGeneration(caller, target, request.generation);
        const now = await this.deps.getTerminal(target.terminalId).catch(() => null);
        if (now === null || foreignInputMoved(now, inputOwner, foreignBefore)) {
          throw new AssistantTargetError(
            ASSISTANT_TARGET_REFUSALS.busy,
            `${
              now === null
                ? `Assistant terminal '${target.terminalId}' can't be read right now.`
                : `Someone typed in assistant terminal '${target.terminalId}' while the keys were going in.`
            } ${pressed.length} of ${keys.length} keys were sent (${pressed.join(", ")}); the rest weren't. Read the screen before pressing more, and never resend the whole sequence.`
          );
        }
      }
      this.deps.write(target.terminalId, keySequence(key), inputOwner);
      pressed.push(key);
    }
    await sleep(SEND_KEYS_SETTLE_MS);
    const screen = await readScreen(SEND_KEYS_SCREEN_LINES).catch(() => null);
    return { terminalId: target.terminalId, keys, ...(screen ? { screen } : {}), ...admittedOver };
  }

  private requireKeysAdmitted(
    target: AssistantTarget,
    record: AssistantTerminalRecord,
    inputOwner: string
  ): void {
    if (record.isExited === true || record.hasPty === false || record.isTrashed === true) {
      throw new AssistantTargetError(
        ASSISTANT_TARGET_REFUSALS.busy,
        `Assistant terminal '${target.terminalId}' has no running process to press keys in. Nothing was pressed.`
      );
    }
    if (typedSinceSettle(record, inputOwner) === "someone") {
      throw new AssistantTargetError(
        ASSISTANT_TARGET_REFUSALS.busy,
        `Someone has typed in assistant terminal '${target.terminalId}' since it last changed state, so keys could edit or submit their draft. Nothing was pressed.`
      );
    }
  }

  /** The double Escape is filed under `caller` (#16094), so it never locks the caller's next keys out. */
  async interrupt(
    caller: AssistantCaller,
    target: AssistantTarget
  ): Promise<{
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
    this.deps.doubleEscape(target.terminalId, inputOwnerOf(caller));
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
    submit: (terminalId, text, submissionToken, handbackCode, promptAsWritten) =>
      deps
        .pty()
        ?.submit(
          terminalId,
          text,
          submissionToken,
          handbackCode,
          "settled-prompt-strict",
          undefined,
          promptAsWritten
        ),
    doubleEscape: (terminalId, inputOwner) =>
      deps.pty()?.batchDoubleEscape([terminalId], inputOwner),
    write: (terminalId, data, inputOwner) =>
      deps.pty()?.write(terminalId, data, undefined, inputOwner),
    launch: async (request) => {
      const { liveAssistantLaunchDeps, startAssistantWithoutView } =
        await import("./assistantLaunch.js");
      return startAssistantWithoutView(request, await liveAssistantLaunchDeps());
    },
    revoke: (sessionId) => deps.help.revokeSession(sessionId),
    extractReply: deps.extractReply,
  });
}

import { randomUUID } from "node:crypto";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import { WORKER_STEER_REFUSALS } from "../../../shared/types/assistantControl.js";
import {
  CLAUDE_UPDATE_DELIVERY_MS,
  CLAUDE_UPDATE_NOT_OFFERED,
  CLAUDE_UPDATE_WAIT_MS,
  CLAUDE_UPDATE_WATCH_MS,
  type ApplyClaudeUpdateResult,
  type ClaudeUpdateNotSentReason,
} from "../../../shared/types/claudeUpdateApply.js";
import type { UpdateInstalledObservation } from "../../../shared/types/ipc/agent.js";
import type { ExactPromptGuard } from "../../../shared/types/pty-host.js";
import type { TerminalSubmissionRecord } from "../../../shared/types/terminalSubmission.js";
import {
  inputSuggestionRuleFor,
  observeInputLine,
} from "../../../shared/utils/terminalInputLine.js";
import { typedSinceSettle } from "../../../shared/utils/terminalInputProvenance.js";
import { EXACT_PROMPT_GATE, evaluateWakeGate } from "../../../shared/utils/terminalWakeGate.js";
import type { PtyClient } from "../PtyClient.js";
import { AssistantTargetError } from "./AssistantTerminalControl.js";
import { findClaudeRestartRefusal } from "./claudeRestartLines.js";

/** Typed alone, as Claude Code's own `/restart` takes it: no stamp, no handback. */
export const CLAUDE_RESTART_COMMAND = "/restart";
const POLL_MS = 200;
/**
 * How long a refusal must stop growing before it is quoted: past the
 * submission capture's own publish interval, so one read that repeats a
 * half-drawn row doesn't end it.
 */
const REFUSAL_SETTLE_MS = 600;
/** Ample for a viewport serialize; a read stuck past it reads as unread. */
const SCREEN_READ_MS = 1_500;

/** The pty-host record fields a request reads. */
export interface ClaudeUpdateRecord {
  isAssistantTerminal?: boolean;
  detectedAgentId?: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  lastTypedInputAt?: number;
  lastOwnedInput?: { owner: string; at: number };
  lastForeignInputAt?: number;
  lastOwnedPromptInput?: { owner: string; at: number };
  lastForeignPromptInputAt?: number;
  hasPendingSubmission?: boolean;
  isExited?: boolean;
  hasPty?: boolean;
  isTrashed?: boolean;
  isClosing?: boolean;
  agentIncarnation?: number;
  agentSessionId?: string;
  worktreeId?: string;
  updateInstalled?: UpdateInstalledObservation;
  submission?: TerminalSubmissionRecord;
}

export interface ClaudeUpdateApplyDeps {
  /** The record, with the named submission's when a token is given; null when it can't be read. */
  getTerminal(terminalId: string, submissionToken?: string): Promise<ClaudeUpdateRecord | null>;
  getLiveGeneration(terminalId: string): number | null;
  /** The screen as the terminal's mirror has parsed it; null when it can't be read. */
  serializedState(
    terminalId: string,
    options: { tailRows: number }
  ): Promise<{ data: string } | null>;
  /** Under the exact guard, so the host admits the line only while it still holds. */
  submit(
    terminalId: string,
    text: string,
    submissionToken: string,
    guard: ExactPromptGuard,
    inputOwner: string
  ): void;
  /** Takes back a line the host hasn't started writing. */
  withdraw(terminalId: string, submissionToken: string): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What the person is asked to approve, read before they are asked: the run,
 * the observation and the last prompt input. Anything that moves one of them
 * before the line goes in drops the request.
 */
export interface ClaudeUpdatePin {
  terminalId: string;
  generation: number;
  agentIncarnation?: number;
  agentSessionId?: string;
  worktreeId?: string;
  observedAt: number;
  promptInputAt?: number;
}

export interface ClaudeUpdateRequest {
  /** The caller's ownership principal: the line is filed as its prompt input once written. */
  inputOwner: string;
  /** Throws while the caller may no longer act here. Asked right before the line is handed over. */
  authorize(): void;
  signal?: AbortSignal;
  /** Epoch ms by which the line must be handed over, so the call can still answer in time. */
  deadline?: number;
}

type Check =
  | { kind: "ready" }
  | { kind: "wait"; on: string }
  | { kind: "drop"; reason: ClaudeUpdateNotSentReason; why: string };

const NOTHING_SENT = "Nothing was sent.";

// A function, so a read after an await isn't narrowed by one before it.
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function refuse(code: string, message: string): never {
  throw new AssistantTargetError(code, message);
}

/** The last input anyone gave the pane that it could take as a prompt. */
function lastPromptInputAt(record: ClaudeUpdateRecord): number | undefined {
  const owned = record.lastOwnedPromptInput?.at;
  const foreign = record.lastForeignPromptInputAt;
  if (owned === undefined) return foreign;
  return foreign === undefined ? owned : Math.max(owned, foreign);
}

function goneWhy(terminalId: string, record: ClaudeUpdateRecord): string | null {
  if (record.isAssistantTerminal === true) {
    return `Terminal '${terminalId}' runs a Daintree Assistant, not a worker.`;
  }
  if (record.isExited === true || record.hasPty === false) {
    return `Terminal '${terminalId}' has no running process.`;
  }
  if (record.isTrashed === true) return `Terminal '${terminalId}' is in the trash.`;
  if (record.isClosing === true) return `Terminal '${terminalId}' is closing.`;
  return null;
}

/** What Claude Code's input box showed, as the global close reads it (#16750). */
type InputBox = "clear" | "draft" | "unread";

function boxDraftWhy(terminalId: string): string {
  return `Claude Code's input box in terminal '${terminalId}' shows typed text, which /restart would join.`;
}

/**
 * One Claude Code update an assistant asked to apply (#17908). Main reads the
 * pane before anyone is asked and pins what it saw; once the person approved,
 * it waits for the pane's own empty prompt and hands `/restart` to the
 * terminal once, under the exact guard pinned to that run and that
 * observation, then reads what the terminal drew after the Enter. A Claude
 * refusal ends it; nothing is ever sent twice. One request per pane at a time.
 */
export class ClaudeUpdateApply {
  private readonly requests = new Set<string>();

  constructor(private readonly deps: ClaudeUpdateApplyDeps) {}

  /**
   * Holds the pane for one request, across its preflight, its approval and its
   * wait; a second request for the same pane is refused until it ends.
   */
  async exclusive<T>(terminalId: string, run: () => Promise<T>): Promise<T> {
    if (this.requests.has(terminalId)) {
      refuse(
        WORKER_STEER_REFUSALS.busy,
        `An update for terminal '${terminalId}' is already waiting to be applied. ${NOTHING_SENT}`
      );
    }
    this.requests.add(terminalId);
    try {
      return await run();
    } finally {
      this.requests.delete(terminalId);
    }
  }

  /**
   * Whether the pane offers `/restart` right now, refused with nothing asked
   * when it doesn't. `generation` is the run the caller named, when it named one.
   */
  async preflight(
    terminalId: string,
    generation: number | undefined,
    inputOwner: string
  ): Promise<ClaudeUpdatePin> {
    const live = this.deps.getLiveGeneration(terminalId);
    if (live === null) {
      refuse(
        WORKER_STEER_REFUSALS.notFound,
        `No terminal '${terminalId}' is running. ${NOTHING_SENT}`
      );
    }
    const restarted = (): never =>
      refuse(
        WORKER_STEER_REFUSALS.restarted,
        `Terminal '${terminalId}' isn't the run that generation named: it was restarted or replaced. ${NOTHING_SENT}`
      );
    if (generation !== undefined && generation !== live) restarted();
    const record = await this.deps.getTerminal(terminalId).catch(() => null);
    if (record === null) {
      refuse(
        WORKER_STEER_REFUSALS.notFound,
        `Terminal '${terminalId}' can't be read right now. ${NOTHING_SENT}`
      );
    }
    if (this.deps.getLiveGeneration(terminalId) !== live) restarted();
    const gone = goneWhy(terminalId, record);
    if (gone !== null) refuse(WORKER_STEER_REFUSALS.notAgent, `${gone} ${NOTHING_SENT}`);
    if (record.detectedAgentId !== "claude") {
      refuse(
        CLAUDE_UPDATE_NOT_OFFERED,
        `Claude Code isn't seen running in terminal '${terminalId}' (${
          record.detectedAgentId === undefined
            ? "no agent is detected there"
            : `it runs ${record.detectedAgentId}`
        }), and only Claude Code's /restart is applied this way. ${NOTHING_SENT}`
      );
    }
    const observed = record.updateInstalled;
    if (observed === undefined) {
      refuse(
        CLAUDE_UPDATE_NOT_OFFERED,
        `Claude Code in terminal '${terminalId}' hasn't shown its "Update installed" footer in this run, so there is nothing to apply. ${NOTHING_SENT}`
      );
    }
    if (!observed.namesRestart) {
      refuse(
        CLAUDE_UPDATE_NOT_OFFERED,
        `The "Update installed" footer in terminal '${terminalId}' didn't name /restart, so Claude Code doesn't offer to apply it in place there. ${NOTHING_SENT} The person can restart that agent themselves.`
      );
    }
    if (record.hasPendingSubmission === true) {
      refuse(
        WORKER_STEER_REFUSALS.typing,
        `A submission is still being written to terminal '${terminalId}'. ${NOTHING_SENT}`
      );
    }
    const typed = typedSinceSettle(record, inputOwner);
    if (record.lastStateChange === undefined || typed !== "nothing") {
      refuse(
        WORKER_STEER_REFUSALS.typing,
        record.lastStateChange === undefined
          ? `Terminal '${terminalId}' hasn't been seen settling, so a draft in it can't be ruled out. ${NOTHING_SENT}`
          : typed === "own-keys"
            ? `The only input in terminal '${terminalId}' since its agent last settled is keys you sent, which can leave text at its prompt. ${NOTHING_SENT} Ask again once the agent settles.`
            : `Someone has typed into terminal '${terminalId}' since its agent last settled, so their input stays as it is. ${NOTHING_SENT}`
      );
    }
    // A settle clears the record's typing, not the box: a draft typed while
    // the agent worked is still there at its prompt. Mid-turn a dialog can
    // stand in the box's place, so an unread box there is left to the read
    // made once the pane is ready.
    const box = await this.inputBox(terminalId);
    if (this.deps.getLiveGeneration(terminalId) !== live) restarted();
    if (box === "draft")
      refuse(WORKER_STEER_REFUSALS.typing, `${boxDraftWhy(terminalId)} ${NOTHING_SENT}`);
    if (box === "unread" && evaluateWakeGate(record, EXACT_PROMPT_GATE).kind === "ready") {
      refuse(
        WORKER_STEER_REFUSALS.typing,
        `Claude Code's input box in terminal '${terminalId}' couldn't be read, so a draft in it can't be ruled out. ${NOTHING_SENT}`
      );
    }
    return {
      terminalId,
      generation: live,
      ...(record.agentIncarnation !== undefined
        ? { agentIncarnation: record.agentIncarnation }
        : {}),
      ...(record.agentSessionId !== undefined ? { agentSessionId: record.agentSessionId } : {}),
      ...(record.worktreeId !== undefined ? { worktreeId: record.worktreeId } : {}),
      observedAt: observed.observedAt,
      ...(lastPromptInputAt(record) !== undefined
        ? { promptInputAt: lastPromptInputAt(record) }
        : {}),
    };
  }

  /**
   * Apply an approved request: wait for the pane's own empty prompt, hand the
   * terminal `/restart` once, and report what was seen.
   */
  async apply(
    pin: ClaudeUpdatePin,
    request: ClaudeUpdateRequest
  ): Promise<ApplyClaudeUpdateResult> {
    const { terminalId } = pin;
    const deadline = Math.min(
      this.now() + CLAUDE_UPDATE_WAIT_MS,
      request.deadline ?? Number.POSITIVE_INFINITY
    );
    for (;;) {
      if (aborted(request.signal)) {
        return this.notSent(pin, "cancelled", "The call ended before the pane was ready.");
      }
      const before = await this.deps.getTerminal(terminalId).catch(() => null);
      let check = this.check(pin, before);
      if (check.kind === "drop") return this.notSent(pin, check.reason, check.why);
      if (check.kind === "ready") {
        // The record can't show a draft from before the pane settled; the box
        // can. The record read after it answers first: a run replaced, or
        // keys typed while the box was read.
        const box = await this.inputBox(terminalId, request.signal);
        if (aborted(request.signal)) {
          return this.notSent(pin, "cancelled", "The call ended before the pane was ready.");
        }
        const after = await this.deps.getTerminal(terminalId).catch(() => null);
        check = this.check(pin, after);
        if (check.kind === "drop") return this.notSent(pin, check.reason, check.why);
        if (box === "draft") return this.notSent(pin, "typed", boxDraftWhy(terminalId));
        if (check.kind === "ready") {
          // As the global close reads its box: what was read holds only for a
          // pane that neither settled nor was typed into meanwhile.
          if (box === "unread") check = { kind: "wait", on: "an input box that couldn't be read" };
          else if (
            after!.lastStateChange !== before!.lastStateChange ||
            after!.lastTypedInputAt !== before!.lastTypedInputAt
          ) {
            check = { kind: "wait", on: "a pane that changed while its input box was read" };
          }
        }
        if (check.kind === "ready") break;
      }
      if (this.now() + POLL_MS >= deadline) {
        return this.notSent(
          pin,
          "expired",
          `The pane didn't wait at its own empty prompt within ${Math.round(
            CLAUDE_UPDATE_WAIT_MS / 1000
          )}s (last seen: ${check.on}).`
        );
      }
      await this.sleep(POLL_MS);
    }
    // The ready read was awaited: the call may have ended, or its time run
    // out, while it was in flight. Nothing is typed for a caller already answered.
    if (aborted(request.signal)) {
      return this.notSent(pin, "cancelled", "The call ended before the pane was ready.");
    }
    if (this.now() >= deadline) {
      return this.notSent(
        pin,
        "expired",
        "The pane reached its empty prompt only after the request's time ran out."
      );
    }
    try {
      request.authorize();
    } catch (error) {
      if (!(error instanceof AssistantTargetError)) throw error;
      return this.notSent(pin, "not-allowed", error.message);
    }
    const token = randomUUID();
    let withdrawn = false;
    const withdraw = () => {
      if (withdrawn) return;
      withdrawn = true;
      this.deps.withdraw(terminalId, token);
    };
    // A call that ends once the line is handed over takes it back at once,
    // not at its next read: the terminal presses Enter on its own timer.
    request.signal?.addEventListener("abort", withdraw, { once: true });
    try {
      this.deps.submit(
        terminalId,
        CLAUDE_RESTART_COMMAND,
        token,
        {
          kind: "settled-prompt-exact",
          ...(pin.agentIncarnation !== undefined ? { agentIncarnation: pin.agentIncarnation } : {}),
          ...(pin.agentSessionId !== undefined ? { agentSessionId: pin.agentSessionId } : {}),
          updateObservedAt: pin.observedAt,
        },
        request.inputOwner
      );
      if (aborted(request.signal)) withdraw();
      return await this.follow(pin, token, withdraw);
    } finally {
      request.signal?.removeEventListener("abort", withdraw);
    }
  }

  /** Read off the parsed screen, given up on at {@link SCREEN_READ_MS} or when the call ends. */
  private async inputBox(terminalId: string, signal?: AbortSignal): Promise<InputBox> {
    if (aborted(signal)) return "unread";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    const cutoff = new Promise<null>((resolve) => {
      stop = () => resolve(null);
      timer = setTimeout(stop, SCREEN_READ_MS);
      signal?.addEventListener("abort", stop, { once: true });
    });
    try {
      const snapshot = await Promise.race([
        this.deps.serializedState(terminalId, { tailRows: 0 }).catch(() => null),
        cutoff,
      ]);
      if (snapshot === null) return "unread";
      const { state } = observeInputLine(snapshot.data, inputSuggestionRuleFor("claude")).inputLine;
      if (state === "empty" || state === "suggestion") return "clear";
      return state === "typed" ? "draft" : "unread";
    } finally {
      clearTimeout(timer);
      if (stop) signal?.removeEventListener("abort", stop);
    }
  }

  /** What the pane looks like to the request now. */
  private check(pin: ClaudeUpdatePin, record: ClaudeUpdateRecord | null): Check {
    const { terminalId } = pin;
    if (this.deps.getLiveGeneration(terminalId) !== pin.generation) {
      return {
        kind: "drop",
        reason: "restarted",
        why: `Terminal '${terminalId}' was restarted or replaced.`,
      };
    }
    // A read that failed says nothing about the pane: the next one may.
    if (record === null) return { kind: "wait", on: "an unreadable record" };
    const gone = goneWhy(terminalId, record);
    if (gone !== null) return { kind: "drop", reason: "target-gone", why: gone };
    if (
      record.detectedAgentId !== "claude" ||
      record.agentIncarnation !== pin.agentIncarnation ||
      (pin.agentSessionId !== undefined && record.agentSessionId !== pin.agentSessionId) ||
      (record.worktreeId ?? "") !== (pin.worktreeId ?? "")
    ) {
      return {
        kind: "drop",
        reason: "restarted",
        why: `The Claude Code run in terminal '${terminalId}' isn't the one approved: it ended or changed.`,
      };
    }
    const promptInputAt = lastPromptInputAt(record);
    if (
      promptInputAt !== undefined &&
      (pin.promptInputAt === undefined || promptInputAt > pin.promptInputAt)
    ) {
      return {
        kind: "drop",
        reason: "typed",
        why: `Terminal '${terminalId}' was given input it could take as a prompt after the update was asked for.`,
      };
    }
    const observed = record.updateInstalled;
    if (observed?.observedAt !== pin.observedAt || !observed.namesRestart) {
      return {
        kind: "drop",
        reason: "observation-changed",
        why: `The "Update installed" footer it was approved on is no longer what terminal '${terminalId}' reports.`,
      };
    }
    if (record.hasPendingSubmission === true) return { kind: "wait", on: "a submission going in" };
    const verdict = evaluateWakeGate(record, EXACT_PROMPT_GATE);
    if (verdict.kind === "ready") return verdict;
    return { kind: "wait", on: verdict.reason };
  }

  /** Follow the line the terminal was handed to its end, then read Claude's answer. */
  private async follow(
    pin: ClaudeUpdatePin,
    token: string,
    withdraw: () => void
  ): Promise<ApplyClaudeUpdateResult> {
    const { terminalId } = pin;
    const handedAt = this.now();
    let written: TerminalSubmissionRecord | undefined;
    while (written === undefined) {
      const record = await this.deps.getTerminal(terminalId, token).catch(() => null);
      const submission = record?.submission;
      switch (submission?.phase) {
        case "pty_written":
          written = submission;
          continue;
        // Refused as it reached the lane, taken back, or its Enter held back
        // after the line went in: the record doesn't say which.
        case "cancelled":
          return {
            terminalId,
            status: "not-sent",
            reason: "withheld",
            message:
              "Enter wasn't pressed: the terminal refused the line, it was taken back, or the pane changed after it went in. If it had gone in, `/restart` may sit typed at the prompt. A later attempt needs a new request and approval.",
          };
        case "failed":
          return {
            terminalId,
            status: "unconfirmed",
            message:
              "Writing the line failed partway: part of `/restart` may sit at the prompt, and Enter may not have been pressed. It won't be sent again.",
          };
        case "unknown":
          return {
            terminalId,
            status: "unconfirmed",
            message:
              "The terminal holds no record of the line, so whether `/restart` went in is unknown. It won't be sent again.",
          };
        default:
          break;
      }
      // A pane trashed or closing while the line waits for its Enter (a close
      // of the same worker, #16750) takes it back; what the terminal did with
      // it still decides the answer.
      if (record !== null && goneWhy(terminalId, record) !== null) withdraw();
      if (this.now() - handedAt >= CLAUDE_UPDATE_DELIVERY_MS) {
        withdraw();
        return {
          terminalId,
          status: "unconfirmed",
          message:
            "The terminal hadn't written the line in time, so taking it back was asked for; whether it went in is unknown, and `/restart` may sit at the prompt. It won't be sent again.",
        };
      }
      await this.sleep(POLL_MS / 2);
    }
    return this.watch(pin, token, written);
  }

  /**
   * Read what the terminal drew after the Enter, until a refusal shows or the
   * watch ends. A refusal is quoted once it has stopped growing for
   * {@link REFUSAL_SETTLE_MS}, so a row still being drawn isn't cut short,
   * and a sighting is never taken back.
   */
  private async watch(
    pin: ClaudeUpdatePin,
    token: string,
    written: TerminalSubmissionRecord
  ): Promise<ApplyClaudeUpdateResult> {
    const { terminalId } = pin;
    const until = this.now() + CLAUDE_UPDATE_WATCH_MS;
    let latest = written;
    // Whether the last read reached this line's record: a capture that can't
    // be followed any more is no evidence that nothing came after it.
    let followed = true;
    let seen: { text: string; at: number } | null = null;
    for (;;) {
      const output = latest.output;
      const complete =
        output !== undefined && followed && output.state !== "lost" && !output.truncated;
      const refusal = output === undefined ? null : findClaudeRestartRefusal(output.text);
      // The same refusal drawn further: a different one is someone else's.
      if (
        refusal !== null &&
        (seen === null || (refusal !== seen.text && refusal.startsWith(seen.text)))
      ) {
        seen = { text: refusal, at: this.now() };
      }
      if (seen !== null) {
        const settled = this.now() - seen.at >= REFUSAL_SETTLE_MS;
        const done = output !== undefined && output.state !== "capturing";
        if (settled || done || this.now() >= until + REFUSAL_SETTLE_MS) {
          return {
            terminalId,
            status: "sent",
            refusal: seen.text,
            // Cut off before it stopped growing, the quote may be part of the line.
            output: complete && settled ? "read" : "lost",
            message:
              "`/restart` was typed and Enter pressed; Claude Code answered with a refusal, quoted as drawn. It won't be sent again: a later attempt is a new request.",
          };
        }
      } else {
        // Nothing more will be drawn into it: the run moved on, or what was kept is all there is.
        const ended = output !== undefined && output.state !== "capturing";
        if (ended || this.now() >= until) {
          return {
            terminalId,
            status: "sent",
            refusal: null,
            output: complete ? "read" : output === undefined && followed ? "unavailable" : "lost",
            message: complete
              ? `\`/restart\` was typed and Enter pressed; no refusal from Claude Code was seen in what the terminal drew after it${ended ? "" : ` in ${Math.round(CLAUDE_UPDATE_WATCH_MS / 1000)}s`}. Whether the conversation came back isn't known from here: check the pane.`
              : "`/restart` was typed and Enter pressed, but what the terminal drew after it couldn't all be read, so a refusal can't be ruled out. Check the pane before asking again.",
          };
        }
      }
      await this.sleep(POLL_MS);
      const next = (await this.deps.getTerminal(terminalId, token).catch(() => null))?.submission;
      followed = next?.phase === "pty_written";
      if (followed) latest = next!;
    }
  }

  private notSent(
    pin: ClaudeUpdatePin,
    reason: ClaudeUpdateNotSentReason,
    why: string
  ): ApplyClaudeUpdateResult {
    return {
      terminalId: pin.terminalId,
      status: "not-sent",
      reason,
      message: `${why} ${NOTHING_SENT} A later attempt needs a new request and approval.`,
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((wait) => new Promise((resolve) => setTimeout(resolve, wait))))(ms);
  }
}

/** The request as the app runs it, over the pty-host. */
export function liveClaudeUpdateApply(pty: () => PtyClient | null): ClaudeUpdateApply {
  return new ClaudeUpdateApply({
    getTerminal: async (terminalId, submissionToken) =>
      (await pty()?.getTerminalAsync(terminalId, submissionToken)) ?? null,
    getLiveGeneration: (terminalId) => pty()?.getLiveGeneration(terminalId) ?? null,
    serializedState: (terminalId, options) =>
      pty()?.getSerializedStateAsync(terminalId, options) ?? Promise.resolve(null),
    submit: (terminalId, text, submissionToken, guard, inputOwner) =>
      pty()?.submit(
        terminalId,
        text,
        submissionToken,
        undefined,
        guard,
        undefined,
        null,
        undefined,
        inputOwner
      ),
    withdraw: (terminalId, submissionToken) =>
      pty()?.withdrawGuardedSubmission(terminalId, submissionToken),
  });
}

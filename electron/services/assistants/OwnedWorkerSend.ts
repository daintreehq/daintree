import { randomUUID } from "node:crypto";
import { WORKER_STEER_REFUSALS } from "../../../shared/types/assistantControl.js";
import type { ExactPromptGuard } from "../../../shared/types/pty-host.js";
import type { QueuedSendReceipt } from "../../../shared/types/queuedSend.js";
import { appendHandbackInstruction, mintHandbackCode } from "../../../shared/utils/handback.js";
import { typedSinceSettle } from "../../../shared/utils/terminalInputProvenance.js";
import {
  buildTerminalSendCommandReceipt,
  MAX_ECHOED_COMMAND_CHARS,
  type TerminalSendCommandReceipt,
} from "../../../shared/utils/terminalSendCommandResult.js";
import {
  ASSISTANT_SEND_GATE,
  choiceDialogRefusalMessage,
  evaluateWakeGate,
} from "../../../shared/utils/terminalWakeGate.js";
import type { PendingNotify } from "../mcp-server/terminalNotify.js";
import type { PtyClient } from "../PtyClient.js";
import { AssistantTargetError } from "./AssistantTerminalControl.js";
import type { WorkerSteerRecord } from "./GlobalWorkerSteer.js";
import { HoldRefusedError, type WorkerSteerQueue } from "./WorkerSteerQueue.js";

export interface OwnedWorkerSendDeps {
  getTerminalProjectId(terminalId: string): string | null;
  getLiveGeneration(terminalId: string): number | null;
  getTerminal(terminalId: string): Promise<WorkerSteerRecord | null>;
  /**
   * Under `guard`, so a turn that starts after the read, or another agent
   * taking the PTY, keeps the line out. `promptOwner` files the line as the
   * caller's prompt input once written, so its own held send isn't dropped as typed.
   */
  submit(
    terminalId: string,
    text: string,
    submissionToken: string,
    handbackCode: string | undefined,
    guard: ExactPromptGuard,
    promptOwner: string
  ): void;
  /** Where a send for a busy worker is held; null, none is. */
  queue(): Pick<WorkerSteerQueue, "hold"> | null;
}

/** A terminal the call launched or was handed, as the ownership gate admitted it. */
export interface OwnedSendTarget {
  terminalId: string;
  /** The caller's ownership principal: one held send per principal and worker. */
  inputOwner: string;
  /**
   * Throws while the call may no longer write to the terminal, in the project
   * the pty-host places it in, right before a write or a hold.
   */
  authorize(projectId: string): void;
  /**
   * Asked right before a held send is written, long after the call that held
   * it, whose MCP session may have closed: null while it may go ahead.
   */
  authorizeHeld(projectId: string): { code: string; message: string } | null;
}

export interface OwnedSendRequest {
  command: string;
  handback: boolean;
  /** The run the caller named, when it named one; otherwise the one running now. */
  generation?: number;
  whenBusy: OwnedWhenBusy;
}

export type OwnedWhenBusy =
  | { kind: "refuse" }
  | {
      kind: "queue";
      ttlSeconds: number;
      /** Takes the call's armed `notify` once the send is held, for the line to complete. */
      takeNotice?: () => PendingNotify | undefined;
      /** Told once the held line is written, when no notice follows it. */
      onWritten?: () => void;
    };

const NOTHING_SENT = "Nothing was sent.";

function refuse(code: string, message: string): never {
  throw new AssistantTargetError(code, message);
}

/**
 * An explicit `whenBusy` on a send to the caller's own worker (#18172). With
 * none, the owned send types at once, mid-turn too, which is how a caller
 * steers its own worker. With one, the worker is read here: a worker at its
 * prompt gets the line, guarded to the run that was read; a busy one gets nothing
 * (`refuse`), or the line is held for its next prompt (`queue`), waiting out
 * an approval as well as a turn, since only the person answers one.
 */
export class OwnedWorkerSend {
  /** Terminals a call here is reading or writing: a second at once is refused. */
  private readonly writing = new Set<string>();

  constructor(private readonly deps: OwnedWorkerSendDeps) {}

  async prompt(
    target: OwnedSendTarget,
    request: OwnedSendRequest
  ): Promise<TerminalSendCommandReceipt | QueuedSendReceipt> {
    const { terminalId } = target;
    if (this.writing.has(terminalId)) {
      refuse(
        WORKER_STEER_REFUSALS.busy,
        `Another call is still writing to terminal '${terminalId}'. ${NOTHING_SENT}`
      );
    }
    this.writing.add(terminalId);
    try {
      return await this.decide(target, request);
    } finally {
      this.writing.delete(terminalId);
    }
  }

  private async decide(
    target: OwnedSendTarget,
    request: OwnedSendRequest
  ): Promise<TerminalSendCommandReceipt | QueuedSendReceipt> {
    const { terminalId } = target;
    const generation = this.deps.getLiveGeneration(terminalId);
    const projectId = this.deps.getTerminalProjectId(terminalId);
    if (generation === null || projectId === null) {
      refuse(
        WORKER_STEER_REFUSALS.notFound,
        `Terminal '${terminalId}' has no running process. ${NOTHING_SENT}`
      );
    }
    // A run the caller named holds it to that run: a relaunch under the id
    // must not take what was meant for the one before.
    if (request.generation !== undefined && request.generation !== generation) {
      refuse(
        WORKER_STEER_REFUSALS.restarted,
        `Terminal '${terminalId}' isn't the run that generation named: it was restarted or replaced. ${NOTHING_SENT}`
      );
    }
    const record = await this.deps.getTerminal(terminalId).catch(() => null);
    if (record === null || (record.projectId !== undefined && record.projectId !== projectId)) {
      refuse(
        WORKER_STEER_REFUSALS.notFound,
        `Terminal '${terminalId}' can't be read right now. ${NOTHING_SENT}`
      );
    }
    if (this.deps.getLiveGeneration(terminalId) !== generation) {
      refuse(
        WORKER_STEER_REFUSALS.restarted,
        `Terminal '${terminalId}' was restarted while it was read. ${NOTHING_SENT}`
      );
    }
    if (record.isExited === true || record.hasPty === false || record.isTrashed === true) {
      refuse(
        WORKER_STEER_REFUSALS.notAgent,
        `Terminal '${terminalId}' has no running process, or is in the trash. ${NOTHING_SENT}`
      );
    }
    if (record.detectedAgentId === undefined) {
      refuse(
        "VALIDATION_ERROR",
        `\`whenBusy\` waits on an agent, and none is seen running in terminal '${terminalId}'. ${NOTHING_SENT} Send without \`whenBusy\`.`
      );
    }
    // The gate a send to any other worker asks: a question asked in prose is
    // still its prompt, and never mid-turn.
    const verdict = evaluateWakeGate(record, ASSISTANT_SEND_GATE);
    if (verdict.kind === "ready") {
      if (record.hasPendingSubmission === true) {
        refuse(
          WORKER_STEER_REFUSALS.typing,
          `A submission is still being written to terminal '${terminalId}'. ${NOTHING_SENT}`
        );
      }
      target.authorize(projectId);
      const submissionToken = randomUUID();
      const handbackCode = request.handback ? mintHandbackCode() : undefined;
      this.deps.submit(
        terminalId,
        handbackCode
          ? appendHandbackInstruction(request.command, handbackCode, "run")
          : request.command,
        submissionToken,
        handbackCode,
        {
          kind: "settled-prompt-exact",
          ...(record.agentIncarnation !== undefined
            ? { agentIncarnation: record.agentIncarnation }
            : {}),
          ...(record.agentSessionId !== undefined ? { agentSessionId: record.agentSessionId } : {}),
          agentId: record.detectedAgentId,
          acceptQuestion: true,
        },
        target.inputOwner
      );
      return buildTerminalSendCommandReceipt(terminalId, request.command, submissionToken);
    }
    const { whenBusy } = request;
    if (
      whenBusy.kind === "queue" &&
      ((verdict.kind === "hold" && verdict.reason === "working") ||
        (verdict.kind === "blocked" && verdict.reason === "approval"))
    ) {
      return this.hold(
        target,
        record,
        { generation, projectId },
        request.command,
        request.handback,
        {
          ...whenBusy,
          waitingOn: verdict.reason,
        }
      );
    }
    if (verdict.kind === "hold" && verdict.reason === "typing") {
      refuse(
        WORKER_STEER_REFUSALS.typing,
        typedSinceSettle(record, target.inputOwner) === "own-keys"
          ? `The only input in terminal '${terminalId}' since its agent last settled is keys you sent, which can leave text at its prompt. ${NOTHING_SENT} Send once the agent settles again.`
          : `Someone has typed into terminal '${terminalId}' since its agent last settled, so their input stays as it is. ${NOTHING_SENT}`
      );
    }
    if (verdict.kind === "hold") {
      refuse(
        WORKER_STEER_REFUSALS.busy,
        `Terminal '${terminalId}' is working. ${NOTHING_SENT} Send without \`whenBusy\` to type it mid-turn, or with \`whenBusy: "queue"\` to hold it for its next prompt.`
      );
    }
    if (verdict.reason === "approval") {
      refuse(WORKER_STEER_REFUSALS.busy, choiceDialogRefusalMessage(terminalId, record));
    }
    refuse(
      WORKER_STEER_REFUSALS.busy,
      `Terminal '${terminalId}' isn't waiting at its agent's prompt (state: ${record.agentState ?? "unknown"}${
        record.waitingReason ? `, ${record.waitingReason}` : ""
      }). ${NOTHING_SENT}${
        whenBusy.kind === "queue"
          ? " A message is held only while its agent works or waits on an approval."
          : ""
      }`
    );
  }

  /** Hold the line for the worker's next own prompt; nothing is written here. */
  private hold(
    target: OwnedSendTarget,
    record: WorkerSteerRecord,
    run: { generation: number; projectId: string },
    command: string,
    handback: boolean,
    whenBusy: Extract<OwnedWhenBusy, { kind: "queue" }> & { waitingOn: string }
  ): QueuedSendReceipt {
    const { terminalId, inputOwner } = target;
    // A command landing at a moment nobody saw could arrive as prose instead.
    if (command.trimStart().startsWith("/")) {
      refuse(
        "VALIDATION_ERROR",
        `A slash command isn't held for its next prompt. ${NOTHING_SENT} Send it once the agent is waiting.`
      );
    }
    const queue = this.deps.queue();
    if (queue === null) {
      refuse(
        WORKER_STEER_REFUSALS.busy,
        `This host can't hold a message for terminal '${terminalId}' right now. ${NOTHING_SENT} Send once it is waiting.`
      );
    }
    // A draft typed mid-turn is still in the composer when the turn ends.
    if (record.hasPendingSubmission === true) {
      refuse(
        WORKER_STEER_REFUSALS.typing,
        `A submission is still being written to terminal '${terminalId}'. ${NOTHING_SENT}`
      );
    }
    if (record.lastStateChange === undefined) {
      refuse(
        WORKER_STEER_REFUSALS.typing,
        `Terminal '${terminalId}' hasn't been seen settling, so a draft in it can't be ruled out. ${NOTHING_SENT}`
      );
    }
    // Keys at an approval move its selector and never reach the prompt; the
    // held send drops only on input that could have (`recheck`).
    const typed =
      whenBusy.waitingOn === "approval" ? "nothing" : typedSinceSettle(record, inputOwner);
    if (typed === "someone") {
      refuse(
        WORKER_STEER_REFUSALS.typing,
        `Someone has typed into terminal '${terminalId}' since its agent last settled, so their input stays as it is. ${NOTHING_SENT}`
      );
    }
    if (typed === "own-keys") {
      refuse(
        WORKER_STEER_REFUSALS.typing,
        `The only input in terminal '${terminalId}' since its agent last settled is keys you sent, which can leave text at its prompt. ${NOTHING_SENT} Send once the agent settles again.`
      );
    }
    target.authorize(run.projectId);
    const handbackCode = handback ? mintHandbackCode() : undefined;
    let held: ReturnType<WorkerSteerQueue["hold"]>;
    try {
      held = queue.hold({
        principal: inputOwner,
        projectId: run.projectId,
        terminalId,
        generation: run.generation,
        run: {
          ...(record.agentIncarnation !== undefined
            ? { agentIncarnation: record.agentIncarnation }
            : {}),
          ...(record.agentSessionId !== undefined ? { agentSessionId: record.agentSessionId } : {}),
          ...(record.worktreeId !== undefined ? { worktreeId: record.worktreeId } : {}),
          ...(record.detectedAgentId !== undefined ? { agentId: record.detectedAgentId } : {}),
          ...(record.lastOwnedPromptInput !== undefined
            ? { lastOwnedPromptInput: record.lastOwnedPromptInput }
            : {}),
          ...(record.lastForeignPromptInputAt !== undefined
            ? { lastForeignPromptInputAt: record.lastForeignPromptInputAt }
            : {}),
        },
        // The caller's own text, unstamped, as its immediate send would type it.
        text: handbackCode ? appendHandbackInstruction(command, handbackCode, "run") : command,
        promptAsWritten: command,
        ...(handbackCode !== undefined ? { handbackCode } : {}),
        ttlSeconds: whenBusy.ttlSeconds,
        waitingOn: whenBusy.waitingOn,
        authorize: () => target.authorizeHeld(run.projectId),
        isWriting: () => this.writing.has(terminalId),
        ...(whenBusy.takeNotice !== undefined ? { takeNotice: whenBusy.takeNotice } : {}),
        ...(whenBusy.onWritten !== undefined ? { onWritten: whenBusy.onWritten } : {}),
      });
    } catch (error) {
      if (!(error instanceof HoldRefusedError)) throw error;
      refuse(
        WORKER_STEER_REFUSALS.busy,
        `Terminal '${terminalId}' isn't waiting at its agent's prompt. ${error.message} ${NOTHING_SENT}`
      );
    }
    const superseded = held.supersededToken
      ? ` It replaces your earlier held message ${held.supersededToken}, which won't be sent.`
      : "";
    return {
      sent: false,
      queued: true,
      terminalId,
      command: command.slice(0, MAX_ECHOED_COMMAND_CHARS),
      queuedSendToken: held.queuedSendToken,
      expiresAt: held.expiresAt,
      ...(held.supersededToken ? { supersededToken: held.supersededToken } : {}),
      message: `Held, not sent: it is typed the next time the agent waits at its own prompt with nothing typed there, and dropped if it is sent another prompt first (yours without \`whenBusy\` too) or the run changes.${superseded} Check it with terminal.getStatus and this queuedSendToken; withdraw it with terminal.cancelQueuedSend.`,
    };
  }
}

/** The owned send as the app runs it, over the pty-host. */
export function liveOwnedWorkerSend(deps: {
  pty: () => PtyClient | null;
  queue: () => Pick<WorkerSteerQueue, "hold"> | null;
}): OwnedWorkerSend {
  return new OwnedWorkerSend({
    getTerminalProjectId: (terminalId) => deps.pty()?.getTerminalProjectId(terminalId) ?? null,
    getLiveGeneration: (terminalId) => deps.pty()?.getLiveGeneration(terminalId) ?? null,
    getTerminal: async (terminalId) => (await deps.pty()?.getTerminalAsync(terminalId)) ?? null,
    submit: (terminalId, text, submissionToken, handbackCode, guard, promptOwner) =>
      deps
        .pty()
        ?.submit(
          terminalId,
          text,
          submissionToken,
          handbackCode,
          guard,
          undefined,
          undefined,
          undefined,
          promptOwner
        ),
    queue: deps.queue,
  });
}

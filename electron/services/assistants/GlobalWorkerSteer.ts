import { randomUUID } from "node:crypto";
import { WORKER_STEER_REFUSALS } from "../../../shared/types/assistantControl.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import { isBuiltInAgentId } from "../../../shared/config/agentIds.js";
import { classifyWorkerSteerCommand } from "../../../shared/config/workerSteerCommands.js";
import { readTailSnapshot, tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import { stampAssistantPrompt } from "../../../shared/utils/assistantProvenance.js";
import { appendHandbackInstruction, mintHandbackCode } from "../../../shared/utils/handback.js";
import { planChoice } from "../../../shared/utils/terminalChoice.js";
import { assessInterruptCandidate } from "../../../shared/utils/terminalInterrupt.js";
import {
  CHOOSE_SCREEN_LINES,
  SEND_KEYS_GAP_MS,
  SEND_KEYS_SCREEN_LINES,
  SEND_KEYS_SETTLE_MS,
  keySequence,
} from "../../../shared/utils/terminalKeys.js";
import {
  buildTerminalSendCommandReceipt,
  type TerminalSendCommandReceipt,
} from "../../../shared/utils/terminalSendCommandResult.js";
import {
  foreignInputMoved,
  foreignTypedInputAt,
  typedSinceSettle,
} from "../../../shared/utils/terminalInputProvenance.js";
import { ASSISTANT_SEND_GATE, evaluateWakeGate } from "../../../shared/utils/terminalWakeGate.js";
import type { PtyClient } from "../PtyClient.js";
import { AssistantTargetError } from "./AssistantTerminalControl.js";

/** The pty-host record fields a steer reads. */
export interface WorkerSteerRecord {
  projectId?: string;
  isAssistantTerminal?: boolean;
  detectedAgentId?: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  lastTypedInputAt?: number;
  lastOwnedInput?: { owner: string; at: number };
  lastForeignInputAt?: number;
  hasPendingSubmission?: boolean;
  isExited?: boolean;
  hasPty?: boolean;
  isTrashed?: boolean;
}

export interface GlobalWorkerSteerDeps {
  getTerminalProjectId(terminalId: string): string | null;
  getLiveGeneration(terminalId: string): number | null;
  /** Main's sealed stamp, or a running assistant lane: either is no worker. */
  isAssistantTerminal(terminalId: string): boolean;
  getTerminal(terminalId: string): Promise<WorkerSteerRecord | null>;
  serializedState(
    terminalId: string,
    options?: { tailRows: number }
  ): Promise<{ data: string; partial?: true } | null>;
  /** Under the strict settled-prompt guard, so the host admits it only while the gate still holds. */
  /**
   * `promptAsWritten` is the brief before its provenance stamp and handback
   * instruction, for the run's first-prompt record (#15521); `null` for a
   * slash command, which is nobody's prompt.
   */
  submit(
    terminalId: string,
    text: string,
    submissionToken: string,
    handbackCode: string | undefined,
    promptAsWritten: string | null
  ): void;
  /** `inputOwner` files the keys under the steering assistant in the pty host (#16094). */
  write(terminalId: string, data: string, inputOwner: string): void;
  /** The pair's gap is scheduled in the pty-host, where IPC can't collapse it. */
  doubleEscape(terminalId: string, inputOwner: string): void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The run a steer names: a terminal in the project the call's session is
 * bound to, by the launch generation `host.list` gave as its `incarnation`.
 */
export interface WorkerSteerTarget {
  projectId: string;
  terminalId: string;
  generation: number | undefined;
  /**
   * The steering assistant's ownership principal (#16094), stable across its
   * sessions: keys written under it aren't a person's on its next call.
   */
  inputOwner: string;
  /**
   * Asked right before every write, and before a reveal: throws while the call
   * may no longer act here (the drive rule, a session gone), so nothing more
   * goes out.
   */
  authorize(): void;
}

/** Said on a receipt admitted only because everything typed since the settle was the caller's own keys. */
export type InputSinceSettle = "own-keys";

const NOTHING_SENT = "Nothing was sent.";

/** How a refusal from the reach gate names what the call would have done, and what it left undone. */
interface ReachWording {
  doing: string;
  undone: string;
}
const STEERING: ReachWording = { doing: "Steering", undone: NOTHING_SENT };
const SHOWING: ReachWording = { doing: "Showing the person", undone: "Nothing was shown." };

function refuse(code: string, message: string): never {
  throw new AssistantTargetError(code, message);
}

/**
 * Who else is at the terminal (#14551): a submission still being written, or
 * input since its agent last settled, which a draft in its composer is. An
 * unknown settle fails closed. Keys the host filed under `owner` are the
 * caller's own, in this call or an earlier one (#16094); mid-sequence, any
 * input from someone else since `foreignBefore` was read stops the rest.
 */
function personAtTerminal(
  terminalId: string,
  record: WorkerSteerRecord,
  owner: string,
  sequence?: { foreignBefore: number | undefined }
): string | null {
  if (record.hasPendingSubmission === true) {
    return `A submission is still being written to terminal '${terminalId}'.`;
  }
  if (sequence !== undefined) {
    return foreignInputMoved(record, owner, sequence.foreignBefore)
      ? `Someone typed into terminal '${terminalId}' while the keys were going in.`
      : null;
  }
  if (record.lastStateChange === undefined) {
    return `Terminal '${terminalId}' hasn't been seen settling, so a draft in it can't be ruled out.`;
  }
  return typedSinceSettle(record, owner) === "someone"
    ? `Someone has typed into terminal '${terminalId}' since its agent last settled, so their input stays as it is.`
    : null;
}

/** The receipt's note when only the caller's own keys were typed since the settle (#16094). */
function inputSinceSettleOf(
  record: WorkerSteerRecord,
  owner: string
): { inputSinceSettle: InputSinceSettle } | Record<string, never> {
  return record.lastStateChange !== undefined && typedSinceSettle(record, owner) === "own-keys"
    ? { inputSinceSettle: "own-keys" }
    : {};
}

function slashRefusedWhy(
  terminalId: string,
  agentId: string | undefined,
  allowed: readonly string[]
): string {
  const where = `terminal '${terminalId}' (${agentId ?? "unknown agent"}), which you neither launched nor were handed`;
  const forms = allowed.map((form) => `\`${form}\``);
  let why: string;
  if (forms.length === 0) {
    why = `No slash command runs in ${where}.`;
  } else if (forms.length === 1) {
    why = `The only slash command that runs in ${where} is ${forms[0]}, sent alone and exactly as written.`;
  } else {
    why = `The only slash commands that run in ${where} are ${forms.slice(0, -1).join(", ")} and ${forms.at(-1)}, each sent alone and exactly as written.`;
  }
  // A hand-over binds the pane to the global Assistant of the machine it runs on.
  return `${why} ${NOTHING_SENT} To run ${forms.length === 0 ? "one" : "another"}, ask the person to type it there, or, for a pane on your own machine, to hand it to you (right-click > Hand to orchestrator > Global Assistant). Text that opens with \`/name\` is read as a command; to send it as a prompt, open it some other way.`;
}

/** Why a record is no agent worker to steer, or null while it is one. */
function noWorkerWhy(terminalId: string, record: WorkerSteerRecord): string | null {
  if (record.isAssistantTerminal === true) {
    return `Terminal '${terminalId}' runs a Daintree Assistant, not a worker.`;
  }
  if (record.isExited === true || record.hasPty === false || record.isTrashed === true) {
    return `Terminal '${terminalId}' has no running process, or is in the trash.`;
  }
  // A launch hint is intent, not identity: a shell an agent has left is a shell.
  if (record.detectedAgentId === undefined) {
    return `No agent is seen running in terminal '${terminalId}': it is a plain shell, or its agent isn't recognised yet.`;
  }
  return null;
}

/**
 * The global Assistant steering a worker it neither launched nor was handed
 * (#14551): a prompt, keys and an interrupt, and nothing else. Each reaches
 * only an agent terminal of the session's project, only the run its
 * generation names, and never one a person is typing into: all three are
 * read again right before each write, never trusted from the caller's read.
 * Answers say what was written, never what the agent did with it.
 *
 * Showing the person that worker's panel (#16096) reaches exactly as far,
 * through the same gate, so a reveal and a prompt can't drift apart on what
 * they'll reach. It writes nothing, so a person at the terminal and a steer
 * still writing to it hold it back no more than they would a glance.
 */
export class GlobalWorkerSteer {
  /** Runs a steer is writing to: a second, planned from the same screen, is refused. */
  private readonly writing = new Set<string>();

  constructor(private readonly deps: GlobalWorkerSteerDeps) {}

  async prompt(
    target: WorkerSteerTarget,
    request: { command: string; handback: boolean; machineName: string }
  ): Promise<TerminalSendCommandReceipt> {
    return this.exclusive(target, async () => {
      const record = await this.requireWorker(target);
      // An agent CLI runs a slash command only when it opens the input, so a
      // stamped one arrives as prose (#16101): refused unless it is a fixed form.
      const slash = classifyWorkerSteerCommand(request.command, record.detectedAgentId);
      if (slash.kind === "refused") {
        refuse(
          WORKER_STEER_REFUSALS.commandNotAllowed,
          slashRefusedWhy(target.terminalId, record.detectedAgentId, slash.allowed)
        );
      }
      if (slash.kind === "slash" && request.handback) {
        refuse(
          "VALIDATION_ERROR",
          `A handback adds its instruction to the text, so \`${slash.form}\` would arrive as a prompt. ${NOTHING_SENT} Send it without \`handback\`.`
        );
      }
      const verdict = evaluateWakeGate(record, ASSISTANT_SEND_GATE);
      if (verdict.kind !== "ready") {
        const typing = verdict.reason === "typing";
        refuse(
          typing ? WORKER_STEER_REFUSALS.typing : WORKER_STEER_REFUSALS.busy,
          typing
            ? typedSinceSettle(record, target.inputOwner) === "own-keys"
              ? // Keys can leave text in the input (a history entry, a placed
                // suggestion) that the prompt's Enter would send along (#16094).
                `The only input in terminal '${target.terminalId}' since its agent last settled is keys you sent, which can leave text at its prompt. ${NOTHING_SENT} Send once the agent settles again.`
              : `${personAtTerminal(target.terminalId, record, target.inputOwner) ?? `Someone has typed into terminal '${target.terminalId}'.`} ${NOTHING_SENT}`
            : `Terminal '${target.terminalId}' isn't waiting at its agent's prompt (state: ${record.agentState ?? "unknown"}${
                record.waitingReason ? `, ${record.waitingReason}` : ""
              }). ${NOTHING_SENT} Answer a dialog with keys, or send once it is waiting.`
        );
      }
      const pending = personAtTerminal(target.terminalId, record, target.inputOwner);
      if (pending !== null) refuse(WORKER_STEER_REFUSALS.typing, `${pending} ${NOTHING_SENT}`);
      this.requireSameRun(target);
      target.authorize();
      const submissionToken = randomUUID();
      if (slash.kind === "slash") {
        // A fixed form has no free text for the stamp's "quoted text is data" rule to guard.
        this.deps.submit(target.terminalId, slash.form, submissionToken, undefined, null);
        return buildTerminalSendCommandReceipt(target.terminalId, slash.form, submissionToken);
      }
      const stamped = stampAssistantPrompt(request.command, request.machineName);
      // The host's strict guard asks the same gate again when it writes, so
      // a draft typed after this read still keeps the prompt out.
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
    });
  }

  async keys(
    target: WorkerSteerTarget,
    request: { keys?: readonly string[]; choose?: string }
  ): Promise<{
    terminalId: string;
    keys: string[];
    screen?: string;
    inputSinceSettle?: InputSinceSettle;
  }> {
    return this.exclusive(target, async () => {
      const { terminalId, inputOwner } = target;
      let record = await this.requireWorker(target);
      let keys = request.keys ? [...request.keys] : undefined;
      if (request.choose !== undefined) {
        const plan = planChoice(
          (await this.readScreen(terminalId, CHOOSE_SCREEN_LINES)) ?? "",
          request.choose
        );
        if (!plan.ok) refuse("VALIDATION_ERROR", `${plan.reason} Nothing was pressed.`);
        keys = plan.keys;
        record = await this.requireWorker(target);
      }
      if (keys === undefined || keys.length === 0) {
        refuse("VALIDATION_ERROR", "Pass `choose` or `keys`. Nothing was pressed.");
      }
      const pressed: string[] = [];
      const stop = (code: string, why: string): never =>
        refuse(
          pressed.length === 0 ? code : WORKER_STEER_REFUSALS.partial,
          pressed.length === 0
            ? `${why} Nothing was pressed.`
            : `${why} ${pressed.length} of ${keys!.length} keys were sent (${pressed.join(", ")}); the rest weren't. Read the screen before pressing more, and never resend the whole sequence.`
        );
      // Read before the first key, never after one: a person's key that lands
      // with ours must still be newer than this.
      const sequence = { foreignBefore: foreignTypedInputAt(record, inputOwner) };
      const admittedOver = inputSinceSettleOf(record, inputOwner);
      for (const [index, key] of keys.entries()) {
        if (index > 0) {
          await this.sleep(SEND_KEYS_GAP_MS);
          const now = await this.deps.getTerminal(terminalId).catch(() => null);
          if (!now)
            stop(
              WORKER_STEER_REFUSALS.notFound,
              `Terminal '${terminalId}' can't be read right now.`
            );
          record = now!;
          // An Escape can drop the agent back to its shell: the rest would land there.
          const gone = noWorkerWhy(terminalId, record);
          if (gone !== null) stop(WORKER_STEER_REFUSALS.notAgent, gone);
        }
        const person = personAtTerminal(
          terminalId,
          record,
          inputOwner,
          index > 0 ? sequence : undefined
        );
        if (person !== null) stop(WORKER_STEER_REFUSALS.typing, person);
        if (!this.isSameRun(target))
          stop(WORKER_STEER_REFUSALS.restarted, this.restartedWhy(target));
        try {
          target.authorize();
        } catch (error) {
          if (pressed.length === 0 || !(error instanceof AssistantTargetError)) throw error;
          stop(error.code, error.message);
        }
        this.deps.write(terminalId, keySequence(key), inputOwner);
        pressed.push(key);
      }
      await this.sleep(SEND_KEYS_SETTLE_MS);
      const read = this.isSameRun(target)
        ? await this.readScreen(terminalId, SEND_KEYS_SCREEN_LINES).catch(() => null)
        : null;
      // Asked after the read as well: a successor's screen is never what these keys did.
      const screen = this.isSameRun(target) ? read : null;
      return { terminalId, keys: pressed, ...(screen ? { screen } : {}), ...admittedOver };
    });
  }

  async interrupt(target: WorkerSteerTarget): Promise<{
    terminalId: string;
    agentId: string;
    agentStateAtDispatch: string | undefined;
    status: "requested" | "requested-unverified";
    inputSinceSettle?: InputSinceSettle;
  }> {
    return this.exclusive(target, async () => {
      const record = await this.requireWorker(target);
      const assessment = assessInterruptCandidate(
        {
          isPty: true,
          trashed: record.isTrashed === true,
          ...(record.hasPty !== undefined ? { hasPty: record.hasPty } : {}),
          exited: record.isExited === true,
          agentId: isBuiltInAgentId(record.detectedAgentId) ? record.detectedAgentId : undefined,
          ...(record.agentState !== undefined ? { agentState: record.agentState } : {}),
          ...(record.waitingReason !== undefined ? { waitingReason: record.waitingReason } : {}),
        },
        target.terminalId
      );
      if (!assessment.eligible) refuse("VALIDATION_ERROR", assessment.reason);
      // An Escape clears a composer as readily as it stops a turn.
      const person = personAtTerminal(target.terminalId, record, target.inputOwner);
      if (person !== null) refuse(WORKER_STEER_REFUSALS.typing, `${person} Nothing was pressed.`);
      this.requireSameRun(target);
      target.authorize();
      this.deps.doubleEscape(target.terminalId, target.inputOwner);
      return {
        terminalId: target.terminalId,
        agentId: assessment.agentId,
        agentStateAtDispatch: assessment.agentState,
        status: assessment.support === "advertised" ? "requested" : "requested-unverified",
        ...inputSinceSettleOf(record, target.inputOwner),
      };
    });
  }

  /**
   * Run `show`, the reveal, once the run passes the gate, right after its
   * last read of it and the caller's `authorize`; never on a refusal.
   */
  async reveal<T>(target: WorkerSteerTarget, show: () => Promise<T>): Promise<T> {
    await this.requireWorker(target, SHOWING);
    target.authorize();
    return show();
  }

  private async exclusive<T>(target: WorkerSteerTarget, run: () => Promise<T>): Promise<T> {
    if (this.writing.has(target.terminalId)) {
      refuse(
        WORKER_STEER_REFUSALS.busy,
        `Another call is still writing to terminal '${target.terminalId}'. ${NOTHING_SENT}`
      );
    }
    this.writing.add(target.terminalId);
    try {
      return await run();
    } finally {
      this.writing.delete(target.terminalId);
    }
  }

  /**
   * The gate every reach goes through: the named run, if it is still an agent
   * worker of this project; refused otherwise.
   */
  private async requireWorker(
    target: WorkerSteerTarget,
    wording: ReachWording = STEERING
  ): Promise<WorkerSteerRecord> {
    const { terminalId, projectId } = target;
    const { undone } = wording;
    if (target.generation === undefined) {
      refuse(
        "VALIDATION_ERROR",
        `${wording.doing} an agent you didn't launch needs its 'generation': the 'incarnation' host.list gave for it. ${undone}`
      );
    }
    if (this.deps.getTerminalProjectId(terminalId) !== projectId) {
      refuse(
        WORKER_STEER_REFUSALS.notFound,
        `No terminal '${terminalId}' is in this project. ${undone} Take the id from host.list or terminal.list here.`
      );
    }
    if (this.deps.isAssistantTerminal(terminalId)) {
      refuse(
        WORKER_STEER_REFUSALS.notAgent,
        `Terminal '${terminalId}' runs a Daintree Assistant, not a worker. ${undone}`
      );
    }
    this.requireSameRun(target, undone);
    const record = await this.deps.getTerminal(terminalId).catch(() => null);
    if (!record || (record.projectId !== undefined && record.projectId !== projectId)) {
      refuse(
        WORKER_STEER_REFUSALS.notFound,
        `Terminal '${terminalId}' can't be read right now. ${undone}`
      );
    }
    // The read was async: still the run the caller named.
    this.requireSameRun(target, undone);
    const notWorker = noWorkerWhy(terminalId, record);
    if (notWorker !== null) {
      refuse(WORKER_STEER_REFUSALS.notAgent, `${notWorker} ${undone}`);
    }
    return record;
  }

  private isSameRun(target: WorkerSteerTarget): boolean {
    return (
      target.generation !== undefined &&
      this.deps.getLiveGeneration(target.terminalId) === target.generation
    );
  }

  private restartedWhy(target: WorkerSteerTarget): string {
    return `Terminal '${target.terminalId}' isn't the run that generation named: it was restarted or replaced.`;
  }

  private requireSameRun(target: WorkerSteerTarget, undone: string = NOTHING_SENT): void {
    if (!this.isSameRun(target)) {
      refuse(
        WORKER_STEER_REFUSALS.restarted,
        `${this.restartedWhy(target)} ${undone} List the agents again with host.list.`
      );
    }
  }

  private async readScreen(terminalId: string, lines: number): Promise<string | null> {
    const snapshot = await readTailSnapshot(
      (options) => this.deps.serializedState(terminalId, options),
      lines
    );
    return snapshot === null ? null : tailCapturedOutput(snapshot.data, lines, true).content;
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((wait) => new Promise((resolve) => setTimeout(resolve, wait))))(ms);
  }
}

/** The steer as the app runs it, over the pty-host. */
export function liveGlobalWorkerSteer(deps: {
  pty: () => PtyClient | null;
  isAssistantTerminal(terminalId: string): boolean;
}): GlobalWorkerSteer {
  return new GlobalWorkerSteer({
    getTerminalProjectId: (terminalId) => deps.pty()?.getTerminalProjectId(terminalId) ?? null,
    getLiveGeneration: (terminalId) => deps.pty()?.getLiveGeneration(terminalId) ?? null,
    isAssistantTerminal: (terminalId) =>
      deps.isAssistantTerminal(terminalId) || deps.pty()?.isAssistantTerminal(terminalId) === true,
    getTerminal: async (terminalId) => (await deps.pty()?.getTerminalAsync(terminalId)) ?? null,
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
    write: (terminalId, data, inputOwner) => deps.pty()?.write(terminalId, data, undefined, inputOwner),
    doubleEscape: (terminalId, inputOwner) =>
      deps.pty()?.batchDoubleEscape([terminalId], inputOwner),
  });
}

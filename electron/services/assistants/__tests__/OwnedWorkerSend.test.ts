import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_STEER_REFUSALS } from "../../../../shared/types/assistantControl.js";
import type { ExactPromptGuard } from "../../../../shared/types/pty-host.js";
import { stampTypedInput } from "../../../../shared/utils/terminalInputProvenance.js";
import { AssistantTargetError } from "../AssistantTerminalControl.js";
import type { WorkerSteerRecord } from "../GlobalWorkerSteer.js";
import {
  OwnedWorkerSend,
  type OwnedSendRequest,
  type OwnedSendTarget,
  type OwnedWhenBusy,
} from "../OwnedWorkerSend.js";
import { HoldRefusedError, type HoldSteerRequest } from "../WorkerSteerQueue.js";

const PROJECT = "proj-1";
const WORKER = "term-mine";
const OWNER = "principal\u0000pane-1";

function atPrompt(extra: Partial<WorkerSteerRecord> = {}): WorkerSteerRecord {
  return {
    projectId: PROJECT,
    detectedAgentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    lastStateChange: 1_000,
    hasPty: true,
    agentIncarnation: 2,
    agentSessionId: "sess-1",
    ...extra,
  };
}

function working(extra: Partial<WorkerSteerRecord> = {}): WorkerSteerRecord {
  return atPrompt({ agentState: "working", waitingReason: undefined, ...extra });
}

const QUEUE: OwnedWhenBusy = { kind: "queue", ttlSeconds: 600 };
const REFUSE: OwnedWhenBusy = { kind: "refuse" };

describe("OwnedWorkerSend (#18172)", () => {
  let record: WorkerSteerRecord | null;
  let generation: number | null;
  let holds: HoldSteerRequest[];
  let holdError: Error | null;
  let submit: ReturnType<typeof vi.fn>;
  let authorize: ReturnType<typeof vi.fn>;
  let authorizeHeld: ReturnType<typeof vi.fn>;
  let queueAvailable: boolean;
  let send: OwnedWorkerSend;

  const target = (): OwnedSendTarget => ({
    terminalId: WORKER,
    inputOwner: OWNER,
    authorize: authorize as unknown as OwnedSendTarget["authorize"],
    authorizeHeld: authorizeHeld as unknown as OwnedSendTarget["authorizeHeld"],
  });

  const prompt = (whenBusy: OwnedWhenBusy, extra: Partial<OwnedSendRequest> = {}) =>
    send.prompt(target(), { command: "reply done2", handback: false, whenBusy, ...extra });

  const refusal = async (pending: Promise<unknown>): Promise<AssistantTargetError> => {
    const error = await pending.then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(AssistantTargetError);
    return error as AssistantTargetError;
  };

  beforeEach(() => {
    record = atPrompt();
    generation = 4;
    holds = [];
    holdError = null;
    queueAvailable = true;
    submit = vi.fn();
    authorize = vi.fn();
    authorizeHeld = vi.fn(() => null);
    send = new OwnedWorkerSend({
      getTerminalProjectId: () => PROJECT,
      getLiveGeneration: () => generation,
      getTerminal: async () => (record === null ? null : { ...record }),
      submit,
      queue: () =>
        queueAvailable
          ? {
              hold: (request) => {
                if (holdError) throw holdError;
                holds.push(request);
                return { queuedSendToken: `tok-${holds.length}`, expiresAt: 601_000 };
              },
            }
          : null,
    });
  });

  it("holds a send for a working worker until its next prompt, writing nothing", async () => {
    record = working();

    const receipt = await prompt(QUEUE);

    expect(receipt).toMatchObject({
      sent: false,
      queued: true,
      terminalId: WORKER,
      queuedSendToken: "tok-1",
      expiresAt: 601_000,
    });
    expect(receipt).not.toHaveProperty("submissionToken");
    expect(submit).not.toHaveBeenCalled();
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      principal: OWNER,
      projectId: PROJECT,
      terminalId: WORKER,
      generation: 4,
      run: { agentIncarnation: 2, agentSessionId: "sess-1" },
      // The caller's own words: an owned send is never stamped as a steer.
      text: "reply done2",
      promptAsWritten: "reply done2",
      ttlSeconds: 600,
      waitingOn: "working",
    });
    expect(authorize).toHaveBeenCalledWith(PROJECT);
  });

  it("waits out an approval for its own worker, held for the prompt after it", async () => {
    record = atPrompt({ waitingReason: "approval", approvalKind: "tool" });

    const receipt = await prompt(QUEUE);

    expect(receipt).toMatchObject({ queued: true });
    expect(holds[0]).toMatchObject({ waitingOn: "approval" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a working worker under `refuse`, writing and holding nothing", async () => {
    record = working();

    const error = await refusal(prompt(REFUSE));

    expect(error.code).toBe(WORKER_STEER_REFUSALS.busy);
    expect(error.message).toMatch(/is working\. Nothing was sent\./);
    expect(submit).not.toHaveBeenCalled();
    expect(holds).toEqual([]);
  });

  it("refuses an approval under `refuse` in the choice dialog's own words", async () => {
    record = atPrompt({ waitingReason: "approval" });

    const error = await refusal(prompt(REFUSE));

    expect(error.code).toBe(WORKER_STEER_REFUSALS.busy);
    expect(error.message).toMatch(/choice dialog/);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ["refuse", REFUSE],
    ["queue", QUEUE],
  ] as const)(
    "writes at once to a worker at its prompt under `%s`, guarded to the run it read",
    async (_label, whenBusy) => {
      const receipt = await prompt(whenBusy, { handback: true });

      expect(receipt).toMatchObject({ sent: true, terminalId: WORKER, command: "reply done2" });
      expect(receipt.message).not.toMatch(/queued/i);
      expect(holds).toEqual([]);
      expect(submit).toHaveBeenCalledTimes(1);
      const [terminalId, text, token, handbackCode, guard, owner] = submit.mock.calls[0]!;
      expect(terminalId).toBe(WORKER);
      expect(text).toContain("reply done2");
      expect(text).toContain(handbackCode);
      expect(token).toBe((receipt as { submissionToken: string }).submissionToken);
      expect(guard).toEqual({
        kind: "settled-prompt-exact",
        agentIncarnation: 2,
        agentSessionId: "sess-1",
        agentId: "claude",
        acceptQuestion: true,
      } satisfies ExactPromptGuard);
      expect(owner).toBe(OWNER);
      expect(authorize).toHaveBeenCalledWith(PROJECT);
    }
  );

  it("takes a question asked in prose as its prompt, as a send to any other worker does", async () => {
    record = atPrompt({ waitingReason: "question" });

    await prompt(QUEUE);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(holds).toEqual([]);
  });

  it("refuses to hold over someone's typing, or a draft it can't rule out", async () => {
    const typed = working({ lastStateChange: 1_000 });
    stampTypedInput(typed, 2_000);
    record = typed;
    expect((await refusal(prompt(QUEUE))).code).toBe(WORKER_STEER_REFUSALS.typing);

    record = working({ lastStateChange: undefined });
    expect((await refusal(prompt(QUEUE))).code).toBe(WORKER_STEER_REFUSALS.typing);

    record = working({ hasPendingSubmission: true });
    expect((await refusal(prompt(QUEUE))).code).toBe(WORKER_STEER_REFUSALS.typing);

    expect(holds).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a state it would wait on for nothing: an error, idle, a plain shell", async () => {
    record = atPrompt({ waitingReason: "error" });
    const errored = await refusal(prompt(QUEUE));
    expect(errored.code).toBe(WORKER_STEER_REFUSALS.busy);
    expect(errored.message).toMatch(/held only while its agent works or waits on an approval/);

    record = atPrompt({ agentState: "idle", waitingReason: undefined });
    expect((await refusal(prompt(QUEUE))).code).toBe(WORKER_STEER_REFUSALS.busy);

    record = atPrompt({ detectedAgentId: undefined, agentState: "idle" });
    expect((await refusal(prompt(QUEUE))).code).toBe("VALIDATION_ERROR");

    record = working({ isExited: true });
    expect((await refusal(prompt(QUEUE))).code).toBe(WORKER_STEER_REFUSALS.notAgent);

    expect(holds).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses to hold a slash command, which could arrive as prose", async () => {
    record = working();

    const error = await refusal(prompt(QUEUE, { command: "/clear" }));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(holds).toEqual([]);
  });

  it("holds a run to the generation the caller named, and to the one it read", async () => {
    record = working();
    const named = await refusal(prompt(QUEUE, { generation: 3 }));
    expect(named.code).toBe(WORKER_STEER_REFUSALS.restarted);

    // Relaunched while the record was read: the line was meant for the run before.
    send = new OwnedWorkerSend({
      getTerminalProjectId: () => PROJECT,
      getLiveGeneration: () => generation,
      getTerminal: async () => {
        generation = 5;
        return working();
      },
      submit,
      queue: () => null,
    });
    const relaunched = await refusal(prompt(QUEUE, { generation: 4 }));
    expect(relaunched.code).toBe(WORKER_STEER_REFUSALS.restarted);
    expect(submit).not.toHaveBeenCalled();
  });

  it("answers a host that can't hold, or a hold the store refuses, with nothing sent", async () => {
    record = working();
    queueAvailable = false;
    expect((await refusal(prompt(QUEUE))).message).toMatch(/can't hold a message/);

    queueAvailable = true;
    holdError = new HoldRefusedError("that worker's notice line can't take it right now");
    const refused = await refusal(prompt(QUEUE));
    expect(refused.code).toBe(WORKER_STEER_REFUSALS.busy);
    expect(refused.message).toMatch(/Nothing was sent/);
  });

  it("writes and holds nothing once the caller may no longer act there", async () => {
    authorize.mockImplementation(() => {
      throw new AssistantTargetError("RESOURCE_NOT_OWNED", "no longer yours");
    });

    expect((await refusal(prompt(REFUSE))).code).toBe("RESOURCE_NOT_OWNED");
    record = working();
    expect((await refusal(prompt(QUEUE))).code).toBe("RESOURCE_NOT_OWNED");

    expect(submit).not.toHaveBeenCalled();
    expect(holds).toEqual([]);
  });

  it("asks the held send's own authority for the project the terminal is in", async () => {
    record = working();
    await prompt(QUEUE);

    authorizeHeld.mockReturnValueOnce({ code: "DRIVEN_ELSEWHERE", message: "driven elsewhere" });
    expect(holds[0]!.authorize()).toEqual({
      code: "DRIVEN_ELSEWHERE",
      message: "driven elsewhere",
    });
    expect(authorizeHeld).toHaveBeenCalledWith(PROJECT);
  });

  it("refuses a second call to the same terminal while the first is still reading it", async () => {
    let release!: () => void;
    send = new OwnedWorkerSend({
      getTerminalProjectId: () => PROJECT,
      getLiveGeneration: () => 4,
      getTerminal: () =>
        new Promise((resolve) => {
          release = () => resolve(atPrompt());
        }),
      submit,
      queue: () => null,
    });

    const first = prompt(REFUSE);
    const second = await refusal(prompt(REFUSE));
    release();
    await first;

    expect(second.code).toBe(WORKER_STEER_REFUSALS.busy);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

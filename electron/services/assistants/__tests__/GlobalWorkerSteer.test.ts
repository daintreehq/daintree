import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_STEER_REFUSALS } from "../../../../shared/types/assistantControl.js";
import { AssistantTargetError } from "../AssistantTerminalControl.js";
import {
  GlobalWorkerSteer,
  type GlobalWorkerSteerDeps,
  type WorkerSteerRecord,
  type WorkerSteerTarget,
} from "../GlobalWorkerSteer.js";

const PROJECT = "proj-1";
const WORKER = "term-worker";

interface Fake {
  projectId: string;
  generation: number | null;
  record: WorkerSteerRecord | null;
  assistant: boolean;
  screen: string;
  clock: number;
}

describe("GlobalWorkerSteer (#14551)", () => {
  let fake: Fake;
  let writes: string[];
  let submits: Array<{ text: string; token: string; handback?: string }>;
  let escapes: number;
  /** Runs before each pause between keys, standing in for whatever happens meanwhile. */
  let duringGap: () => void;
  let steer: GlobalWorkerSteer;

  const atPrompt = (extra: Partial<WorkerSteerRecord> = {}): WorkerSteerRecord => ({
    projectId: PROJECT,
    detectedAgentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    lastStateChange: 1_000,
    hasPty: true,
    ...extra,
  });

  const target = (extra: Partial<WorkerSteerTarget> = {}): WorkerSteerTarget => ({
    projectId: PROJECT,
    terminalId: WORKER,
    generation: 4,
    authorize: () => {},
    ...extra,
  });

  const refusal = async (work: Promise<unknown>): Promise<AssistantTargetError> => {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(AssistantTargetError);
    return error as AssistantTargetError;
  };

  beforeEach(() => {
    fake = {
      projectId: PROJECT,
      generation: 4,
      record: atPrompt(),
      assistant: false,
      screen: "",
      clock: 2_000,
    };
    writes = [];
    submits = [];
    escapes = 0;
    duringGap = () => {};
    const deps: GlobalWorkerSteerDeps = {
      getTerminalProjectId: () => fake.projectId,
      getLiveGeneration: () => fake.generation,
      isAssistantTerminal: () => fake.assistant,
      getTerminal: async () => (fake.record ? { ...fake.record } : null),
      serializedState: async () => ({ data: fake.screen }),
      submit: (_id, text, token, handback) =>
        submits.push({ text, token, ...(handback ? { handback } : {}) }),
      write: (_id, data) => {
        writes.push(data);
        // The host stamps every raw key as typed input, ours included.
        if (fake.record) fake.record.lastTypedInputAt = ++fake.clock;
      },
      doubleEscape: () => {
        escapes += 1;
      },
      sleep: async () => {
        duringGap();
      },
    };
    steer = new GlobalWorkerSteer(deps);
  });

  describe("an agent worker it didn't launch", () => {
    it("is prompted under the strict guard, stamped with where it came from", async () => {
      const receipt = await steer.prompt(target(), {
        command: "Rebase onto develop",
        handback: false,
        machineName: "studio-01",
      });

      expect(submits).toHaveLength(1);
      expect(submits[0]!.text).toContain("From the Daintree Assistant on studio-01");
      expect(submits[0]!.text.endsWith("Rebase onto develop")).toBe(true);
      expect(receipt).toMatchObject({
        sent: true,
        terminalId: WORKER,
        command: "Rebase onto develop",
        submissionToken: submits[0]!.token,
      });
    });

    it("is keyed one key at a time, reporting the keys that went in", async () => {
      fake.record = atPrompt({ waitingReason: "approval" });
      fake.screen = "Allow this edit?\n❯ 1. Yes\n  2. No";

      const result = await steer.keys(target(), { keys: ["2", "Enter", "Escape"] });

      expect(writes).toEqual(["2", "\r", "\x1b"]);
      expect(result.keys).toEqual(["2", "Enter", "Escape"]);
      expect(result.screen).toContain("Allow this edit?");
    });

    it("is interrupted mid-turn with the double Escape", async () => {
      fake.record = atPrompt({ agentState: "working", waitingReason: undefined });

      const result = await steer.interrupt(target());

      expect(escapes).toBe(1);
      expect(result).toMatchObject({
        terminalId: WORKER,
        agentId: "claude",
        agentStateAtDispatch: "working",
      });
    });
  });

  it("refuses a plain shell, an agent's launch hint alone included", async () => {
    fake.record = atPrompt({ detectedAgentId: undefined, agentState: "idle" });
    for (const work of [
      () => steer.prompt(target(), { command: "ls", handback: false, machineName: "m" }),
      () => steer.keys(target(), { keys: ["Enter"] }),
      () => steer.interrupt(target()),
    ]) {
      expect((await refusal(work())).code).toBe(WORKER_STEER_REFUSALS.notAgent);
    }
    expect(submits).toEqual([]);
    expect(writes).toEqual([]);
    expect(escapes).toBe(0);
  });

  it("refuses a run restarted since it was read, and one replaced while it was read", async () => {
    fake.generation = 5;
    expect((await refusal(steer.keys(target(), { keys: ["Enter"] }))).code).toBe(
      WORKER_STEER_REFUSALS.restarted
    );

    fake.generation = 4;
    const deps = {
      getTerminalProjectId: () => PROJECT,
      getLiveGeneration: vi.fn(() => 4),
      isAssistantTerminal: () => false,
      getTerminal: async () => {
        // Replaced while the record was on its way back.
        deps.getLiveGeneration.mockReturnValue(5);
        return atPrompt();
      },
      serializedState: async () => null,
      submit: vi.fn(),
      write: vi.fn(),
      doubleEscape: vi.fn(),
    };
    const racing = new GlobalWorkerSteer(deps);
    expect(
      (await refusal(racing.prompt(target(), { command: "go", handback: false, machineName: "m" })))
        .code
    ).toBe(WORKER_STEER_REFUSALS.restarted);
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("needs the generation it read, and refuses without one", async () => {
    const error = await refusal(steer.interrupt(target({ generation: undefined })));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("incarnation");
    expect(escapes).toBe(0);
  });

  it("refuses all three while someone has typed since the agent settled", async () => {
    fake.record = atPrompt({ lastTypedInputAt: 1_500 });
    const working = atPrompt({
      agentState: "working",
      waitingReason: undefined,
      lastTypedInputAt: 1_500,
    });

    const prompt = await refusal(
      steer.prompt(target(), { command: "go", handback: false, machineName: "m" })
    );
    const keys = await refusal(steer.keys(target(), { keys: ["Enter"] }));
    fake.record = working;
    const interrupt = await refusal(steer.interrupt(target()));

    for (const error of [prompt, keys, interrupt]) {
      expect(error.code).toBe(WORKER_STEER_REFUSALS.typing);
      expect(error.message).toMatch(/typed/);
    }
    expect(submits).toEqual([]);
    expect(writes).toEqual([]);
    expect(escapes).toBe(0);
  });

  it("refuses keys while a submission is still going in, and before any settle is seen", async () => {
    fake.record = atPrompt({ hasPendingSubmission: true });
    expect((await refusal(steer.keys(target(), { keys: ["Enter"] }))).code).toBe(
      WORKER_STEER_REFUSALS.typing
    );
    fake.record = atPrompt({ lastStateChange: undefined });
    expect((await refusal(steer.keys(target(), { keys: ["Enter"] }))).code).toBe(
      WORKER_STEER_REFUSALS.typing
    );
    expect(writes).toEqual([]);
  });

  it("stops the rest when a person types between keys, and says which went in", async () => {
    fake.record = atPrompt({ waitingReason: "approval" });
    duringGap = () => {
      fake.record!.lastTypedInputAt = ++fake.clock;
    };

    const error = await refusal(steer.keys(target(), { keys: ["Down", "Enter"] }));

    expect(error.code).toBe(WORKER_STEER_REFUSALS.partial);
    expect(error.message).toContain("1 of 2 keys went in (Down)");
    expect(writes).toEqual(["\x1b[B"]);
  });

  it("stops the rest when the run is restarted between keys", async () => {
    fake.record = atPrompt({ waitingReason: "approval" });
    duringGap = () => {
      fake.generation = 5;
    };

    const error = await refusal(steer.keys(target(), { keys: ["Down", "Enter"] }));

    expect(error.code).toBe(WORKER_STEER_REFUSALS.partial);
    expect(writes).toEqual(["\x1b[B"]);
  });

  it("asks before every key whether it may still write, and stops on a refusal", async () => {
    fake.record = atPrompt({ waitingReason: "approval" });
    let allowed = 1;
    const authorize = () => {
      if (allowed-- <= 0) throw new AssistantTargetError("DRIVEN_ELSEWHERE", "Driven elsewhere.");
    };

    const error = await refusal(steer.keys(target({ authorize }), { keys: ["1", "Enter"] }));

    expect(error.code).toBe(WORKER_STEER_REFUSALS.partial);
    expect(error.message).toContain("Driven elsewhere.");
    expect(writes).toEqual(["1"]);

    fake.record = atPrompt();
    const first = await refusal(
      steer.prompt(target({ authorize: () => authorize() }), {
        command: "go",
        handback: false,
        machineName: "m",
      })
    );
    expect(first.code).toBe("DRIVEN_ELSEWHERE");
    expect(submits).toEqual([]);
  });

  it("refuses a terminal of another project, and an assistant's", async () => {
    fake.projectId = "proj-2";
    expect((await refusal(steer.interrupt(target()))).code).toBe(WORKER_STEER_REFUSALS.notFound);

    fake.projectId = PROJECT;
    fake.assistant = true;
    expect((await refusal(steer.interrupt(target()))).code).toBe(WORKER_STEER_REFUSALS.notAgent);

    fake.assistant = false;
    fake.record = atPrompt({ isAssistantTerminal: true, agentState: "working" });
    expect((await refusal(steer.interrupt(target()))).code).toBe(WORKER_STEER_REFUSALS.notAgent);
    expect(escapes).toBe(0);
  });

  it("refuses a prompt an agent isn't waiting at, mid-turn or on a dialog", async () => {
    for (const record of [
      atPrompt({ agentState: "working", waitingReason: undefined }),
      atPrompt({ waitingReason: "approval" }),
    ]) {
      fake.record = record;
      const error = await refusal(
        steer.prompt(target(), { command: "go", handback: false, machineName: "m" })
      );
      expect(error.code).toBe(WORKER_STEER_REFUSALS.busy);
    }
    expect(submits).toEqual([]);
  });

  it("refuses a second steer of a run while the first is still writing", async () => {
    fake.record = atPrompt({ waitingReason: "approval" });
    const first = steer.keys(target(), { keys: ["Down", "Enter"] });
    const second = await refusal(steer.keys(target(), { keys: ["Enter"] }));

    expect(second.code).toBe(WORKER_STEER_REFUSALS.busy);
    await first;
    expect(writes).toEqual(["\x1b[B", "\r"]);
  });
});

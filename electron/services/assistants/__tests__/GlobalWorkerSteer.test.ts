import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_STEER_REFUSALS } from "../../../../shared/types/assistantControl.js";
import {
  stampPromptInput,
  stampTypedInput,
} from "../../../../shared/utils/terminalInputProvenance.js";
import { AssistantTargetError } from "../AssistantTerminalControl.js";
import {
  HoldRefusedError,
  type HoldSteerRequest,
  type HoldSteerResult,
} from "../WorkerSteerQueue.js";
import {
  GlobalWorkerSteer,
  liveGlobalWorkerSteer,
  type GlobalWorkerSteerDeps,
  type WorkerSteerRecord,
  type WorkerSteerTarget,
} from "../GlobalWorkerSteer.js";

const PROJECT = "proj-1";
const WORKER = "term-worker";
const OWNER = "principal\u0000relay\u0000shell-1\u0000help-1";

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
  let submits: Array<{
    text: string;
    token: string;
    handback?: string;
    promptAsWritten: string | null;
  }>;
  let escapes: number;
  /** Runs before each pause between keys, standing in for whatever happens meanwhile. */
  let duringGap: () => void;
  /** Runs while a screen read is on its way back. */
  let duringRead: () => void;
  let steer: GlobalWorkerSteer;
  /** What the steer handed its queue, and how the queue answers; null is no queue. */
  let held: HoldSteerRequest[];
  let overtaken: Array<[string, string]>;
  let holdAnswer: ((request: HoldSteerRequest) => HoldSteerResult) | null;

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
    inputOwner: OWNER,
    authorize: () => {},
    ...extra,
  });

  /** A key from a person at the pane, as the host files it: nobody's. */
  const personTypes = () => {
    if (fake.record) stampTypedInput(fake.record, ++fake.clock);
  };

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
    duringRead = () => {};
    held = [];
    overtaken = [];
    holdAnswer = null;
    const deps: GlobalWorkerSteerDeps = {
      getTerminalProjectId: () => fake.projectId,
      getLiveGeneration: () => fake.generation,
      isAssistantTerminal: () => fake.assistant,
      getTerminal: async () => (fake.record ? { ...fake.record } : null),
      serializedState: async () => {
        duringRead();
        return { data: fake.screen };
      },
      submit: (_id, text, token, handback, promptAsWritten) =>
        submits.push({ text, token, ...(handback ? { handback } : {}), promptAsWritten }),
      write: (_id, data, inputOwner) => {
        writes.push(data);
        // The host stamps every raw key as typed input, filed under its owner.
        if (fake.record) stampTypedInput(fake.record, ++fake.clock, inputOwner);
      },
      doubleEscape: (_id, inputOwner) => {
        escapes += 1;
        if (fake.record) stampTypedInput(fake.record, ++fake.clock, inputOwner);
      },
      sleep: async () => {
        duringGap();
      },
      queue: () =>
        holdAnswer === null
          ? null
          : {
              hold: (request) => {
                held.push(request);
                return holdAnswer!(request);
              },
              promptSent: (terminalId, principal) => overtaken.push([terminalId, principal]),
            },
    };
    steer = new GlobalWorkerSteer(deps);
  });

  describe("an agent worker it didn't launch", () => {
    it("offers the brief alone as the run's first prompt when it asks for a handback (#15521)", async () => {
      await steer.prompt(target(), {
        command: "Rebase onto develop",
        handback: true,
        machineName: "studio-01",
      });

      expect(submits[0]!.handback).toBeDefined();
      expect(submits[0]!.text).toContain(`DAINTREE-DONE-${submits[0]!.handback}`);
      // A worker that needs the owner to act can say so (#16190).
      expect(submits[0]!.text).toContain(`DAINTREE-NEEDS-YOU-${submits[0]!.handback}`);
      expect(submits[0]!.promptAsWritten).toBe("Rebase onto develop");
    });

    it("is prompted under the strict guard, stamped with where it came from", async () => {
      const receipt = await steer.prompt(target(), {
        command: "Rebase onto develop",
        handback: false,
        machineName: "studio-01",
      });

      expect(submits).toHaveLength(1);
      expect(submits[0]!.text).toContain("From the Daintree Assistant on studio-01");
      expect(submits[0]!.text.endsWith("Rebase onto develop")).toBe(true);
      // The run's first prompt is the brief, not the stamp (#15521).
      expect(submits[0]!.promptAsWritten).toBe("Rebase onto develop");
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

  describe("a send held for a worker mid-turn (#16187)", () => {
    const working = (extra: Partial<WorkerSteerRecord> = {}): WorkerSteerRecord =>
      atPrompt({
        agentState: "working",
        waitingReason: undefined,
        agentIncarnation: 2,
        agentSessionId: "sess-1",
        worktreeId: "wt-1",
        ...extra,
      });
    const heldTarget = (extra: Partial<WorkerSteerTarget> = {}) =>
      target({ authorizeHeld: () => null, ...extra });
    const queueSend = (
      command = "Rebase onto develop",
      extra: { handback?: boolean; target?: WorkerSteerTarget } = {}
    ) =>
      steer.prompt(extra.target ?? heldTarget(), {
        command,
        handback: extra.handback ?? false,
        machineName: "studio-01",
        whenBusy: { queue: { ttlSeconds: 900 } },
      });

    beforeEach(() => {
      fake.record = working();
      holdAnswer = () => ({ queuedSendToken: "q-1", expiresAt: 901_000 });
    });

    it("holds the stamped brief for the run it read, sending nothing", async () => {
      const receipt = await queueSend();

      expect(submits).toEqual([]);
      expect(receipt).toMatchObject({
        sent: false,
        queued: true,
        terminalId: WORKER,
        command: "Rebase onto develop",
        queuedSendToken: "q-1",
        expiresAt: 901_000,
      });
      expect(receipt).not.toHaveProperty("submissionToken");
      expect(held).toHaveLength(1);
      const request = held[0]!;
      expect(request).toMatchObject({
        principal: OWNER,
        projectId: PROJECT,
        terminalId: WORKER,
        generation: 4,
        run: { agentIncarnation: 2, agentSessionId: "sess-1", worktreeId: "wt-1" },
        promptAsWritten: "Rebase onto develop",
        ttlSeconds: 900,
      });
      expect(request.text).toContain("From the Daintree Assistant on studio-01");
      expect(request.text.endsWith("Rebase onto develop")).toBe(true);
      expect(request.handbackCode).toBeUndefined();
    });

    it("mints the handback now and puts its instruction on the held text", async () => {
      await queueSend("Rebase onto develop", { handback: true });

      const request = held[0]!;
      expect(request.handbackCode).toBeDefined();
      expect(request.text).toContain(`DAINTREE-DONE-${request.handbackCode}`);
      expect(request.promptAsWritten).toBe("Rebase onto develop");
    });

    it("carries the run's prompt-capable input as the baseline someone else's must move past", async () => {
      fake.record = working();
      stampPromptInput(fake.record, 1_500);

      await queueSend();

      expect(held[0]!.run.lastForeignPromptInputAt).toBe(1_500);
    });

    it("names the held prompt it replaced", async () => {
      holdAnswer = () => ({ queuedSendToken: "q-2", expiresAt: 901_000, supersededToken: "q-1" });

      const receipt = await queueSend();

      expect(receipt).toMatchObject({ queuedSendToken: "q-2", supersededToken: "q-1" });
      expect(receipt.message).toContain("q-1");
    });

    it("hands the deferred authority and writer check to the queue, never the session's", async () => {
      const authorizeHeld = vi.fn(() => null);
      await queueSend("go", { target: heldTarget({ authorizeHeld }) });

      expect(held[0]!.authorize).toBe(authorizeHeld);
      // Read when asked: the call that held it has finished writing by now.
      expect(held[0]!.isWriting()).toBe(false);

      // While another steer writes keys to the worker, the held prompt waits.
      let midKeys: boolean | undefined;
      duringGap = () => {
        midKeys ??= held[0]!.isWriting();
      };
      fake.record = atPrompt({ waitingReason: "approval" });
      await steer.keys(target(), { keys: ["2", "Enter"] });
      expect(midKeys).toBe(true);
      expect(held[0]!.isWriting()).toBe(false);
    });

    it("still sends at once when the agent is already at its prompt", async () => {
      fake.record = atPrompt();

      const receipt = await queueSend();

      expect(held).toEqual([]);
      expect(submits).toHaveLength(1);
      expect(receipt).toMatchObject({ sent: true });
    });

    it("overtakes what other assistants held for the worker when it sends, and only then", async () => {
      // Held, not sent: nothing is overtaken.
      await queueSend();
      expect(overtaken).toEqual([]);

      fake.record = atPrompt();
      await queueSend();
      expect(overtaken).toEqual([[WORKER, OWNER]]);

      // A refused send overtakes nothing.
      personTypes();
      await refusal(queueSend());
      expect(overtaken).toHaveLength(1);
    });

    it("keeps refusing what an immediate send refuses: a draft typed mid-turn", async () => {
      personTypes();

      const error = await refusal(queueSend());

      expect(error.code).toBe(WORKER_STEER_REFUSALS.typing);
      expect(held).toEqual([]);
    });

    it("refuses over its own keys left at the prompt", async () => {
      fake.record = working();
      stampTypedInput(fake.record, 1_500, OWNER);

      const error = await refusal(queueSend());

      expect(error.code).toBe(WORKER_STEER_REFUSALS.typing);
      expect(error.message).toContain("keys you sent");
      expect(held).toEqual([]);
    });

    it("refuses to hold a slash command", async () => {
      fake.record = working({ detectedAgentId: "codex" });

      const error = await refusal(queueSend("/compact"));

      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message).toContain("isn't held");
      expect(held).toEqual([]);
    });

    it("refuses as busy with nothing to hold it in", async () => {
      holdAnswer = null;
      const noQueue = await refusal(queueSend());
      expect(noQueue.code).toBe(WORKER_STEER_REFUSALS.busy);

      holdAnswer = () => ({ queuedSendToken: "q-1", expiresAt: 1 });
      const noAuthority = await refusal(queueSend("go", { target: target() }));
      expect(noAuthority.code).toBe(WORKER_STEER_REFUSALS.busy);
      expect(held).toEqual([]);
    });

    it("refuses as busy when the queue can't take it", async () => {
      holdAnswer = () => {
        throw new HoldRefusedError("that worker's notice line can't take it right now");
      };

      const error = await refusal(queueSend());

      expect(error.code).toBe(WORKER_STEER_REFUSALS.busy);
      expect(error.message).toContain("can't take it");
      expect(error.message).toContain("Nothing was sent.");
    });

    it("refuses a restarted run and a session gone, holding nothing", async () => {
      const stale = await refusal(queueSend("go", { target: heldTarget({ generation: 3 }) }));
      expect(stale.code).toBe(WORKER_STEER_REFUSALS.restarted);

      const gone = await refusal(
        queueSend("go", {
          target: heldTarget({
            authorize: () => {
              throw new AssistantTargetError("SESSION_GONE", "gone");
            },
          }),
        })
      );
      expect(gone.code).toBe("SESSION_GONE");
      expect(held).toEqual([]);
    });

    it("never holds without being asked: a working agent still refuses as busy", async () => {
      const error = await refusal(
        steer.prompt(heldTarget(), { command: "go", handback: false, machineName: "m" })
      );

      expect(error.code).toBe(WORKER_STEER_REFUSALS.busy);
      expect(held).toEqual([]);
    });
  });

  describe("a slash command (#16101)", () => {
    const send = (command: string, handback = false) =>
      steer.prompt(target(), { command, handback, machineName: "studio-01" });

    it("runs one of its agent's fixed forms as the whole input, unstamped and nobody's prompt", async () => {
      fake.record = atPrompt({ detectedAgentId: "codex" });

      const receipt = await send(" /goal resume\n");

      expect(receipt.sent).toBe(true);
      expect(submits).toEqual([
        {
          text: "/goal resume",
          token: (receipt as { submissionToken: string }).submissionToken,
          promptAsWritten: null,
        },
      ]);
      expect(receipt).toMatchObject({ sent: true, terminalId: WORKER, command: "/goal resume" });
    });

    it("refuses any other, naming the forms that run and the hand-over, with nothing sent", async () => {
      fake.record = atPrompt({ detectedAgentId: "codex" });

      for (const command of ["/clear", "/quit", "/goal", "/goal resume now", "/compact\nthen go"]) {
        const error = await refusal(send(command));
        expect(error.code, command).toBe(WORKER_STEER_REFUSALS.commandNotAllowed);
        expect(error.message).toContain(
          "`/goal resume`, `/goal pause`, `/compact` and `/status`, each sent alone"
        );
        expect(error.message).toContain("Hand to orchestrator");
        expect(error.message).toContain("Nothing was sent.");
      }
      expect(submits).toEqual([]);
    });

    it("refuses one it can never run before asking whether the agent is free", async () => {
      fake.record = atPrompt({
        detectedAgentId: "codex",
        agentState: "working",
        waitingReason: undefined,
      });

      expect((await refusal(send("/clear"))).code).toBe(WORKER_STEER_REFUSALS.commandNotAllowed);
      expect(submits).toEqual([]);
    });

    it("holds each agent to its own forms", async () => {
      // Claude takes `/compact` alone: Codex's `/goal resume` is refused there.
      const claude = await refusal(send("/goal resume"));
      expect(claude.code).toBe(WORKER_STEER_REFUSALS.commandNotAllowed);
      expect(claude.message).toContain("The only slash command that runs in");
      expect(claude.message).toContain("is `/compact`, sent alone");

      fake.record = atPrompt({ detectedAgentId: "aider" });
      const aider = await refusal(send("/compact"));
      expect(aider.code).toBe(WORKER_STEER_REFUSALS.commandNotAllowed);
      expect(aider.message).toContain("No slash command runs in terminal 'term-worker' (aider)");

      fake.record = atPrompt();
      await send("/compact");
      expect(submits.map(({ text }) => text)).toEqual(["/compact"]);
    });

    it("keeps a prompt that opens with a path a stamped prompt", async () => {
      fake.record = atPrompt({ detectedAgentId: "codex" });

      await send("/Users/me/app/src/index.ts throws on start, fix it");

      expect(submits[0]!.text).toContain("From the Daintree Assistant on studio-01");
      expect(submits[0]!.promptAsWritten).toBe(
        "/Users/me/app/src/index.ts throws on start, fix it"
      );
    });

    it("refuses a fixed form with a handback, whose instruction would make it prose", async () => {
      fake.record = atPrompt({ detectedAgentId: "codex" });

      const error = await refusal(send("/goal resume", true));

      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message).toContain("without `handback`");
      expect(submits).toEqual([]);
    });

    it("holds a fixed form to every gate a prompt answers to", async () => {
      for (const record of [
        atPrompt({ detectedAgentId: "codex", agentState: "working", waitingReason: undefined }),
        atPrompt({ detectedAgentId: "codex", lastTypedInputAt: 1_500 }),
        atPrompt({ detectedAgentId: "codex", hasPendingSubmission: true }),
      ]) {
        fake.record = record;
        expect([WORKER_STEER_REFUSALS.busy, WORKER_STEER_REFUSALS.typing]).toContain(
          (await refusal(send("/goal resume"))).code
        );
      }
      fake.record = atPrompt({ detectedAgentId: "codex" });
      fake.generation = 5;
      expect((await refusal(send("/goal resume"))).code).toBe(WORKER_STEER_REFUSALS.restarted);
      fake.generation = 4;
      const revoked = await refusal(
        steer.prompt(
          target({
            authorize: () => {
              throw new AssistantTargetError("DRIVEN_ELSEWHERE", "Another machine drives it.");
            },
          }),
          { command: "/goal resume", handback: false, machineName: "m" }
        )
      );
      expect(revoked.code).toBe("DRIVEN_ELSEWHERE");
      expect(submits).toEqual([]);
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

  describe("its own earlier keys (#16094)", () => {
    it("lets keys through after its own, and says so on that receipt alone", async () => {
      const first = await steer.keys(target(), { keys: ["Escape"] });

      const second = await steer.keys(target(), { keys: ["Escape"] });

      expect(writes).toEqual(["\x1b", "\x1b"]);
      expect(first.inputSinceSettle).toBeUndefined();
      expect(second).toMatchObject({ keys: ["Escape"], inputSinceSettle: "own-keys" });
    });

    it("lets an interrupt through after its own keys, and says so", async () => {
      await steer.keys(target(), { keys: ["Escape"] });
      fake.record!.agentState = "working";
      fake.record!.waitingReason = undefined;

      const result = await steer.interrupt(target());

      expect(escapes).toBe(1);
      expect(result.inputSinceSettle).toBe("own-keys");
    });

    it("lets keys through after its own interrupt", async () => {
      fake.record = atPrompt({ agentState: "working", waitingReason: undefined });
      await steer.interrupt(target());

      await expect(steer.keys(target(), { keys: ["Escape"] })).resolves.toMatchObject({
        inputSinceSettle: "own-keys",
      });
    });

    it("still refuses once a person types after them", async () => {
      await steer.keys(target(), { keys: ["Escape"] });
      personTypes();

      const error = await refusal(steer.keys(target(), { keys: ["Escape"] }));

      expect(error.code).toBe(WORKER_STEER_REFUSALS.typing);
      expect(error.message).toContain("Someone has typed");
      expect(writes).toEqual(["\x1b"]);
    });

    it("still refuses a person's key that landed between its check and its write", async () => {
      // Under a "nothing newer than our own stamp" rule this key would be filed as ours.
      await steer.keys(target({ authorize: personTypes }), { keys: ["Escape"] });

      const error = await refusal(steer.keys(target(), { keys: ["Escape"] }));

      expect(error.code).toBe(WORKER_STEER_REFUSALS.typing);
      expect(writes).toEqual(["\x1b"]);
    });

    it("counts another assistant's keys as someone's", async () => {
      await steer.keys(target({ inputOwner: "principal\u0000help\u0000other" }), {
        keys: ["a"],
      });

      const keys = await refusal(steer.keys(target(), { keys: ["Enter"] }));
      fake.record!.agentState = "working";
      fake.record!.waitingReason = undefined;
      const interrupt = await refusal(steer.interrupt(target()));

      expect(keys.code).toBe(WORKER_STEER_REFUSALS.typing);
      expect(interrupt.code).toBe(WORKER_STEER_REFUSALS.typing);
      expect(writes).toEqual(["a"]);
      expect(escapes).toBe(0);
    });

    it("still holds a prompt until the agent settles again, naming its own keys", async () => {
      await steer.keys(target(), { keys: ["Up"] });

      const error = await refusal(
        steer.prompt(target(), { command: "go", handback: false, machineName: "m" })
      );

      expect(error.code).toBe(WORKER_STEER_REFUSALS.typing);
      expect(error.message).toContain("keys you sent");
      expect(error.message).not.toContain("Someone");
      expect(submits).toEqual([]);

      fake.record!.lastStateChange = ++fake.clock;
      await steer.prompt(target(), { command: "go", handback: false, machineName: "m" });
      expect(submits).toHaveLength(1);
    });
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
    duringGap = personTypes;

    const error = await refusal(steer.keys(target(), { keys: ["Down", "Enter"] }));

    expect(error.code).toBe(WORKER_STEER_REFUSALS.partial);
    expect(error.message).toContain("1 of 2 keys were sent (Down)");
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
  it("stops the rest when the agent drops back to its shell between keys", async () => {
    fake.record = atPrompt({ waitingReason: "approval" });
    duringGap = () => {
      fake.record!.detectedAgentId = undefined;
    };

    const error = await refusal(steer.keys(target(), { keys: ["Escape", "1"] }));

    expect(error.code).toBe(WORKER_STEER_REFUSALS.partial);
    expect(error.message).toContain("plain shell");
    expect(error.message).toContain("1 of 2 keys were sent (Escape)");
    expect(writes).toEqual(["\x1b"]);
  });

  it("quotes no screen when the run was replaced while it was being read", async () => {
    fake.record = atPrompt({ waitingReason: "approval" });
    fake.screen = "a successor's screen";
    duringRead = () => {
      fake.generation = 5;
    };

    const result = await steer.keys(target(), { keys: ["Enter"] });

    expect(result.keys).toEqual(["Enter"]);
    expect(result.screen).toBeUndefined();
  });

  it("lets the run be steered again once a refused steer has let go", async () => {
    fake.record = atPrompt({ lastTypedInputAt: 1_500 });
    await refusal(steer.keys(target(), { keys: ["Enter"] }));
    fake.record = atPrompt({ waitingReason: "approval" });

    await expect(steer.keys(target(), { keys: ["Enter"] })).resolves.toMatchObject({
      keys: ["Enter"],
    });
  });

  describe("showing the person a worker's panel (#16096)", () => {
    const shown = () => vi.fn(async () => "shown");

    it("shows a worker someone is typing into, mid-turn, or one a steer is still writing to", async () => {
      const show = shown();
      fake.record = atPrompt({ lastTypedInputAt: 1_500, hasPendingSubmission: true });
      await expect(steer.reveal(target(), show)).resolves.toBe("shown");

      fake.record = atPrompt({ agentState: "working", waitingReason: undefined });
      await expect(steer.reveal(target(), show)).resolves.toBe("shown");

      fake.record = atPrompt({ waitingReason: "approval" });
      const writing = steer.keys(target(), { keys: ["Down", "Enter"] });
      await expect(steer.reveal(target(), show)).resolves.toBe("shown");
      await writing;

      expect(show).toHaveBeenCalledTimes(3);
    });

    // One gate: every run a steer can't reach, a reveal can't either, refused alike.
    it.each<[string, () => void]>([
      ["a plain shell", () => (fake.record = atPrompt({ detectedAgentId: undefined }))],
      ["an exited agent", () => (fake.record = atPrompt({ isExited: true }))],
      ["a trashed panel", () => (fake.record = atPrompt({ isTrashed: true }))],
      ["a panel with no process", () => (fake.record = atPrompt({ hasPty: false }))],
      ["an unreadable terminal", () => (fake.record = null)],
      ["another project's terminal", () => (fake.projectId = "proj-2")],
      ["a terminal its record puts elsewhere", () => (fake.record = atPrompt({ projectId: "x" }))],
      ["an assistant", () => (fake.assistant = true)],
      ["an assistant by its record", () => (fake.record = atPrompt({ isAssistantTerminal: true }))],
      ["a restarted run", () => (fake.generation = 5)],
    ])("refuses %s as a prompt is refused, showing nothing", async (_what, arrange) => {
      arrange();
      const show = shown();

      const shownRefusal = await refusal(steer.reveal(target(), show));
      const sentRefusal = await refusal(
        steer.prompt(target(), { command: "go", handback: false, machineName: "m" })
      );

      expect(shownRefusal.code).toBe(sentRefusal.code);
      expect(shownRefusal.message).toContain("Nothing was shown.");
      expect(shownRefusal.message).not.toContain("Nothing was sent.");
      expect(show).not.toHaveBeenCalled();
      expect(submits).toEqual([]);
    });

    it("needs the generation it read, and refuses without one", async () => {
      const show = shown();
      const error = await refusal(steer.reveal(target({ generation: undefined }), show));

      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message).toContain("incarnation");
      expect(error.message).toMatch(/^Showing/);
      expect(show).not.toHaveBeenCalled();
    });

    it("shows nothing when the run is replaced while it is being read", async () => {
      const show = shown();
      const racing = new GlobalWorkerSteer({
        getTerminalProjectId: () => PROJECT,
        getLiveGeneration: () => fake.generation,
        isAssistantTerminal: () => false,
        getTerminal: async () => {
          fake.generation = 5;
          return atPrompt();
        },
        serializedState: async () => null,
        submit: vi.fn(),
        write: vi.fn(),
        doubleEscape: vi.fn(),
      });

      expect((await refusal(racing.reveal(target(), show))).code).toBe(
        WORKER_STEER_REFUSALS.restarted
      );
      expect(show).not.toHaveBeenCalled();
    });

    it("asks whether it may still act once the run is read, and shows nothing when it may not", async () => {
      const show = shown();
      const authorize = vi.fn(() => {
        throw new AssistantTargetError("DRIVEN_ELSEWHERE", "Another machine drives it.");
      });

      expect((await refusal(steer.reveal(target({ authorize }), show))).code).toBe(
        "DRIVEN_ELSEWHERE"
      );
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(show).not.toHaveBeenCalled();
    });

    it("answers with the reveal's own failure, untouched", async () => {
      const failure = new Error("no view");
      await expect(steer.reveal(target(), async () => Promise.reject(failure))).rejects.toBe(
        failure
      );
    });
  });
});

describe("liveGlobalWorkerSteer (#14551)", () => {
  it("submits under the pty-host's strict settled-prompt guard", async () => {
    const pty = {
      getTerminalProjectId: () => PROJECT,
      getLiveGeneration: () => 4,
      isAssistantTerminal: () => false,
      getTerminalAsync: async () => ({
        projectId: PROJECT,
        detectedAgentId: "claude",
        agentState: "waiting",
        waitingReason: "prompt",
        lastStateChange: 1_000,
        hasPty: true,
      }),
      submit: vi.fn(),
    };
    const steer = liveGlobalWorkerSteer({
      pty: () => pty as never,
      isAssistantTerminal: () => false,
    });

    await steer.prompt(
      {
        projectId: PROJECT,
        terminalId: WORKER,
        generation: 4,
        inputOwner: OWNER,
        authorize: () => {},
      },
      { command: "go", handback: false, machineName: "m" }
    );

    expect(pty.submit).toHaveBeenCalledWith(
      WORKER,
      expect.stringContaining("go"),
      expect.any(String),
      undefined,
      "settled-prompt-strict",
      undefined,
      "go"
    );
  });

  it("files its keys and its double Escape under the steering assistant (#16094)", async () => {
    const pty = {
      getTerminalProjectId: () => PROJECT,
      getLiveGeneration: () => 4,
      isAssistantTerminal: () => false,
      getTerminalAsync: async () => ({
        projectId: PROJECT,
        detectedAgentId: "claude",
        agentState: "working",
        lastStateChange: 1_000,
        hasPty: true,
      }),
      getSerializedStateAsync: async () => null,
      write: vi.fn(),
      batchDoubleEscape: vi.fn(),
    };
    const steer = liveGlobalWorkerSteer({
      pty: () => pty as never,
      isAssistantTerminal: () => false,
    });
    const target = {
      projectId: PROJECT,
      terminalId: WORKER,
      generation: 4,
      inputOwner: OWNER,
      authorize: () => {},
    };

    vi.useFakeTimers();
    try {
      const keys = steer.keys(target, { keys: ["Escape"] });
      await vi.runAllTimersAsync();
      await keys;
    } finally {
      vi.useRealTimers();
    }
    await steer.interrupt(target);

    expect(pty.write).toHaveBeenCalledWith(WORKER, "\x1b", undefined, OWNER);
    expect(pty.batchDoubleEscape).toHaveBeenCalledWith([WORKER], OWNER);
  });

  it("submits a fixed slash form as written, as nobody's prompt (#16101)", async () => {
    const pty = {
      getTerminalProjectId: () => PROJECT,
      getLiveGeneration: () => 4,
      isAssistantTerminal: () => false,
      getTerminalAsync: async () => ({
        projectId: PROJECT,
        detectedAgentId: "codex",
        agentState: "waiting",
        waitingReason: "prompt",
        lastStateChange: 1_000,
        hasPty: true,
      }),
      submit: vi.fn(),
    };
    const steer = liveGlobalWorkerSteer({
      pty: () => pty as never,
      isAssistantTerminal: () => false,
    });

    await steer.prompt(
      {
        projectId: PROJECT,
        terminalId: WORKER,
        generation: 4,
        inputOwner: OWNER,
        authorize: () => {},
      },
      { command: "/goal resume", handback: false, machineName: "m" }
    );

    expect(pty.submit).toHaveBeenCalledWith(
      WORKER,
      "/goal resume",
      expect.any(String),
      undefined,
      "settled-prompt-strict",
      undefined,
      null
    );
  });
});

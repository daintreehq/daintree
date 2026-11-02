import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../../events.js";
import { getAgentAvailabilityStore } from "../../AgentAvailabilityStore.js";
import type { AgentState, WaitingReason } from "../../../../shared/types/agent.js";
import { waitForAgentAtPrompt } from "../agentPromptWait.js";

let counter = 0;
const nextTerminal = () => `prompt-wait-${++counter}`;

function spawn(terminalId: string) {
  events.emit("agent:spawned", { agentId: "claude", terminalId, timestamp: Date.now() });
}

function transition(
  terminalId: string,
  state: AgentState,
  waitingReason?: WaitingReason,
  trigger: "output" | "exit" = "output"
) {
  events.emit("agent:state-changed", {
    agentId: "claude",
    terminalId,
    state,
    previousState: "working",
    trigger,
    confidence: 1,
    timestamp: Date.now(),
    ...(waitingReason ? { waitingReason } : {}),
  });
}

/** As `TerminalProcess.kill` reports one: the reset to idle, then the kill. */
function kill(terminalId: string) {
  transition(terminalId, "idle", undefined, "exit");
  events.emit("agent:killed", { agentId: "claude", terminalId, timestamp: Date.now() });
}

/** Whether the promise has settled, without waiting on it. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
  getAgentAvailabilityStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("waitForAgentAtPrompt", () => {
  it("waits through a launch's boot for its first prompt", async () => {
    const terminalId = nextTerminal();
    const wait = waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000 });

    spawn(terminalId);
    transition(terminalId, "working");
    expect(await isSettled(wait)).toBe(false);
    transition(terminalId, "waiting", "prompt");

    await expect(wait).resolves.toEqual({
      terminalId,
      outcome: "settled",
      state: "waiting",
      waitingReason: "prompt",
    });
  });

  it("ignores other terminals' transitions", async () => {
    const terminalId = nextTerminal();
    const other = nextTerminal();
    spawn(terminalId);
    spawn(other);
    const wait = waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000 });
    transition(other, "waiting", "prompt");
    kill(other);
    expect(await isSettled(wait)).toBe(false);
  });

  it("never reads a terminal not yet announced as idle", async () => {
    const terminalId = nextTerminal();
    const wait = waitForAgentAtPrompt(terminalId, { timeoutMs: 5_000 });
    expect(await isSettled(wait)).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(wait).resolves.toEqual({ terminalId, outcome: "timeout" });
  });

  it("keeps waiting through a completion until the prompt that follows it", async () => {
    const terminalId = nextTerminal();
    spawn(terminalId);
    const wait = waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000 });

    transition(terminalId, "completed");
    expect(await isSettled(wait)).toBe(false);
    transition(terminalId, "idle");

    await expect(wait).resolves.toEqual({ terminalId, outcome: "settled", state: "idle" });
  });

  it("answers at once for an agent already at its prompt", async () => {
    const terminalId = nextTerminal();
    spawn(terminalId);
    transition(terminalId, "waiting", "prompt");
    await expect(waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000 })).resolves.toMatchObject({
      outcome: "settled",
      state: "waiting",
      waitingReason: "prompt",
    });
  });

  it("reports an approval on screen as what it is", async () => {
    const terminalId = nextTerminal();
    spawn(terminalId);
    const wait = waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000 });
    transition(terminalId, "waiting", "approval");
    await expect(wait).resolves.toMatchObject({
      outcome: "settled",
      state: "waiting",
      waitingReason: "approval",
    });
  });

  it("reports an agent that quit to its shell", async () => {
    const terminalId = nextTerminal();
    spawn(terminalId);
    const wait = waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000 });
    transition(terminalId, "exited");
    await expect(wait).resolves.toEqual({ terminalId, outcome: "exited", state: "exited" });
  });

  it("reports a terminal killed during the wait, or before it", async () => {
    const terminalId = nextTerminal();
    spawn(terminalId);
    transition(terminalId, "working");
    const wait = waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000 });
    kill(terminalId);
    await expect(wait).resolves.toMatchObject({ outcome: "closed" });
    await expect(waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000 })).resolves.toMatchObject({
      outcome: "closed",
    });
  });

  it("times out with the last state it saw", async () => {
    const terminalId = nextTerminal();
    spawn(terminalId);
    const wait = waitForAgentAtPrompt(terminalId, { timeoutMs: 1_000 });
    transition(terminalId, "completed");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toEqual({ terminalId, outcome: "timeout", state: "completed" });
  });

  it("notes a spawn announced during the wait", async () => {
    const terminalId = nextTerminal();
    const wait = waitForAgentAtPrompt(terminalId, { timeoutMs: 1_000 });
    spawn(terminalId);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toEqual({ terminalId, outcome: "timeout", state: "working" });
  });

  it("stops when the caller gives up", async () => {
    const terminalId = nextTerminal();
    spawn(terminalId);
    const controller = new AbortController();
    const wait = waitForAgentAtPrompt(terminalId, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(wait).resolves.toMatchObject({ outcome: "aborted" });

    await expect(
      waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000, signal: controller.signal })
    ).resolves.toMatchObject({ outcome: "aborted" });
  });

  it.each([
    ["settles", (id: string) => transition(id, "waiting", "prompt"), "settled"],
    ["exits", (id: string) => transition(id, "exited"), "exited"],
    ["is killed", (id: string) => kill(id), "closed"],
    ["times out", () => vi.advanceTimersByTime(60_000), "timeout"],
    ["is given up on", (_id: string, controller: AbortController) => controller.abort(), "aborted"],
  ] as const)(
    "releases its listeners, timer and abort listener when it %s",
    async (_label, end, outcome) => {
      const realOn = events.on.bind(events);
      const offs: Array<ReturnType<typeof vi.fn>> = [];
      vi.spyOn(events, "on").mockImplementation(((
        event: Parameters<typeof events.on>[0],
        listener: Parameters<typeof events.on>[1]
      ) => {
        const off = vi.fn(realOn(event, listener));
        offs.push(off);
        return off;
      }) as typeof events.on);
      const terminalId = nextTerminal();
      spawn(terminalId);
      const controller = new AbortController();
      const removeAbort = vi.spyOn(controller.signal, "removeEventListener");

      const wait = waitForAgentAtPrompt(terminalId, {
        timeoutMs: 60_000,
        signal: controller.signal,
      });
      expect(vi.getTimerCount()).toBe(1);
      end(terminalId, controller);

      await expect(wait).resolves.toMatchObject({ outcome });
      expect(offs).toHaveLength(3);
      for (const off of offs) expect(off).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    }
  );

  it("releases every listener when it settles while still subscribing", async () => {
    const realOn = events.on.bind(events);
    const offs: Array<ReturnType<typeof vi.fn>> = [];
    const terminalId = nextTerminal();
    vi.spyOn(events, "on").mockImplementation(((
      event: Parameters<typeof events.on>[0],
      listener: Parameters<typeof events.on>[1]
    ) => {
      const off = vi.fn(realOn(event, listener));
      offs.push(off);
      // A bus that replays its last event to a new listener: the wait
      // settles before this registration even returns.
      if (event === "agent:state-changed") {
        (listener as (payload: unknown) => void)({
          agentId: "claude",
          terminalId,
          state: "waiting",
          previousState: "working",
          trigger: "output",
          confidence: 1,
          timestamp: Date.now(),
        });
      }
      return off;
    }) as typeof events.on);

    await expect(waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000 })).resolves.toMatchObject({
      outcome: "settled",
    });
    expect(offs).toHaveLength(3);
    for (const off of offs) expect(off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases everything when it answers before waiting at all", async () => {
    const terminalId = nextTerminal();
    spawn(terminalId);
    transition(terminalId, "waiting", "prompt");
    await waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["at its prompt", (id: string) => transition(id, "waiting", "prompt")],
    ["killed", (id: string) => kill(id)],
    ["exited", (id: string) => transition(id, "exited")],
  ] as const)(
    "answers a caller that already gave up, for an agent %s, whichever wait it asked for",
    async (_label, before) => {
      for (const promptOnly of [false, true]) {
        const terminalId = nextTerminal();
        spawn(terminalId);
        before(terminalId);
        const controller = new AbortController();
        controller.abort();
        await expect(
          waitForAgentAtPrompt(terminalId, {
            timeoutMs: 60_000,
            signal: controller.signal,
            promptOnly,
          })
        ).resolves.toMatchObject({ outcome: "aborted" });
        expect(vi.getTimerCount()).toBe(0);
      }
    }
  );

  describe("promptOnly", () => {
    it("waits through idle, an approval and a question for the prompt", async () => {
      const terminalId = nextTerminal();
      spawn(terminalId);
      const wait = waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000, promptOnly: true });
      transition(terminalId, "idle");
      transition(terminalId, "waiting", "approval");
      transition(terminalId, "waiting", "question");
      transition(terminalId, "waiting", "error");
      expect(await isSettled(wait)).toBe(false);

      transition(terminalId, "waiting", "prompt");
      await expect(wait).resolves.toEqual({
        terminalId,
        outcome: "settled",
        state: "waiting",
        waitingReason: "prompt",
      });
    });

    it("answers at once for an agent already at its prompt, and never for one idle", async () => {
      const atPrompt = nextTerminal();
      spawn(atPrompt);
      transition(atPrompt, "waiting", "prompt");
      await expect(
        waitForAgentAtPrompt(atPrompt, { timeoutMs: 60_000, promptOnly: true })
      ).resolves.toMatchObject({ outcome: "settled", waitingReason: "prompt" });

      const idle = nextTerminal();
      spawn(idle);
      transition(idle, "idle");
      const wait = waitForAgentAtPrompt(idle, { timeoutMs: 1_000, promptOnly: true });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(wait).resolves.toEqual({ terminalId: idle, outcome: "timeout", state: "idle" });
    });

    it("stops when the caller gives up, releasing its timer", async () => {
      const terminalId = nextTerminal();
      spawn(terminalId);
      const controller = new AbortController();
      const wait = waitForAgentAtPrompt(terminalId, {
        timeoutMs: 60_000,
        signal: controller.signal,
        promptOnly: true,
      });
      transition(terminalId, "waiting", "approval");
      controller.abort();
      await expect(wait).resolves.toMatchObject({ outcome: "aborted", waitingReason: "approval" });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("still reports an exit and a kill", async () => {
      const exits = nextTerminal();
      spawn(exits);
      const exiting = waitForAgentAtPrompt(exits, { timeoutMs: 60_000, promptOnly: true });
      transition(exits, "exited");
      await expect(exiting).resolves.toMatchObject({ outcome: "exited" });

      const killed = nextTerminal();
      spawn(killed);
      const killing = waitForAgentAtPrompt(killed, { timeoutMs: 60_000, promptOnly: true });
      kill(killed);
      await expect(killing).resolves.toMatchObject({ outcome: "closed" });
    });
  });
});

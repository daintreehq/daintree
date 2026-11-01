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

function transition(terminalId: string, state: AgentState, waitingReason?: WaitingReason) {
  events.emit("agent:state-changed", {
    agentId: "claude",
    terminalId,
    state,
    previousState: "working",
    trigger: "output",
    confidence: 1,
    timestamp: Date.now(),
    ...(waitingReason ? { waitingReason } : {}),
  });
}

function kill(terminalId: string) {
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

  it("releases its listeners and timer however it ends", async () => {
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

    const wait = waitForAgentAtPrompt(terminalId, { timeoutMs: 60_000 });
    expect(vi.getTimerCount()).toBe(1);
    transition(terminalId, "waiting", "prompt");
    await wait;

    expect(offs.length).toBeGreaterThan(0);
    for (const off of offs) expect(off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

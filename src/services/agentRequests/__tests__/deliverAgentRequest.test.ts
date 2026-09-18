import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import { usePanelStore } from "@/store/panelStore";
import {
  __resetAgentRequestsForTests,
  cancelAgentRequests,
  deliverAgentRequest,
  forceAgentRequest,
  type AgentRequestDelivery,
} from "../index";

/** An agent terminal whose detector never classifies it, until told otherwise. */
function terminal(agentState: string | null = null) {
  const sent: string[] = [];
  const launches: string[] = [];
  let state = agentState;
  // What `terminal.getStatus` reports for a live agent session: which agent,
  // and which pty generation. A restart changes `spawnedAt`; a demotion to a
  // plain shell clears `agentId`.
  let agentId: string | null = "claude";
  let spawnedAt = 1_000;
  let waitingReason: string | null = null;
  dispatch.mockImplementation(async (id: string, args: Record<string, unknown>) => {
    if (id === "agent.launch") {
      launches.push(String(args.agentId));
      return { ok: true, result: { launched: true, terminalId: "t1" } };
    }
    if (id === "terminal.getStatus") {
      return {
        ok: true,
        result: {
          terminals: [
            {
              terminalId: "t1",
              agentId,
              spawnedAt,
              agentState: state,
              ...(waitingReason === null ? {} : { waitingReason }),
              submission: args.submissionToken ? { phase: "pty_written" } : undefined,
            },
          ],
        },
      };
    }
    if (id === "terminal.sendCommand") {
      sent.push(String(args.command));
      return { ok: true, result: { submissionToken: "tok" } };
    }
    throw new Error(`unexpected ${id}`);
  });
  return {
    sent,
    launches,
    setState: (next: string) => (state = next),
    // What a real demotion looks like: the agent process exits and leaves its
    // shell reading stdin. The pty never restarted, so `spawnedAt` holds, and
    // `agentId` falls back to what the terminal was launched as — so only
    // `agentState` says anything happened.
    demoteToShell: () => {
      state = "exited";
    },
    /** A pane that was never an agent at all. */
    beNonAgent: () => (agentId = null),
    setWaitingReason: (next: string) => (waitingReason = next),
    restart: () => (spawnedAt += 1),
  };
}

/**
 * `verify` runs twice: once before the prompt is built, and once after
 * readiness has been proved and immediately before the write. Only the second
 * call sits in the window these tests are about, so `change` fires there.
 */
function verifyThenChange(change: () => void): () => Promise<string | null> {
  let calls = 0;
  return async () => {
    if (++calls === 2) change();
    return null;
  };
}

/**
 * Put one terminal panel in a worktree. Only the two fields
 * `destinationStillEligible` reads are set; the store's panel type is far
 * wider and nothing here touches the rest.
 */
function placePanel(terminalId: string, worktreeId: string): void {
  usePanelStore.setState((prior) => ({
    panelsById: {
      ...prior.panelsById,
      [terminalId]: { location: "grid", worktreeId } as (typeof prior.panelsById)[string],
    },
  }));
}

function sink() {
  const states: AgentRequestDelivery[] = [];
  return { states, onState: (delivery: AgentRequestDelivery) => states.push(delivery) };
}

const last = (states: AgentRequestDelivery[]) => states.at(-1);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  dispatch.mockReset();
  __resetAgentRequestsForTests();
  // The worktree test seeds a panel; an entry left behind changes what
  // `destinationStillEligible` sees in every test after it.
  usePanelStore.setState({ panelsById: {} });
});

describe("deliverAgentRequest", () => {
  it("types nothing into an agent whose owner went away while it was getting ready", async () => {
    const agent = terminal();
    const { states, onState } = sink();
    let owned = true;
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => owned,
      onState,
      buildPrompt: async () => "Make it pop",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(last(states)?.state.status).toBe("sending");

    // The plugin was disabled, or the surface switched off: nothing of it is
    // mounted to notice, so the run itself has to.
    owned = false;
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Stopped before the request was sent",
    });
  });

  it("does not send to a destination that stopped being an agent while verifying", async () => {
    // The audit's second reproduction: the picker offers agent terminals, but
    // nothing held the destination to that between the offer and the write.
    const agent = terminal("waiting");
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
      // Readiness is proved before this runs and stale by the time it resolves.
      verify: verifyThenChange(() => agent.demoteToShell()),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude isn't an agent session any more — the request wasn't sent",
    });
  });

  it("refuses a demoted shell even when the user said send anyway", async () => {
    // "Send anyway" waives waiting for a readiness signal. It cannot waive the
    // destination: the agent has exited and its shell is what would read this.
    const agent = terminal("waiting");
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
      verify: verifyThenChange(() => agent.demoteToShell()),
    });
    forceAgentRequest("owner-1\nwt-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude isn't an agent session any more — the request wasn't sent",
    });
  });

  it("does not send to a destination that moved worktree while it was verifying", async () => {
    const agent = terminal("waiting");
    const { states, onState } = sink();
    placePanel("t1", "wt-1");
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
      verify: verifyThenChange(() => placePanel("t1", "wt-2")),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude left this worktree — the request wasn't sent",
    });
  });

  it("does not send into the session that replaced the one it bound to", async () => {
    const agent = terminal("waiting");
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
      // Same terminal id, same agent, different process.
      verify: verifyThenChange(() => agent.restart()),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude restarted before the request went out — nothing was sent",
    });
  });

  it("does not send when readiness lapsed into a question during verification", async () => {
    // The audit's first reproduction: ready, then an approval prompt appears
    // while the source is being re-verified. Typing now answers the question.
    const agent = terminal("waiting");
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
      verify: verifyThenChange(() => agent.setWaitingReason("approval")),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude is asking you something — the request wasn't sent",
    });
  });

  it("lets send-anyway waive readiness but not the session it bound to", async () => {
    const agent = terminal("waiting");
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
      verify: verifyThenChange(() => agent.setWaitingReason("approval")),
    });
    forceAgentRequest("owner-1\nwt-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    // Waived: the request goes out despite the question.
    expect(agent.sent).toEqual(["Make it pop"]);
    expect(last(states)?.state.status).toBe("sent");

    // Not waived: the same force against a restarted session still refuses.
    const second = terminal("waiting");
    const secondSink = sink();
    const run2 = deliverAgentRequest({
      ownerKey: "owner-2\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState: secondSink.onState,
      buildPrompt: async () => "Make it pop",
      verify: verifyThenChange(() => second.restart()),
    });
    forceAgentRequest("owner-2\nwt-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await run2;

    expect(second.sent).toEqual([]);
    expect(last(secondSink.states)?.state).toEqual({
      status: "failed",
      message: "Claude restarted before the request went out — nothing was sent",
    });
  });

  it("keeps the request text and never retries when the write itself failed", async () => {
    terminal("waiting");
    dispatch.mockImplementation(async (id: string) => {
      if (id === "terminal.getStatus") {
        return {
          ok: true,
          result: {
            terminals: [
              { terminalId: "t1", agentId: "claude", spawnedAt: 1_000, agentState: "waiting" },
            ],
          },
        };
      }
      if (id === "terminal.sendCommand") {
        return { ok: false, error: { message: "The terminal stopped accepting input" } };
      }
      throw new Error(`unexpected ${id}`);
    });
    const { states, onState } = sink();
    await deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
    });

    expect(last(states)).toMatchObject({
      state: { status: "failed", message: "The terminal stopped accepting input", partial: true },
      request: "Make it pop",
    });
    expect(dispatch.mock.calls.filter(([id]) => id === "terminal.sendCommand")).toHaveLength(1);
  });

  it("joins an in-flight run with the same idempotency key instead of sending twice", async () => {
    const agent = terminal();
    const first = sink();
    const second = sink();
    const options = {
      ownerKey: "owner-1\nwt-1",
      idempotencyKey: "owner-1\nwt-1\nterminal:t1\nMake it pop",
      destination: { kind: "terminal" as const, terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      buildPrompt: async () => "Make it pop",
    };
    const run = deliverAgentRequest({ ...options, onState: first.onState });
    await vi.advanceTimersByTimeAsync(1_000);
    // The surface remounted and asked again for the same words, same place.
    const rejoined = deliverAgentRequest({ ...options, onState: second.onState });
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    await rejoined;

    expect(agent.sent).toEqual(["Make it pop"]);
    expect(last(first.states)?.state.status).toBe("sent");
    // The second caller never started a run, so it gets no state of its own —
    // the key deduplicates the submission, it does not fan the receipt out.
    expect(second.states).toEqual([]);

    // Once it has settled the key is free again: repeating an uncertain request
    // is the user's call, and nothing must block it forever.
    const third = sink();
    const again = deliverAgentRequest({ ...options, onState: third.onState });
    await vi.advanceTimersByTimeAsync(2_000);
    await again;
    expect(agent.sent).toEqual(["Make it pop", "Make it pop"]);
  });

  it("frees an idempotency key on cancellation, so the next send is its own run", async () => {
    const agent = terminal();
    const first = sink();
    const options = {
      ownerKey: "owner-1\nwt-1",
      idempotencyKey: "owner-1\nwt-1\nterminal:t1\nMake it pop",
      destination: { kind: "terminal" as const, terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      buildPrompt: async () => "Make it pop",
    };
    const cancelled = deliverAgentRequest({ ...options, onState: first.onState });
    await vi.advanceTimersByTimeAsync(1_000);
    cancelAgentRequests("owner-1\n");

    // The cancelled run is still awaiting its poll. A send of the same words
    // must not join it — it will never submit anything.
    const second = sink();
    const run = deliverAgentRequest({ ...options, onState: second.onState });
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await cancelled;
    await run;
    expect(agent.sent).toEqual(["Make it pop"]);
    expect(last(second.states)?.state.status).toBe("sent");
  });

  it("frees the key before the caller resumes, so an immediate resend is a real run", async () => {
    const agent = terminal("waiting");
    const options = {
      ownerKey: "owner-1\nwt-1",
      idempotencyKey: "owner-1\nwt-1\nterminal:t1\nMake it pop",
      destination: { kind: "terminal" as const, terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState: () => {},
      buildPrompt: async () => "Make it pop",
    };
    const first = deliverAgentRequest(options);
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    // Straight off the await: a key still held one microtask longer would hand
    // back the finished run and send nothing.
    const second = deliverAgentRequest(options);
    await vi.advanceTimersByTimeAsync(2_000);
    await second;
    expect(agent.sent).toEqual(["Make it pop", "Make it pop"]);
  });

  it("frees a superseded run's key, so retrying that request is a real run", async () => {
    const agent = terminal();
    const owner = "owner-1\nwt-1";
    const base = {
      ownerKey: owner,
      destination: { kind: "terminal" as const, terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState: () => {},
    };
    const older = deliverAgentRequest({
      ...base,
      idempotencyKey: `${owner}\nfirst`,
      buildPrompt: async () => "First",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    // A second request for the same owner supersedes the first, which is now
    // nobody's answer even though it is still awaiting its poll.
    const newer = deliverAgentRequest({
      ...base,
      idempotencyKey: `${owner}\nsecond`,
      buildPrompt: async () => "Second",
    });
    // The user goes back to the first request and asks for it again.
    const retry = deliverAgentRequest({
      ...base,
      idempotencyKey: `${owner}\nfirst`,
      buildPrompt: async () => "First",
    });
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await older;
    await newer;
    await retry;
    // The retry is the live run, so its words are what went out — once.
    expect(agent.sent).toEqual(["First"]);
  });

  it("launches once, then types the request in when the new session is at its prompt", async () => {
    const agent = terminal();
    const { states, onState } = sink();
    const destinations: string[] = [];
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "launch", agentId: "claude", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      onDestination: (terminalId) => destinations.push(terminalId),
      buildPrompt: async () => "Make it pop",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(agent.launches).toEqual(["claude"]);
    expect(destinations).toEqual(["t1"]);
    expect(states.some((delivery) => delivery.state.status === "starting")).toBe(true);
    // Not before the agent is observed at its prompt: a launch that is still
    // printing a trust question would take the request as its answer.
    expect(agent.sent).toEqual([]);

    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(agent.launches).toEqual(["claude"]);
    expect(agent.sent).toEqual(["Make it pop"]);
    expect(last(states)).toMatchObject({ state: { status: "sent" }, terminalId: "t1" });
  });

  it("sends on the user's word when readiness never resolves", async () => {
    const agent = terminal();
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(last(states)?.state.status).toBe("unknown-readiness");
    expect(agent.sent).toEqual([]);

    forceAgentRequest("owner-1\nwt-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(agent.sent).toEqual(["Make it pop"]);
  });

  it("cancels by owner-key prefix and leaves other owners' requests running", async () => {
    const agent = terminal();
    const mine = sink();
    const other = sink();
    const options = {
      destination: { kind: "terminal" as const, terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      buildPrompt: async () => "Make it pop",
    };
    const run = deliverAgentRequest({
      ...options,
      ownerKey: "owner-1\nwt-1",
      onState: mine.onState,
    });
    const untouched = deliverAgentRequest({
      ...options,
      ownerKey: "owner-2\nwt-1",
      onState: other.onState,
    });
    await vi.advanceTimersByTimeAsync(6_000);

    cancelAgentRequests("owner-1\n");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(last(mine.states)?.state).toEqual({
      status: "failed",
      message: "Stopped before the request was sent",
    });

    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await untouched;
    expect(last(other.states)?.state.status).toBe("sent");
    expect(agent.sent).toEqual(["Make it pop"]);
  });
});

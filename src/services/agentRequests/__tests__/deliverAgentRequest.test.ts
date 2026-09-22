import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import { usePanelStore } from "@/store/panelStore";
import {
  __resetAgentRequestsForTests,
  cancelAgentRequest,
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
  let spawnedAt: number | undefined = 1_000;
  // How many relaunches inside this pty the host has seen (#12535). Zero is a
  // live agent that has not been replaced; the renderer surface reports it for
  // every pty-backed pane, so the default here is what real panes report.
  let agentIncarnation: number | undefined = 0;
  let hasPty: boolean | undefined = undefined;
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
              ...(spawnedAt === undefined ? {} : { spawnedAt }),
              ...(agentIncarnation === undefined ? {} : { agentIncarnation }),
              ...(hasPty === undefined ? {} : { hasPty }),
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
    setState: (next: string | null) => (state = next),
    // What a real demotion looks like: the agent process exits and leaves its
    // shell reading stdin. The pty never restarted, so `spawnedAt` holds, and
    // `agentId` falls back to what the terminal was launched as — so only
    // `agentState` says anything happened.
    demoteToShell: () => {
      state = "exited";
    },
    /** A pane that was never an agent at all. */
    beNonAgent: () => (agentId = null),
    /**
     * A pane restored without its process: `addPanel` leaves a recovery hold
     * unstamped and marks it `hasPty: false`, so it reports a launch agent id
     * and nothing that says which session, because there is none.
     */
    beRecoveryHold: () => {
      spawnedAt = undefined;
      hasPty = false;
    },
    /** A surface that reports no spawn stamp at all, process or no process. */
    hideSpawnedAt: () => (spawnedAt = undefined),
    /** A surface too old to count sessions — it cannot name which one this is. */
    hideIncarnation: () => (agentIncarnation = undefined),
    setWaitingReason: (next: string) => (waitingReason = next),
    restart: () => (spawnedAt = (spawnedAt ?? 0) + 1),
    /**
     * The bug this identity exists for (#12535): the agent quits, the user runs
     * the same CLI again in the shell it left, and the pty never restarts. Same
     * slot, same pty, same agent id, same spawn stamp — only the host's count
     * of sessions it has watched take the pty over moves.
     */
    relaunchAgent: () => {
      agentIncarnation = (agentIncarnation ?? 0) + 1;
      state = "waiting";
    },
    /** A pty replayed under the same id, counting from the start again. */
    rewindIncarnation: () => {
      agentIncarnation = 0;
      state = "waiting";
    },
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
    expect(last(states)?.state.status).toBe("queued");

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
    // "Send now" waives waiting for a readiness signal. It cannot waive the
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

  it("does not send into an agent relaunched inside the pty it bound to", async () => {
    // The whole of #12535: the bound agent quits to its shell, the user types
    // the same CLI again, and every other observable holds — same slot, same
    // pty, same agent id, same spawn stamp. Only the host's count of sessions
    // it has watched take this pty over says a different one is listening.
    const agent = terminal("waiting");
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
      verify: verifyThenChange(() => agent.relaunchAgent()),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude restarted before the request went out — nothing was sent",
    });
  });

  it("does not let 'send anyway' waive a relaunch inside the same pty", async () => {
    // Forcing waives the readiness signal, not the proof of where the words go.
    const agent = terminal("waiting");
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
      verify: verifyThenChange(() => agent.relaunchAgent()),
    });
    forceAgentRequest("owner-1\nwt-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude restarted before the request went out — nothing was sent",
    });
  });

  it("sends to a session that has not been relaunched", async () => {
    // The other half of the guard: a count that holds is a session that holds,
    // and zero is a reading rather than a refusal.
    const agent = terminal("waiting");
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual(["Make it pop"]);
    expect(last(states)?.state.status).toBe("sent");
  });

  it("does not bind on a surface that cannot say which session this is", async () => {
    // A surface too old to report the count cannot tell this session from the
    // one that replaces it, and two absent counts compare equal — the shape the
    // absent spawn stamp already had to be refused for.
    const agent = terminal("waiting");
    agent.hideIncarnation();
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state.status).toBe("failed");
  });

  it("does not rebind when the destination leaves its prompt and comes back", async () => {
    // The retry path: the last look finds the agent no longer at its prompt, so
    // the run goes back to waiting. The session is replaced while it waits. It
    // must keep the session it bound to — re-reading the identity on the way
    // round would make the relaunch the thing it thinks it was always
    // addressing, and it would send into it (#12535).
    const agent = terminal("waiting");
    let calls = 0;
    let offPrompt = false;
    let relaunched = false;
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      // Called on every settle, so it is where the relaunch lands: once the run
      // has gone back to waiting, the next one puts a new session at the prompt.
      stillOwned: () => {
        if (offPrompt && !relaunched) {
          relaunched = true;
          agent.relaunchAgent();
        }
        return true;
      },
      onState,
      buildPrompt: async () => "Make it pop",
      // The second call is the one inside the pre-write window. Take the agent
      // off its prompt there, so the look after it sends the run round again.
      verify: async () => {
        if (++calls === 2) {
          agent.setState("working");
          offPrompt = true;
        }
        return null;
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    expect(relaunched).toBe(true);
    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude restarted before the request went out — nothing was sent",
    });
  });

  it("binds while the agent is still working, not when it reaches its prompt", async () => {
    // A request queued behind an agent's work is a request for the session it
    // was asked of. If that one ends and another starts in the same pty while
    // the request waits, the prompt it eventually finds belongs to someone else.
    const agent = terminal("working");
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
    });
    // Bound against the working session on the first look, then replaced.
    await vi.advanceTimersByTimeAsync(1_000);
    agent.relaunchAgent();
    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude restarted before the request went out — nothing was sent",
    });
  });

  it("ends the run on the look that names a different session, not at the end", async () => {
    // A pty replayed under the same id after a host crash starts counting
    // again, so a slot that has already been seen to change can come back to
    // the numbers the run bound to. The check latches on the first look that
    // disagrees rather than being weighed once more at the write (#12535).
    const agent = terminal("working");
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
    });
    // Bound against the working session, then replaced, then wound back to the
    // count it bound to — as a replayed pty would.
    await vi.advanceTimersByTimeAsync(1_000);
    agent.relaunchAgent();
    await vi.advanceTimersByTimeAsync(1_000);
    agent.rewindIncarnation();
    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude restarted before the request went out — nothing was sent",
    });
  });

  it("does not bind to a pane restored without its process", async () => {
    // Both halves of the identity are absent here, and absent compares equal to
    // absent — the session check would pass on nothing at all.
    const agent = terminal("waiting");
    agent.beRecoveryHold();
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude has no session running — the request wasn't sent",
    });
  });

  it("does not bind on an unstamped session even when 'send anyway' waived readiness", async () => {
    // "Send anyway" waives the readiness signal, not the proof of where the
    // words go: an unnameable session is still unnameable under force.
    const agent = terminal(null);
    agent.hideSpawnedAt();
    const { states, onState } = sink();
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState,
      buildPrompt: async () => "Make it pop",
    });
    forceAgentRequest("owner-1\nwt-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({
      status: "failed",
      message: "Claude has no session running — the request wasn't sent",
    });
  });

  it("goes back to waiting, unsent, when readiness lapsed into a question during verification", async () => {
    // The audit's first reproduction: ready, then an approval prompt appears
    // while the source is being re-verified. Typing now answers the question.
    // It is not a reason to lose the request either: it waits for the answer.
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
    await vi.advanceTimersByTimeAsync(5_000);
    expect(agent.sent).toEqual([]);
    expect(last(states)?.state).toEqual({ status: "needs-you" });

    cancelAgentRequests("owner-1\n");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(agent.sent).toEqual([]);
  });

  it("stops what is queued behind a request cancelled after it was typed", async () => {
    let release: () => void = () => {};
    const agent = terminal("waiting");
    const normal = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (id: string, args: Record<string, unknown>) => {
      if (id !== "terminal.sendCommand") return normal(id, args);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return normal(id, args);
    });
    const first = sink();
    const second = sink();
    const base = {
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal" as const, terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
    };
    const typed = deliverAgentRequest({
      ...base,
      onState: first.onState,
      buildPrompt: async () => "First",
    });
    const behind = deliverAgentRequest({
      ...base,
      onState: second.onState,
      buildPrompt: async () => "Second",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    // Removed while it is going in: that can't take back what was typed, and
    // the one behind it must not be typed on top of it.
    expect(cancelAgentRequest("owner-1\nwt-1", first.states[0]!.id)).toBe("submitted");
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([typed, behind]);
    expect(last(first.states)?.state).toEqual({ status: "unconfirmed" });
    expect(last(second.states)?.state).toMatchObject({ status: "failed" });
    expect(agent.sent).toEqual(["First"]);
  });

  it("lets one request into a terminal at a time, whoever it belongs to", async () => {
    const agent = terminal("waiting");
    const make = (ownerKey: string, prompt: string) =>
      deliverAgentRequest({
        ownerKey,
        destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
        worktreeId: "wt-1",
        stillOwned: () => true,
        onState: () => {},
        buildPrompt: async () => prompt,
      });
    // Two previews, one agent: both are at the head of their own queue and both
    // read "waiting" in the same poll.
    const one = make("owner-1\nwt-1", "From the first preview");
    const two = make("owner-2\nwt-1", "From the second preview");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(agent.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([one, two]);
    expect(agent.sent).toHaveLength(2);
  });

  it("takes an unreadable status for no evidence that the last request was picked up", async () => {
    const agent = terminal("waiting");
    const make = (prompt: string) =>
      deliverAgentRequest({
        ownerKey: "owner-1\nwt-1",
        destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
        worktreeId: "wt-1",
        stillOwned: () => true,
        onState: () => {},
        buildPrompt: async () => prompt,
      });
    const first = make("First");
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    const second = make("Second");
    // The detector goes quiet for a poll and comes back reading "waiting", as
    // it did before: nothing was seen to happen, so the spacing still stands.
    agent.setState(null);
    await vi.advanceTimersByTimeAsync(1_000);
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(agent.sent).toEqual(["First"]);
    await vi.advanceTimersByTimeAsync(8_000);
    await second;
    expect(agent.sent).toEqual(["First", "Second"]);
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
              {
                terminalId: "t1",
                agentId: "claude",
                spawnedAt: 1_000,
                agentIncarnation: 0,
                agentState: "waiting",
              },
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
    // Not straight in behind the first: the agent hasn't been seen to pick that
    // one up, so "waiting" is given a moment to be a fresh reading.
    await vi.advanceTimersByTimeAsync(7_000);
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
    await vi.advanceTimersByTimeAsync(7_000);
    await second;
    expect(agent.sent).toEqual(["Make it pop", "Make it pop"]);
  });

  it("queues a second request behind the first instead of replacing it", async () => {
    const agent = terminal("working");
    const owner = "owner-1\nwt-1";
    const first = sink();
    const second = sink();
    const base = {
      ownerKey: owner,
      destination: { kind: "terminal" as const, terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
    };
    const older = deliverAgentRequest({
      ...base,
      onState: first.onState,
      idempotencyKey: `${owner}\nfirst`,
      buildPrompt: async () => "First",
    });
    const newer = deliverAgentRequest({
      ...base,
      onState: second.onState,
      idempotencyKey: `${owner}\nsecond`,
      buildPrompt: async () => "Second",
    });
    // Asking for the first again while it waits joins it: a queued request
    // keeps its key, or a remount would put the same words in the queue twice.
    const retry = deliverAgentRequest({
      ...base,
      onState: () => {},
      idempotencyKey: `${owner}\nfirst`,
      buildPrompt: async () => "First",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(last(first.states)?.state.status).toBe("queued");
    expect(last(second.states)?.state.status).toBe("queued");
    expect(first.states[0]?.id).not.toBe(second.states[0]?.id);

    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await older;
    await retry;
    expect(agent.sent).toEqual(["First"]);

    agent.setState("working");
    await vi.advanceTimersByTimeAsync(2_000);
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await newer;
    expect(agent.sent).toEqual(["First", "Second"]);
  });

  it("builds the prompt when the request's turn comes, not when it was queued", async () => {
    const agent = terminal("working");
    let source = "as it was when queued";
    let settled = false;
    const run = deliverAgentRequest({
      ownerKey: "owner-1\nwt-1",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      worktreeId: "wt-1",
      stillOwned: () => true,
      onState: () => {},
      settled: () => settled,
      verify: async () => (settled ? null : "judged too early"),
      buildPrompt: async () => source,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    // The request ahead of it edits the file; the owner is still re-establishing
    // what this one is about when the agent comes back to its prompt.
    source = "as it is when sent";
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(agent.sent).toEqual([]);

    settled = true;
    await vi.advanceTimersByTimeAsync(3_000);
    await run;
    expect(agent.sent).toEqual(["as it is when sent"]);
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
    expect(last(states)?.state.status).toBe("queued");
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

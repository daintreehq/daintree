import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import { __resetAgentRequestsForTests } from "@/services/agentRequests";
import {
  cancelAgentRequests,
  deliverAgentRequest,
  forceAgentRequest,
  removeAgentRequest,
} from "../agentRequest";
import {
  __resetComposerMemoryForTests,
  composerMemoryKey,
  readComposerMemory,
  updateComposerMemory,
} from "../composerMemory";
import { BUILDER_TOOL_ID } from "../../shared/protocol";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import { usePanelStore } from "@/store/panelStore";

const KEY = composerMemoryKey("preview-1", "wt-1");

function previewIn(worktreeId: string) {
  usePanelStore.setState({
    panelsById: {
      "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", worktreeId },
    } as never,
  });
}

/** An agent terminal whose detector never classifies it, until told otherwise. */
function terminal(agentState: string | null = null) {
  const sent: string[] = [];
  let state = agentState;
  dispatch.mockImplementation(async (id: string, args: Record<string, unknown>) => {
    if (id === "terminal.getStatus") {
      return {
        ok: true,
        result: {
          terminals: [
            {
              terminalId: "t1",
              // As `terminal.getStatus` reports a live agent session: delivery
              // binds to these and refuses a slot that stopped being this one.
              agentId: "claude",
              spawnedAt: 1_000,
              agentState: state,
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
  return { sent, setState: (next: string) => (state = next) };
}

/** The newest request's record. */
function last() {
  return readComposerMemory(KEY).deliveries.at(-1);
}

function statuses() {
  return readComposerMemory(KEY).deliveries.map(
    (delivery) => `${delivery.instruction}: ${delivery.state.status}`
  );
}

function send(overrides: { subjectKey?: string; prompt?: string; words?: string } = {}) {
  return deliverAgentRequest({
    memoryKey: KEY,
    worktreeId: "wt-1",
    sentDraft: overrides.words ?? "Make it pop",
    destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
    buildPrompt: async () => overrides.prompt ?? "Make it pop",
    ...(overrides.subjectKey === undefined ? {} : { subjectKey: overrides.subjectKey }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  previewIn("wt-1");
  useDevPreviewToolStore.setState({ activeByPanel: { "preview-1": BUILDER_TOOL_ID } });
});

afterEach(() => {
  vi.useRealTimers();
  dispatch.mockReset();
  __resetAgentRequestsForTests();
  __resetComposerMemoryForTests();
  useDevPreviewToolStore.setState({ activeByPanel: {} });
  usePanelStore.setState({ panelsById: {} as never });
});

describe("deliverAgentRequest", () => {
  it("never sends into a preview that moved to another worktree, and says it stopped", async () => {
    const agent = terminal();
    const run = send();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(last()?.state.status).toBe("queued");

    // Nothing of the builder is mounted to notice the move; the run must.
    previewIn("wt-2");
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(last()?.state).toEqual({
      status: "failed",
      message: "Stopped before the request was sent",
    });
  });

  it("doesn't follow an agent that moved to another worktree while it was getting ready", async () => {
    const agent = terminal();
    usePanelStore.setState({
      panelsById: {
        ...usePanelStore.getState().panelsById,
        t1: { id: "t1", kind: "terminal", location: "grid", worktreeId: "wt-1" },
      } as never,
    });
    const run = send();
    await vi.advanceTimersByTimeAsync(1_000);
    usePanelStore.setState({
      panelsById: {
        ...usePanelStore.getState().panelsById,
        t1: { id: "t1", kind: "terminal", location: "grid", worktreeId: "wt-2" },
      } as never,
    });
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(agent.sent).toEqual([]);
    expect(last()?.state).toEqual({
      status: "failed",
      message: "Claude left this worktree — the request wasn't sent",
    });
  });

  it("checks the source again once the agent is ready, before anything is typed", async () => {
    const agent = terminal();
    let changed = false;
    const run = deliverAgentRequest({
      memoryKey: KEY,
      worktreeId: "wt-1",
      sentDraft: "Make it pop",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      buildPrompt: async () => "Make it pop",
      verify: async () => (changed ? "The source changed" : null),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    // The agent sat at a trust prompt while the file was edited.
    changed = true;
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(agent.sent).toEqual([]);
    expect(last()?.state).toEqual({
      status: "failed",
      message: "The source changed",
    });
  });

  it("rechecks the agent's worktree after the last source check", async () => {
    const agent = terminal("waiting");
    const inWorktree = (worktreeId: string) =>
      usePanelStore.setState({
        panelsById: {
          ...usePanelStore.getState().panelsById,
          t1: { id: "t1", kind: "terminal", location: "grid", worktreeId },
        } as never,
      });
    inWorktree("wt-1");
    let checks = 0;
    const run = deliverAgentRequest({
      memoryKey: KEY,
      worktreeId: "wt-1",
      sentDraft: "Make it pop",
      destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
      buildPrompt: async () => "Make it pop",
      verify: async () => {
        checks += 1;
        // The agent moves while the final check is out: the third, after the
        // quick refusal and the one before the prompt was built.
        if (checks === 3) inWorktree("wt-2");
        return null;
      },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(checks).toBe(3);
    expect(agent.sent).toEqual([]);
    expect(last()?.state.status).toBe("failed");
  });

  it("keeps the request text on a run cancelled while it was being typed in", async () => {
    let release: () => void = () => {};
    dispatch.mockImplementation(async (id: string, args: Record<string, unknown>) => {
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
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ok: true, result: { submissionToken: String(args.command) } };
      }
      throw new Error(`unexpected ${id}`);
    });
    const run = send();
    await vi.advanceTimersByTimeAsync(500);
    cancelAgentRequests("preview-1");
    release();
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(last()).toMatchObject({
      state: { status: "unconfirmed" },
      request: "Make it pop",
    });
    // Unconfirmed is not a reason to try again: the words may be in the agent
    // already, and only the user may decide to repeat them.
    expect(dispatch.mock.calls.filter(([id]) => id === "terminal.sendCommand")).toHaveLength(1);
  });

  it("writes once when the same request is sent again while the first is in flight", async () => {
    const agent = terminal();
    // The grid re-lays and the composer remounts mid-flight, then asks again
    // for the same words, about the same subject, to the same place. That is
    // the request already waiting, not a second one to queue behind it.
    const first = send({ subjectKey: "sel-1" });
    await vi.advanceTimersByTimeAsync(1_000);
    const second = send({ subjectKey: "sel-1" });
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    await second;
    expect(agent.sent).toEqual(["Make it pop"]);
    expect(statuses()).toEqual(["Make it pop: sent"]);
  });

  it("treats the same words about another subject as a different request", async () => {
    const agent = terminal();
    // Same sentence, but the user picked another element before sending again:
    // the prompt differs, so this is not the run already in flight.
    const first = send({ subjectKey: "sel-1", prompt: "Make it pop — button" });
    await vi.advanceTimersByTimeAsync(1_000);
    const second = send({ subjectKey: "sel-2", prompt: "Make it pop — heading" });
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    agent.setState("working");
    await vi.advanceTimersByTimeAsync(2_000);
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await second;
    // Two requests, so two prompts, in the order they were made.
    expect(agent.sent).toEqual(["Make it pop — button", "Make it pop — heading"]);
  });

  it("frees the composer once a request is accepted, while the agent is still busy", async () => {
    terminal("working");
    updateComposerMemory(KEY, { draft: "Make it pop" });
    const run = send();
    await vi.advanceTimersByTimeAsync(1_000);
    // Nothing has been typed into the agent, and the words are already out of
    // the way of the next request — kept on the row that is waiting.
    expect(readComposerMemory(KEY).draft).toBe("");
    expect(statuses()).toEqual(["Make it pop: queued"]);

    cancelAgentRequests("preview-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
  });

  it("keeps what was typed after sending: only the sent words are cleared", async () => {
    terminal("working");
    updateComposerMemory(KEY, { draft: "Make it pop — and bigger" });
    const run = send();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readComposerMemory(KEY).draft).toBe("Make it pop — and bigger");
    cancelAgentRequests("preview-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
  });

  it("queues a second request behind the first and sends them in order, one prompt at a time", async () => {
    const agent = terminal("working");
    const first = send({ words: "Make it green", prompt: "green", subjectKey: "a" });
    const second = send({ words: "Round the corners", prompt: "round", subjectKey: "b" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(statuses()).toEqual(["Make it green: queued", "Round the corners: queued"]);
    expect(agent.sent).toEqual([]);

    // Back at its prompt: the first goes in. The second does not follow it
    // straight in — "waiting" is still the old reading until the agent has been
    // seen to pick the first one up.
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    expect(agent.sent).toEqual(["green"]);
    expect(statuses()).toEqual(["Make it green: sent", "Round the corners: queued"]);

    agent.setState("working");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(agent.sent).toEqual(["green"]);

    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await second;
    expect(agent.sent).toEqual(["green", "round"]);
    expect(statuses()).toEqual(["Make it green: sent", "Round the corners: sent"]);
  });

  it("waits out an agent that works for longer than a launch is given", async () => {
    const agent = terminal("working");
    const run = send();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(last()?.state.status).toBe("queued");
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(agent.sent).toEqual(["Make it pop"]);
  });

  it("takes a removed request out of the queue without touching the one behind it", async () => {
    const agent = terminal("working");
    const first = send({ words: "Make it green", prompt: "green", subjectKey: "a" });
    const second = send({ words: "Round the corners", prompt: "round", subjectKey: "b" });
    await vi.advanceTimersByTimeAsync(1_000);
    removeAgentRequest(KEY, readComposerMemory(KEY).deliveries[0]!.id);
    expect(statuses()).toEqual(["Round the corners: queued"]);

    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all([first, second]);
    expect(agent.sent).toEqual(["round"]);
  });

  it("sends the head of the queue on the user's word, and only the head", async () => {
    const agent = terminal();
    const first = send({ words: "Make it green", prompt: "green", subjectKey: "a" });
    const second = send({ words: "Round the corners", prompt: "round", subjectKey: "b" });
    await vi.advanceTimersByTimeAsync(1_000);
    const [head, behind] = readComposerMemory(KEY).deliveries;
    forceAgentRequest(KEY, behind!.id);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(agent.sent).toEqual([]);

    forceAgentRequest(KEY, head!.id);
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    expect(agent.sent).toEqual(["green"]);
    cancelAgentRequests("preview-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
  });

  it("keeps the warning when a request is removed after it started going in", async () => {
    let release: () => void = () => {};
    terminal("waiting");
    const normal = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (id: string, args: Record<string, unknown>) => {
      if (id !== "terminal.sendCommand") return normal(id, args);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return normal(id, args);
    });
    const run = send();
    await vi.advanceTimersByTimeAsync(1_000);
    // Remove raced the send: it can't take back what was typed, so the row
    // stays, and says so.
    removeAgentRequest(KEY, last()!.id);
    expect(statuses()).toEqual(["Make it pop: unconfirmed"]);
    release();
    await vi.advanceTimersByTimeAsync(3_000);
    await run;
    expect(statuses()).toEqual(["Make it pop: unconfirmed"]);
  });

  it("never drops a record that is holding sending off, however many settle after it", async () => {
    updateComposerMemory(KEY, {
      deliveries: [
        {
          id: "uncertain",
          instruction: "Half typed",
          subject: null,
          state: { status: "unconfirmed" },
          title: "Claude",
          terminalId: "t1",
        },
      ],
    });
    const agent = terminal("waiting");
    for (let index = 0; index < 12; index += 1) {
      const run = send({ words: `Request ${index}`, prompt: `p${index}`, subjectKey: `s${index}` });
      await vi.advanceTimersByTimeAsync(8_000);
      await run;
    }
    expect(agent.sent).toHaveLength(12);
    const kept = readComposerMemory(KEY).deliveries;
    expect(kept.map((delivery) => delivery.id)).toContain("uncertain");
    expect(kept.length).toBeLessThan(13);
  });

  it("frees the field for a send that joined a request already waiting", async () => {
    terminal("working");
    updateComposerMemory(KEY, { draft: "Make it pop" });
    const first = send({ subjectKey: "sel-1" });
    await vi.advanceTimersByTimeAsync(1_000);
    // The same words about the same thing, typed and sent again while it waits.
    updateComposerMemory(KEY, { draft: "Make it pop" });
    const second = send({ subjectKey: "sel-1" });
    expect(readComposerMemory(KEY).draft).toBe("");
    expect(statuses()).toEqual(["Make it pop: queued"]);
    cancelAgentRequests("preview-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);
  });

  it("stops what was queued behind a request that may be half-typed", async () => {
    const agent = terminal("waiting");
    const normal = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (id: string, args: Record<string, unknown>) =>
      id === "terminal.sendCommand"
        ? { ok: false, error: { message: "The terminal stopped accepting input" } }
        : normal(id, args)
    );
    const first = send({ words: "Make it green", prompt: "green", subjectKey: "a" });
    const second = send({ words: "Round the corners", prompt: "round", subjectKey: "b" });
    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all([first, second]);
    expect(agent.sent).toEqual([]);
    const [failed, stopped] = readComposerMemory(KEY).deliveries;
    expect(failed!.state).toMatchObject({ status: "failed", partial: true });
    // Typed after it, the second would have been appended to the first.
    expect(stopped!.state).toMatchObject({ status: "failed" });
    expect(stopped!.state).not.toHaveProperty("partial");
    expect(stopped!.instruction).toBe("Round the corners");
  });

  it("settles a cancelled request instead of leaving it pending", async () => {
    terminal();
    const run = send();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(last()?.state.status).toBe("queued");

    cancelAgentRequests("preview-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(last()?.state.status).toBe("failed");
  });

  it("publishes a waiting state once rather than on every poll", async () => {
    terminal();
    const run = send();
    const writes: string[] = [];
    let previous = readComposerMemory(KEY);
    const record = setInterval(() => {
      const now = readComposerMemory(KEY);
      const newest = now.deliveries.at(-1);
      if (now !== previous && newest) writes.push(newest.state.status);
      previous = now;
    }, 50);
    await vi.advanceTimersByTimeAsync(20_000);
    clearInterval(record);
    cancelAgentRequests("preview-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(writes.filter((status) => status === "queued")).toHaveLength(1);
  });

  it("sends once the agent is at its prompt and clears the unchanged draft", async () => {
    const agent = terminal("waiting");
    updateComposerMemory(KEY, { draft: "Make it pop" });
    const run = send();
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(agent.sent).toEqual(["Make it pop"]);
    expect(last()?.state.status).toBe("sent");
    expect(readComposerMemory(KEY).draft).toBe("");
  });
});

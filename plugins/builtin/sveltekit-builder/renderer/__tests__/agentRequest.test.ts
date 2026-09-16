import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import { cancelAgentRequests, deliverAgentRequest } from "../agentRequest";
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

function send() {
  return deliverAgentRequest({
    memoryKey: KEY,
    worktreeId: "wt-1",
    sentDraft: "Make it pop",
    destination: { kind: "terminal", terminalId: "t1", title: "Claude" },
    buildPrompt: async () => "Make it pop",
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
  __resetComposerMemoryForTests();
  useDevPreviewToolStore.setState({ activeByPanel: {} });
  usePanelStore.setState({ panelsById: {} as never });
});

describe("deliverAgentRequest", () => {
  it("never sends into a preview that moved to another worktree, and says it stopped", async () => {
    const agent = terminal();
    const run = send();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readComposerMemory(KEY).delivery?.state.status).toBe("sending");

    // Nothing of the builder is mounted to notice the move; the run must.
    previewIn("wt-2");
    agent.setState("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(agent.sent).toEqual([]);
    expect(readComposerMemory(KEY).delivery?.state).toEqual({
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
    expect(readComposerMemory(KEY).delivery?.state).toEqual({
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
    expect(readComposerMemory(KEY).delivery?.state).toEqual({
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
        // The agent moves while the final check is out.
        if (checks === 2) inWorktree("wt-2");
        return null;
      },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(checks).toBe(2);
    expect(agent.sent).toEqual([]);
    expect(readComposerMemory(KEY).delivery?.state.status).toBe("failed");
  });

  it("settles a cancelled request instead of leaving it pending", async () => {
    terminal();
    const run = send();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(readComposerMemory(KEY).delivery?.state.status).toBe("unknown-readiness");

    cancelAgentRequests("preview-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(readComposerMemory(KEY).delivery?.state.status).toBe("failed");
  });

  it("publishes a waiting state once rather than on every poll", async () => {
    terminal();
    const run = send();
    const writes: string[] = [];
    let last = readComposerMemory(KEY);
    const record = setInterval(() => {
      const now = readComposerMemory(KEY);
      if (now !== last && now.delivery) writes.push(now.delivery.state.status);
      last = now;
    }, 50);
    await vi.advanceTimersByTimeAsync(20_000);
    clearInterval(record);
    cancelAgentRequests("preview-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(writes.filter((status) => status === "unknown-readiness")).toHaveLength(1);
  });

  it("sends once the agent is at its prompt and clears the unchanged draft", async () => {
    const agent = terminal("waiting");
    updateComposerMemory(KEY, { draft: "Make it pop" });
    const run = send();
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(agent.sent).toEqual(["Make it pop"]);
    expect(readComposerMemory(KEY).delivery?.state.status).toBe("sent");
    expect(readComposerMemory(KEY).draft).toBe("");
  });
});

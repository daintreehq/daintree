import { afterEach, describe, expect, it, vi } from "vitest";
import {
  noteAssistantToolAnswer,
  setAssistantWorkerSink,
  workerLaunchesIn,
  type AssistantToolAnswer,
} from "../assistantWorkerLaunches.js";

afterEach(() => {
  setAssistantWorkerSink(null);
});

const answer = (overrides: Partial<AssistantToolAnswer> = {}): AssistantToolAnswer => ({
  helpSessionId: "help-1",
  tool: "agent.launch",
  args: { agentId: "codex" },
  result: { launched: true, terminalId: "t-1" },
  hostId: null,
  hostName: null,
  projectId: "project-1",
  askedAt: 1,
  ...overrides,
});

describe("workerLaunchesIn (#16169)", () => {
  it("reads the agent terminal an answer names, with the agent the call asked for", () => {
    expect(workerLaunchesIn("agent.launch", { agentId: "codex" }, answer().result)).toEqual({
      terminalIds: ["t-1"],
      agentId: "codex",
    });
    expect(
      workerLaunchesIn("workflow.startWorkOnIssue", { issueNumber: 3 }, { terminalId: "t-2" })
    ).toEqual({ terminalIds: ["t-2"], agentId: null });
  });

  it("finds no worker in a launch that didn't happen, or in a shell or recipe", () => {
    expect(
      workerLaunchesIn("agent.launch", {}, { launched: false, terminalId: "t-stale" }).terminalIds
    ).toEqual([]);
    expect(workerLaunchesIn("agent.launch", {}, null).terminalIds).toEqual([]);
    expect(workerLaunchesIn("terminal.new", {}, { terminalId: "t-3" }).terminalIds).toEqual([]);
    expect(workerLaunchesIn("recipe.run", {}, { spawnedTerminalIds: ["t-4"] }).terminalIds).toEqual(
      []
    );
  });
});

describe("noteAssistantToolAnswer (#16169)", () => {
  it("costs nothing until the run history listens, and hands it only launches", () => {
    noteAssistantToolAnswer(answer());
    const sink = vi.fn();
    setAssistantWorkerSink(sink);

    noteAssistantToolAnswer(answer({ tool: "terminal.list" }));
    noteAssistantToolAnswer(answer());

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(answer());
  });

  it("never lets a failing record reach the call that answered", () => {
    setAssistantWorkerSink(() => {
      throw new Error("disk full");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => noteAssistantToolAnswer(answer())).not.toThrow();
    warn.mockRestore();
  });
});

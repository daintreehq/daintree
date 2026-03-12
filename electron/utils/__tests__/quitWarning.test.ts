import { describe, expect, it, vi } from "vitest";
import { getActiveAgentCount, showQuitWarning } from "../quitWarning.js";
import type { AgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";

function mockStore(agents: Array<{ agentId: string; state: string }>): AgentAvailabilityStore {
  return {
    getAgentsByAvailability: () =>
      agents.map((a) => ({
        agentId: a.agentId,
        available: a.state === "idle" || a.state === "waiting",
        state: a.state as import("../../../shared/types/domain.js").AgentState,
        concurrentTasks: 0,
        lastStateChange: 0,
      })),
  } as unknown as AgentAvailabilityStore;
}

describe("getActiveAgentCount", () => {
  it("returns 0 when no agents are tracked", () => {
    expect(getActiveAgentCount(mockStore([]))).toBe(0);
  });

  it("returns 0 when all agents are idle or waiting", () => {
    const store = mockStore([
      { agentId: "a1", state: "idle" },
      { agentId: "a2", state: "waiting" },
      { agentId: "a3", state: "completed" },
    ]);
    expect(getActiveAgentCount(store)).toBe(0);
  });

  it("counts working agents", () => {
    const store = mockStore([
      { agentId: "a1", state: "working" },
      { agentId: "a2", state: "idle" },
    ]);
    expect(getActiveAgentCount(store)).toBe(1);
  });

  it("counts running agents", () => {
    const store = mockStore([
      { agentId: "a1", state: "running" },
      { agentId: "a2", state: "idle" },
    ]);
    expect(getActiveAgentCount(store)).toBe(1);
  });

  it("counts both working and running agents", () => {
    const store = mockStore([
      { agentId: "a1", state: "working" },
      { agentId: "a2", state: "running" },
      { agentId: "a3", state: "idle" },
    ]);
    expect(getActiveAgentCount(store)).toBe(2);
  });
});

describe("showQuitWarning", () => {
  it("returns true when user clicks Quit Anyway (button 0)", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    expect(await showQuitWarning(1, showMessageBox)).toBe(true);
    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it("returns false when user clicks Cancel (button 1)", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    expect(await showQuitWarning(1, showMessageBox)).toBe(false);
  });

  it("uses singular message for 1 agent", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    await showQuitWarning(1, showMessageBox);
    expect(showMessageBox.mock.calls[0][0].message).toBe("1 agent is currently working");
  });

  it("uses plural message for multiple agents", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    await showQuitWarning(3, showMessageBox);
    expect(showMessageBox.mock.calls[0][0].message).toBe("3 agents are currently working");
  });

  it("shows a warning-type dialog with Cancel as default", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    await showQuitWarning(1, showMessageBox);
    const opts = showMessageBox.mock.calls[0][0];
    expect(opts.type).toBe("warning");
    expect(opts.defaultId).toBe(1);
    expect(opts.cancelId).toBe(1);
    expect(opts.buttons).toEqual(["Quit Anyway", "Cancel"]);
  });
});

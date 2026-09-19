import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveAgentCount, showQuitWarning } from "../quitWarning.js";
import {
  AgentAvailabilityStore,
  type AgentAvailabilityInfo,
} from "../../services/AgentAvailabilityStore.js";
import { events } from "../../services/events.js";
import type { AgentState } from "../../../shared/types/agent.js";

function mockStore(agents: Array<{ agentId: string; state: string }>): AgentAvailabilityStore {
  const rows = (): AgentAvailabilityInfo[] =>
    agents.map((a, index) => ({
      terminalId: `term-${index}`,
      agentId: a.agentId,
      available: a.state === "idle" || a.state === "waiting",
      // "running" is a retired state kept here on purpose, hence the cast.
      state: a.state as AgentState,
      lastStateChange: 0,
    }));
  return { getAgentsByAvailability: rows } as unknown as AgentAvailabilityStore;
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

  it("ignores legacy running agents (retired state)", () => {
    const store = mockStore([
      { agentId: "a1", state: "running" },
      { agentId: "a2", state: "idle" },
    ]);
    expect(getActiveAgentCount(store)).toBe(0);
  });
});

// #12494 — a fleet of identical agents is several terminals sharing one agent
// id, and each working one is a separate agent the quit would interrupt.
describe("getActiveAgentCount against a real store", () => {
  let store: AgentAvailabilityStore | undefined;

  afterEach(() => {
    store?.dispose();
    store = undefined;
  });

  const spawn = (terminalId: string) =>
    events.emit("agent:spawned", { agentId: "claude", terminalId, timestamp: Date.now() });

  it("counts two working terminals of the same agent type as two", () => {
    store = new AgentAvailabilityStore();
    spawn("term-a");
    spawn("term-b");

    expect(getActiveAgentCount(store)).toBe(2);
  });

  it("counts only the sibling that is still working", () => {
    store = new AgentAvailabilityStore();
    spawn("term-a");
    spawn("term-b");
    events.emit("agent:state-changed", {
      agentId: "claude",
      terminalId: "term-a",
      state: "waiting",
      previousState: "working",
      trigger: "output",
      confidence: 1,
      timestamp: Date.now(),
    });

    expect(getActiveAgentCount(store)).toBe(1);
  });

  it("still counts a working sibling of a trashed or help terminal", () => {
    store = new AgentAvailabilityStore();
    spawn("term-trashed");
    spawn("term-help");
    spawn("term-live");
    events.emit("terminal:trashed", { id: "term-trashed", expiresAt: Date.now() + 60_000 });
    store.markAsHelp("term-help");

    expect(getActiveAgentCount(store)).toBe(1);
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

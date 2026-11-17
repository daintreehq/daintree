import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActiveAgentCount,
  getActiveAgents,
  showQuitWarning,
  showUpdateWarning,
  type QuitImpact,
} from "../quitWarning.js";
import {
  AgentAvailabilityStore,
  type AgentAvailabilityInfo,
} from "../../services/AgentAvailabilityStore.js";
import { events } from "../../services/events.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";

function mockStore(
  agents: Array<{ agentId: string; state: string; waitingReason?: WaitingReason }>
): AgentAvailabilityStore {
  const rows = (): AgentAvailabilityInfo[] =>
    agents.map((a, index) => ({
      terminalId: `term-${index}`,
      agentId: a.agentId,
      available: a.state === "idle" || a.state === "waiting",
      // "running" is a retired state kept here on purpose, hence the cast.
      state: a.state as AgentState,
      lastStateChange: 0,
    }));
  const getTerminalSnapshot = (terminalId: string) => {
    const index = Number(terminalId.slice("term-".length));
    const agent = agents[index];
    return agent ? { terminalId, ...agent, lastStateChange: 0 } : undefined;
  };
  return {
    getAgentsByAvailability: rows,
    getTerminalSnapshot,
  } as unknown as AgentAvailabilityStore;
}

function agents(activeAgents: number, awaitingApproval = 0): QuitImpact {
  return { activeAgents, awaitingApproval, attachedShells: [] };
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

  it("counts an agent held on a permission prompt", () => {
    const store = mockStore([
      { agentId: "a1", state: "waiting", waitingReason: "approval" },
      { agentId: "a2", state: "idle" },
    ]);
    expect(getActiveAgents(store)).toEqual({ activeAgents: 1, awaitingApproval: 1 });
  });

  it.each<WaitingReason | undefined>(["question", "prompt", "error", undefined])(
    "doesn't count a wait for %s",
    (waitingReason) => {
      const store = mockStore([{ agentId: "a1", state: "waiting", waitingReason }]);
      expect(getActiveAgents(store)).toEqual({ activeAgents: 0, awaitingApproval: 0 });
    }
  );

  it("splits working agents from those waiting for permission", () => {
    const store = mockStore([
      { agentId: "a1", state: "working" },
      { agentId: "a2", state: "waiting", waitingReason: "approval" },
      { agentId: "a3", state: "working" },
      { agentId: "a4", state: "completed" },
    ]);
    expect(getActiveAgents(store)).toEqual({ activeAgents: 3, awaitingApproval: 1 });
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

  it("counts a terminal whose agent stops on a permission prompt, until it is answered", () => {
    store = new AgentAvailabilityStore();
    spawn("term-a");
    const transition = (state: AgentState, waitingReason?: WaitingReason) =>
      events.emit("agent:state-changed", {
        agentId: "claude",
        terminalId: "term-a",
        state,
        previousState: "working",
        trigger: "output",
        confidence: 1,
        timestamp: Date.now(),
        ...(waitingReason ? { waitingReason } : {}),
      });

    transition("waiting", "approval");
    expect(getActiveAgents(store)).toEqual({ activeAgents: 1, awaitingApproval: 1 });

    transition("working");
    expect(getActiveAgents(store)).toEqual({ activeAgents: 1, awaitingApproval: 0 });

    transition("waiting", "approval");
    transition("waiting");
    expect(getActiveAgents(store)).toEqual({ activeAgents: 0, awaitingApproval: 0 });

    transition("waiting", "question");
    expect(getActiveAgentCount(store)).toBe(0);
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
  it("quits when user clicks Quit Anyway (button 0)", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    expect(await showQuitWarning(agents(1), showMessageBox)).toBe("quit");
    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it("cancels when user clicks Cancel (button 1)", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    expect(await showQuitWarning(agents(1), showMessageBox)).toBe("cancel");
  });

  it("uses singular message for 1 agent", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    await showQuitWarning(agents(1), showMessageBox);
    expect(showMessageBox.mock.calls[0][0].message).toBe("1 agent is currently working");
  });

  it("uses plural message for multiple agents", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    await showQuitWarning(agents(3), showMessageBox);
    expect(showMessageBox.mock.calls[0][0].message).toBe("3 agents are currently working");
  });

  it("shows a warning-type dialog with Cancel as default", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    await showQuitWarning(agents(1), showMessageBox);
    const opts = showMessageBox.mock.calls[0][0];
    expect(opts.type).toBe("warning");
    expect(opts.defaultId).toBe(1);
    expect(opts.cancelId).toBe(1);
    expect(opts.buttons).toEqual(["Quit Anyway", "Cancel"]);
  });
});

describe("showQuitWarning for agents waiting for permission", () => {
  const messageFor = async (impact: QuitImpact) => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    await showQuitWarning(impact, showMessageBox);
    return showMessageBox.mock.calls[0]![0].message as string;
  };

  it("names a wait on its own", async () => {
    expect(await messageFor(agents(1, 1))).toBe("1 agent is waiting for permission");
    expect(await messageFor(agents(2, 2))).toBe("2 agents are waiting for permission");
  });

  it("names both when some are working and some are waiting", async () => {
    expect(await messageFor(agents(3, 1))).toBe(
      "2 agents are working and 1 is waiting for permission"
    );
    expect(await messageFor(agents(3, 2))).toBe(
      "1 agent is working and 2 are waiting for permission"
    );
  });
});

describe("showQuitWarning offering to keep agents running", () => {
  const box = (response: number) => vi.fn().mockResolvedValue({ response });

  it.each([
    [0, "keep-running"],
    [1, "quit"],
    [2, "cancel"],
  ] as const)("answers button %i with %s", async (response, decision) => {
    const showMessageBox = box(response);
    expect(await showQuitWarning(agents(2), showMessageBox, null, { offerKeepRunning: true })).toBe(
      decision
    );
  });

  it.each([-1, 3, 1000])("treats an unknown answer (%i) as Cancel", async (response) => {
    expect(await showQuitWarning(agents(1), box(response), null, { offerKeepRunning: true })).toBe(
      "cancel"
    );
  });

  it("puts the choice beside Quit, keeps Cancel the default, and never renders command links", async () => {
    const showMessageBox = box(2);
    await showQuitWarning(agents(1), showMessageBox, null, { offerKeepRunning: true });
    const opts = showMessageBox.mock.calls[0]![0];
    expect(opts.buttons).toEqual(["Keep Agents Running", "Quit and Stop Agents", "Cancel"]);
    expect(opts.buttons[opts.defaultId]).toBe("Cancel");
    expect(opts.buttons[opts.cancelId]).toBe("Cancel");
    expect(opts.noLink).toBe(true);
    expect(opts.detail).toContain("closes every window");
  });

  it("isn't offered when only attached Shells are affected", async () => {
    const showMessageBox = box(0);
    const decision = await showQuitWarning(
      { activeAgents: 0, awaitingApproval: 0, attachedShells: [{ clientName: "MacBook Pro" }] },
      showMessageBox,
      null,
      { offerKeepRunning: true }
    );
    const opts = showMessageBox.mock.calls[0]![0];
    expect(decision).toBe("quit");
    expect(opts.buttons).toEqual(["Quit Anyway", "Cancel"]);
    expect(opts.detail).not.toContain("Keep Agents Running");
  });

  it("says the attached machines stay connected when agents are kept running beside them", async () => {
    const showMessageBox = box(0);
    const decision = await showQuitWarning(
      { activeAgents: 1, awaitingApproval: 0, attachedShells: [{ clientName: "MacBook Pro" }] },
      showMessageBox,
      null,
      { offerKeepRunning: true }
    );
    const opts = showMessageBox.mock.calls[0]![0];
    expect(decision).toBe("keep-running");
    expect(opts.title).toBe("Other machines are attached");
    expect(opts.detail).toContain("1 agent is currently working");
    expect(opts.detail).toContain("MacBook Pro still attached");
  });

  it("asks without a parent window when none is given", async () => {
    const showMessageBox = box(1);
    await showQuitWarning(agents(1), showMessageBox, null);
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
    expect(showMessageBox.mock.calls[0]).toHaveLength(1);
  });
});

describe("showQuitWarning with attached Shells", () => {
  const box = (response: number) => vi.fn().mockResolvedValue({ response });

  it("keeps the agents-only copy when nothing is attached", async () => {
    const showMessageBox = box(0);
    await showQuitWarning(agents(2), showMessageBox);
    const opts = showMessageBox.mock.calls[0]![0];
    expect(opts.title).toBe("Agents are working");
    expect(opts.message).toBe("2 agents are currently working");
  });

  it("names the attached machines when only Shells are affected", async () => {
    const showMessageBox = box(0);
    const confirmed = await showQuitWarning(
      {
        activeAgents: 0,
        awaitingApproval: 0,
        attachedShells: [{ clientName: "MacBook Pro" }, { clientName: "Studio" }],
      },
      showMessageBox
    );
    const opts = showMessageBox.mock.calls[0]![0];
    expect(confirmed).toBe("quit");
    expect(opts.message).toContain("MacBook Pro and Studio are attached");
    expect(opts.detail).toContain("disconnects MacBook Pro and Studio");
    expect(opts.defaultId).toBe(1);
  });

  it("mentions working agents too when both apply, in one dialog", async () => {
    const showMessageBox = box(1);
    const confirmed = await showQuitWarning(
      { activeAgents: 1, awaitingApproval: 0, attachedShells: [{ clientName: "MacBook Pro" }] },
      showMessageBox
    );
    expect(confirmed).toBe("cancel");
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox.mock.calls[0]![0].detail).toContain("1 agent is currently working");
  });

  it("counts two unnamed machines instead of merging them into one", async () => {
    const showMessageBox = box(1);
    await showQuitWarning(
      {
        activeAgents: 0,
        awaitingApproval: 0,
        attachedShells: [{ clientName: "" }, { clientName: " " }],
      },
      showMessageBox
    );
    const opts = showMessageBox.mock.calls[0]![0];
    expect(opts.message).toBe("2 machines are attached to this host");
    expect(opts.detail).toBe(
      "Quitting disconnects 2 machines and ends the work they have open on this machine."
    );
  });

  it("keeps the fallback lowercase mid-sentence", async () => {
    const showMessageBox = box(1);
    await showQuitWarning(
      { activeAgents: 0, awaitingApproval: 0, attachedShells: [{ clientName: "" }] },
      showMessageBox
    );
    const opts = showMessageBox.mock.calls[0]![0];
    expect(opts.message).toBe("Another machine is attached to this host");
    expect(opts.detail).toContain("disconnects another machine and ends the work it has open");
  });
});

describe("showUpdateWarning", () => {
  it("names the machines and says the update stays ready", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    const confirmed = await showUpdateWarning(
      { activeAgents: 0, awaitingApproval: 0, attachedShells: [{ clientName: "MacBook Pro" }] },
      showMessageBox
    );
    const opts = showMessageBox.mock.calls[0]![0];
    expect(confirmed).toBe(true);
    expect(opts.detail).toContain("disconnects MacBook Pro");
    expect(opts.detail).toContain("stays ready");
    expect(opts.detail).not.toContain("agent");
    expect(opts.buttons).toEqual(["Restart and Update", "Cancel"]);
  });

  it("asks about working agents with the same count Quit shows", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    const confirmed = await showUpdateWarning(agents(2), showMessageBox);
    const opts = showMessageBox.mock.calls[0]![0];
    expect(confirmed).toBe(false);
    expect(opts.title).toBe("Agents are working");
    expect(opts.message).toBe("2 agents are currently working");
    expect(opts.detail).toContain("interrupt active agents");
    expect(opts.detail).toContain("stays ready");
    expect(opts.buttons).toEqual(["Restart and Update", "Cancel"]);
    expect(opts.cancelId).toBe(1);
    expect(opts.defaultId).toBe(1);
  });

  it("asks about agents waiting for permission with the same copy Quit shows", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    await showUpdateWarning(agents(1, 1), showMessageBox);
    await showUpdateWarning(agents(3, 1), showMessageBox);
    await showUpdateWarning(
      { activeAgents: 2, awaitingApproval: 2, attachedShells: [{ clientName: "MacBook Pro" }] },
      showMessageBox
    );
    expect(showMessageBox.mock.calls[0]![0].message).toBe("1 agent is waiting for permission");
    expect(showMessageBox.mock.calls[1]![0].message).toBe(
      "2 agents are working and 1 is waiting for permission"
    );
    expect(showMessageBox.mock.calls[2]![0].detail).toContain(
      "2 agents are waiting for permission, and restarting will interrupt them too"
    );
  });

  it("mentions working agents beside the attached Shells in one dialog", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    await showUpdateWarning(
      { activeAgents: 1, awaitingApproval: 0, attachedShells: [{ clientName: "MacBook Pro" }] },
      showMessageBox
    );
    const opts = showMessageBox.mock.calls[0]![0];
    expect(opts.title).toBe("Other machines are attached");
    expect(opts.detail).toContain("disconnects MacBook Pro");
    expect(opts.detail).toContain("1 agent is currently working");
    expect(opts.detail).toContain("stays ready");
  });

  it("counts machines that share a name", async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
    await showUpdateWarning(
      {
        activeAgents: 0,
        awaitingApproval: 0,
        attachedShells: [{ clientName: "MacBook Pro" }, { clientName: "MacBook Pro" }],
      },
      showMessageBox
    );
    const opts = showMessageBox.mock.calls[0]![0];
    expect(opts.message).toBe("2 machines named MacBook Pro are attached to this host");
    expect(opts.detail).toBe(
      "Restarting to update disconnects 2 machines named MacBook Pro and ends the work they have open on this machine. The update stays ready until you restart."
    );
  });
});

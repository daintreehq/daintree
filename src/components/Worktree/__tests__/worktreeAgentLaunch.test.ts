import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockDispatch = vi.fn<(actionId: string, args?: unknown, options?: unknown) => unknown>();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => mockDispatch(...args) },
}));

interface NotifyPayloadShape {
  type: string;
  title: string;
  message: string;
  placement?: string;
  action: { label: string; onClick: () => void };
}
const mockNotify = vi.fn<(payload: NotifyPayloadShape) => void>();
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => mockNotify(...args) }));

type PanelState = { panelsById: Record<string, { spawnStatus?: string }> };
const panelStore = vi.hoisted(() => {
  let state: PanelState = { panelsById: {} };
  const listeners = new Set<(s: PanelState) => void>();
  return {
    getState: () => state,
    subscribe: (listener: (s: PanelState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: PanelState) {
      state = next;
      for (const l of [...listeners]) l(state);
    },
    listenerCount: () => listeners.size,
  };
});
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStore }));

import {
  launchFirstAgent,
  notifyAgentNotStarted,
  startFirstAgentWhenReady,
  waitForWorktreeSetup,
  waitForSpawnOutcome,
  type FirstAgentLaunch,
} from "../worktreeAgentLaunch";

const PROMPT = "SENTINEL-PROMPT fix the login bug";

const launch: FirstAgentLaunch = {
  agentId: "claude",
  agentName: "Claude",
  prompt: PROMPT,
  worktreeId: "wt-1",
  cwd: "/abs/wt-1",
};

function readiness(setupState: string, timedOut = false) {
  return {
    ok: true,
    result: { worktreeId: "wt-1", setupState, stage: null, error: null, timedOut },
  };
}

function launched(value: boolean) {
  return {
    ok: true,
    result: {
      launched: value,
      terminalId: value ? "t-1" : null,
      location: null,
      spawnStatus: null,
      worktreeId: "wt-1",
      worktreePath: "/abs/wt-1",
      branch: "feature/x",
      cwd: "/abs/wt-1",
    },
  };
}

function scriptDispatch(readinessResults: unknown[], launchResult: unknown = launched(true)) {
  const queue = [...readinessResults];
  mockDispatch.mockImplementation(async (actionId: string) => {
    if (actionId === "worktree.waitUntilReady") return queue.shift() ?? readiness("ready");
    if (actionId === "agent.launch") return launchResult;
    throw new Error(`unexpected action ${actionId}`);
  });
}

function launchCalls() {
  return mockDispatch.mock.calls.filter(([id]) => id === "agent.launch");
}

function timeoutOf(args: unknown): number {
  if (args && typeof args === "object" && "timeoutMs" in args && typeof args.timeoutMs === "number")
    return args.timeoutMs;
  throw new Error("no timeoutMs");
}

function lastNotifyPayload(): NotifyPayloadShape {
  const call = mockNotify.mock.calls.at(-1);
  if (!call) throw new Error("notify was not called");
  return call[0];
}

beforeEach(() => {
  mockDispatch.mockReset();
  mockNotify.mockReset();
  panelStore.set({ panelsById: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForWorktreeSetup", () => {
  it("keeps waiting across expired slices until setup settles", async () => {
    scriptDispatch([readiness("running", true), readiness("running", true), readiness("ready")]);
    await expect(waitForWorktreeSetup("wt-1")).resolves.toBe("ready");
    const waits = mockDispatch.mock.calls.filter(([id]) => id === "worktree.waitUntilReady");
    expect(waits).toHaveLength(3);
    for (const [, args] of waits) {
      expect(args).toMatchObject({ worktreeId: "wt-1" });
      expect(timeoutOf(args)).toBeLessThanOrEqual(25_000);
    }
  });

  it("reports still-running once the overall budget is spent", async () => {
    scriptDispatch([readiness("running", true)]);
    await expect(waitForWorktreeSetup("wt-1", 0)).resolves.toBe("still-running");
  });

  it("returns settled non-ready states as-is", async () => {
    scriptDispatch([readiness("needs-approval")]);
    await expect(waitForWorktreeSetup("wt-1")).resolves.toBe("needs-approval");
  });

  it("maps a refused dispatch to error", async () => {
    mockDispatch.mockResolvedValue({ ok: false, error: { message: "nope" } });
    await expect(waitForWorktreeSetup("wt-1")).resolves.toBe("error");
  });
});

describe("launchFirstAgent", () => {
  it("passes the worktree, directory and exact prompt to agent.launch", async () => {
    scriptDispatch([]);
    await expect(launchFirstAgent(launch)).resolves.toBe("t-1");
    expect(launchCalls()).toEqual([
      [
        "agent.launch",
        { agentId: "claude", worktreeId: "wt-1", cwd: "/abs/wt-1", prompt: PROMPT },
        { source: "user" },
      ],
    ]);
  });

  it("omits a blank prompt so the agent starts without a first turn", async () => {
    scriptDispatch([]);
    await launchFirstAgent({ ...launch, prompt: "   " });
    expect(launchCalls()[0]![1]).not.toHaveProperty("prompt");
  });

  it("treats launched:false and thrown dispatches as not started", async () => {
    scriptDispatch([], launched(false));
    await expect(launchFirstAgent(launch)).resolves.toBeNull();
    mockDispatch.mockRejectedValue(new Error("boom"));
    await expect(launchFirstAgent(launch)).resolves.toBeNull();
  });
});

describe("startFirstAgentWhenReady", () => {
  it("launches exactly once after setup is ready", async () => {
    panelStore.set({ panelsById: { "t-1": { spawnStatus: "ready" } } });
    scriptDispatch([readiness("running", true), readiness("ready")]);
    await startFirstAgentWhenReady(launch);
    expect(launchCalls()).toHaveLength(1);
    const order = mockDispatch.mock.calls.map(([id]) => id);
    expect(order.filter((id) => id === "worktree.waitUntilReady")).toHaveLength(2);
    expect(order.indexOf("agent.launch")).toBeGreaterThan(
      order.lastIndexOf("worktree.waitUntilReady")
    );
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it.each(["failed", "timed-out", "needs-approval", "unknown"])(
    "does not launch when setup settles as %s and hands the launch back",
    async (state) => {
      scriptDispatch([readiness(state)]);
      await startFirstAgentWhenReady(launch);
      expect(launchCalls()).toHaveLength(0);
      const payload = lastNotifyPayload();
      expect(payload.type).toBe("warning");
      expect(payload.title).toBe("Agent not started");
      expect(payload.action.label).toBe("Start Claude");
      // Grid-bar, not inbox: a blurred window would otherwise drop the
      // callback action that carries the prompt.
      expect(payload.placement).toBe("grid-bar");
    }
  );

  it("hands the launch back when the dispatched wait throws", async () => {
    mockDispatch.mockRejectedValue(new Error("boom"));
    await startFirstAgentWhenReady(launch);
    expect(launchCalls()).toHaveLength(0);
    expect(lastNotifyPayload().title).toBe("Agent not started");
  });

  it("hands the launch back when the panel's spawn fails after launching", async () => {
    panelStore.set({ panelsById: { "t-1": { spawnStatus: "spawning" } } });
    scriptDispatch([readiness("ready")]);
    const done = startFirstAgentWhenReady(launch);
    await vi.waitFor(() => expect(launchCalls()).toHaveLength(1));
    expect(mockNotify).not.toHaveBeenCalled();
    panelStore.set({ panelsById: { "t-1": { spawnStatus: "failed" } } });
    await done;
    expect(lastNotifyPayload().message).toContain("Claude didn't start");
    expect(panelStore.listenerCount()).toBe(0);
  });

  it("notifies with a replay when the launch itself fails, and the replay relaunches once", async () => {
    scriptDispatch([readiness("ready")], launched(false));
    await startFirstAgentWhenReady(launch);
    expect(launchCalls()).toHaveLength(1);
    const { message, action } = lastNotifyPayload();
    expect(message).toContain("Claude didn't start");

    panelStore.set({ panelsById: { "t-1": { spawnStatus: "ready" } } });
    scriptDispatch([]);
    action.onClick();
    action.onClick();
    await vi.waitFor(() => expect(launchCalls()).toHaveLength(2));
    expect(launchCalls()[1]?.[1]).toMatchObject({ prompt: PROMPT });
  });
});

describe("notifyAgentNotStarted", () => {
  it("never puts the prompt in the notification", () => {
    notifyAgentNotStarted(launch, "recipe-has-agent");
    expect(JSON.stringify(mockNotify.mock.calls)).not.toContain("SENTINEL");
    expect(lastNotifyPayload().message).toContain("The recipe already starts an agent");
  });

  it("its action replays the same launch once, even when clicked twice", async () => {
    scriptDispatch([]);
    notifyAgentNotStarted(launch, "layout-has-agent");
    const { action } = lastNotifyPayload();
    action.onClick();
    action.onClick();
    await vi.waitFor(() => expect(launchCalls()).toHaveLength(1));
    expect(launchCalls()[0]?.[1]).toMatchObject({ prompt: PROMPT });
  });
});

describe("replaying a handed-back launch", () => {
  it.each(["still-running", "needs-approval"] as const)(
    "waits for setup again after %s instead of racing it",
    async (reason) => {
      panelStore.set({ panelsById: { "t-1": { spawnStatus: "ready" } } });
      scriptDispatch([readiness("ready")]);
      notifyAgentNotStarted(launch, reason);
      lastNotifyPayload().action.onClick();
      await vi.waitFor(() => expect(launchCalls()).toHaveLength(1));
      const order = mockDispatch.mock.calls.map(([id]) => id);
      expect(order).toEqual(["worktree.waitUntilReady", "agent.launch"]);
    }
  );

  it("starts straight away after a hard setup failure, as an explicit override", async () => {
    panelStore.set({ panelsById: { "t-1": { spawnStatus: "ready" } } });
    scriptDispatch([]);
    notifyAgentNotStarted(launch, "failed");
    lastNotifyPayload().action.onClick();
    await vi.waitFor(() => expect(launchCalls()).toHaveLength(1));
    expect(mockDispatch.mock.calls.map(([id]) => id)).toEqual(["agent.launch"]);
  });
});

describe("waitForSpawnOutcome", () => {
  it("settles immediately for a panel that already spawned or is gone", async () => {
    panelStore.set({ panelsById: { "t-1": { spawnStatus: "ready" } } });
    await expect(waitForSpawnOutcome("t-1")).resolves.toBe("ready");
    await expect(waitForSpawnOutcome("missing")).resolves.toBe("unknown");
  });

  it("gives up quietly when the spawn outlasts the watch", async () => {
    vi.useFakeTimers();
    panelStore.set({ panelsById: { "t-1": { spawnStatus: "spawning" } } });
    const outcome = waitForSpawnOutcome("t-1", 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe("unknown");
    expect(panelStore.listenerCount()).toBe(0);
  });
});

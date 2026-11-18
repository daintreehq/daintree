import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendTerminalInfo } from "@shared/types/ipc/terminal";
import type { ProjectStatusEntry } from "@shared/types/ipc/project";

const getAllMock = vi.hoisted(() => vi.fn());
const presenceMock = vi.hoisted(() => vi.fn());
const sleepProjectMock = vi.hoisted(() => vi.fn());
const submitNoteMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; path: string; status: string }>,
  currentProject: null as { id: string } | null,
  sleepProject: (...args: unknown[]): Promise<unknown> => sleepProjectMock(...args),
}));

vi.mock("@/clients/terminalClient", () => ({
  terminalClient: { getAll: (...args: unknown[]) => getAllMock(...args) },
}));
vi.mock("@/clients/projectPresenceClient", () => ({
  projectPresenceClient: { getSnapshot: (...args: unknown[]) => presenceMock(...args) },
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => storeState },
}));
vi.mock("@/components/Fleet/fleetExecution", () => ({
  submitNoteToAgent: (...args: unknown[]) => submitNoteMock(...args),
}));
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => notifyMock(...args) }));

import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectSleepWaitStore } from "@/store/projectSleepWaitStore";
import {
  cancelSleepWait,
  keepWaiting,
  observeAgent,
  sleepWaitingNow,
  startSleepWait,
  SLEEP_PAUSE_NOTE,
  SLEEP_WAIT_DWELL_MS,
  SLEEP_WAIT_POLL_MS,
  SLEEP_WAIT_TIMEOUT_MS,
} from "../projectSleepWait";

const SPAWNED = 1_000;

function agent(
  id: string,
  projectId: string,
  overrides: Partial<BackendTerminalInfo> = {}
): BackendTerminalInfo {
  return {
    id,
    projectId,
    cwd: "/repo",
    spawnedAt: SPAWNED,
    hasPty: true,
    detectedAgentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    lastStateChange: SPAWNED + 10,
    title: `Agent ${id}`,
    ...overrides,
  } as BackendTerminalInfo;
}

function stats(overrides: Partial<ProjectStatusEntry> = {}): ProjectStatusEntry {
  return {
    activeAgentCount: 0,
    waitingAgentCount: 0,
    processCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    ...overrides,
  };
}

let terminals: BackendTerminalInfo[] = [];
let shown: Array<{ projectId: string; state: "foreground" | "cached" }> = [];

const run = () => useProjectSleepWaitStore.getState().run;
const statusOf = (id: string) => run()?.projects.find((p) => p.id === id)?.status;

/** Lets the poll's reads resolve and its next timer fire. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.clearAllMocks();
  terminals = [];
  shown = [];
  getAllMock.mockImplementation(async () => terminals);
  presenceMock.mockImplementation(async () => ({
    thisWindow: shown.map((e) => ({ ...e, windowId: 1 })),
    otherWindows: [],
  }));
  sleepProjectMock.mockResolvedValue({});
  submitNoteMock.mockResolvedValue(undefined);
  storeState.projects = [
    { id: "a", name: "Alpha", path: "/a", status: "background" },
    { id: "b", name: "Beta", path: "/b", status: "background" },
  ];
  storeState.currentProject = null;
  useProjectStatsStore.setState({ stats: { a: stats(), b: stats() } });
});

afterEach(() => {
  cancelSleepWait();
  useProjectSleepWaitStore.getState().setRun(null);
  useProjectStatsStore.setState({ stats: {} });
  vi.useRealTimers();
});

describe("observeAgent", () => {
  it("reports what was seen, and leaves non-agents out", () => {
    expect(observeAgent(agent("t", "a", { agentState: "working" }))).toBe("working");
    expect(observeAgent(agent("t", "a", { waitingReason: "approval" }))).toBe("approval");
    expect(observeAgent(agent("t", "a", { waitingReason: "question" }))).toBe("question");
    expect(observeAgent(agent("t", "a", { waitingReason: "prompt" }))).toBe("waiting-input");
    expect(observeAgent(agent("t", "a", { waitingReason: undefined }))).toBe("waiting-input");
    expect(observeAgent(agent("t", "a", { agentState: "idle" }))).toBe("idle");
    expect(observeAgent(agent("t", "a", { agentState: "exited" }))).toBeNull();
    expect(observeAgent(agent("t", "a", { hasPty: false }))).toBeNull();
    expect(observeAgent(agent("t", "a", { isTrashed: true }))).toBeNull();
    expect(
      observeAgent(agent("t", "a", { detectedAgentId: undefined, launchAgentId: undefined }))
    ).toBeNull();
    // A launch hint counts before detection has fired.
    expect(
      observeAgent(agent("t", "a", { detectedAgentId: undefined, launchAgentId: "codex" }))
    ).toBe("waiting-input");
  });

  it("holds a launch-seeded idle as no reading, however old", () => {
    expect(observeAgent(agent("t", "a", { agentState: "idle", lastStateChange: SPAWNED }))).toBe(
      "starting"
    );
    expect(observeAgent(agent("t", "a", { agentState: "idle", lastStateChange: undefined }))).toBe(
      "starting"
    );
  });
});

describe("startSleepWait", () => {
  it("sleeps nothing until every project has read settled for the dwell, then sleeps them all", async () => {
    terminals = [agent("a1", "a"), agent("b1", "b", { agentState: "working" })];
    await startSleepWait(["a", "b"], { pauseNote: false });
    expect(statusOf("a")).toBe("waiting");
    // One reading after another isn't the dwell.
    await advance(SLEEP_WAIT_POLL_MS);
    expect(statusOf("a")).toBe("waiting");

    await advance(SLEEP_WAIT_DWELL_MS);
    // Alpha has settled, Beta hasn't: the barrier holds Alpha too.
    expect(statusOf("a")).toBe("ready");
    expect(statusOf("b")).toBe("waiting");
    expect(sleepProjectMock).not.toHaveBeenCalled();

    terminals = [agent("a1", "a"), agent("b1", "b", { lastStateChange: 100_500 })];
    await advance(SLEEP_WAIT_DWELL_MS + 2 * SLEEP_WAIT_POLL_MS);

    expect(sleepProjectMock.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(run()).toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("sleeps the project this view shows last, the rest in order", async () => {
    storeState.projects.push({ id: "c", name: "Gamma", path: "/c", status: "background" });
    storeState.currentProject = { id: "b" };
    shown = [{ projectId: "b", state: "foreground" }];
    terminals = [agent("a1", "a"), agent("b1", "b"), agent("c1", "c")];
    await startSleepWait(["a", "b", "c"], { pauseNote: false });
    await advance(SLEEP_WAIT_DWELL_MS + 2 * SLEEP_WAIT_POLL_MS);

    expect(sleepProjectMock.mock.calls.map(([id]) => id)).toEqual(["a", "c", "b"]);
  });

  it("never sleeps when, between readings, an idle agent hits a prompt and a new one is seeded", async () => {
    terminals = [agent("a1", "a"), agent("a2", "a", { agentState: "working" })];
    await startSleepWait(["a"], { pauseNote: false });

    terminals = [
      agent("a1", "a", { waitingReason: "approval", lastStateChange: 100_200 }),
      agent("a2", "a", { agentState: "idle", lastStateChange: 100_300 }),
      agent("a3", "a", { agentState: "idle", spawnedAt: 100_400, lastStateChange: 100_400 }),
    ];
    await advance(SLEEP_WAIT_DWELL_MS * 4);

    expect(sleepProjectMock).not.toHaveBeenCalled();
    expect(run()?.projects[0]!.agents.map((a) => a.observation)).toEqual([
      "approval",
      "idle",
      "starting",
    ]);
  });

  it("restarts the dwell when an agent's state changed between readings", async () => {
    terminals = [agent("a1", "a")];
    await startSleepWait(["a"], { pauseNote: false });
    await advance(SLEEP_WAIT_DWELL_MS - SLEEP_WAIT_POLL_MS);
    // Worked and settled again between two readings: only the timestamp moved.
    terminals = [agent("a1", "a", { lastStateChange: 103_000 })];
    await advance(SLEEP_WAIT_POLL_MS * 2);

    expect(sleepProjectMock).not.toHaveBeenCalled();
    expect(statusOf("a")).toBe("waiting");
  });

  it.each([
    ["working", { activeAgentCount: 1, processCount: 1 }],
    ["blocked", { blockedAgentCount: 1, processCount: 1 }],
  ])("holds a project whose pushed counts show a %s agent the read missed", async (_, counts) => {
    useProjectStatsStore.setState({ stats: { a: stats(counts) } });
    terminals = [agent("a1", "a")];
    await startSleepWait(["a"], { pauseNote: false });
    await advance(SLEEP_WAIT_DWELL_MS * 3);

    expect(statusOf("a")).toBe("waiting");
    expect(sleepProjectMock).not.toHaveBeenCalled();
  });

  it("sleeps a project whose only process is one the terminal list never shows", async () => {
    // A dev preview counts as a process but isn't a terminal.
    useProjectStatsStore.setState({ stats: { a: stats({ processCount: 1 }) } });
    terminals = [];
    await startSleepWait(["a"], { pauseNote: false });
    await advance(SLEEP_WAIT_DWELL_MS + 2 * SLEEP_WAIT_POLL_MS);

    expect(sleepProjectMock).toHaveBeenCalledWith("a");
  });

  it("reads a project with agents by its counts but none in the read as unavailable", async () => {
    useProjectStatsStore.setState({
      stats: { a: stats({ processCount: 1, waitingAgentCount: 1 }) },
    });
    terminals = [];
    await startSleepWait(["a"], { pauseNote: false });
    await advance(SLEEP_WAIT_DWELL_MS * 3);

    expect(statusOf("a")).toBe("unavailable");
    expect(sleepProjectMock).not.toHaveBeenCalled();
  });

  it("treats a failed reading as unavailable, and starts the dwell over after it", async () => {
    terminals = [agent("a1", "a")];
    await startSleepWait(["a"], { pauseNote: false });
    await advance(SLEEP_WAIT_DWELL_MS - SLEEP_WAIT_POLL_MS);
    getAllMock.mockRejectedValueOnce(new Error("host gone"));
    await advance(SLEEP_WAIT_POLL_MS);
    expect(statusOf("a")).toBe("unavailable");
    // Had the earlier dwell survived, this reading would sleep it.
    await advance(SLEEP_WAIT_POLL_MS);
    expect(sleepProjectMock).not.toHaveBeenCalled();
  });

  it("leaves a project the user comes back to open, in any window, and sleeps the rest", async () => {
    terminals = [agent("a1", "a", { agentState: "working" }), agent("b1", "b")];
    await startSleepWait(["a", "b"], { pauseNote: false });
    presenceMock.mockImplementation(async () => ({
      thisWindow: [],
      otherWindows: shown.map((e) => ({ ...e, windowId: 2 })),
    }));
    shown = [{ projectId: "a", state: "foreground" }];
    await advance(SLEEP_WAIT_POLL_MS);
    expect(statusOf("a")).toBe("left-open");

    // Leaving it again doesn't put it back in the run.
    shown = [];
    terminals = [agent("a1", "a"), agent("b1", "b")];
    await advance(SLEEP_WAIT_DWELL_MS + 2 * SLEEP_WAIT_POLL_MS);

    expect(sleepProjectMock.mock.calls.map(([id]) => id)).toEqual(["b"]);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", title: "Project left open" })
    );
  });

  it("keeps a project shown at the start in the run while it stays on screen", async () => {
    shown = [{ projectId: "a", state: "foreground" }];
    terminals = [agent("a1", "a")];
    await startSleepWait(["a"], { pauseNote: false });
    await advance(SLEEP_WAIT_DWELL_MS + 2 * SLEEP_WAIT_POLL_MS);

    expect(sleepProjectMock).toHaveBeenCalledWith("a");
  });

  it("leaves a project open when its agents moved at all since they earned the dwell", async () => {
    terminals = [agent("a1", "a"), agent("b1", "b")];
    sleepProjectMock.mockImplementation(async (id: string) => {
      // Worked and settled again while Alpha slept: settled, but not the reading that qualified.
      if (id === "a") terminals = [agent("b1", "b", { lastStateChange: 150_000 })];
      return {};
    });
    await startSleepWait(["a", "b"], { pauseNote: false });
    await advance(SLEEP_WAIT_DWELL_MS + 2 * SLEEP_WAIT_POLL_MS);

    expect(sleepProjectMock.mock.calls.map(([id]) => id)).toEqual(["a"]);
  });

  it("leaves a project open when an agent starts again before its turn", async () => {
    terminals = [agent("a1", "a"), agent("b1", "b")];
    sleepProjectMock.mockImplementation(async (id: string) => {
      if (id === "a") terminals = [agent("b1", "b", { agentState: "working" })];
      return {};
    });
    await startSleepWait(["a", "b"], { pauseNote: false });
    await advance(SLEEP_WAIT_DWELL_MS + 2 * SLEEP_WAIT_POLL_MS);

    expect(sleepProjectMock.mock.calls.map(([id]) => id)).toEqual(["a"]);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Project left open" })
    );
  });

  it("sleeps nothing on Cancel, even with a project already ready", async () => {
    terminals = [agent("a1", "a"), agent("b1", "b", { agentState: "working" })];
    await startSleepWait(["a", "b"], { pauseNote: false });
    await advance(SLEEP_WAIT_DWELL_MS + SLEEP_WAIT_POLL_MS);
    expect(statusOf("a")).toBe("ready");

    cancelSleepWait();
    terminals = [agent("a1", "a"), agent("b1", "b")];
    await advance(SLEEP_WAIT_DWELL_MS * 3);

    expect(run()).toBeNull();
    expect(sleepProjectMock).not.toHaveBeenCalled();
  });

  it("sleeps every remaining project at once on Sleep now", async () => {
    terminals = [agent("a1", "a", { agentState: "working" }), agent("b1", "b")];
    await startSleepWait(["a", "b"], { pauseNote: false });

    await sleepWaitingNow();

    expect(sleepProjectMock.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(run()).toBeNull();
  });

  it("spares a project the user came back to since the last reading, even on Sleep now", async () => {
    terminals = [agent("a1", "a", { agentState: "working" }), agent("b1", "b")];
    await startSleepWait(["a", "b"], { pauseNote: false });
    shown = [{ projectId: "a", state: "foreground" }];

    await sleepWaitingNow();

    expect(sleepProjectMock.mock.calls.map(([id]) => id)).toEqual(["b"]);
  });

  it("doesn't sleep on Sleep now a project already slept elsewhere, or call it left open", async () => {
    terminals = [agent("a1", "a", { agentState: "working" })];
    await startSleepWait(["a"], { pauseNote: false });
    storeState.projects = [{ ...storeState.projects[0]!, status: "closed" }];

    await sleepWaitingNow();

    expect(sleepProjectMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("stops at the timeout and asks instead of sleeping, until told to keep waiting", async () => {
    terminals = [agent("a1", "a", { agentState: "working" })];
    await startSleepWait(["a"], { pauseNote: false });
    await advance(SLEEP_WAIT_TIMEOUT_MS + SLEEP_WAIT_POLL_MS);
    expect(run()?.phase).toBe("timed-out");

    terminals = [agent("a1", "a", { lastStateChange: 200_000 })];
    await advance(SLEEP_WAIT_DWELL_MS * 3);
    expect(statusOf("a")).toBe("ready");
    expect(sleepProjectMock).not.toHaveBeenCalled();

    keepWaiting();
    expect(run()?.phase).toBe("waiting");
    await advance(SLEEP_WAIT_POLL_MS * 2);
    expect(sleepProjectMock).toHaveBeenCalledWith("a");
    expect(submitNoteMock).not.toHaveBeenCalled();
  });

  it("reports a project that failed to sleep, and its retry waits for the agents again", async () => {
    terminals = [agent("a1", "a"), agent("b1", "b")];
    sleepProjectMock.mockRejectedValueOnce(new Error("boom"));
    await startSleepWait(["a", "b"], { pauseNote: false });
    await advance(SLEEP_WAIT_DWELL_MS + 2 * SLEEP_WAIT_POLL_MS);
    expect(sleepProjectMock.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);

    const call = notifyMock.mock.calls.find(([n]) => n.title === "Couldn't sleep project");
    expect(call).toBeDefined();
    // The agent went back to work since: the retry must not stop it.
    terminals = [agent("a1", "a", { agentState: "working" })];
    await call![0].actions[0].onClick();
    expect(run()?.projects.map((p) => p.id)).toEqual(["a"]);
    await advance(SLEEP_WAIT_DWELL_MS * 2);
    expect(sleepProjectMock).toHaveBeenCalledTimes(2);

    terminals = [agent("a1", "a", { lastStateChange: 120_000 })];
    await advance(SLEEP_WAIT_DWELL_MS + 2 * SLEEP_WAIT_POLL_MS);
    expect(sleepProjectMock.mock.calls.map(([id]) => id)).toEqual(["a", "b", "a"]);
  });

  it("drops a project slept elsewhere from the run", async () => {
    terminals = [agent("a1", "a", { agentState: "working" })];
    await startSleepWait(["a"], { pauseNote: false });
    storeState.projects = [{ ...storeState.projects[0]!, status: "closed" }];
    await advance(SLEEP_WAIT_POLL_MS);

    expect(run()).toBeNull();
    expect(sleepProjectMock).not.toHaveBeenCalled();
  });
});

describe("pause note", () => {
  it("is sent once, only to agents observed working with a detected agent", async () => {
    terminals = [
      agent("a1", "a", { agentState: "working" }),
      agent("a2", "a"),
      agent("a3", "a", {
        agentState: "working",
        detectedAgentId: undefined,
        launchAgentId: "codex",
      }),
      agent("x1", "other", { agentState: "working" }),
    ];
    await startSleepWait(["a"], { pauseNote: true });
    await advance(SLEEP_WAIT_POLL_MS * 4);

    expect(submitNoteMock).toHaveBeenCalledTimes(1);
    expect(submitNoteMock).toHaveBeenCalledWith("a1", SLEEP_PAUSE_NOTE);
    expect(run()?.projects[0]!.agents.find((a) => a.terminalId === "a1")?.note).toBe("sent");
  });

  it("marks a refused note on its agent, keeps waiting, and never sends it again", async () => {
    submitNoteMock.mockRejectedValue(new Error("choice dialog"));
    terminals = [agent("a1", "a", { agentState: "working" })];
    await startSleepWait(["a"], { pauseNote: true });

    expect(run()?.projects[0]!.agents[0]!.note).toBe("refused");
    expect(statusOf("a")).toBe("waiting");
    await advance(SLEEP_WAIT_POLL_MS * 4);
    expect(submitNoteMock).toHaveBeenCalledTimes(1);
  });

  it("sends nothing once the user chose Sleep now", async () => {
    terminals = [agent("a1", "a", { agentState: "working" })];
    let release!: (value: BackendTerminalInfo[]) => void;
    getAllMock.mockImplementationOnce(
      () => new Promise<BackendTerminalInfo[]>((resolve) => (release = resolve))
    );
    const started = startSleepWait(["a"], { pauseNote: true });
    await sleepWaitingNow();
    release(terminals);
    await started;

    expect(sleepProjectMock).toHaveBeenCalledWith("a");
    expect(submitNoteMock).not.toHaveBeenCalled();
  });

  it("sends nothing when not chosen", async () => {
    terminals = [agent("a1", "a", { agentState: "working" })];
    await startSleepWait(["a"], { pauseNote: false });
    await advance(SLEEP_WAIT_POLL_MS * 4);

    expect(submitNoteMock).not.toHaveBeenCalled();
  });
});

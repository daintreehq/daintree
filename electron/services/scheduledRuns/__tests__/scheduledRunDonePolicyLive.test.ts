import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRun, ScheduledRunEvidence } from "../../../../shared/types/scheduledRuns.js";
import { outcomeForEvidence } from "../../../../shared/utils/scheduledRuns.js";

const state = vi.hoisted(() => ({
  runs: new Map<string, unknown>(),
  views: [] as Array<{ id: number; send: ReturnType<typeof vi.fn> }>,
  shutdown: null as unknown,
  ptyClient: {
    getTerminalAsync: vi.fn(),
    gracefulKill: vi.fn(),
    kill: vi.fn(),
  },
  background: vi.fn(async () => {}),
  forget: vi.fn(async () => {}),
}));

vi.mock("../../../lifecycle/shutdownCoordinator.js", () => ({
  getActiveShutdown: () => state.shutdown,
}));
vi.mock("../../../utils/thawThenSend.js", () => ({
  thawThenSend: (_wc: unknown, _pending: () => boolean, send: () => void) => send(),
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => state.ptyClient }));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: () => state.views,
}));
vi.mock("../../ProjectStore.js", () => ({ projectStore: { id: "project-store" } }));
vi.mock("../../viewless/projectStateAuthoring.js", () => ({
  backgroundViewlessTerminal: state.background,
  forgetViewlessTerminal: state.forget,
}));
vi.mock("../index.js", () => ({
  peekScheduledRunRecorder: () => ({ get: (runId: string) => state.runs.get(runId) ?? null }),
}));

import { CHANNELS } from "../../../ipc/channels.js";
import { events } from "../../events.js";
import {
  _resetScheduledRunDonePolicyForTest,
  armScheduledRunDonePolicy,
} from "../scheduledRunDonePolicyLive.js";

const SPAWNED_AT = 1_800_000_000_040;
const DONE: ScheduledRunEvidence = {
  kind: "handback",
  report: "done",
  summary: "triaged all six",
  truncated: false,
};

function settledRun(evidence: ScheduledRunEvidence = DONE): ScheduledRun {
  return {
    id: "run-1",
    scheduleId: "schedule-1",
    projectId: "project-1",
    origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
    createdAt: SPAWNED_AT - 40,
    terminalId: "terminal-1",
    terminalSpawnedAt: SPAWNED_AT,
    settlement: {
      state: "settled",
      settledAt: SPAWNED_AT + 5_000,
      outcome: outcomeForEvidence(evidence),
      evidence,
    },
    process: { agent: { state: "not-started" }, pty: { state: "running", startedAt: SPAWNED_AT } },
    pane: { state: "none" },
    resume: null,
  };
}

const terminalInfo = (overrides: Record<string, unknown> = {}) => ({
  id: "terminal-1",
  spawnedAt: SPAWNED_AT,
  launchAgentId: "codex",
  projectId: "project-1",
  worktreeId: "/repo",
  cwd: "/repo",
  title: "Codex",
  lastObservedTitle: "Triage the new issues",
  agentLaunchFlags: [],
  scheduledRun: { scheduleId: "schedule-1", runId: "run-1" },
  ...overrides,
});

const arm = (onDone: "close" | "background") =>
  armScheduledRunDonePolicy({
    runId: "run-1",
    scheduleId: "schedule-1",
    projectId: "project-1",
    terminalId: "terminal-1",
    onDone,
  });

const view = (id: number) => ({ id, send: vi.fn() });

beforeEach(() => {
  state.runs.clear();
  state.views = [];
  state.shutdown = null;
  state.ptyClient.getTerminalAsync.mockReset().mockResolvedValue(terminalInfo());
  state.ptyClient.gracefulKill.mockReset().mockResolvedValue("codex-session");
  state.ptyClient.kill.mockReset();
  state.background.mockClear();
  state.forget.mockClear();
});

afterEach(() => {
  _resetScheduledRunDonePolicyForTest();
  events.removeAllListeners();
});

describe("a scheduled run's done policy, applied (#15982)", () => {
  it("closes the terminal the quit way, capturing its session onto the run, and removes the pane", async () => {
    const captured: unknown[] = [];
    events.on("agent-session:captured", (payload) => captured.push(payload));
    const views = [view(1), view(2)];
    state.views = views;
    state.runs.set("run-1", settledRun());

    arm("close");

    await vi.waitFor(() => expect(views[1]!.send).toHaveBeenCalled());
    expect(state.ptyClient.gracefulKill).toHaveBeenCalledWith("terminal-1");
    expect(state.ptyClient.kill).not.toHaveBeenCalled();
    expect(captured).toEqual([
      expect.objectContaining({
        terminalId: "terminal-1",
        boundary: "kill",
        record: expect.objectContaining({
          sessionId: "codex-session",
          agentId: "codex",
          projectId: "project-1",
          title: "Triage the new issues",
          scheduledRun: { scheduleId: "schedule-1", runId: "run-1" },
          closedBy: "kill",
          terminal: { id: "terminal-1", spawnedAt: SPAWNED_AT },
        }),
      }),
    ]);
    for (const each of views) {
      expect(each.send).toHaveBeenCalledWith(CHANNELS.SCHEDULES_FINISH_REQUEST, {
        runId: "run-1",
        terminalId: "terminal-1",
        action: "remove",
      });
    }
    // A view holding the pane saves its own layout.
    expect(state.forget).not.toHaveBeenCalled();
  });

  it("takes a closed pane out of the saved layout when no view shows the project", async () => {
    state.runs.set("run-1", settledRun());

    arm("close");

    await vi.waitFor(() =>
      expect(state.forget).toHaveBeenCalledWith(
        { id: "project-store" },
        "project-1",
        "terminal-1"
      )
    );
  });

  it("closes nothing when another incarnation now runs under the run's terminal id", async () => {
    state.ptyClient.getTerminalAsync.mockResolvedValue(terminalInfo({ spawnedAt: SPAWNED_AT + 1 }));
    state.views = [view(1)];
    state.runs.set("run-1", settledRun());

    arm("close");

    await vi.waitFor(() => expect(state.ptyClient.getTerminalAsync).toHaveBeenCalled());
    await Promise.resolve();
    expect(state.ptyClient.gracefulKill).not.toHaveBeenCalled();
    expect(state.views[0]!.send).not.toHaveBeenCalled();
    expect(state.forget).not.toHaveBeenCalled();
  });

  it("moves the pane to the background in the views, or in the saved layout with none", async () => {
    const shown = view(1);
    state.views = [shown];
    state.runs.set("run-1", settledRun());
    arm("background");
    expect(shown.send).toHaveBeenCalledWith(CHANNELS.SCHEDULES_FINISH_REQUEST, {
      runId: "run-1",
      terminalId: "terminal-1",
      action: "background",
    });
    expect(state.background).not.toHaveBeenCalled();

    state.views = [];
    arm("background");
    await vi.waitFor(() =>
      expect(state.background).toHaveBeenCalledWith(
        { id: "project-store" },
        "project-1",
        "terminal-1"
      )
    );
    expect(state.ptyClient.gracefulKill).not.toHaveBeenCalled();
  });

  it("waits for the run to end, and acts only on the agent's done", async () => {
    state.runs.set("run-1", { ...settledRun(), settlement: { state: "open" } });
    arm("close");
    expect(state.ptyClient.getTerminalAsync).not.toHaveBeenCalled();

    const needsYou: ScheduledRunEvidence = { ...DONE, report: "needs-you" };
    state.runs.set("run-1", settledRun(needsYou));
    events.emit("scheduled-run:ended", {
      runId: "run-1",
      scheduleId: "schedule-1",
      projectId: "project-1",
      terminalId: "terminal-1",
      outcome: "needs-you",
      timestamp: SPAWNED_AT + 5_000,
    });
    await Promise.resolve();
    expect(state.ptyClient.getTerminalAsync).not.toHaveBeenCalled();

    state.runs.set("run-1", { ...settledRun(), settlement: { state: "open" } });
    arm("close");
    state.runs.set("run-1", settledRun());
    events.emit("scheduled-run:ended", {
      runId: "run-1",
      scheduleId: "schedule-1",
      projectId: "project-1",
      terminalId: "terminal-1",
      outcome: "done",
      timestamp: SPAWNED_AT + 5_000,
    });
    await vi.waitFor(() => expect(state.ptyClient.gracefulKill).toHaveBeenCalledTimes(1));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunIpc } from "@shared/types/ipc/api";

vi.hoisted(() => {
  (globalThis as unknown as { window?: unknown }).window = {
    ...((globalThis as unknown as { window?: unknown }).window as Record<string, unknown>),
    electron: {
      workflow: {
        listRuns: vi.fn(),
        getWorkflowRun: vi.fn(),
        cancelWorkflow: vi.fn(),
      },
    },
  } as unknown;
});

import { useWorkflowStore } from "../workflowStore";

function makeRun(runId: string, overrides: Partial<WorkflowRunIpc> = {}): WorkflowRunIpc {
  return {
    runId,
    workflowId: "wf-1",
    workflowVersion: "1.0.0",
    status: "completed",
    startedAt: Date.now(),
    nodeStates: {},
    scheduledNodes: [],
    taskMapping: {},
    evaluatedConditions: [],
    definition: {
      id: "wf-1",
      version: "1.0.0",
      name: "Test Workflow",
      nodes: [{ id: "node-1", type: "action", config: { actionId: "test.action" } }],
    },
    ...overrides,
  };
}

describe("workflowStore", () => {
  beforeEach(() => {
    vi.mocked(window.electron.workflow.listRuns).mockResolvedValue([]);
    vi.mocked(window.electron.workflow.getWorkflowRun).mockResolvedValue(null);
    vi.mocked(window.electron.workflow.cancelWorkflow).mockResolvedValue(undefined);
  });

  afterEach(() => {
    useWorkflowStore.getState().reset();
    vi.clearAllMocks();
  });

  it("initializes with listRuns data", async () => {
    const runs = [makeRun("r1", { startedAt: 100 }), makeRun("r2", { startedAt: 200 })];
    vi.mocked(window.electron.workflow.listRuns).mockResolvedValue(runs);

    await useWorkflowStore.getState().init();

    expect(useWorkflowStore.getState().isInitialized).toBe(true);
    expect(useWorkflowStore.getState().runs.size).toBe(2);
  });

  it("trims to 20 runs on init keeping newest", async () => {
    const runs = Array.from({ length: 25 }, (_, i) => makeRun(`r-${i}`, { startedAt: i }));
    vi.mocked(window.electron.workflow.listRuns).mockResolvedValue(runs);

    await useWorkflowStore.getState().init();

    const state = useWorkflowStore.getState();
    expect(state.runs.size).toBe(20);
    expect(state.runs.has("r-24")).toBe(true);
    expect(state.runs.has("r-0")).toBe(false);
  });

  it("refreshRun upserts a run", async () => {
    const run = makeRun("r1", { status: "running" });
    vi.mocked(window.electron.workflow.getWorkflowRun).mockResolvedValue(run);

    await useWorkflowStore.getState().refreshRun("r1");

    expect(useWorkflowStore.getState().runs.get("r1")?.status).toBe("running");
  });

  it("refreshRun removes run when null returned", async () => {
    useWorkflowStore.setState({
      runs: new Map([["r1", makeRun("r1")]]),
    });
    vi.mocked(window.electron.workflow.getWorkflowRun).mockResolvedValue(null);

    await useWorkflowStore.getState().refreshRun("r1");

    expect(useWorkflowStore.getState().runs.has("r1")).toBe(false);
  });

  it("cancelRun calls cancelWorkflow", async () => {
    await useWorkflowStore.getState().cancelRun("r1");

    expect(window.electron.workflow.cancelWorkflow).toHaveBeenCalledWith("r1");
  });

  it("reset clears runs and increments epoch", () => {
    useWorkflowStore.setState({
      runs: new Map([["r1", makeRun("r1")]]),
      isInitialized: true,
    });

    const epochBefore = useWorkflowStore.getState().epoch;
    useWorkflowStore.getState().reset();

    expect(useWorkflowStore.getState().runs.size).toBe(0);
    expect(useWorkflowStore.getState().isInitialized).toBe(false);
    expect(useWorkflowStore.getState().epoch).toBe(epochBefore + 1);
  });

  it("epoch guard prevents stale init from applying", async () => {
    let resolveListRuns: (value: WorkflowRunIpc[]) => void;
    vi.mocked(window.electron.workflow.listRuns).mockReturnValue(
      new Promise((resolve) => {
        resolveListRuns = resolve;
      })
    );

    const initPromise = useWorkflowStore.getState().init();
    useWorkflowStore.getState().reset();
    resolveListRuns!([makeRun("r1")]);
    await initPromise;

    expect(useWorkflowStore.getState().runs.size).toBe(0);
    expect(useWorkflowStore.getState().isInitialized).toBe(false);
  });

  it("trim preserves running runs over newer completed ones", async () => {
    const runs: WorkflowRunIpc[] = [
      makeRun("old-running", { startedAt: 1, status: "running" }),
      ...Array.from({ length: 20 }, (_, i) =>
        makeRun(`completed-${i}`, { startedAt: 100 + i, status: "completed" })
      ),
    ];
    vi.mocked(window.electron.workflow.listRuns).mockResolvedValue(runs);

    await useWorkflowStore.getState().init();

    const state = useWorkflowStore.getState();
    expect(state.runs.has("old-running")).toBe(true);
    expect(state.runs.size).toBe(20);
  });
});

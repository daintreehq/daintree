import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRun } from "../../../../shared/types/workflowRun.js";
import type { WorkflowSummary } from "../../../../shared/types/workflow.js";

const mockListWorkflows = vi.fn();
vi.mock("../../../services/WorkflowLoader.js", () => ({
  workflowLoader: {
    listWorkflows: (...args: unknown[]) => mockListWorkflows(...args),
  },
}));

const mockGetWorkflowEngine = vi.fn();
vi.mock("../../../services/WorkflowEngine.js", () => ({
  getWorkflowEngine: () => mockGetWorkflowEngine(),
}));

const mockIpcMainHandle = vi.fn();
const mockIpcMainRemoveHandler = vi.fn();
const mockBroadcastWindow = vi.hoisted(() => ({
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send: vi.fn(),
  },
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => mockIpcMainHandle(...args),
    removeHandler: (...args: unknown[]) => mockIpcMainRemoveHandler(...args),
  },
  BrowserWindow: { getAllWindows: () => [mockBroadcastWindow] },
}));

vi.mock("../../../utils/performance.js", () => ({
  isPerformanceCaptureEnabled: () => false,
  markPerformance: vi.fn(),
  sampleIpcTiming: vi.fn(),
}));

vi.mock("../../../../shared/perf/marks.js", () => ({
  PERF_MARKS: { IPC_REQUEST_START: "ipc:start", IPC_REQUEST_END: "ipc:end" },
}));

import { registerWorkflowHandlers } from "../workflow.js";
import type { HandlerDependencies } from "../../types.js";

function makeMockDeps(overrides?: Partial<HandlerDependencies>): HandlerDependencies {
  return {
    mainWindow: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: vi.fn(),
      },
    } as unknown as HandlerDependencies["mainWindow"],
    events: {
      on: vi.fn(() => vi.fn()),
      emit: vi.fn(),
      off: vi.fn(),
    } as unknown as HandlerDependencies["events"],
    ...overrides,
  };
}

function makeWorkflowRun(overrides?: Partial<WorkflowRun>): WorkflowRun {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    workflowVersion: "1.0.0",
    status: "running",
    startedAt: 1000,
    definition: {
      id: "wf-1",
      version: "1.0.0",
      name: "Test Workflow",
      nodes: [{ id: "n1", type: "action", config: { actionId: "test.action" } }],
    },
    nodeStates: {},
    taskMapping: {},
    scheduledNodes: new Set(["n1", "n2"]),
    evaluatedConditions: [],
    ...overrides,
  };
}

describe("registerWorkflowHandlers", () => {
  let deps: HandlerDependencies;
  let handlers: Map<string, (...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeMockDeps();
    handlers = new Map();

    mockIpcMainHandle.mockImplementation((channel: string, handler: unknown) => {
      handlers.set(channel, handler as (...args: unknown[]) => unknown);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getHandler(channel: string) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler;
  }

  it("registers all 7 invoke handlers", () => {
    registerWorkflowHandlers(deps);

    expect(mockIpcMainHandle).toHaveBeenCalledTimes(7);
    const channels = mockIpcMainHandle.mock.calls.map((c: unknown[]) => c[0]);
    expect(channels).toContain("workflow:list");
    expect(channels).toContain("workflow:start");
    expect(channels).toContain("workflow:cancel");
    expect(channels).toContain("workflow:get-run");
    expect(channels).toContain("workflow:list-runs");
    expect(channels).toContain("workflow:list-pending-approvals");
    expect(channels).toContain("workflow:resolve-approval");
  });

  it("subscribes to 5 event bus events", () => {
    registerWorkflowHandlers(deps);

    expect(deps.events!.on).toHaveBeenCalledTimes(5);
    const eventNames = (deps.events!.on as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0]
    );
    expect(eventNames).toContain("workflow:started");
    expect(eventNames).toContain("workflow:completed");
    expect(eventNames).toContain("workflow:failed");
    expect(eventNames).toContain("workflow:approval-requested");
    expect(eventNames).toContain("workflow:approval-cleared");
  });

  it("cleanup removes all handlers and event subscriptions", () => {
    const unsubFns = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    let callIdx = 0;
    (deps.events!.on as ReturnType<typeof vi.fn>).mockImplementation(() => unsubFns[callIdx++]);

    const cleanup = registerWorkflowHandlers(deps);
    cleanup();

    expect(mockIpcMainRemoveHandler).toHaveBeenCalledTimes(7);
    for (const unsub of unsubFns) {
      expect(unsub).toHaveBeenCalledTimes(1);
    }
  });

  describe("listWorkflows", () => {
    it("returns workflow summaries from loader", async () => {
      const summaries: WorkflowSummary[] = [
        { id: "wf-1", name: "Test", version: "1.0.0", nodeCount: 2, source: "built-in" },
      ];
      mockListWorkflows.mockResolvedValue(summaries);

      registerWorkflowHandlers(deps);
      const result = await getHandler("workflow:list")({});

      expect(result).toEqual(summaries);
    });

    it("works even when engine is null (uses loader directly)", async () => {
      mockGetWorkflowEngine.mockReturnValue(null);
      mockListWorkflows.mockResolvedValue([]);

      registerWorkflowHandlers(deps);
      const result = await getHandler("workflow:list")({});

      expect(result).toEqual([]);
    });
  });

  describe("startWorkflow", () => {
    it("starts a workflow and returns runId", async () => {
      const mockEngine = { startWorkflow: vi.fn().mockResolvedValue("run-abc") };
      mockGetWorkflowEngine.mockReturnValue(mockEngine);

      registerWorkflowHandlers(deps);
      const result = await getHandler("workflow:start")({}, "wf-1");

      expect(mockEngine.startWorkflow).toHaveBeenCalledWith("wf-1");
      expect(result).toBe("run-abc");
    });

    it("throws when engine is null", async () => {
      mockGetWorkflowEngine.mockReturnValue(null);

      registerWorkflowHandlers(deps);

      await expect(getHandler("workflow:start")({}, "wf-1")).rejects.toThrow(
        "WorkflowEngine not initialized"
      );
    });
  });

  describe("cancelWorkflow", () => {
    it("cancels a workflow run", async () => {
      const mockEngine = { cancelWorkflow: vi.fn().mockResolvedValue(undefined) };
      mockGetWorkflowEngine.mockReturnValue(mockEngine);

      registerWorkflowHandlers(deps);
      await getHandler("workflow:cancel")({}, "run-1");

      expect(mockEngine.cancelWorkflow).toHaveBeenCalledWith("run-1");
    });

    it("throws when engine is null", async () => {
      mockGetWorkflowEngine.mockReturnValue(null);

      registerWorkflowHandlers(deps);

      await expect(getHandler("workflow:cancel")({}, "run-1")).rejects.toThrow(
        "WorkflowEngine not initialized"
      );
    });
  });

  describe("getWorkflowRun", () => {
    it("serializes scheduledNodes Set to array and preserves other fields", async () => {
      const run = makeWorkflowRun();
      const mockEngine = { getWorkflowRun: vi.fn().mockResolvedValue(run) };
      mockGetWorkflowEngine.mockReturnValue(mockEngine);

      registerWorkflowHandlers(deps);
      const result = (await getHandler("workflow:get-run")({}, "run-1")) as Record<string, unknown>;

      expect(Array.isArray(result.scheduledNodes)).toBe(true);
      expect(result.scheduledNodes).toEqual(expect.arrayContaining(["n1", "n2"]));
      expect(result.runId).toBe("run-1");
      expect(result.workflowId).toBe("wf-1");
      expect(result.status).toBe("running");
      expect(result.nodeStates).toEqual({});
      expect(result.taskMapping).toEqual({});
    });

    it("returns null for nonexistent run", async () => {
      const mockEngine = { getWorkflowRun: vi.fn().mockResolvedValue(null) };
      mockGetWorkflowEngine.mockReturnValue(mockEngine);

      registerWorkflowHandlers(deps);
      const result = await getHandler("workflow:get-run")({}, "nonexistent");

      expect(result).toBeNull();
    });

    it("throws when engine is null", async () => {
      mockGetWorkflowEngine.mockReturnValue(null);

      registerWorkflowHandlers(deps);

      await expect(getHandler("workflow:get-run")({}, "run-1")).rejects.toThrow(
        "WorkflowEngine not initialized"
      );
    });
  });

  describe("listRuns", () => {
    it("serializes all runs and preserves fields", async () => {
      const runs = [makeWorkflowRun(), makeWorkflowRun({ runId: "run-2" })];
      const mockEngine = { listAllRuns: vi.fn().mockResolvedValue(runs) };
      mockGetWorkflowEngine.mockReturnValue(mockEngine);

      registerWorkflowHandlers(deps);
      const result = (await getHandler("workflow:list-runs")({})) as Array<Record<string, unknown>>;

      expect(result).toHaveLength(2);
      expect(Array.isArray(result[0].scheduledNodes)).toBe(true);
      expect(result[0].runId).toBe("run-1");
      expect(Array.isArray(result[1].scheduledNodes)).toBe(true);
      expect(result[1].runId).toBe("run-2");
    });

    it("returns empty array when engine is null", async () => {
      mockGetWorkflowEngine.mockReturnValue(null);

      registerWorkflowHandlers(deps);
      const result = await getHandler("workflow:list-runs")({});

      expect(result).toEqual([]);
    });
  });

  describe("event forwarding", () => {
    it("forwards workflow:started to renderer", () => {
      registerWorkflowHandlers(deps);

      const onCalls = (deps.events!.on as ReturnType<typeof vi.fn>).mock.calls;
      const startedCall = onCalls.find((c: unknown[]) => c[0] === "workflow:started");
      const callback = startedCall![1] as (payload: unknown) => void;

      const payload = { runId: "r1", workflowId: "w1", workflowVersion: "1.0.0", timestamp: 123 };
      callback(payload);

      expect(mockBroadcastWindow.webContents.send).toHaveBeenCalledWith(
        "workflow:started",
        payload
      );
    });

    it("forwards workflow:completed to renderer", () => {
      registerWorkflowHandlers(deps);

      const onCalls = (deps.events!.on as ReturnType<typeof vi.fn>).mock.calls;
      const completedCall = onCalls.find((c: unknown[]) => c[0] === "workflow:completed");
      const callback = completedCall![1] as (payload: unknown) => void;

      const payload = {
        runId: "r1",
        workflowId: "w1",
        workflowVersion: "1.0.0",
        duration: 5000,
        timestamp: 123,
      };
      callback(payload);

      expect(mockBroadcastWindow.webContents.send).toHaveBeenCalledWith(
        "workflow:completed",
        payload
      );
    });

    it("forwards workflow:failed to renderer", () => {
      registerWorkflowHandlers(deps);

      const onCalls = (deps.events!.on as ReturnType<typeof vi.fn>).mock.calls;
      const failedCall = onCalls.find((c: unknown[]) => c[0] === "workflow:failed");
      const callback = failedCall![1] as (payload: unknown) => void;

      const payload = {
        runId: "r1",
        workflowId: "w1",
        workflowVersion: "1.0.0",
        error: "something broke",
        timestamp: 123,
      };
      callback(payload);

      expect(mockBroadcastWindow.webContents.send).toHaveBeenCalledWith("workflow:failed", payload);
    });
  });

  describe("without events bus", () => {
    it("still registers invoke handlers when events is undefined", () => {
      const depsNoEvents = makeMockDeps({ events: undefined });
      const cleanup = registerWorkflowHandlers(depsNoEvents);

      expect(mockIpcMainHandle).toHaveBeenCalledTimes(7);
      expect(() => cleanup()).not.toThrow();
    });
  });
});

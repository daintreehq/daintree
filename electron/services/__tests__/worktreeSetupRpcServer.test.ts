import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceHostRequest,
  WorktreeSetupStepDescriptor,
} from "../../../shared/types/workspace-host.js";
import type { PluginWorktreeSetupStepContext } from "../../../shared/types/plugin.js";
import { WorktreeSetupRpcServer, type WorktreeSetupRpcDeps } from "../worktreeSetupRpcServer.js";
import {
  clearWorktreeSetupStepRegistry,
  registerWorktreeSetupStepHandler,
  registerWorktreeSetupSteps,
} from "../worktreeSetupStepRegistry.js";

const TARGET = { worktreeId: "/repo/wt", worktreePath: "/repo/wt", branch: "feature/x" };

const DB: WorktreeSetupStepDescriptor = {
  pluginId: "acme",
  pluginName: "Acme",
  pluginVersion: "1.0.0",
  stepId: "db",
  label: "Provision DB",
  timeoutMs: 5_000,
};

describe("WorktreeSetupRpcServer", () => {
  let sent: WorkspaceHostRequest[];
  let deps: WorktreeSetupRpcDeps;
  let server: WorktreeSetupRpcServer;

  beforeEach(() => {
    sent = [];
    deps = {
      resolveProjectId: vi.fn(async () => "project-1"),
      whenPluginsLoaded: vi.fn(async () => undefined),
      activatePlugin: vi.fn(async () => undefined),
      isPluginActivated: vi.fn(() => true),
      filterForProject: vi.fn(async (steps) => steps),
    };
    server = new WorktreeSetupRpcServer(
      "/repo",
      (request) => {
        sent.push(request);
        return true;
      },
      deps
    );
    registerWorktreeSetupSteps("acme", { pluginName: "Acme", pluginVersion: "1.0.0" }, [
      { id: "db", label: "Provision DB", timeoutMs: 5_000 },
    ]);
  });

  afterEach(() => {
    clearWorktreeSetupStepRegistry();
    vi.useRealTimers();
  });

  async function answerTo(id: string): Promise<WorkspaceHostRequest> {
    await vi.waitFor(() => expect(sent.some((r) => "setupRequestId" in r)).toBe(true));
    const reply = sent.find((r) => "setupRequestId" in r && r.setupRequestId === id);
    if (!reply) throw new Error(`no answer to ${id}`);
    return reply;
  }

  it("lists the steps visible to the host's own project", async () => {
    server.handleList("list-1");

    expect(await answerTo("list-1")).toEqual({
      type: "worktree-setup:result",
      setupRequestId: "list-1",
      ok: true,
      value: [DB],
    });
    expect(deps.resolveProjectId).toHaveBeenCalledWith("/repo");
    // The project's own plugins are waited for, so a list is not a load-time blank.
    expect(deps.whenPluginsLoaded).toHaveBeenCalledWith("project-1");
    expect(deps.filterForProject).toHaveBeenCalledWith(expect.any(Array), "project-1");
  });

  it("runs the handler with the worktree and project, and reports success", async () => {
    const handler = vi.fn(async (_context: PluginWorktreeSetupStepContext) => undefined);
    registerWorktreeSetupStepHandler("acme", "db", handler);

    server.handleRun("run-1", DB, TARGET);

    expect(await answerTo("run-1")).toMatchObject({ ok: true, value: { state: "succeeded" } });
    expect(deps.activatePlugin).toHaveBeenCalledWith("acme");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", ...TARGET, signal: expect.any(Object) })
    );
  });

  it("reports a handler that throws as a failure carrying its message", async () => {
    registerWorktreeSetupStepHandler("acme", "db", async () => {
      throw new Error("quota exceeded");
    });

    server.handleRun("run-2", DB, TARGET);

    expect(await answerTo("run-2")).toMatchObject({
      ok: true,
      value: { state: "failed", error: "quota exceeded" },
    });
  });

  it("skips a step whose plugin is not loaded for the project", async () => {
    vi.mocked(deps.filterForProject).mockResolvedValue([]);

    server.handleRun("run-3", DB, TARGET);

    expect(await answerTo("run-3")).toMatchObject({ ok: true, value: { state: "skipped" } });
    expect(deps.activatePlugin).not.toHaveBeenCalled();
  });

  it("skips a step whose plugin activated without binding a handler", async () => {
    server.handleRun("run-4", DB, TARGET);

    expect(await answerTo("run-4")).toMatchObject({ ok: true, value: { state: "skipped" } });
    expect(deps.activatePlugin).toHaveBeenCalledWith("acme");
  });

  it("skips a step whose plugin failed to activate, even with a handler still bound", async () => {
    const handler = vi.fn();
    registerWorktreeSetupStepHandler("acme", "db", handler);
    vi.mocked(deps.isPluginActivated).mockReturnValue(false);

    server.handleRun("run-4b", DB, TARGET);

    expect(await answerTo("run-4b")).toMatchObject({
      ok: true,
      value: { state: "skipped", error: "the plugin didn't start" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not run a handler whose plugin was replaced by a new version while activating", async () => {
    const stale = vi.fn();
    registerWorktreeSetupStepHandler("acme", "db", stale);
    vi.mocked(deps.activatePlugin).mockImplementation(async () => {
      registerWorktreeSetupSteps("acme", { pluginName: "Acme", pluginVersion: "2.0.0" }, [
        { id: "db", label: "Provision DB", timeoutMs: 5_000 },
      ]);
    });

    server.handleRun("run-4c", DB, TARGET);

    expect(await answerTo("run-4c")).toMatchObject({ ok: true, value: { state: "failed" } });
    expect(stale).not.toHaveBeenCalled();
  });

  it("refuses a step whose declaration changed since the host listed it", async () => {
    const handler = vi.fn();
    registerWorktreeSetupStepHandler("acme", "db", handler);

    server.handleRun("run-5", { ...DB, pluginVersion: "0.9.0" }, TARGET);

    expect(await answerTo("run-5")).toMatchObject({ ok: true, value: { state: "failed" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("times a step out at its declared timeout and aborts its signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    registerWorktreeSetupStepHandler("acme", "db", (context) => {
      signal = context.signal;
      return new Promise<void>(() => {});
    });

    server.handleRun("run-6", DB, TARGET);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await answerTo("run-6")).toMatchObject({ ok: true, value: { state: "timed-out" } });
    expect(signal?.aborted).toBe(true);
  });

  it("aborts a cancelled step's signal and sends no answer", async () => {
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    registerWorktreeSetupStepHandler("acme", "db", (context) => {
      signal = context.signal;
      return new Promise<void>((resolve) => (finish = resolve));
    });

    server.handleRun("run-7", DB, TARGET);
    await vi.waitFor(() => expect(signal).toBeDefined());
    server.handleCancel("run-7");
    finish();
    await new Promise((resolve) => setImmediate(resolve));

    expect(signal?.aborted).toBe(true);
    expect(sent).toEqual([]);
  });

  it("aborts every running step when the host goes away", async () => {
    let signal: AbortSignal | undefined;
    registerWorktreeSetupStepHandler("acme", "db", (context) => {
      signal = context.signal;
      return new Promise<void>(() => {});
    });

    server.handleRun("run-8", DB, TARGET);
    await vi.waitFor(() => expect(signal).toBeDefined());
    server.abortAll();

    expect(signal?.aborted).toBe(true);
  });
});

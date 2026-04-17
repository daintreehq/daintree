/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHosts, MockWorkspaceHostProcess } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");

  const mockHosts: any[] = [];

  class MockWorkspaceHostProcess extends EventEmitter {
    projectPath: string;
    private _isReady = false;
    private _isDisposed = false;
    private readyResolve: (() => void) | null = null;
    private readyPromise: Promise<void>;
    private responseHandlers = new Map<string, (result: any) => void>();
    private responseRejects = new Map<string, (error: Error) => void>();

    constructor(projectPath: string) {
      super();
      this.projectPath = projectPath;
      this.readyPromise = new Promise((resolve) => {
        this.readyResolve = resolve;
      });
      mockHosts.push(this);
    }

    waitForReady(): Promise<void> {
      return this.readyPromise;
    }

    isReady(): boolean {
      return this._isReady && !this._isDisposed;
    }

    generateRequestId(): string {
      return `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    }

    send = vi.fn(() => true);

    sendWithResponse = vi.fn(<T>(request: { requestId: string; type: string }): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        this.responseHandlers.set(request.requestId, resolve);
        this.responseRejects.set(request.requestId, reject);
      });
    });

    pauseHealthCheck = vi.fn();
    resumeHealthCheck = vi.fn();
    dispose = vi.fn(() => {
      this._isDisposed = true;
    });

    simulateReady(): void {
      this._isReady = true;
      if (this.readyResolve) {
        this.readyResolve();
        this.readyResolve = null;
      }
    }

    /** Reset the ready promise to simulate a restart that hasn't completed yet. */
    resetReady(): void {
      this._isReady = false;
      this.readyPromise = new Promise((resolve) => {
        this.readyResolve = resolve;
      });
    }

    resolveRequest(requestId: string, result: any = {}): void {
      const handler = this.responseHandlers.get(requestId);
      if (handler) {
        this.responseHandlers.delete(requestId);
        handler(result);
      }
    }

    rejectRequest(requestId: string, error: Error): void {
      const handler = this.responseRejects.get(requestId);
      if (handler) {
        this.responseRejects.delete(requestId);
        this.responseHandlers.delete(requestId);
        handler(error);
      }
    }

    getLastRequest(): { requestId: string; type: string; [key: string]: any } | undefined {
      const calls = this.sendWithResponse.mock.calls;
      if (calls.length === 0) return undefined;
      return calls[calls.length - 1][0] as any;
    }

    getAllRequests(): Array<{ requestId: string; type: string; [key: string]: any }> {
      return this.sendWithResponse.mock.calls.map(([req]: any) => req);
    }

    attachRendererPort = vi.fn(() => true);
  }

  return { mockHosts, MockWorkspaceHostProcess };
});

vi.mock("../WorkspaceHostProcess.js", () => ({
  WorkspaceHostProcess: MockWorkspaceHostProcess,
}));

vi.mock("electron", () => {
  class MockMessageChannelMain {
    port1 = { close: vi.fn() };
    port2 = { close: vi.fn() };
  }
  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
    },
    MessageChannelMain: MockMessageChannelMain,
  };
});

vi.mock("../events.js", () => ({
  events: { emit: vi.fn() },
}));

import { WorkspaceClient } from "../WorkspaceClient.js";

type MockHost = InstanceType<typeof MockWorkspaceHostProcess>;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("WorkspaceClient.waitForReady after host restart", () => {
  let client: WorkspaceClient;

  beforeEach(() => {
    mockHosts.length = 0;
    client = new WorkspaceClient({
      maxRestartAttempts: 3,
      showCrashDialog: false,
      healthCheckIntervalMs: 1000,
    });
  });

  afterEach(() => {
    client.dispose();
  });

  function h(index: number): MockHost {
    return mockHosts[index];
  }

  async function loadAndReady(projectPath: string, windowId: number): Promise<void> {
    const load = client.loadProject(projectPath, windowId);
    h(mockHosts.length - 1).simulateReady();
    await tick();
    const req = h(mockHosts.length - 1).getLastRequest()!;
    h(mockHosts.length - 1).resolveRequest(req.requestId);
    await load;
  }

  it("resolves immediately when no entries exist", async () => {
    await expect(client.waitForReady()).resolves.toBeUndefined();
  });

  it("resolves immediately once initial loadProject has completed", async () => {
    await loadAndReady("/project-a", 1);
    await expect(client.waitForReady()).resolves.toBeUndefined();
  });

  it("blocks until the post-restart load-project completes", async () => {
    await loadAndReady("/project-a", 1);

    // Simulate crash + restart: reset the host's ready promise so the reload
    // has to actually wait, then emit the restart event.
    h(0).resetReady();
    h(0).emit("restarted");
    await tick();

    let resolved = false;
    const waitPromise = client.waitForReady().then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(false);

    // Host becomes ready, but `reloadProjectAfterRestart` still has to await
    // its load-project response — `waitForReady` must block on that too.
    h(0).simulateReady();
    await tick();
    expect(resolved).toBe(false);

    // Find the post-restart load-project request and resolve it.
    const loadProjectReqs = h(0)
      .getAllRequests()
      .filter((r: any) => r.type === "load-project");
    expect(loadProjectReqs.length).toBe(2);
    h(0).resolveRequest(loadProjectReqs[1].requestId);

    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("does not hang forever if the post-restart load-project fails", async () => {
    await loadAndReady("/project-a", 1);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    h(0).resetReady();
    h(0).emit("restarted");
    await tick();
    h(0).simulateReady();
    await tick();

    const loadProjectReqs = h(0)
      .getAllRequests()
      .filter((r: any) => r.type === "load-project");
    h(0).rejectRequest(loadProjectReqs[1].requestId, new Error("reload failed"));

    await expect(client.waitForReady()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to reload project after host restart"),
      expect.any(Error)
    );
    consoleError.mockRestore();
  });
});

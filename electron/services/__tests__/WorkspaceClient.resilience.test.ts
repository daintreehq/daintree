import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const forkMock = vi.hoisted(() => vi.fn());
const getAllWindowsMock = vi.hoisted(() => vi.fn(() => []));
const showMessageBoxMock = vi.hoisted(() => vi.fn().mockResolvedValue({ response: 0 }));

class MockUtilityProcess extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn();
}

vi.mock("electron", () => ({
  utilityProcess: {
    fork: forkMock,
  },
  UtilityProcess: class {},
  dialog: {
    showMessageBox: showMessageBoxMock,
  },
  app: {
    getPath: vi.fn(() => "/tmp"),
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

vi.mock("../github/GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => undefined),
  },
}));

import { WorkspaceClient } from "../WorkspaceClient.js";

describe("WorkspaceClient resilience", () => {
  let client: WorkspaceClient;
  let child: MockUtilityProcess;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    child = new MockUtilityProcess();
    forkMock.mockReturnValue(child);

    client = new WorkspaceClient({
      maxRestartAttempts: 0,
      showCrashDialog: false,
      healthCheckIntervalMs: 1000,
    });

    void client.waitForReady().catch(() => {
      // ignore host-ready failures for resilience tests
    });
  });

  afterEach(() => {
    client.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("rejects immediately when host is not running", async () => {
    child.emit("exit", 1);

    await expect(client.listBranches("/repo")).rejects.toThrow("Workspace Host not running");
    expect(
      (client as never as { pendingRequests: Map<string, unknown> }).pendingRequests.size
    ).toBe(0);
  });

  it("cleans up pending request when postMessage throws", async () => {
    child.postMessage.mockImplementation((request: { type?: string }) => {
      if (request?.type === "dispose") {
        return;
      }
      throw new Error("post failed");
    });

    await expect(client.listBranches("/repo")).rejects.toThrow("post failed");
    expect(
      (client as never as { pendingRequests: Map<string, unknown> }).pendingRequests.size
    ).toBe(0);
  });

  it("rejects waitForReady when disposed before ready", async () => {
    const readyPromise = client.waitForReady();

    client.dispose();

    await expect(readyPromise).rejects.toThrow("disposed");
  });

  it("resumes health checks after ready when resumed before host initialization completes", async () => {
    client.pauseHealthCheck();
    client.resumeHealthCheck();

    child.emit("message", { type: "ready" });
    child.postMessage.mockClear();

    vi.advanceTimersByTime(1001);

    expect(
      child.postMessage.mock.calls.some(
        ([request]) => (request as { type?: string })?.type === "health-check"
      )
    ).toBe(true);
  });

  it("swallows child kill errors during dispose", () => {
    const badChild = child;
    badChild.kill.mockImplementation(() => {
      throw new Error("kill failed");
    });

    expect(() => client.dispose()).not.toThrow();
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it("times out stalled requests and clears pending state", async () => {
    const request = client.listBranches("/repo");

    vi.advanceTimersByTime(30001);

    await expect(request).rejects.toThrow("Request timeout");
    expect(
      (client as never as { pendingRequests: Map<string, unknown> }).pendingRequests.size
    ).toBe(0);
  });
});

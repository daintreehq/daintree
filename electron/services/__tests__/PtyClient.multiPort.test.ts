import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { EventEmitter } from "events";

vi.mock("electron", () => ({
  utilityProcess: {
    fork: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
  },
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

import { utilityProcess } from "electron";

interface MockUtilityProcess extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function createMockPort() {
  return {
    close: vi.fn(),
    start: vi.fn(),
    on: vi.fn(),
    postMessage: vi.fn(),
  };
}

describe("PtyClient multi-port support", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;
  let forkMock: Mock;

  beforeEach(async () => {
    vi.useFakeTimers();

    mockChild = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    vi.resetModules();
    vi.doMock("electron", () => ({
      utilityProcess: {
        fork: vi.fn().mockReturnValue(mockChild),
      },
      dialog: {
        showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
      },
      app: {
        getPath: vi.fn().mockReturnValue("/mock/user/data"),
      },
    }));

    const module = await import("../PtyClient.js");
    PtyClientClass = module.PtyClient;
    forkMock = (await import("electron")).utilityProcess.fork as unknown as Mock;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const createClient = () => {
    const client = new PtyClientClass();
    mockChild.emit("message", { type: "ready" });
    return client;
  };

  it("sends windowId with connect-port message", () => {
    const client = createClient();
    mockChild.postMessage.mockClear();

    const port = createMockPort();
    client.connectMessagePort(1, port as any);

    expect(mockChild.postMessage).toHaveBeenCalledWith({ type: "connect-port", windowId: 1 }, [
      port,
    ]);
  });

  it("connects multiple windows independently", () => {
    const client = createClient();
    mockChild.postMessage.mockClear();

    const port1 = createMockPort();
    const port2 = createMockPort();

    client.connectMessagePort(1, port1 as any);
    client.connectMessagePort(2, port2 as any);

    expect(mockChild.postMessage).toHaveBeenCalledTimes(2);
    expect(mockChild.postMessage).toHaveBeenCalledWith({ type: "connect-port", windowId: 1 }, [
      port1,
    ]);
    expect(mockChild.postMessage).toHaveBeenCalledWith({ type: "connect-port", windowId: 2 }, [
      port2,
    ]);
  });

  it("sends windowId with set-active-project", () => {
    const client = createClient();
    mockChild.postMessage.mockClear();

    client.setActiveProject(1, "project-a");

    expect(mockChild.postMessage).toHaveBeenCalledWith({
      type: "set-active-project",
      windowId: 1,
      projectId: "project-a",
    });
  });

  it("sends windowId with project-switch", () => {
    const client = createClient();
    mockChild.postMessage.mockClear();

    client.onProjectSwitch(1, "project-b");

    expect(mockChild.postMessage).toHaveBeenCalledWith({
      type: "project-switch",
      windowId: 1,
      projectId: "project-b",
    });
  });

  it("sends disconnect-port message", () => {
    const client = createClient();
    mockChild.postMessage.mockClear();

    client.disconnectMessagePort(1);

    expect(mockChild.postMessage).toHaveBeenCalledWith({
      type: "disconnect-port",
      windowId: 1,
    });
  });

  it("replays per-window project contexts after host restart", () => {
    const client = createClient();
    client.setActiveProject(1, "project-a");
    client.onProjectSwitch(2, "project-b");

    // Simulate host crash and restart
    const newChild = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    forkMock.mockReturnValue(newChild);

    // Install port refresh callback (normally done in windowServices.ts)
    client.setPortRefreshCallback(() => {
      // In production this recreates ports for all windows
    });

    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(2000);

    // New host becomes ready
    newChild.emit("message", { type: "ready" });

    // Should replay both windows' project contexts
    const setActiveCalls = newChild.postMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as any)?.type === "set-active-project"
    );
    const switchCalls = newChild.postMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as any)?.type === "project-switch"
    );

    expect(setActiveCalls.length).toBe(1);
    expect(setActiveCalls[0][0]).toMatchObject({
      type: "set-active-project",
      windowId: 1,
      projectId: "project-a",
    });
    expect(switchCalls.length).toBe(1);
    expect(switchCalls[0][0]).toMatchObject({
      type: "project-switch",
      windowId: 2,
      projectId: "project-b",
    });
  });

  it("disconnectMessagePort clears window project context", () => {
    const client = createClient();
    client.setActiveProject(1, "project-a");
    client.onProjectSwitch(2, "project-b");

    // Disconnect window 1
    client.disconnectMessagePort(1);

    // Simulate host crash and restart
    const newChild = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    forkMock.mockReturnValue(newChild);
    client.setPortRefreshCallback(() => {});

    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(2000);
    newChild.emit("message", { type: "ready" });

    // Should only replay window 2's context, not window 1
    const setActiveCalls = newChild.postMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as any)?.type === "set-active-project"
    );
    const switchCalls = newChild.postMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as any)?.type === "project-switch"
    );

    expect(setActiveCalls.length).toBe(0);
    expect(switchCalls.length).toBe(1);
    expect(switchCalls[0][0]).toMatchObject({
      type: "project-switch",
      windowId: 2,
      projectId: "project-b",
    });
  });
});

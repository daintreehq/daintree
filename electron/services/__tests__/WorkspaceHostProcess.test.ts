/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "node:stream";

const { forkMock, mockChildren, loggerCalls } = vi.hoisted(() => {
  const forkMock = vi.fn();
  const mockChildren: any[] = [];
  const loggerCalls: { level: "info" | "warn"; message: string }[] = [];
  return { forkMock, mockChildren, loggerCalls };
});

class MockUtilityChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  postMessage = vi.fn();
  kill = vi.fn(() => true);
  pid = 42;

  constructor() {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    mockChildren.push(this);
  }
}

vi.mock("electron", () => ({
  utilityProcess: {
    fork: forkMock,
  },
  app: {
    getPath: vi.fn(() => "/tmp/userData"),
  },
  UtilityProcess: class {},
  MessagePortMain: class {},
}));

vi.mock("../github/GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => null),
  },
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: (name: string) => ({
    name,
    debug: vi.fn(),
    info: (message: string) => loggerCalls.push({ level: "info", message }),
    warn: (message: string) => loggerCalls.push({ level: "warn", message }),
    error: vi.fn(),
  }),
}));

async function loadModule(): Promise<typeof import("../WorkspaceHostProcess.js")> {
  return await import("../WorkspaceHostProcess.js");
}

describe("WorkspaceHostProcess", () => {
  beforeEach(() => {
    vi.resetModules();
    forkMock.mockReset();
    mockChildren.length = 0;
    loggerCalls.length = 0;
    forkMock.mockImplementation(() => new MockUtilityChild());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forks the utility process with stdio:"pipe" to isolate from main process\'s fd 2 (regression guard for #5588)', async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    expect(forkMock).toHaveBeenCalledTimes(1);
    const options = forkMock.mock.calls[0][2];
    expect(options.stdio).toBe("pipe");

    host.dispose();
  });

  it("forwards stdout lines via logger.info with [WorkspaceHost] prefix", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.stdout.emit("data", Buffer.from("hello world\n"));

    const infoMessages = loggerCalls.filter((c) => c.level === "info").map((c) => c.message);
    expect(infoMessages).toContain("[WorkspaceHost] hello world");

    host.dispose();
  });

  it("forwards stderr lines via logger.warn", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.stderr.emit("data", Buffer.from("boom!\n"));

    const warnMessages = loggerCalls.filter((c) => c.level === "warn").map((c) => c.message);
    expect(warnMessages).toContain("[WorkspaceHost] boom!");

    host.dispose();
  });

  it("reassembles lines split across chunks and only emits once complete", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.stdout.emit("data", Buffer.from("partial"));
    const afterFirstChunk = loggerCalls.filter((c) =>
      c.message.startsWith("[WorkspaceHost]")
    ).length;
    expect(afterFirstChunk).toBe(0);

    child.stdout.emit("data", Buffer.from(" line\n"));
    const infoMessages = loggerCalls.filter((c) => c.level === "info").map((c) => c.message);
    expect(infoMessages).toContain("[WorkspaceHost] partial line");

    host.dispose();
  });

  it("flushes partial (unterminated) line buffer on host exit", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    child.stderr.emit("data", Buffer.from("partial crash trace"));

    const beforeExit = loggerCalls.filter((c) => c.message.startsWith("[WorkspaceHost]")).length;
    expect(beforeExit).toBe(0);

    child.emit("exit", 137);
    const warnMessages = loggerCalls.filter((c) => c.level === "warn").map((c) => c.message);
    expect(warnMessages).toContain("[WorkspaceHost] partial crash trace");

    host.dispose();
  });

  it("does not throw when Readable streams emit 'error' events (post-exit pipe I/O)", async () => {
    const { WorkspaceHostProcess } = await loadModule();
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});

    const child = mockChildren[0] as MockUtilityChild;
    // Without an "error" listener Node would throw; we've added a silencer.
    expect(() => child.stdout.emit("error", new Error("pipe gone"))).not.toThrow();
    expect(() => child.stderr.emit("error", new Error("pipe gone"))).not.toThrow();

    host.dispose();
  });
});

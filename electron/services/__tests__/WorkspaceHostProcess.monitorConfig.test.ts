/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "node:stream";

const { forkMock, mockChildren, appMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const forkMock = vi.fn();
  const mockChildren: any[] = [];
  const appEmitter = new EventEmitter();
  const appMock = Object.assign(appEmitter, {
    getPath: vi.fn(() => "/tmp/userData"),
  });
  return { forkMock, mockChildren, appMock };
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
  app: appMock,
  UtilityProcess: class {},
  MessagePortMain: class {},
}));

vi.mock("../github/GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => null),
  },
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  ingestHostLogEvent: vi.fn(),
}));

function monitorConfigsSentTo(child: MockUtilityChild): unknown[] {
  return child.postMessage.mock.calls
    .map(([msg]) => msg as { type?: string; config?: unknown })
    .filter((msg) => msg?.type === "update-monitor-config")
    .map((msg) => msg.config);
}

function policiesSentTo(child: MockUtilityChild): unknown[] {
  return child.postMessage.mock.calls
    .map(([msg]) => msg as { type?: string; policy?: unknown })
    .filter((msg) => msg?.type === "set-workspace-power-policy")
    .map((msg) => msg.policy);
}

const DEEP_POLICY = {
  statusAllowed: false,
  backgroundWorkAllowed: false,
  attenuated: true,
};

describe("WorkspaceHostProcess — monitor-config relay", () => {
  beforeEach(() => {
    vi.resetModules();
    forkMock.mockReset();
    mockChildren.length = 0;
    appMock.removeAllListeners();
    forkMock.mockImplementation(() => new MockUtilityChild());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createHost() {
    const { WorkspaceHostProcess } = await import("../WorkspaceHostProcess.js");
    const host = new WorkspaceHostProcess("/tmp/project", {
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
    } as any);
    host.waitForReady().catch(() => {});
    return host;
  }

  it("replays nothing on ready when no config was ever pushed", async () => {
    const host = await createHost();
    const child = mockChildren[0] as MockUtilityChild;

    child.emit("message", { type: "ready" });

    expect(monitorConfigsSentTo(child)).toEqual([]);
    host.dispose();
  });

  it("caches a config pushed before ready and replays it on ready", async () => {
    const host = await createHost();
    const child = mockChildren[0] as MockUtilityChild;

    host.updateMonitorConfig({ pollIntervalActive: 4000, pollIntervalBackground: 20000 });
    expect(monitorConfigsSentTo(child)).toEqual([]);

    child.emit("message", { type: "ready" });
    expect(monitorConfigsSentTo(child)).toEqual([
      { pollIntervalActive: 4000, pollIntervalBackground: 20000 },
    ]);
    host.dispose();
  });

  it("merges partial pushes and replays the merged config to the NEW child after restart", async () => {
    const host = await createHost();
    const firstChild = mockChildren[0] as MockUtilityChild;

    firstChild.emit("message", { type: "ready" });
    host.updateMonitorConfig({
      pollIntervalActive: 4000,
      pollIntervalBackground: 20000,
      backgroundGitWatcherCap: 6,
    });
    // A later partial push (focus throttle) must not erase the earlier fields.
    host.updateMonitorConfig({ pollIntervalActive: 20000, pollIntervalBackground: 100000 });

    firstChild.emit("exit", 1);
    host.manualRestart();
    expect(mockChildren).toHaveLength(2);
    const secondChild = mockChildren[1] as MockUtilityChild;

    secondChild.emit("message", { type: "ready" });

    expect(monitorConfigsSentTo(secondChild)).toEqual([
      {
        pollIntervalActive: 20000,
        pollIntervalBackground: 100000,
        backgroundGitWatcherCap: 6,
      },
    ]);
    host.dispose();
  });

  it("replays the workspace power policy to the NEW child after restart", async () => {
    const host = await createHost();
    const firstChild = mockChildren[0] as MockUtilityChild;
    firstChild.emit("message", { type: "ready" });

    // Screen locked, say. Without the replay a host that crashes and restarts
    // behind that lock comes back watching and fetching at full permission,
    // and stays there until the next policy change happens to fire.
    host.setWorkspacePowerPolicy(DEEP_POLICY, true);
    expect(policiesSentTo(firstChild)).toEqual([DEEP_POLICY]);

    firstChild.emit("exit", 1);
    host.manualRestart();
    const secondChild = mockChildren[1] as MockUtilityChild;
    secondChild.emit("message", { type: "ready" });

    expect(policiesSentTo(secondChild)).toEqual([DEEP_POLICY]);
    host.dispose();
  });

  it("caches an undelivered policy so a dormant host restarts holding it", async () => {
    const host = await createHost();
    const firstChild = mockChildren[0] as MockUtilityChild;
    firstChild.emit("message", { type: "ready" });

    // A grant skipped for this host (dormant, kept behind a cached view) is
    // still the policy in force — the restart has to honour it.
    host.setWorkspacePowerPolicy(DEEP_POLICY, false);
    expect(policiesSentTo(firstChild)).toEqual([]);

    firstChild.emit("exit", 1);
    host.manualRestart();
    const secondChild = mockChildren[1] as MockUtilityChild;
    secondChild.emit("message", { type: "ready" });

    expect(policiesSentTo(secondChild)).toEqual([DEEP_POLICY]);
    host.dispose();
  });
});

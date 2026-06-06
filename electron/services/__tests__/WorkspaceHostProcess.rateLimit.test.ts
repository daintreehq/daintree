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
}));

function throttleMultipliersSentTo(child: MockUtilityChild): number[] {
  return child.postMessage.mock.calls
    .map(([msg]) => msg as { type?: string; multiplier?: number })
    .filter((msg) => msg?.type === "apply-fetch-throttle")
    .map((msg) => msg.multiplier as number);
}

describe("WorkspaceHostProcess — fetch-throttle relay", () => {
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
    // Swallow the ready-promise rejection that fires on dispose before ready
    host.waitForReady().catch(() => {});
    return host;
  }

  it("replays the default multiplier on ready when none was relayed", async () => {
    const host = await createHost();
    const child = mockChildren[0] as MockUtilityChild;

    child.emit("message", { type: "ready" });

    expect(throttleMultipliersSentTo(child)).toEqual([1]);
    host.dispose();
  });

  it("caches a multiplier relayed before ready and replays it on ready", async () => {
    const host = await createHost();
    const child = mockChildren[0] as MockUtilityChild;

    host.relayFetchThrottle(3);
    // Not initialized yet — the value is cached, nothing is sent.
    expect(throttleMultipliersSentTo(child)).toEqual([]);

    child.emit("message", { type: "ready" });
    expect(throttleMultipliersSentTo(child)).toEqual([3]);
    host.dispose();
  });

  it("sends immediately once initialized and replays the latest value on every subsequent ready", async () => {
    const host = await createHost();
    const child = mockChildren[0] as MockUtilityChild;

    child.emit("message", { type: "ready" });
    host.relayFetchThrottle(5);
    expect(throttleMultipliersSentTo(child)).toEqual([1, 5]);

    // A host restart re-runs the ready handshake — the cached multiplier must
    // be replayed so the restarted host doesn't run unthrottled.
    child.emit("message", { type: "ready" });
    expect(throttleMultipliersSentTo(child)).toEqual([1, 5, 5]);
    host.dispose();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

interface MockUtilityProcess extends EventEmitter {
  pid: number | undefined;
  postMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

describe("PtyClient.getHostPidForWindow", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;

  beforeEach(async () => {
    mockChild = Object.assign(new EventEmitter(), {
      pid: 4242 as number | undefined,
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    vi.resetModules();
    vi.doMock("electron", () => ({
      utilityProcess: { fork: vi.fn().mockReturnValue(mockChild) },
      dialog: { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) },
      app: {
        getPath: vi.fn().mockReturnValue("/mock/user/data"),
        on: vi.fn(),
        off: vi.fn(),
      },
    }));

    PtyClientClass = (await import("../PtyClient.js")).PtyClient;
    // Install after imports: fake timers can stall module re-execution (#11661).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns null before the host is forked", () => {
    const client = new PtyClientClass({ deferStart: true });
    expect(client.getHostPidForWindow(1)).toBeNull();
    client.dispose();
  });

  it("returns the forked host's pid for any window on the default shard", () => {
    const client = new PtyClientClass({ deferStart: true });
    client.start();
    expect(client.getHostPidForWindow(1)).toBe(4242);
    expect(client.getHostPidForWindow(99)).toBe(4242);
    client.dispose();
  });

  it("returns null when the forked process has no pid yet", () => {
    mockChild.pid = undefined;
    const client = new PtyClientClass({ deferStart: true });
    client.start();
    expect(client.getHostPidForWindow(1)).toBeNull();
    client.dispose();
  });

  it("returns null once the host has exited", () => {
    const client = new PtyClientClass({ deferStart: true });
    client.start();
    mockChild.emit("exit", 1);
    expect(client.getHostPidForWindow(1)).toBeNull();
    client.dispose();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { EventEmitter } from "events";

// Mock Electron modules before importing PtyClient (mirrors PtyClient.handshake.test.ts).
vi.mock("electron", () => ({
  utilityProcess: {
    fork: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
  },
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

import { utilityProcess } from "electron";

interface MockUtilityProcess extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

/**
 * #8827: the app boot path constructs PtyClient with `deferStart: true` so the
 * PTY host fork no longer blocks the first renderer load. The fork is triggered
 * later by `start()`, after the early PATH refresh resolves. These tests pin
 * that contract: deferStart skips the constructor fork, `start()` forks exactly
 * once, and the default (non-deferred) path keeps forking in the constructor.
 */
describe("PtyClient deferStart", () => {
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

    (utilityProcess.fork as Mock).mockReturnValue(mockChild);

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
        on: vi.fn(),
        off: vi.fn(),
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

  it("does not fork the host in the constructor when deferStart is true", () => {
    const client = new PtyClientClass({ deferStart: true });

    expect(forkMock).not.toHaveBeenCalled();
    expect(client.isHostStarted()).toBe(false);

    client.dispose();
  });

  it("forks the host exactly once when start() is called after a deferred construction", () => {
    const client = new PtyClientClass({ deferStart: true });
    expect(forkMock).not.toHaveBeenCalled();

    client.start();

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(client.isHostStarted()).toBe(true);

    client.dispose();
  });

  it("treats a second start() call as a no-op (idempotent)", () => {
    const client = new PtyClientClass({ deferStart: true });

    client.start();
    client.start();
    client.start();

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(client.isHostStarted()).toBe(true);

    client.dispose();
  });

  it("forks in the constructor when deferStart is unset (default behavior)", () => {
    const client = new PtyClientClass();

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(client.isHostStarted()).toBe(true);

    client.dispose();
  });
});

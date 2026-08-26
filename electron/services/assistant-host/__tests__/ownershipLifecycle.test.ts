import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * Nothing survives the loss of its owner.
 *
 * The cleanup methods existed before this suite and had no callers outside the service
 * itself — the only path that reached them was lazy, from `deliver()`, when an event
 * happened to be sent into a view that had already gone. So an engine that was simply
 * QUIET was never reaped at all: it sat holding its project's state lease, invisible,
 * until the next launch waited on a lease held by nothing anyone could see.
 *
 * These are the four ways an owner disappears — the renderer unmounts, the view is
 * evicted or crashes, the window closes, the app quits — plus the property that makes
 * the difference visible: a project can be started again immediately afterwards.
 */

interface StartedHost {
  disposed: boolean;
  exitedAfter: number | null;
  /** Releases this host's `waitForExit`, so a test can hold shutdown open. */
  release: () => void;
}

const hosts: StartedHost[] = [];
/** When true, `waitForExit` hangs until the test releases it. */
let deferExits = false;

vi.mock("../AssistantHostProcess.js", () => ({
  AssistantHostProcess: class {
    private readonly record: StartedHost = {
      disposed: false,
      exitedAfter: null,
      release: () => {},
    };
    constructor() {
      hosts.push(this.record);
    }
    start() {}
    waitForReady() {
      return Promise.resolve();
    }
    getReadyEvent() {
      return null;
    }
    takePreReadyEvents() {
      return [];
    }
    dispose() {
      this.record.disposed = true;
    }
    waitForExit(timeoutMs: number) {
      this.record.exitedAfter = timeoutMs;
      if (!deferExits) return Promise.resolve();
      return new Promise<void>((resolve) => {
        this.record.release = resolve;
      });
    }
  },
}));

/**
 * Pin the platform for the whole file.
 *
 * `start()` refuses a platform the engine's project lock has no port for, and the unit
 * suite runs natively on a Windows release runner — so without this, every ordinary
 * lifecycle assertion below would be refused there for a reason that has nothing to do
 * with what it is testing. The refusal has its own test, which supplies `win32` itself.
 */
const REAL_PLATFORM = process.platform;
beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

vi.mock("../resolveAssistantBinary.js", () => ({
  ASSISTANT_BIN_ENV: "DAINTREE_ASSISTANT_BIN",
  resolveAssistantBinary: () =>
    Promise.resolve({ path: "/nonexistent/daintree-assistant", source: "repo" }),
}));

/**
 * Spied, and asserted NOT to have been called.
 *
 * `deliver()` reaps a session lazily when it tries to send into a dead view — the only
 * path that reached this cleanup before it was wired up, and the reason a QUIET engine
 * was never reaped at all. These tests must prove the direct paths, so the lazy one is
 * held to zero: without this, a later change to the host mock that started emitting
 * events could quietly start satisfying every assertion below for the old reason.
 */
const fromId = vi.fn(() => undefined);

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-lifecycle-test" },
  webContents: { fromId: () => fromId() },
}));

vi.mock("../../../ipc/handlers/helpAssistant.js", () => ({
  getHelpAssistantSettings: () => ({ tier: "action" }),
}));

vi.mock("../../HelpSessionService.js", () => ({
  helpSessionService: {
    provisionSession: () =>
      Promise.resolve({
        sessionId: "help_1",
        sessionPath: "/tmp/help_1",
        token: "tok",
        tier: "action",
        mcpUrl: "http://127.0.0.1:1/mcp",
        windowId: 1,
      }),
    markEngineSession: () => true,
    getDebugLoggingPreference: () => false,
    getDebugLogging: () => false,
    getBypassPermissions: () => false,
    revokeSession: () => Promise.resolve(),
  },
}));

const { AssistantHostService } = await import("../AssistantHostService.js");

interface Owner {
  projectId: string;
  webContentsId: number;
  windowId: number;
}

async function serviceWith(owners: Owner[]) {
  hosts.length = 0;
  const service = new AssistantHostService();
  const sessions: string[] = [];
  for (const owner of owners) {
    const { sessionId } = await service.start({
      projectId: owner.projectId,
      cwd: `/tmp/${owner.projectId}`,
      webContentsId: owner.webContentsId,
      windowId: owner.windowId,
    });
    sessions.push(sessionId);
  }
  return { service, sessions };
}

/**
 * Drains the microtask queue.
 *
 * `shutdown()` crosses several awaits before it reaches the wait-for-exit pass — it
 * stops the live sessions, races the start queue against a bound, then sweeps again —
 * so a single `await Promise.resolve()` lands mid-sequence and reads as "not started
 * yet" rather than "not finished". A macrotask boundary drains everything queued behind
 * it, which is deterministic here because everything in between is microtasks.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const VIEW_A: Owner = { projectId: "p1", webContentsId: 7, windowId: 1 };
const VIEW_B: Owner = { projectId: "p2", webContentsId: 8, windowId: 2 };

describe("assistant host ownership lifecycle", () => {
  beforeEach(() => {
    hosts.length = 0;
    deferExits = false;
    fromId.mockClear();
  });

  afterEach(() => {
    // Nothing below may have gone through the lazy dead-view reap.
    expect(fromId).not.toHaveBeenCalled();
  });

  it("refuses to start where the engine cannot take its project lease", async () => {
    // Windows. The engine's lock has no port there and the lease is taken on the way in,
    // so spawning produces a child that dies at boot reporting a Makefile target no
    // install ships. Refusing here means the caller gets the real reason instead.
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      hosts.length = 0;
      const service = new AssistantHostService();
      await expect(
        service.start({ projectId: "p1", cwd: "/tmp/p1", webContentsId: 7, windowId: 1 })
      ).rejects.toThrow(/Windows/i);
      expect(hosts).toHaveLength(0);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  it("stops only the sessions the lost view owned", async () => {
    const { service } = await serviceWith([VIEW_A, VIEW_B]);

    service.stopByWebContents(VIEW_A.webContentsId);

    // The blast radius is the point. A view going away must not take another
    // project's live conversation with it.
    expect(hosts[0].disposed).toBe(true);
    expect(hosts[1].disposed).toBe(false);
  });

  it("stops only the sessions the closing window owned", async () => {
    // Window ids are REUSED, so this cleanup has to run while the window is being
    // unregistered — after that the id names somebody else and the session is
    // unreachable by any owner at all.
    const { service } = await serviceWith([VIEW_A, VIEW_B]);

    service.stopByWindow(VIEW_A.windowId);

    expect(hosts[0].disposed).toBe(true);
    expect(hosts[1].disposed).toBe(false);
  });

  it("keeps a stopped engine reachable until its process is really gone", async () => {
    // The bug this whole phase is about, in its purest form. `stop()` removes the
    // session from both maps at once, while the engine is still draining behind an
    // unref'd kill timer that `app.exit()` will discard. A teardown that looked only at
    // the live sessions could not see it, so an engine displaced or evicted moments
    // before quit was orphaned — still holding its project's state lease, invisible.
    //
    // Deliberately NOT written as "stop, then start again and check it works": a fresh
    // start displaces the project's session anyway, so that version passes with the
    // cleanup removed entirely.
    deferExits = true;
    const { service } = await serviceWith([VIEW_A]);
    service.stopByWebContents(VIEW_A.webContentsId);
    expect(hosts[0].disposed).toBe(true);

    let settled = false;
    const done = service.shutdown(10).then(() => {
      settled = true;
    });
    await flush();

    // Shutdown is waiting on the engine it can no longer find by session id.
    expect(settled).toBe(false);
    expect(hosts[0].exitedAfter).toBe(10);
    hosts[0].release();
    await done;
    expect(settled).toBe(true);
  });

  describe("shutdown", () => {
    it("stays pending until every child has actually exited", async () => {
      // `dispose` arms an UNREF'D kill backstop, which is right while the app runs and
      // worthless at quit: `app.exit()` takes the timer with it, and a spawned child is
      // not reaped with its parent. So shutdown has to still be HERE when the killing
      // happens — which means asserting it waits, not merely that it asked. A
      // fire-and-forget implementation calls exactly the same methods.
      deferExits = true;
      const { service } = await serviceWith([VIEW_A, VIEW_B]);

      let settled = false;
      const done = service.shutdown(1234).then(() => {
        settled = true;
      });
      await flush();

      for (const host of hosts) {
        expect(host.disposed).toBe(true);
        expect(host.exitedAfter).toBe(1234);
      }
      expect(settled).toBe(false);

      // One is not enough — the wait is for ALL of them.
      hosts[0].release();
      await flush();
      expect(settled).toBe(false);

      hosts[1].release();
      await done;
      expect(settled).toBe(true);
    });

    it("refuses a start that races a shutdown already in progress", async () => {
      // The refusal has to be in force from the FIRST synchronous line of shutdown, not
      // merely after it finishes — a start arriving mid-teardown is the whole point.
      // Otherwise it spawns an engine after the pass that was meant to stop everything,
      // into a process that is about to exit, and the child outlives Daintree holding
      // its project's lease.
      deferExits = true;
      const { service } = await serviceWith([VIEW_A]);
      const spawnedBefore = hosts.length;

      const done = service.shutdown(10);
      await expect(
        service.start({ projectId: "p3", cwd: "/tmp/p3", webContentsId: 10, windowId: 4 })
      ).rejects.toThrow(/shutting down/i);
      expect(hosts).toHaveLength(spawnedBefore);

      hosts[0].release();
      await done;
    });
  });
});

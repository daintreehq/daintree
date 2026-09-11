import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * Which surfaces a live engine cannot afford to lose (#12364).
 *
 * View eviction destroys a cached project view and then runs `stopByWebContents` on it.
 * The native engine never binds a PTY, so the eviction floor that protects PTY
 * assistants never saw it, and every reclaimed view took its conversation along.
 * `wouldEndLiveEngine` is that floor's native half: it has to say yes for exactly the
 * views whose loss ends an engine, and for exactly as long as there is an engine to end.
 */

interface FakeHost {
  disposed: boolean;
  exited: boolean;
  /** Settles the readiness wait while `deferReady` holds it open. */
  ready: { resolve: () => void; reject: (error: Error) => void } | null;
}

const hosts: FakeHost[] = [];
/** When true, `waitForReady` hangs until the test settles it. */
let deferReady = false;
/** Runs inside `host.start()` — the moment the child would be spawned. */
let onSpawn: (() => void) | null = null;

vi.mock("../AssistantHostProcess.js", () => ({
  AssistantHostProcess: class {
    private readonly record: FakeHost = { disposed: false, exited: false, ready: null };
    constructor() {
      hosts.push(this.record);
    }
    start() {
      onSpawn?.();
    }
    waitForReady() {
      if (!deferReady) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        this.record.ready = { resolve, reject };
      });
    }
    getReadyEvent() {
      return null;
    }
    getTranscript() {
      return { events: [], prompts: [], truncated: false };
    }
    getPid() {
      return null;
    }
    takePreReadyEvents() {
      return [];
    }
    hasExited() {
      return this.record.exited;
    }
    dispose() {
      this.record.disposed = true;
    }
    waitForExit() {
      return Promise.resolve();
    }
  },
}));

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

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-eviction-protection-test", isPackaged: false },
  webContents: { fromId: () => ({ isDestroyed: () => false, send: () => {} }) },
}));

vi.mock("../../../ipc/handlers/helpAssistant.js", () => ({
  getHelpAssistantSettings: () => ({ tier: "action" }),
}));

vi.mock("../../HelpSessionService.js", () => ({
  helpSessionService: {
    provisionSession: () =>
      Promise.resolve({
        sessionId: "help_1",
        sessionPath: "/tmp/daintree-eviction-protection-test/help_1",
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

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../utils/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/logger.js")>()),
  createLogger: () => logger,
}));

const { AssistantHostService } = await import("../AssistantHostService.js");

type Service = InstanceType<typeof AssistantHostService>;

function startSurface(service: Service, webContentsId: number, windowId: number, slot?: number) {
  return service.start({ projectId: "p1", cwd: "/tmp/project", webContentsId, windowId, slot });
}

/** A macrotask boundary: every microtask a start chains before its readiness wait has run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  hosts.length = 0;
  deferReady = false;
  onSpawn = null;
  vi.clearAllMocks();
});

describe("which surfaces a live native engine cannot lose (#12364)", () => {
  it("names the view holding the control plane, not a window that joined it", async () => {
    const service = new AssistantHostService();
    await startSurface(service, 10, 1);
    await startSurface(service, 11, 2);

    expect(service.wouldEndLiveEngine(10)).toBe(true);
    // Losing a joiner only detaches it — the engine keeps running for surface 10.
    expect(service.wouldEndLiveEngine(11)).toBe(false);
    expect(service.wouldEndLiveEngine(99)).toBe(false);

    service.stopByWebContents(11);
    expect(hosts[0]?.disposed).toBe(false);
    expect(service.wouldEndLiveEngine(10)).toBe(true);
  });

  it("agrees with what losing each surface actually does", async () => {
    // The floor is only as good as this prediction. Each case asks, then does what
    // eviction does, on a fresh engine — so a change to `detach` the query did not follow
    // fails here instead of in somebody's lost conversation.
    const cases = [
      { surfaces: [10], lose: 10 },
      { surfaces: [10, 11], lose: 10 },
      { surfaces: [10, 11], lose: 11 },
      { surfaces: [10, 11, 12], lose: 12 },
    ];
    for (const { surfaces, lose } of cases) {
      hosts.length = 0;
      const service = new AssistantHostService();
      for (const [index, webContentsId] of surfaces.entries()) {
        await startSurface(service, webContentsId, index + 1);
      }

      const predicted = service.wouldEndLiveEngine(lose);
      service.stopByWebContents(lose);

      expect({ surfaces, lose, ended: hosts[0]?.disposed }).toEqual({
        surfaces,
        lose,
        ended: predicted,
      });
    }
  });

  it("covers the engine from registration, before it is spawned or ready", async () => {
    // The session is registered before the child is spawned, and the readiness wait can
    // run for 90 seconds — long enough for a background view to be reclaimed mid-boot.
    deferReady = true;
    const service = new AssistantHostService();
    let atSpawn: boolean | null = null;
    onSpawn = () => {
      atSpawn = service.wouldEndLiveEngine(10);
    };

    const pending = startSurface(service, 10, 1);
    await flush();

    expect(atSpawn).toBe(true);
    expect(hosts[0]?.ready).not.toBe(null);
    expect(service.wouldEndLiveEngine(10)).toBe(true);

    hosts[0]?.ready?.resolve();
    await pending;
    expect(service.wouldEndLiveEngine(10)).toBe(true);
  });

  it("releases the view once the engine's child has exited", async () => {
    const service = new AssistantHostService();
    await startSurface(service, 10, 1);
    expect(service.wouldEndLiveEngine(10)).toBe(true);

    // Flipped WITHOUT the exit callback that deregisters the session: liveness is read
    // from the child, not inferred from the session still being on file.
    hosts[0]!.exited = true;

    expect(service.wouldEndLiveEngine(10)).toBe(false);
  });

  it("releases the view as soon as the session is stopped, while its child still drains", async () => {
    // `stop` leaves routing and revokes the bearer at once, then gives the child a grace
    // period. There is nothing left to keep alive, so there is nothing to protect.
    const service = new AssistantHostService();
    const { sessionId } = await startSurface(service, 10, 1);

    service.stop(sessionId);

    expect(hosts[0]?.disposed).toBe(true);
    expect(hosts[0]?.exited).toBe(false);
    expect(service.wouldEndLiveEngine(10)).toBe(false);
  });

  it("does not hold a view for a start that failed", async () => {
    deferReady = true;
    const service = new AssistantHostService();
    const pending = startSurface(service, 10, 1);
    await flush();

    hosts[0]?.ready?.reject(new Error("engine never became ready"));

    await expect(pending).rejects.toThrow(/never became ready/);
    expect(service.wouldEndLiveEngine(10)).toBe(false);
  });

  it("keeps each lane's owner to itself", async () => {
    // Lanes of one project run separate engines (#12108), here started from different
    // windows. A dead lane must not borrow its sibling's liveness, nor lend its own.
    const service = new AssistantHostService();
    await startSurface(service, 10, 1, 0);
    await startSurface(service, 20, 2, 1);
    expect(hosts).toHaveLength(2);
    expect(service.wouldEndLiveEngine(10)).toBe(true);
    expect(service.wouldEndLiveEngine(20)).toBe(true);

    hosts[0]!.exited = true;

    expect(service.wouldEndLiveEngine(10)).toBe(false);
    expect(service.wouldEndLiveEngine(20)).toBe(true);
  });

  it("says the control plane left when it did, not that the last surface did", async () => {
    // A provisioner leaving with windows still attached ends the session too, and the log
    // used to follow the right line with the wrong one.
    const messages = () => logger.info.mock.calls.map(([message]) => String(message));
    const logged = (pattern: RegExp) => messages().some((message) => pattern.test(message));

    const shared = new AssistantHostService();
    await startSurface(shared, 10, 1);
    await startSurface(shared, 11, 2);
    logger.info.mockClear();
    shared.stopByWebContents(10);
    expect(logged(/control plane left/)).toBe(true);
    expect(logged(/last surface left/)).toBe(false);

    const solo = new AssistantHostService();
    await startSurface(solo, 20, 3);
    logger.info.mockClear();
    solo.stopByWebContents(20);
    expect(logged(/last surface left/)).toBe(true);
    expect(logged(/control plane left/)).toBe(false);
  });
});

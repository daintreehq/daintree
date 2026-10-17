import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), isPackaged: false, on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  shell: { openExternal: vi.fn() },
  dialog: {},
  session: {},
}));

const crashServiceMock = vi.hoisted(() => ({
  recordCrash: vi.fn(),
  recordRendererGone: vi.fn(),
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => crashServiceMock,
}));

vi.mock("../../utils/openExternal.js", () => ({
  canOpenExternalUrl: vi.fn(() => false),
  openExternalUrl: vi.fn(),
}));

vi.mock("../../ipc/errorHandlers.js", () => ({ notifyError: vi.fn() }));

vi.mock("../rendererConsoleCapture.js", () => ({
  attachRendererConsoleCapture: vi.fn(),
  detachRendererConsoleCapture: vi.fn(),
}));

vi.mock("../ProjectViewEvictionController.js", () => ({
  evictDeadView: vi.fn(),
  getAvailableMemoryMb: vi.fn(() => null),
}));

vi.mock("../powerPolicyDelivery.js", () => ({ deliverPowerPolicy: vi.fn() }));

const loggerMock = vi.hoisted(() => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("../../utils/logger.js", () => loggerMock);

import {
  isWebviewSrcAllowed,
  setRemoteWebviewSrcGate,
  setupViewHandlers,
} from "../ProjectViewHandlers.js";
import type { ProjectViewManager } from "../ProjectViewManager.js";
import type { ViewEntry } from "../ProjectViewManagerTypes.js";
import {
  GUEST_MAX_PENDING_LOOKUPS,
  GUEST_MAX_QUEUED_LOOKUPS,
  GUEST_RESOLVE_DEADLINE_MS,
  guardRemoteGuestRequests,
  guestDocument,
  isGuestPageReadableByHost,
  isGuestPopupAllowed,
  isGuestRequestAllowed,
} from "../webviewSrcGate.js";

describe("webview src gate", () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it("keeps today's rule with no remote gate installed", () => {
    expect(isWebviewSrcAllowed(7, "http://localhost:3000/")).toBe(true);
    expect(isWebviewSrcAllowed(7, "http://dp-a-b.localhost:43000/")).toBe(true);
    expect(isWebviewSrcAllowed(7, "https://example.com/")).toBe(false);
  });

  it("lets a remote-bound view load only what its gate allows, and local views keep the local rule", () => {
    dispose = setRemoteWebviewSrcGate((webContentsId, src) =>
      webContentsId === 9 ? src === "http://localhost:5173/" : null
    );
    expect(isWebviewSrcAllowed(9, "http://localhost:5173/")).toBe(true);
    expect(isWebviewSrcAllowed(9, "http://localhost:3000/")).toBe(false);
    expect(isWebviewSrcAllowed(7, "http://localhost:3000/")).toBe(true);
  });

  it("stops applying a gate once it is disposed", () => {
    setRemoteWebviewSrcGate(() => false)();
    expect(isWebviewSrcAllowed(9, "http://localhost:3000/")).toBe(true);
  });
});

describe("remote guest requests", () => {
  const REMOTE = 9;
  const LOCAL = 7;
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    // The host's forward holds 127.0.0.1:5173 and [::1]:5173.
    dispose = setRemoteWebviewSrcGate(
      (webContentsId, src) =>
        webContentsId === REMOTE
          ? /^(https?|wss?):\/\/(localhost|127\.0\.0\.1|\[::1\]):5173\//.test(src)
          : null,
      (webContentsId) => webContentsId === REMOTE
    );
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  function fakeSession() {
    let listener: ((details: unknown, cb: (r: { cancel?: boolean }) => void) => void) | null = null;
    const onBeforeRequest = vi.fn((_filter: unknown, next: typeof listener) => {
      listener = next;
    });
    return {
      session: { webRequest: { onBeforeRequest } } as never,
      onBeforeRequest,
      request(url: string, embedder?: number): boolean {
        let cancelled = false;
        listener!(
          {
            url,
            webContents: embedder === undefined ? undefined : { hostWebContents: { id: embedder } },
          },
          (r) => (cancelled = r.cancel === true)
        );
        return !cancelled;
      },
    };
  }

  it("checks fetch, img, frame and WebSocket requests of a remote view's guest, not only navigations", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeSession();
    guardRemoteGuestRequests(REMOTE, { session: fake.session });
    expect(fake.onBeforeRequest).toHaveBeenCalledTimes(1);

    expect(fake.request("http://localhost:5173/api", REMOTE)).toBe(true);
    expect(fake.request("ws://127.0.0.1:5173/hmr", REMOTE)).toBe(true);
    expect(fake.request("https://cdn.example.com/lib.js", REMOTE)).toBe(true);
    expect(fake.request("http://localhost:6379/", REMOTE)).toBe(false);
    expect(fake.request("ws://127.0.0.1:9222/devtools", REMOTE)).toBe(false);
    expect(fake.request("http://127.0.0.2:5173/", REMOTE)).toBe(false);
    expect(fake.request("http://[::ffff:127.0.0.1]:8080/", REMOTE)).toBe(false);
    expect(fake.request("http://admin.localhost:8080/", REMOTE)).toBe(false);
    expect(fake.request("http://0.0.0.0:8080/", REMOTE)).toBe(false);
    // A request no guest owns (a service worker) follows the remote views the session served.
    expect(fake.request("http://localhost:5173/sw", undefined)).toBe(true);
    expect(fake.request("http://localhost:8080/sw", undefined)).toBe(false);
    // A local view sharing the partition keeps today's rules.
    expect(fake.request("http://localhost:8080/", LOCAL)).toBe(true);
    warn.mockRestore();
  });

  it("installs nothing on a session only local views use", () => {
    const fake = fakeSession();
    guardRemoteGuestRequests(LOCAL, { session: fake.session });
    expect(fake.onBeforeRequest).not.toHaveBeenCalled();
  });

  it("installs one listener per session however many guests use it", () => {
    const fake = fakeSession();
    guardRemoteGuestRequests(REMOTE, { session: fake.session });
    guardRemoteGuestRequests(REMOTE, { session: fake.session });
    expect(fake.onBeforeRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses a request no guest owns once no remote view is left", () => {
    const fake = fakeSession();
    guardRemoteGuestRequests(REMOTE, { session: fake.session });
    dispose?.();
    dispose = setRemoteWebviewSrcGate(
      () => null,
      () => false
    );
    expect(fake.request("http://localhost:5173/sw", undefined)).toBe(false);
    expect(isGuestRequestAllowed(new Set(), { url: "https://example.com/" })).toBe(true);
  });

  it("keeps a remote view's popups off this machine's localhost", () => {
    expect(isGuestPopupAllowed(REMOTE, "http://localhost:8080/admin")).toBe(false);
    expect(isGuestPopupAllowed(REMOTE, "http://localhost:5173/")).toBe(true);
    expect(isGuestPopupAllowed(REMOTE, "https://github.com/login")).toBe(true);
    expect(isGuestPopupAllowed(LOCAL, "http://localhost:8080/admin")).toBe(true);
  });

  type Answer = string[] | "reject" | "hang";

  function resolvingSession(answers: Record<string, Answer>) {
    let listener: ((details: unknown, cb: (r: { cancel?: boolean }) => void) => void) | null = null;
    const resolveHost = vi.fn((host: string) => {
      const answer = answers[host] ?? [];
      if (answer === "reject") return Promise.reject(new Error("ENOTFOUND"));
      if (answer === "hang") return new Promise<never>(() => {});
      return Promise.resolve({
        endpoints: answer.map((address) => ({ address, family: "ipv4" })),
      });
    });
    const session = {
      webRequest: {
        onBeforeRequest: (_filter: unknown, next: typeof listener) => (listener = next),
      },
      resolveHost,
    } as never;
    const destroyed: Array<() => void> = [];
    return {
      session,
      resolveHost,
      destroyed,
      /** Every callback the listener made for this request, once it has made one. */
      send(
        url: string,
        options: {
          resourceType?: string;
          frameUrl?: string;
          frameOrigin?: string;
          parentUrl?: string;
          guest?: number;
        } = {}
      ): { calls: Array<{ cancel?: boolean }>; settled: Promise<boolean> } {
        const calls: Array<{ cancel?: boolean }> = [];
        const settled = new Promise<boolean>((resolve) => {
          listener!(
            {
              url,
              resourceType: options.resourceType ?? "xhr",
              webContentsId: options.guest ?? 70,
              webContents: {
                id: options.guest ?? 70,
                hostWebContents: { id: REMOTE },
                once: (_event: string, run: () => void) => destroyed.push(run),
                removeListener: () => {},
              },
              frame: options.frameUrl
                ? {
                    url: options.frameUrl,
                    ...(options.frameOrigin ? { origin: options.frameOrigin } : {}),
                    parent: options.parentUrl ? { url: options.parentUrl } : null,
                  }
                : null,
            },
            (r) => {
              calls.push(r);
              resolve(r.cancel !== true);
            }
          );
        });
        return { calls, settled };
      },
    };
  }

  it("refuses a name that resolves to this machine, as the session's resolver sees it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = resolvingSession({
      "rebind.example": ["127.0.0.1"],
      "any.example": ["0.0.0.0"],
      "six.example": ["::1"],
      "mapped.example": ["::ffff:127.0.0.1"],
      "mixed.example": ["93.184.216.34", "127.0.0.1"],
      "example.com": ["93.184.216.34"],
    });
    guardRemoteGuestRequests(REMOTE, { session: fake.session });
    const page = "https://example.com/";
    for (const url of [
      "http://rebind.example:6379/",
      "ws://any.example:9222/",
      "http://six.example/",
      "http://mapped.example/",
      "http://mixed.example/",
      "http://REBIND.example./",
    ]) {
      await expect(fake.send(url, { frameUrl: page }).settled).resolves.toBe(false);
    }
    await expect(fake.send("https://example.com/", { frameUrl: page }).settled).resolves.toBe(true);
    // The host's own forward is answered from the forward rule, with no lookup.
    fake.resolveHost.mockClear();
    await expect(fake.send("http://localhost:5173/", { frameUrl: page }).settled).resolves.toBe(
      true
    );
    expect(fake.resolveHost).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses a request whose name can't be resolved, answering exactly once, and remembers nothing", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const answers: Record<string, Answer> = { "flaky.example": "reject", "slow.example": "hang" };
      const fake = resolvingSession(answers);
      guardRemoteGuestRequests(REMOTE, { session: fake.session });

      const failed = fake.send("http://flaky.example/");
      await expect(failed.settled).resolves.toBe(false);
      const stalled = fake.send("http://slow.example/");
      await vi.advanceTimersByTimeAsync(GUEST_RESOLVE_DEADLINE_MS + 1);
      await expect(stalled.settled).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(GUEST_RESOLVE_DEADLINE_MS * 2);
      expect(failed.calls).toHaveLength(1);
      expect(stalled.calls).toHaveLength(1);

      // A failure isn't kept: the next request asks again.
      answers["flaky.example"] = ["93.184.216.34"];
      await expect(fake.send("http://flaky.example/").settled).resolves.toBe(true);
      // An empty answer, or one that isn't an address, refuses too.
      answers["empty.example"] = [];
      answers["junk.example"] = ["not-an-address"];
      await expect(fake.send("http://empty.example/").settled).resolves.toBe(false);
      await expect(fake.send("http://junk.example/").settled).resolves.toBe(false);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps the host's pages and the internet out of this computer's network, as Local Network Access does", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = resolvingSession({
      "router.lan": ["192.168.1.1"],
      "nas.tail": ["100.101.102.103"],
      "example.com": ["93.184.216.34"],
    });
    guardRemoteGuestRequests(REMOTE, { session: fake.session });
    const hostPage = "http://localhost:5173/";
    const internetPage = "https://example.com/";
    for (const frameUrl of [hostPage, internetPage]) {
      for (const url of [
        "http://192.168.1.1/camera.jpg",
        "http://10.0.0.5/api",
        "http://[fe80::1]/",
        "http://router.lan/",
        "http://nas.tail/",
      ]) {
        await expect(fake.send(url, { frameUrl, resourceType: "image" }).settled).resolves.toBe(
          false
        );
        await expect(fake.send(url, { frameUrl, resourceType: "subFrame" }).settled).resolves.toBe(
          false
        );
      }
    }
    // A request no frame can be traced to doesn't reach the network either.
    await expect(fake.send("http://192.168.1.1/", {}).settled).resolves.toBe(false);
    // The person's own navigation does, and that page's own requests with it.
    await expect(
      fake.send("http://router.lan/", { resourceType: "mainFrame", frameUrl: hostPage }).settled
    ).resolves.toBe(true);
    await expect(
      fake.send("http://192.168.1.1/style.css", { frameUrl: "http://router.lan/" }).settled
    ).resolves.toBe(true);
    // An iframe is vouched for by the document that holds it, not by the blank frame itself.
    const frame = (parentUrl: string) =>
      fake.send("http://192.168.1.1/panel", {
        resourceType: "subFrame",
        frameUrl: "about:blank",
        parentUrl,
      }).settled;
    await expect(frame("http://router.lan/")).resolves.toBe(true);
    await expect(frame(hostPage)).resolves.toBe(false);
    warn.mockRestore();
  });

  it("records each navigation, and remembers for the guest's life that it touched this computer's network", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = resolvingSession({
      "router.lan": ["192.168.1.1"],
      "example.com": ["93.184.216.34"],
    });
    guardRemoteGuestRequests(REMOTE, { session: fake.session });

    await fake.send("https://example.com/", { resourceType: "mainFrame", guest: 71 }).settled;
    const first = guestDocument(71)!;
    expect(first.localNetwork).toBe(false);
    // A refused request leaves the record as it was.
    await fake.send("http://192.168.1.1/x.png", { frameUrl: "https://example.com/", guest: 71 })
      .settled;
    expect(guestDocument(71)).toEqual(first);

    await fake.send("http://router.lan/", { resourceType: "mainFrame", guest: 71 }).settled;
    expect(guestDocument(71)).toEqual({ generation: first.generation + 1, localNetwork: true });
    // Navigating away doesn't clear it: the navigation may never have replaced the page.
    await fake.send("https://example.com/", { resourceType: "mainFrame", guest: 71 }).settled;
    expect(guestDocument(71)).toEqual({ generation: first.generation + 2, localNetwork: true });

    for (const run of fake.destroyed) run();
    expect(guestDocument(71)).toBeNull();
    warn.mockRestore();
  });

  it("judges a document by where it loaded from, never by what its name answers now", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const answers: Record<string, Answer> = {
      "rebind.example": ["93.184.216.34"],
      "router.lan": ["192.168.1.1"],
    };
    const fake = resolvingSession(answers);
    guardRemoteGuestRequests(REMOTE, { session: fake.session });
    await fake.send("https://rebind.example/", { resourceType: "mainFrame", guest: 72 }).settled;
    answers["rebind.example"] = ["192.168.1.1"];
    await expect(
      fake.send("http://192.168.1.1/admin", { frameUrl: "https://rebind.example/", guest: 72 })
        .settled
    ).resolves.toBe(false);

    // A frame with its creator's origin (about:blank, srcdoc) asks as that origin.
    await fake.send("http://router.lan/", { resourceType: "mainFrame", guest: 72 }).settled;
    await expect(
      fake.send("http://192.168.1.1/api", {
        frameUrl: "about:blank",
        frameOrigin: "http://router.lan",
        guest: 72,
      }).settled
    ).resolves.toBe(true);
    // An opaque origin asks as nothing.
    await expect(
      fake.send("http://192.168.1.1/api", {
        frameUrl: "data:text/html,x",
        frameOrigin: "null",
        guest: 72,
      }).settled
    ).resolves.toBe(false);
    warn.mockRestore();
  });

  it("queues a request past the names in flight, and loads it once one of them gives up", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const answers: Record<string, Answer> = {};
      for (let i = 0; i < GUEST_MAX_PENDING_LOOKUPS; i++) answers[`n${i}.example`] = "hang";
      answers["fine.example"] = ["93.184.216.34"];
      const fake = resolvingSession(answers);
      guardRemoteGuestRequests(REMOTE, { session: fake.session });
      for (let i = 0; i < GUEST_MAX_PENDING_LOOKUPS; i++) fake.send(`http://n${i}.example/`);
      const queued = fake.send("http://fine.example/");
      await vi.advanceTimersByTimeAsync(0);
      // Waiting its turn, not refused and not yet asked about.
      expect(fake.resolveHost).toHaveBeenCalledTimes(GUEST_MAX_PENDING_LOOKUPS);
      await vi.advanceTimersByTimeAsync(GUEST_RESOLVE_DEADLINE_MS + 1);
      await expect(queued.settled).resolves.toBe(true);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("refuses a request only once the queue behind the names in flight is full too", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const total = GUEST_MAX_PENDING_LOOKUPS + GUEST_MAX_QUEUED_LOOKUPS;
      const answers: Record<string, Answer> = {};
      for (let i = 0; i < total; i++) answers[`n${i}.example`] = "hang";
      answers["fine.example"] = ["93.184.216.34"];
      const fake = resolvingSession(answers);
      guardRemoteGuestRequests(REMOTE, { session: fake.session });
      for (let i = 0; i < total; i++) fake.send(`http://n${i}.example/`);
      await expect(fake.send("http://fine.example/").settled).resolves.toBe(false);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("hands the host a capture of an internet page or its own forward, never this computer's network", async () => {
    const resolve = async (host: string) =>
      ({
        "router.lan": ["192.168.1.1"],
        "example.com": ["93.184.216.34"],
        "mixed.example": ["93.184.216.34", "10.0.0.5"],
      })[host] ?? [];
    expect(await isGuestPageReadableByHost(REMOTE, "https://example.com/", resolve)).toBe(true);
    expect(await isGuestPageReadableByHost(REMOTE, "http://localhost:5173/", resolve)).toBe(true);
    expect(await isGuestPageReadableByHost(REMOTE, "http://localhost:8080/", resolve)).toBe(false);
    expect(await isGuestPageReadableByHost(REMOTE, "http://router.lan/", resolve)).toBe(false);
    expect(await isGuestPageReadableByHost(REMOTE, "http://mixed.example/", resolve)).toBe(false);
    expect(await isGuestPageReadableByHost(REMOTE, "http://10.1.2.3/", resolve)).toBe(false);
    expect(await isGuestPageReadableByHost(REMOTE, "http://[fe80::1]/", resolve)).toBe(false);
    expect(await isGuestPageReadableByHost(REMOTE, "http://unresolvable.example/", resolve)).toBe(
      false
    );
    expect(await isGuestPageReadableByHost(REMOTE, "file:///etc/passwd", resolve)).toBe(false);
  });
});

type Listener = (...args: unknown[]) => void;

function setup() {
  const listeners = new Map<string, Listener>();
  const wc = {
    id: 42,
    isDestroyed: () => false,
    on: vi.fn((event: string, listener: Listener) => listeners.set(event, listener)),
    removeListener: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const host = {
    win: { isDestroyed: () => true },
    webContentsToProject: new Map([[42, "proj-a"]]),
    views: new Map(),
    activeProjectId: "proj-a",
  } as unknown as ProjectViewManager;
  const entry = { cleanupHandlers: () => {} } as unknown as ViewEntry;
  setupViewHandlers(host, { webContents: wc } as never, entry);
  const fire = (reason: string, exitCode: number) =>
    listeners.get("render-process-gone")!({}, { reason, exitCode });
  return { fire };
}

describe("ProjectViewHandlers render-process-gone recording (#12884)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("records a view renderer death as a non-fatal event, never as a crash", () => {
    const { fire } = setup();

    fire("killed", 15);

    expect(crashServiceMock.recordRendererGone).toHaveBeenCalledWith({
      process: "project-view",
      projectId: "proj-a",
      webContentsId: 42,
      reason: "killed",
      exitCode: 15,
    });
    expect(crashServiceMock.recordCrash).not.toHaveBeenCalled();
  });

  it.each(["clean-exit", "memory-eviction"])("records nothing for %s", (reason) => {
    const { fire } = setup();

    fire(reason, 0);

    expect(crashServiceMock.recordRendererGone).not.toHaveBeenCalled();
    expect(crashServiceMock.recordCrash).not.toHaveBeenCalled();
  });

  it("writes the reason and exit code to the log file (#12954)", () => {
    const { fire } = setup();

    fire("crashed", 5);

    expect(loggerMock.logError).toHaveBeenCalledWith(
      "View renderer gone",
      undefined,
      expect.objectContaining({
        process: "project-view",
        reason: "crashed",
        exitCode: 5,
        webContentsId: 42,
        projectId: "proj-a",
      })
    );
    expect(loggerMock.logWarn).not.toHaveBeenCalled();
  });

  it("logs memory eviction as a warning, not an error", () => {
    const { fire } = setup();

    fire("memory-eviction", 0);

    expect(loggerMock.logWarn).toHaveBeenCalledWith(
      "View renderer gone",
      expect.objectContaining({ reason: "memory-eviction" })
    );
    expect(loggerMock.logError).not.toHaveBeenCalled();
  });

  it("logs nothing for a clean exit", () => {
    const { fire } = setup();

    fire("clean-exit", 0);

    expect(loggerMock.logError).not.toHaveBeenCalled();
    expect(loggerMock.logWarn).not.toHaveBeenCalled();
  });
});

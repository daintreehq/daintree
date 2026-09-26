import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const order = vi.hoisted(() => [] as string[]);

const pathRefresh = vi.hoisted(() => ({
  promise: null as Promise<void> | null,
  kickOff: vi.fn(() => Promise.resolve()),
}));

const workspaceClientFactory = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/user-data") },
  webContents: { fromId: vi.fn(() => undefined) },
}));

vi.mock("../../setup/environment.js", () => ({
  isSmokeTest: false,
  getEarlyPathRefreshPromise: () => pathRefresh.promise,
  kickOffEarlyPathRefresh: pathRefresh.kickOff,
}));

vi.mock("../../setup/runtimeFlags.js", () => ({ isE2EFaultMode: false }));

vi.mock("../../utils/performance.js", () => ({ markPerformance: vi.fn() }));

vi.mock("../../services/MainProcessWatchdogClient.js", () => ({
  getMainProcessWatchdogClient: vi.fn(() => {
    order.push("watchdog");
    return { onDisabled: vi.fn() };
  }),
}));

vi.mock("../../window/perWindowInit.js", () => ({
  wireWatchdogDisabledBroadcast: vi.fn(),
}));

vi.mock("../../services/TerminalLineageLedger.js", () => ({
  reapPersistedLineages: vi.fn(async () => {
    order.push("reap");
  }),
}));

vi.mock("../../services/WorkspaceClient.js", () => ({
  getWorkspaceClient: workspaceClientFactory,
}));

const pluginServiceMock = vi.hoisted(() => ({ setWorkspaceClient: vi.fn() }));
vi.mock("../../services/PluginService.js", () => ({ pluginService: pluginServiceMock }));

vi.mock("../../services/WorktreePortBroker.js", () => ({
  WorktreePortBroker: class {
    closePortsForHost = vi.fn(() => []);
  },
}));

import {
  _resetHostServicesForTest,
  adoptWindowHandlerDeps,
  createWindowDepsAdopter,
  ensurePtyHostStarted,
  ensureWorkspaceClient,
  isWorkspaceClientStarting,
} from "../hostServices.js";
import {
  getWorkspaceClientRef,
  getWorktreePortBrokerRef,
  setMainProcessWatchdogClientRef,
  setPtyClientRef,
  setWorkspaceClientRef,
  setWorktreePortBrokerRef,
} from "../../window/serviceRefs.js";
import type { PtyClient } from "../../services/PtyClient.js";
import type { HandlerDependencies } from "../../ipc/types.js";

function makePtyClient() {
  let started = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const client = {
    isHostStarted: vi.fn(() => started),
    setDeferInitialPoolWarm: vi.fn(),
    start: vi.fn(() => {
      order.push("pty-start");
      started = true;
    }),
    waitForReady: vi.fn(() => {
      order.push("pty-wait");
      return ready;
    }),
  };
  return { client, resolveReady };
}

function makeWorkspaceClient() {
  return {
    prewarmProject: vi.fn(() => order.push("prewarm")),
    on: vi.fn(),
  };
}

beforeEach(() => {
  order.length = 0;
  pathRefresh.promise = null;
  vi.clearAllMocks();
  _resetHostServicesForTest();
  setPtyClientRef(null);
  setWorkspaceClientRef(null);
  setWorktreePortBrokerRef(null);
  setMainProcessWatchdogClientRef(null);
});

afterEach(() => {
  setPtyClientRef(null);
  setWorkspaceClientRef(null);
  setWorktreePortBrokerRef(null);
  setMainProcessWatchdogClientRef(null);
});

describe("ensurePtyHostStarted", () => {
  it("forks after the watchdog, the PATH refresh and the lineage reap", async () => {
    const { client } = makePtyClient();
    setPtyClientRef(client as unknown as PtyClient);
    let releaseRefresh!: () => void;
    pathRefresh.promise = new Promise<void>((resolve) => {
      releaseRefresh = () => {
        order.push("path-refresh");
        resolve();
      };
    });

    const started = ensurePtyHostStarted({ windowRegistry: undefined, deferInitialPoolWarm: true });
    await Promise.resolve();
    expect(client.start).not.toHaveBeenCalled();

    releaseRefresh();
    await started;

    expect(order).toEqual(["watchdog", "path-refresh", "reap", "pty-start"]);
    expect(client.setDeferInitialPoolWarm).toHaveBeenCalledWith(true);
  });

  it("forks once when the Host runtime and a window ask at the same time", async () => {
    const { client } = makePtyClient();
    setPtyClientRef(client as unknown as PtyClient);

    const fromHost = ensurePtyHostStarted({
      windowRegistry: undefined,
      deferInitialPoolWarm: false,
    });
    const fromWindow = ensurePtyHostStarted({
      windowRegistry: undefined,
      deferInitialPoolWarm: true,
    });
    await Promise.all([fromHost, fromWindow]);

    expect(fromWindow).toBe(fromHost);
    expect(client.start).toHaveBeenCalledTimes(1);
    // The first caller's policy stands.
    expect(client.setDeferInitialPoolWarm).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("leaves an already forked host alone for a window that attaches later", async () => {
    const { client } = makePtyClient();
    setPtyClientRef(client as unknown as PtyClient);
    await ensurePtyHostStarted({ windowRegistry: undefined, deferInitialPoolWarm: false });

    _resetHostServicesForTest();
    await ensurePtyHostStarted({ windowRegistry: undefined, deferInitialPoolWarm: true });

    expect(client.start).toHaveBeenCalledTimes(1);
  });

  it("kicks off the PATH refresh itself when nothing started it", async () => {
    const { client } = makePtyClient();
    setPtyClientRef(client as unknown as PtyClient);

    await ensurePtyHostStarted({ windowRegistry: undefined, deferInitialPoolWarm: false });

    expect(pathRefresh.kickOff).toHaveBeenCalledTimes(1);
    expect(client.start).toHaveBeenCalledTimes(1);
  });

  it("starts the watchdog only once", async () => {
    const { client } = makePtyClient();
    setPtyClientRef(client as unknown as PtyClient);

    await ensurePtyHostStarted({ windowRegistry: undefined, deferInitialPoolWarm: false });
    await ensurePtyHostStarted({ windowRegistry: undefined, deferInitialPoolWarm: false });

    expect(order.filter((step) => step === "watchdog")).toHaveLength(1);
  });
});

describe("ensureWorkspaceClient", () => {
  it("constructs one client for concurrent callers and publishes it after pty-host ready", async () => {
    const { client, resolveReady } = makePtyClient();
    setPtyClientRef(client as unknown as PtyClient);
    const workspace = makeWorkspaceClient();
    workspaceClientFactory.mockReturnValue(workspace);

    const fromHost = ensureWorkspaceClient({});
    const fromWindow = ensureWorkspaceClient({ prewarmPath: "/projects/a" });
    await Promise.resolve();
    expect(getWorkspaceClientRef()).toBeNull();

    resolveReady();
    const [a, b] = await Promise.all([fromHost, fromWindow]);

    expect(a).toBe(workspace);
    expect(b).toBe(workspace);
    expect(workspaceClientFactory).toHaveBeenCalledTimes(1);
    expect(getWorkspaceClientRef()).toBe(workspace);
    expect(getWorktreePortBrokerRef()).not.toBeNull();
    expect(pluginServiceMock.setWorkspaceClient).toHaveBeenCalledWith(workspace);
  });

  it("prewarms before waiting on the pty-host", async () => {
    const { client, resolveReady } = makePtyClient();
    setPtyClientRef(client as unknown as PtyClient);
    workspaceClientFactory.mockReturnValue(makeWorkspaceClient());
    resolveReady();

    await ensureWorkspaceClient({ prewarmPath: "/projects/a" });

    expect(order.indexOf("prewarm")).toBeLessThan(order.indexOf("pty-wait"));
  });

  it("holds a caller that finds the ref published but the broker not yet wired", async () => {
    const { client, resolveReady } = makePtyClient();
    setPtyClientRef(client as unknown as PtyClient);
    const workspace = makeWorkspaceClient();
    workspaceClientFactory.mockReturnValue(workspace);

    const first = ensureWorkspaceClient({});
    expect(isWorkspaceClientStarting()).toBe(true);
    // The ref goes live partway through the init; a caller arriving then must
    // still wait for the rest of it.
    setWorkspaceClientRef(workspace as never);

    const second = ensureWorkspaceClient({});
    expect(second).toBe(first);

    resolveReady();
    await second;
    expect(getWorktreePortBrokerRef()).not.toBeNull();
    expect(isWorkspaceClientStarting()).toBe(false);
  });

  it("returns the published client to a window that attaches later", async () => {
    const existing = makeWorkspaceClient();
    setWorkspaceClientRef(existing as never);

    expect(await ensureWorkspaceClient({ prewarmPath: "/projects/a" })).toBe(existing);
    expect(workspaceClientFactory).not.toHaveBeenCalled();
  });

  it("survives a prewarm that throws synchronously", async () => {
    const { client, resolveReady } = makePtyClient();
    setPtyClientRef(client as unknown as PtyClient);
    const workspace = makeWorkspaceClient();
    workspace.prewarmProject.mockImplementation(() => {
      throw new Error("sync prewarm failure");
    });
    workspaceClientFactory.mockReturnValue(workspace);
    resolveReady();

    expect(await ensureWorkspaceClient({ prewarmPath: "/projects/a" })).toBe(workspace);
    expect(getWorkspaceClientRef()).toBe(workspace);
  });
});

describe("adoptWindowHandlerDeps", () => {
  it("fills the window-scoped fields a windowless registration left empty", () => {
    const registered: HandlerDependencies = { isDemoMode: false };
    const mainWindow = {} as never;
    const portalManager = {} as never;
    const ptyClient = {} as never;

    adoptWindowHandlerDeps(registered, { mainWindow, portalManager, ptyClient });

    expect(registered.mainWindow).toBe(mainWindow);
    expect(registered.portalManager).toBe(portalManager);
    // Process-wide services are the registration's own, never the window's.
    expect(registered.ptyClient).toBeUndefined();
  });

  it("never replaces a field while its window is alive", () => {
    const first = { isDestroyed: () => false } as never;
    const registered: HandlerDependencies = { mainWindow: first };

    adoptWindowHandlerDeps(registered, { mainWindow: { isDestroyed: () => false } as never });

    expect(registered.mainWindow).toBe(first);
  });

  it("rebinds every window-scoped field once the adopted window is gone", () => {
    const closedPortal = {} as never;
    const registered: HandlerDependencies = {
      mainWindow: { isDestroyed: () => true } as never,
      portalManager: closedPortal,
      eventBuffer: {} as never,
    };
    const next = {
      mainWindow: { isDestroyed: () => false } as never,
      portalManager: {} as never,
      eventBuffer: {} as never,
    };

    adoptWindowHandlerDeps(registered, next);

    expect(registered.mainWindow).toBe(next.mainWindow);
    expect(registered.portalManager).toBe(next.portalManager);
    expect(registered.eventBuffer).toBe(next.eventBuffer);
  });
});

describe("createWindowDepsAdopter", () => {
  function makeWindowDeps() {
    let destroyed = false;
    const mainWindow = { isDestroyed: () => destroyed };
    return {
      deps: { mainWindow, portalManager: {}, eventBuffer: {} } as unknown as HandlerDependencies,
      close: () => {
        destroyed = true;
      },
    };
  }

  it("hands the registration to a surviving window when the adopted one closes", () => {
    const registered: HandlerDependencies = {};
    const adopter = createWindowDepsAdopter(registered);
    const a = makeWindowDeps();
    const b = makeWindowDeps();

    adopter.attach(1, a.deps);
    adopter.attach(2, b.deps);
    expect(registered.portalManager).toBe(a.deps.portalManager);

    a.close();
    adopter.detach(1);

    expect(registered.mainWindow).toBe(b.deps.mainWindow);
    expect(registered.portalManager).toBe(b.deps.portalManager);
    expect(registered.eventBuffer).toBe(b.deps.eventBuffer);
  });

  it("leaves the registration alone when a window it never adopted closes", () => {
    const registered: HandlerDependencies = {};
    const adopter = createWindowDepsAdopter(registered);
    const a = makeWindowDeps();
    const b = makeWindowDeps();
    adopter.attach(1, a.deps);
    adopter.attach(2, b.deps);

    b.close();
    adopter.detach(2);

    expect(registered.mainWindow).toBe(a.deps.mainWindow);
  });

  it("keeps the closed window's fields when none survives, for the next window to replace", () => {
    const registered: HandlerDependencies = {};
    const adopter = createWindowDepsAdopter(registered);
    const a = makeWindowDeps();
    adopter.attach(1, a.deps);

    a.close();
    adopter.detach(1);
    const c = makeWindowDeps();
    adopter.attach(3, c.deps);

    expect(registered.mainWindow).toBe(c.deps.mainWindow);
    expect(registered.portalManager).toBe(c.deps.portalManager);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "node:stream";

const { forkMock, mockChildren, appMock, watchMock, watchCalls } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const forkMock = vi.fn();
  const mockChildren: any[] = [];
  const appEmitter = new EventEmitter();
  const appMock = Object.assign(appEmitter, { getPath: vi.fn(() => "/tmp/userData") });
  const watchCalls: { dir: string; cb: (event: string, filename: string | null) => void }[] = [];
  const watchMock = vi.fn((dir: string, _opts: unknown, cb: any) => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    watchCalls.push({ dir, cb });
    return watcher;
  });
  return { forkMock, mockChildren, appMock, watchMock, watchCalls };
});

class MockUtilityChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  postMessage = vi.fn();
  kill = vi.fn(() => true);
  pid = 99;
  constructor() {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    mockChildren.push(this);
  }
}

vi.mock("electron", () => ({
  utilityProcess: { fork: forkMock },
  app: appMock,
  UtilityProcess: class {},
}));

vi.mock("fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  // existsSync → true so the watcher targets the dist dir directly (the fake
  // test paths don't exist on the real fs, which would otherwise route through
  // the "dist not created yet" plugin-root fallback).
  const existsSync = () => true;
  return {
    ...actual,
    default: { ...actual.default, watch: watchMock, existsSync },
    watch: watchMock,
    existsSync,
  };
});

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

async function loadModule(): Promise<typeof import("../PluginDevWorkerHost.js")> {
  return import("../PluginDevWorkerHost.js");
}

const OPTS = {
  pluginId: "acme.demo",
  pluginDir: "/plugins/acme.demo",
  bundlePath: "/plugins/acme.demo/dist/index.js",
};

/** Flush microtasks + the host's setImmediate deferrals. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("PluginDevWorkerHost", () => {
  beforeEach(() => {
    vi.resetModules();
    forkMock.mockReset();
    mockChildren.length = 0;
    watchCalls.length = 0;
    watchMock.mockClear();
    appMock.removeAllListeners();
    forkMock.mockImplementation(() => new MockUtilityChild());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("forks the worker with the dev-worker kind, piped stdio, and the plugin dir as cwd", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    host.waitForReady().catch(() => {});
    void host.start();

    expect(forkMock).toHaveBeenCalledTimes(1);
    const [, , options] = forkMock.mock.calls[0];
    expect(options.stdio).toBe("pipe");
    expect(options.cwd).toBe(OPTS.pluginDir);
    expect(options.env.DAINTREE_UTILITY_PROCESS_KIND).toBe("plugin-dev-worker");
    // env must spread process.env (REPLACES, not merges — #6081).
    expect(options.env.DAINTREE_USER_DATA).toBe("/tmp/userData");
    host.dispose();
  });

  it("forks the worker with a V8 heap cap in execArgv", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    host.waitForReady().catch(() => {});
    void host.start();

    const execArgv: string[] = forkMock.mock.calls[0][2].execArgv;
    expect(execArgv.some((arg) => /^--max-old-space-size=\d+$/.test(arg))).toBe(true);
    host.dispose();
  });

  it("exports CRASH_WINDOW_MS aligned with the other guards (30 minutes)", async () => {
    const mod = await loadModule();
    expect(mod.CRASH_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it("on worker `ready`, sends `start` with the bundle file:// URL and resolves ready", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    const ready = host.start();
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });
    await ready;

    const startMsg = child.postMessage.mock.calls.find((c) => c[0]?.type === "start")?.[0];
    expect(startMsg).toBeTruthy();
    expect(startMsg.pluginId).toBe("acme.demo");
    expect(startMsg.bundleUrl).toMatch(/^file:\/\/.*\/dist\/index\.js$/);
    host.dispose();
  });

  it("watches the bundle's dist directory and debounces a rebuild into one reload", async () => {
    vi.useFakeTimers();
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    void host.start();
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    expect(watchCalls).toHaveLength(1);
    expect(watchCalls[0].dir).toBe("/plugins/acme.demo/dist");

    // Two rapid change events for index.js → one reload after debounce.
    watchCalls[0].cb("change", "index.js");
    watchCalls[0].cb("change", "index.js");
    vi.advanceTimersByTime(250);

    // Reload sends a dispose to the old child, then the old child exits.
    const disposeSent = child.postMessage.mock.calls.some((c) => c[0]?.type === "dispose");
    expect(disposeSent).toBe(true);
    host.dispose();
  });

  it("ignores change events for unrelated files in the dist dir", async () => {
    vi.useFakeTimers();
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    void host.start();
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });
    child.postMessage.mockClear();

    watchCalls[0].cb("change", "style.css");
    vi.advanceTimersByTime(250);

    const disposeSent = child.postMessage.mock.calls.some((c) => c[0]?.type === "dispose");
    expect(disposeSent).toBe(false);
    host.dispose();
  });

  it("a reload clears the crash window so deliberate restarts never trip the cap", async () => {
    vi.useFakeTimers();
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    const crashLoop = vi.fn();
    host.on("crash-loop", crashLoop);
    void host.start();
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    // Trigger a reload (deliberate kill).
    watchCalls[0].cb("change", "index.js");
    vi.advanceTimersByTime(250);
    // Old child exits as a result of the reload's dispose/kill.
    child.emit("exit", 0);
    await vi.runOnlyPendingTimersAsync();

    // A fresh worker was forked for the reload.
    expect(forkMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(crashLoop).not.toHaveBeenCalled();
    host.dispose();
  });

  it("gives up after the crash threshold of unexpected exits", async () => {
    const { PluginDevWorkerHost, CRASH_WINDOW_MS } = await loadModule();
    expect(CRASH_WINDOW_MS).toBeGreaterThan(0);
    const host = new PluginDevWorkerHost(OPTS);
    const crashLoop = vi.fn();
    host.on("crash-loop", crashLoop);
    void host.start();
    mockChildren[0].emit("message", { type: "ready" });

    // Three unexpected crashes in a row (each respawns until the cap).
    for (let i = 0; i < 3; i++) {
      const child = mockChildren[mockChildren.length - 1] as MockUtilityChild;
      child.emit("exit", 1);
      await flush();
    }

    expect(crashLoop).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("dispose sends a cooperative dispose then force-kills after the grace period", async () => {
    vi.useFakeTimers();
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    void host.start();
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    host.dispose();
    expect(child.postMessage.mock.calls.some((c) => c[0]?.type === "dispose")).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1100);
    expect(child.kill).toHaveBeenCalled();
  });

  it("prod mode forks with the prod-worker kind and starts NO file watcher (#10526)", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost({ ...OPTS, mode: "prod" });
    host.waitForReady().catch(() => {});
    void host.start();
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    // Forked with the prod kind for process-monitor observability...
    const [, , options] = forkMock.mock.calls[0];
    expect(options.env.DAINTREE_UTILITY_PROCESS_KIND).toBe("plugin-prod-worker");
    // ...and crucially never arms the hot-reload bundle watcher.
    expect(watchCalls).toHaveLength(0);
    host.dispose();
  });

  it("dev mode arms the file watcher (contrast with prod) (#10526)", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost({ ...OPTS, mode: "dev" });
    void host.start();
    (mockChildren[0] as MockUtilityChild).emit("message", { type: "ready" });

    expect(watchCalls).toHaveLength(1);
    const [, , options] = forkMock.mock.calls[0];
    expect(options.env.DAINTREE_UTILITY_PROCESS_KIND).toBe("plugin-dev-worker");
    host.dispose();
  });

  it("re-emits non-lifecycle worker messages as `worker-message`", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    const seen: any[] = [];
    host.on("worker-message", (m) => seen.push(m));
    void host.start();
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });
    child.emit("message", { type: "host-call", requestId: "c1", method: "getWorktrees" });

    expect(seen).toContainEqual({ type: "host-call", requestId: "c1", method: "getWorktrees" });
    host.dispose();
  });
});

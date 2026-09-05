/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "node:stream";

const { forkMock, mockChildren, appMock, watchMock, watchCalls, loggerMock } = vi.hoisted(() => {
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
  const loggerMock = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { forkMock, mockChildren, appMock, watchMock, watchCalls, loggerMock };
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
  createLogger: () => loggerMock,
}));

async function loadModule(): Promise<typeof import("../PluginDevWorkerHost.js")> {
  return import("../PluginDevWorkerHost.js");
}

const OPTS = {
  pluginId: "acme.demo",
  identity: {
    instanceId: "acme.demo",
    manifestId: "acme.demo",
    origin: "global" as const,
    projectId: null,
    projectRoot: null,
  },
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
    loggerMock.debug.mockClear();
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
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
    // env REPLACES process.env in a utility process (#6081), so every key the
    // worker needs must be in this one object.
    expect(options.env.DAINTREE_USER_DATA).toBe("/tmp/userData");
    host.dispose();
  });

  it("scrubs the worker's inherited environment down to the safe allowlist (#11300)", async () => {
    const SECRET = "DAINTREE_WORKER_TEST_SECRET";
    const prevSecret = process.env[SECRET];
    process.env[SECRET] = "api-token";
    try {
      const { PluginDevWorkerHost } = await loadModule();
      const host = new PluginDevWorkerHost(OPTS);
      host.waitForReady().catch(() => {});
      void host.start();

      const [, , options] = forkMock.mock.calls[0];
      // Plugin code runs inside this worker. Spawned children are scrubbed via
      // SAFE_ENV_KEYS specifically to keep host secrets away from plugins —
      // inheriting them one level up made that a formality.
      expect(options.env[SECRET]).toBeUndefined();
      // Essentials the worker genuinely needs still survive.
      expect(options.env.PATH).toBe(process.env.PATH);
      expect(options.env.DAINTREE_USER_DATA).toBe("/tmp/userData");
      expect(options.env.DAINTREE_UTILITY_PROCESS_KIND).toBe("plugin-dev-worker");
      host.dispose();
    } finally {
      if (prevSecret === undefined) delete process.env[SECRET];
      else process.env[SECRET] = prevSecret;
    }
  });

  it("keeps proxy and CA settings so plugin HTTPS calls survive the scrub (#11300)", async () => {
    // Plugins make network calls from inside this worker (the built-in GitHub
    // forge provider talks to api.github.com). Proxy endpoints and CA bundles
    // are transport config, not credentials — dropping them fails every HTTPS
    // call behind a corporate TLS-inspecting proxy, at runtime, silently.
    const prev = {
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      https_proxy: process.env.https_proxy,
      NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA,
    };
    process.env.https_proxy = "http://lower-proxy:8080";
    process.env.NODE_USE_SYSTEM_CA = "1";
    process.env.HTTPS_PROXY = "http://corp-proxy:8080";
    process.env.NO_PROXY = "localhost";
    process.env.NODE_EXTRA_CA_CERTS = "/etc/ssl/corp-ca.pem";
    const expectedHttpsProxy = process.env.HTTPS_PROXY;
    const expectedLowerHttpsProxy = process.env.https_proxy;
    try {
      const { PluginDevWorkerHost } = await loadModule();
      const host = new PluginDevWorkerHost(OPTS);
      host.waitForReady().catch(() => {});
      void host.start();

      const [, , options] = forkMock.mock.calls[0];
      expect(options.env.HTTPS_PROXY).toBe(expectedHttpsProxy);
      // POSIX tooling conventionally uses the lowercase names, and env lookup
      // is case-sensitive there — carrying only one form drops the other user.
      // Windows aliases environment keys case-insensitively, so both forms
      // correctly carry the last value assigned by the host environment.
      expect(options.env.https_proxy).toBe(expectedLowerHttpsProxy);
      // The other branch of Daintree's own TLS recovery hint.
      expect(options.env.NODE_USE_SYSTEM_CA).toBe("1");
      expect(options.env.NO_PROXY).toBe("localhost");
      expect(options.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp-ca.pem");
      host.dispose();
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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

  it("omits permission-model flags by default (spike #10890)", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    host.waitForReady().catch(() => {});
    void host.start();

    const execArgv: string[] = forkMock.mock.calls[0][2].execArgv;
    expect(execArgv.some((arg) => arg.startsWith("--permission"))).toBe(false);
    host.dispose();
  });

  it("appends permissionExecArgv directly after the heap cap, in order (spike #10890)", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const permissionExecArgv = ["--permission", "--allow-fs-read=/plugins/acme.demo"];
    const host = new PluginDevWorkerHost({ ...OPTS, permissionExecArgv });
    host.waitForReady().catch(() => {});
    void host.start();

    const execArgv: string[] = forkMock.mock.calls[0][2].execArgv;
    expect(execArgv[0]).toMatch(/^--max-old-space-size=\d+$/);
    expect(execArgv.slice(1)).toEqual(permissionExecArgv);
    host.dispose();
  });

  it("logs the permission-model honored verdict from ready when flags were requested (spike #10890)", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const permissionExecArgv = ["--permission", "--allow-fs-read=/plugins/acme.demo"];
    const host = new PluginDevWorkerHost({ ...OPTS, permissionExecArgv });
    const ready = host.start();
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready", permission: { present: false } });
    await ready;

    const spikeLog = loggerMock.info.mock.calls.find(
      ([, fields]) => fields && typeof fields === "object" && "honored" in fields
    );
    expect(spikeLog).toBeDefined();
    expect(spikeLog?.[1]).toMatchObject({
      requested: true,
      honored: false,
      flags: permissionExecArgv,
    });
    host.dispose();
  });

  it("stays quiet on ready when no permission flags were requested (spike #10890)", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    const ready = host.start();
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });
    await ready;

    const spikeLog = loggerMock.info.mock.calls.find(
      ([, fields]) => fields && typeof fields === "object" && "honored" in fields
    );
    expect(spikeLog).toBeUndefined();
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

  // #12279: a reload asks the worker to dispose cooperatively and only
  // force-kills it after a grace period, so the outgoing worker stays alive and
  // connected after `reloading` has already retired its generation. Anything it
  // says in that window would be stamped with the INCOMING generation and pass
  // every downstream staleness check.
  it("drops messages from a worker that is being retired (#12279)", async () => {
    vi.useFakeTimers();
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    const seen: any[] = [];
    host.on("worker-message", (m) => seen.push(m));
    void host.start();
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    watchCalls[0].cb("change", "index.js");
    vi.advanceTimersByTime(250);

    // The dying worker's cleanup runs before the process exits and can still
    // call the host — a settings write here must not be forwarded.
    child.emit("message", {
      type: "host-call",
      requestId: "late",
      method: "settings.set",
      params: { key: "k", value: "v" },
    });

    expect(seen).toHaveLength(0);
    // The cooperative dispose must still reach it — gating receives, not sends.
    expect(child.postMessage).toHaveBeenCalledWith({ type: "dispose" });
    host.dispose();
  });

  it("ignores a superseded child once its replacement takes over (#12279)", async () => {
    vi.useFakeTimers();
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    const seen: any[] = [];
    host.on("worker-message", (m) => seen.push(m));
    void host.start();
    const oldChild = mockChildren[0] as MockUtilityChild;
    oldChild.emit("message", { type: "ready" });

    watchCalls[0].cb("change", "index.js");
    vi.advanceTimersByTime(250);
    oldChild.emit("exit", 0);
    await vi.runOnlyPendingTimersAsync();

    const newChild = mockChildren[mockChildren.length - 1] as MockUtilityChild;
    expect(newChild).not.toBe(oldChild);

    oldChild.emit("message", { type: "host-call", requestId: "ghost", method: "getWorktrees" });
    expect(seen).toHaveLength(0);

    // The replacement is served immediately — including the host calls its
    // activate() makes, so the guard cannot deadlock activation.
    newChild.emit("message", { type: "ready" });
    newChild.emit("message", { type: "host-call", requestId: "live", method: "getWorktrees" });
    expect(seen).toContainEqual({
      type: "host-call",
      requestId: "live",
      method: "getWorktrees",
    });
    host.dispose();
  });
});

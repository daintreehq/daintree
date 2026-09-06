/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "node:stream";

const { forkMock, mockChildren, appMock, loggerMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const forkMock = vi.fn();
  const mockChildren: any[] = [];
  const appEmitter = new EventEmitter();
  const appMock = Object.assign(appEmitter, { getPath: vi.fn(() => "/tmp/userData") });
  const loggerMock = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { forkMock, mockChildren, appMock, loggerMock };
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

  it("prod mode forks with the prod-worker kind (#10526)", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost({ ...OPTS, mode: "prod" });
    host.waitForReady().catch(() => {});
    void host.start();
    const child = mockChildren[0] as MockUtilityChild;
    child.emit("message", { type: "ready" });

    const [, , options] = forkMock.mock.calls[0];
    expect(options.env.DAINTREE_UTILITY_PROCESS_KIND).toBe("plugin-prod-worker");
    host.dispose();
  });

  it("dev mode forks with the dev-worker kind (contrast with prod) (#10526)", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost({ ...OPTS, mode: "dev" });
    void host.start();
    (mockChildren[0] as MockUtilityChild).emit("message", { type: "ready" });

    const [, , options] = forkMock.mock.calls[0];
    expect(options.env.DAINTREE_UTILITY_PROCESS_KIND).toBe("plugin-dev-worker");
    host.dispose();
  });

  describe("fork-to-ready deadline (#12275)", () => {
    it("rejects start() and kills a worker that forks but never posts `ready`", async () => {
      vi.useFakeTimers();
      const { PluginDevWorkerHost } = await loadModule();
      const host = new PluginDevWorkerHost(OPTS);
      const started = host.start();
      const rejection = started.catch((err: Error) => err.message);
      // A worker whose bootstrap throws stays alive-but-mute — Electron only
      // WARNS a utility process on an unhandled rejection (#10340) — so nothing
      // but this deadline ever settles `start()`.
      const child = mockChildren[0] as MockUtilityChild;

      await vi.advanceTimersByTimeAsync(5000);

      expect(await rejection).toContain("did not become ready");
      expect(child.kill).toHaveBeenCalled();
      host.dispose();
    });

    it("does not fire once the worker posts `ready`", async () => {
      vi.useFakeTimers();
      const { PluginDevWorkerHost } = await loadModule();
      const host = new PluginDevWorkerHost(OPTS);
      const started = host.start();
      const child = mockChildren[0] as MockUtilityChild;
      child.emit("message", { type: "ready" });
      await expect(started).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(child.kill).not.toHaveBeenCalled();
      host.dispose();
    });

    it("does not charge a wedged bootstrap against the crash respawn budget", async () => {
      vi.useFakeTimers();
      const { PluginDevWorkerHost } = await loadModule();
      const host = new PluginDevWorkerHost(OPTS);
      host.start().catch(() => undefined);
      const child = mockChildren[0] as MockUtilityChild;

      await vi.advanceTimersByTimeAsync(5000);
      // The stop is deliberate, so the exit must read as expected: a bootstrap
      // that never completes is not a crash, and must not burn the budget that
      // exists for workers that genuinely die.
      const exits: Array<[number, boolean]> = [];
      host.on("exit", (code: number, expected: boolean) => exits.push([code, expected]));
      child.emit("exit", 0);
      await vi.advanceTimersByTimeAsync(0);

      expect(exits).toEqual([[0, true]]);
      host.dispose();
    });

    it("does not arm a deadline for the supervisor's own crash respawn", async () => {
      vi.useFakeTimers();
      const { PluginDevWorkerHost } = await loadModule();
      const host = new PluginDevWorkerHost(OPTS);
      host.start().catch(() => undefined);
      const first = mockChildren[0] as MockUtilityChild;
      first.emit("message", { type: "ready" });

      first.emit("exit", 139);
      await vi.advanceTimersByTimeAsync(0);
      expect(forkMock).toHaveBeenCalledTimes(2);
      const second = mockChildren[1] as MockUtilityChild;
      host.waitForReady().catch(() => undefined);

      // Nobody awaits a respawn, so a wedged one hangs no one — and the crash
      // ladder already owns the give-up policy. A deadline here would be a
      // second, competing restart policy layered over it.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(second.kill).not.toHaveBeenCalled();
      host.dispose();
    });
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

  // #12279: a retiring worker stays alive and connected until the cooperative
  // dispose lands or the grace period force-kills it, so a superseded child can
  // still speak. Anything it says would be stamped with the CURRENT generation
  // and pass every downstream staleness check. A rebuild takes this route now
  // too (#12277): PluginService disposes the host outright rather than reloading
  // the worker in place, so a crash respawn is the one path that leaves an old
  // child behind while this host is still live.
  it("ignores a superseded child once its replacement takes over (#12279)", async () => {
    const { PluginDevWorkerHost } = await loadModule();
    const host = new PluginDevWorkerHost(OPTS);
    const seen: any[] = [];
    host.on("worker-message", (m) => seen.push(m));
    void host.start();
    const oldChild = mockChildren[0] as MockUtilityChild;
    oldChild.emit("message", { type: "ready" });

    oldChild.emit("exit", 1);
    await flush();

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

  describe("protocol violations (#12276)", () => {
    /** Start a host with a live child and drop the boot `ready` handshake. */
    async function startedHost() {
      const { PluginDevWorkerHost } = await loadModule();
      const host = new PluginDevWorkerHost(OPTS);
      const forwarded: any[] = [];
      const violations: string[] = [];
      host.on("worker-message", (m) => forwarded.push(m));
      host.on("protocol-violation", (reason: string) => violations.push(reason));
      void host.start();
      const child = mockChildren[mockChildren.length - 1] as MockUtilityChild;
      child.emit("message", { type: "ready" });
      return { host, child, forwarded, violations };
    }

    it("contains a malformed message instead of throwing out of the child listener", async () => {
      const { child, forwarded, violations } = await startedHost();
      // Each of these read `msg.type` off a non-object before this fix and threw
      // a TypeError straight into `uncaughtException`.
      expect(() => child.emit("message", null)).not.toThrow();
      expect(forwarded).toHaveLength(0);
      expect(violations).toEqual(["worker sent a malformed message"]);
    });

    it("rejects primitives, unknown tags and methods outside the allowlist", async () => {
      for (const raw of [
        42,
        "host-call",
        { type: "nope" },
        { type: "host-call", requestId: "c1", method: "fs.unlink" },
        { type: "host-notify", method: "fs.readFile" },
        { type: "subscribe", subscriptionId: "s1", kind: "everything" },
        { type: "invoke-result", requestId: "i1", ok: "maybe" },
      ]) {
        const { host, child, forwarded, violations } = await startedHost();
        expect(() => child.emit("message", raw), JSON.stringify(raw)).not.toThrow();
        expect(forwarded, JSON.stringify(raw)).toHaveLength(0);
        expect(violations, JSON.stringify(raw)).toEqual(["worker sent a malformed message"]);
        host.dispose();
      }
    });

    it("admits a large but legitimate payload", async () => {
      // No blanket size ceiling. A plugin writing a big file through
      // `host.fs.writeFile` is doing something the host allows with no size
      // contract of its own, so killing it would be a worse bug than the crash
      // this validation fixes. Deliberately past the 32 MiB ceiling an earlier
      // draft imposed, so restoring one fails here.
      const { child, forwarded, violations } = await startedHost();
      const contents = "x".repeat(33 * 1024 * 1024);
      child.emit("message", {
        type: "host-call",
        requestId: "c1",
        method: "fs.writeFile",
        params: { path: "/tmp/big.bin", contents },
      });
      expect(violations).toHaveLength(0);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].params.contents).toHaveLength(contents.length);
    });

    it("does not count a protocol violation as a crash or respawn the worker", async () => {
      const { PluginDevWorkerHost } = await loadModule();
      const host = new PluginDevWorkerHost(OPTS);
      const crashLoop = vi.fn();
      const exits = vi.fn();
      const violations: string[] = [];
      host.on("crash-loop", crashLoop);
      host.on("exit", exits);
      host.on("protocol-violation", (reason: string) => violations.push(reason));
      host.start().catch(() => undefined);
      const child = mockChildren[mockChildren.length - 1] as MockUtilityChild;
      child.emit("message", { type: "ready" });

      // Three violations in a row is what the crash window would trip on, if a
      // live-but-misbehaving worker were (wrongly) accounted for as a crash.
      child.emit("message", null);
      child.emit("exit", 0);
      await flush();

      expect(violations).toEqual(["worker sent a malformed message"]);
      expect(crashLoop).not.toHaveBeenCalled();
      // No respawn: the worker is stopped, not restarted under a fresh fork.
      expect(forkMock).toHaveBeenCalledTimes(1);
      // dispose() already ran, so the exit is swallowed rather than reported.
      expect(exits).not.toHaveBeenCalled();
    });

    it("contains a throwing worker-message listener", async () => {
      const { PluginDevWorkerHost } = await loadModule();
      const host = new PluginDevWorkerHost(OPTS);
      const violations: string[] = [];
      host.on("worker-message", () => {
        throw new Error("bridge blew up");
      });
      host.on("protocol-violation", (reason: string) => violations.push(reason));
      void host.start();
      const child = mockChildren[mockChildren.length - 1] as MockUtilityChild;
      child.emit("message", { type: "ready" });
      expect(() =>
        child.emit("message", { type: "host-call", requestId: "c1", method: "getWorktrees" })
      ).not.toThrow();
      expect(violations).toEqual(["worker message handling failed"]);
      expect(child.postMessage).toHaveBeenCalledWith({ type: "dispose" });
    });

    it("stops the worker even when the violation listener throws", async () => {
      const { PluginDevWorkerHost } = await loadModule();
      const host = new PluginDevWorkerHost(OPTS);
      host.start().catch(() => undefined);
      host.on("protocol-violation", () => {
        throw new Error("bridge teardown blew up");
      });
      const child = mockChildren[mockChildren.length - 1] as MockUtilityChild;
      child.emit("message", { type: "ready" });
      expect(() => child.emit("message", null)).not.toThrow();
      expect(child.postMessage).toHaveBeenCalledWith({ type: "dispose" });
    });

    it("stops the worker even with no bridge listening", async () => {
      const { PluginDevWorkerHost } = await loadModule();
      const host = new PluginDevWorkerHost(OPTS);
      const ready = host.start();
      ready.catch(() => undefined);
      const child = mockChildren[mockChildren.length - 1] as MockUtilityChild;
      expect(() => child.emit("message", null)).not.toThrow();
      await expect(ready).rejects.toThrow(/malformed message/);
      expect(child.postMessage).toHaveBeenCalledWith({ type: "dispose" });
    });

    it("ignores anything the child says after teardown", async () => {
      const { host, child, forwarded } = await startedHost();
      host.dispose();
      expect(() => child.emit("message", null)).not.toThrow();
      expect(() =>
        child.emit("message", { type: "host-call", requestId: "c1", method: "getWorktrees" })
      ).not.toThrow();
      expect(forwarded).toHaveLength(0);
    });

    it("stops forwarding worker output once a violation kills it", async () => {
      const { child } = await startedHost();
      loggerMock.info.mockClear();
      // Positive control: while the worker is live, its stdout is forwarded.
      child.stdout.push(Buffer.from("still running"));
      await flush();
      expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining("still running"));

      child.emit("message", null);
      child.stdout.push(Buffer.from("noise on the way out"));
      await flush();
      expect(loggerMock.info).not.toHaveBeenCalledWith(
        expect.stringContaining("noise on the way out")
      );
    });

    // The suppression above is scoped to the terminal case on purpose. A normal
    // unload/idle-dispose/quit runs the plugin's own disposer, and a throw from
    // it reaches the worker's stderr AFTER dispose() has set `isDisposed` — so
    // gating on that flag would silently discard a broken disposer's only signal.
    it("still forwards worker output through a graceful teardown", async () => {
      const { host, child } = await startedHost();
      loggerMock.warn.mockClear();
      host.dispose();
      child.stderr.push(Buffer.from("[PluginDevWorker] Plugin cleanup threw: boom"));
      await flush();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining("Plugin cleanup threw: boom")
      );
    });
  });
});

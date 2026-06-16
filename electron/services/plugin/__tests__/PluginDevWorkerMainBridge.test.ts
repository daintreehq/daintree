/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PluginDevWorkerMainBridge } from "../PluginDevWorkerMainBridge.js";

class FakeWorkerHost extends EventEmitter {
  sent: any[] = [];
  ready = true;
  send = vi.fn((msg: any) => {
    this.sent.push(msg);
    return this.ready;
  });
  isReady = () => this.ready;
  off = this.removeListener;
}

function makeHost() {
  return {
    pluginId: "acme.demo",
    registerAction: vi.fn(),
    registerHandler: vi.fn(),
    broadcastToRenderer: vi.fn(),
    getActiveWorktree: vi.fn(async () => null),
    getWorktrees: vi.fn(async () => [{ id: "w1" }]),
    onDidChangeActiveWorktree: vi.fn((_cb: any) => vi.fn()),
    onDidChangeWorktrees: vi.fn((_cb: any) => vi.fn()),
    registerForgeProvider: vi.fn(() => vi.fn()),
    registerFileDecorationProvider: vi.fn(() => vi.fn()),
    invalidateFileDecorations: vi.fn(),
    showToast: vi.fn(async () => {}),
    dispatch: vi.fn(async () => ({ ok: true, result: undefined })),
    actions: {
      list: vi.fn(async () => [{ id: "terminal.new", danger: "safe", requiresArgs: false }]),
      get: vi.fn(async (id: string) => ({ id, danger: "safe", requiresArgs: false })),
      canDispatch: vi.fn(async () => "ok"),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      onDidChange: vi.fn(() => vi.fn()),
    },
    storage: {
      // Annotated `Promise<unknown>` so a test can `mockResolvedValueOnce` a
      // concrete value (the default-inferred `Promise<undefined>` would reject it).
      get: vi.fn(async (): Promise<unknown> => undefined),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      onDidChange: vi.fn((_key: any, _cb: any) => vi.fn()),
    },
    process: {
      spawn: vi.fn(async () => ({
        id: "p0",
        kill: vi.fn(),
        restart: vi.fn(async () => {}),
        onExit: vi.fn(() => vi.fn()),
        onCrash: vi.fn(() => vi.fn()),
      })),
    },
    fs: {
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
      stat: vi.fn(async () => ({})),
      watch: vi.fn(async (_paths: string[], _cb: (p: string) => void) => vi.fn()),
    },
    clipboard: {
      writeText: vi.fn(async () => {}),
      readText: vi.fn(async () => "clip-contents"),
    },
  };
}

/** A controllable spawned-process handle whose lifecycle callbacks can be fired. */
function makeProcessHandle(id = "p1") {
  let exitCb: ((info: unknown) => void) | undefined;
  let crashCb: ((info: unknown) => void) | undefined;
  return {
    id,
    kill: vi.fn(),
    restart: vi.fn(async () => {}),
    onExit: vi.fn((cb: (info: unknown) => void) => {
      exitCb = cb;
      return vi.fn();
    }),
    onCrash: vi.fn((cb: (info: unknown) => void) => {
      crashCb = cb;
      return vi.fn();
    }),
    emitExit: (info: unknown) => exitCb?.(info),
    emitCrash: (info: unknown) => crashCb?.(info),
  };
}

function makeBridge(
  overrides?: Partial<{
    capabilities: string[];
    clear: () => void;
    onActivationResult: (r: { ok: true } | { ok: false; error: string; stack?: string }) => void;
  }>
) {
  const host = makeHost();
  const workerHost = new FakeWorkerHost();
  const clear = overrides?.clear ?? vi.fn();
  const onActivationResult = overrides?.onActivationResult ?? vi.fn();
  const bridge = new PluginDevWorkerMainBridge({
    pluginId: "acme.demo",
    host: host as any,
    workerHost: workerHost as any,
    getCapabilities: () => overrides?.capabilities ?? [],
    clearPriorRegistrations: clear,
    onActivationResult,
  });
  return { host, workerHost, bridge, clear, onActivationResult };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("PluginDevWorkerMainBridge", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("routes a host-call to the real host and replies with host-result", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c1",
      method: "getWorktrees",
      params: undefined,
    });
    await flush();
    expect(host.getWorktrees).toHaveBeenCalled();
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c1");
    expect(result).toMatchObject({ ok: true, result: [{ id: "w1" }] });
  });

  it("routes clipboard.writeText to the host and replies with undefined", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "cw",
      method: "clipboard.writeText",
      params: { text: "hello" },
    });
    await flush();
    expect(host.clipboard.writeText).toHaveBeenCalledWith("hello");
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "cw");
    expect(result).toMatchObject({ ok: true, result: undefined });
  });

  it("routes clipboard.readText to the host and replies with its text", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "cr",
      method: "clipboard.readText",
      params: undefined,
    });
    await flush();
    expect(host.clipboard.readText).toHaveBeenCalled();
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "cr");
    expect(result).toMatchObject({ ok: true, result: "clip-contents" });
  });

  it("relays an empty clipboard read as ok:true with an empty string", async () => {
    const { host, workerHost } = makeBridge();
    host.clipboard.readText.mockResolvedValueOnce("");
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "ce",
      method: "clipboard.readText",
      params: undefined,
    });
    await flush();
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "ce");
    expect(result).toMatchObject({ ok: true, result: "" });
  });

  it("replies host-result ok:false when the host method throws", async () => {
    const { host, workerHost } = makeBridge();
    host.getWorktrees.mockRejectedValueOnce(new Error("boom"));
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c2",
      method: "getWorktrees",
      params: undefined,
    });
    await flush();
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c2");
    expect(result).toMatchObject({ ok: false, error: "boom" });
  });

  it("routes actions.list to the real host (#10561)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "a1",
      method: "actions.list",
      params: undefined,
    });
    await flush();
    expect(host.actions.list).toHaveBeenCalledTimes(1);
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "a1");
    expect(result).toMatchObject({
      ok: true,
      result: [{ id: "terminal.new", danger: "safe", requiresArgs: false }],
    });
  });

  it("routes actions.get with the action id to the real host (#10561)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "a2",
      method: "actions.get",
      params: { actionId: "recipe.run" },
    });
    await flush();
    expect(host.actions.get).toHaveBeenCalledWith("recipe.run");
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "a2");
    expect(result).toMatchObject({ ok: true, result: { id: "recipe.run" } });
  });

  it("registerAction wires a wrapper that round-trips invocation to the worker", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerAction",
      registrationKey: "action:acme.demo.greet",
      params: {
        descriptor: {
          id: "greet",
          title: "Greet",
          description: "",
          category: "Demo",
          kind: "command",
          danger: "safe",
        },
      },
    });
    expect(host.registerAction).toHaveBeenCalledTimes(1);
    const wrapper = host.registerAction.mock.calls[0][1] as (a: unknown) => Promise<unknown>;

    const resultPromise = wrapper({ name: "world" });
    const invoke = workerHost.sent.find((m) => m.type === "invoke" && m.kind === "action");
    expect(invoke).toMatchObject({ namespacedId: "acme.demo.greet", args: { name: "world" } });

    // Worker replies.
    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: invoke.requestId,
      ok: true,
      result: "hello world",
    });
    await expect(resultPromise).resolves.toBe("hello world");
  });

  it("fails closed on a typed handler whose required capability is undeclared", async () => {
    const { host, workerHost } = makeBridge({ capabilities: [] });
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerHandler",
      registrationKey: "handler:secret",
      params: { channel: "secret", hasSchema: true, requires: ["worktree:read"] },
    });
    // host-notify dispatch is async (the host registration methods are
    // Promise-returning); flush microtasks so the capability-gate rejection
    // routes to register-error before asserting.
    await flush();
    expect(host.registerHandler).not.toHaveBeenCalled();
    const err = workerHost.sent.find((m) => m.type === "register-error");
    expect(err).toMatchObject({ registrationKey: "handler:secret" });
    expect(err.error).toMatch(/PERMISSION_REQUIRED/);
  });

  it("registers a typed handler when its required capability is declared", async () => {
    const { host, workerHost } = makeBridge({ capabilities: ["worktree:read"] });
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerHandler",
      params: { channel: "ok", hasSchema: true, requires: ["worktree:read"] },
    });
    expect(host.registerHandler).toHaveBeenCalledWith("ok", expect.any(Function));
  });

  it("opens a worktree subscription and pushes events to the worker", async () => {
    const { host, workerHost } = makeBridge();
    let emitActive: ((s: unknown) => void) | undefined;
    host.onDidChangeActiveWorktree.mockImplementation((cb: any) => {
      emitActive = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s1",
      kind: "active-worktree",
    });
    expect(host.onDidChangeActiveWorktree).toHaveBeenCalled();
    emitActive?.({ id: "w9" });
    const evt = workerHost.sent.find((m) => m.type === "subscription-event");
    expect(evt).toMatchObject({ subscriptionId: "s1", payload: { id: "w9" } });
  });

  it("disposes a subscription on unsubscribe", async () => {
    const { host, workerHost } = makeBridge();
    const dispose = vi.fn();
    host.onDidChangeWorktrees.mockReturnValueOnce(dispose);
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s2",
      kind: "worktrees",
    });
    // Subscribe is async now (onDidChangeWorktrees resolves the disposer); flush
    // so the disposer is recorded before the unsubscribe looks it up — mirrors
    // the per-message task boundary the MessagePort provides in production.
    await flush();
    workerHost.emit("worker-message", { type: "unsubscribe", subscriptionId: "s2" });
    expect(dispose).toHaveBeenCalled();
  });

  it("routes storage.get/set/delete host-calls to the real host", async () => {
    const { host, workerHost } = makeBridge();
    host.storage.get.mockResolvedValueOnce("stored");

    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "sg",
      method: "storage.get",
      params: { key: "k", scope: "worktree" },
    });
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "ss",
      method: "storage.set",
      params: { key: "k", value: 7, scope: "project" },
    });
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "sd",
      method: "storage.delete",
      params: { key: "k", scope: "user" },
    });
    await flush();

    expect(host.storage.get).toHaveBeenCalledWith("k", "worktree");
    expect(host.storage.set).toHaveBeenCalledWith("k", 7, "project");
    expect(host.storage.delete).toHaveBeenCalledWith("k", "user");

    const getReply = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "sg");
    expect(getReply).toMatchObject({ ok: true, result: "stored" });
    const setReply = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "ss");
    expect(setReply).toMatchObject({ ok: true, result: undefined });
    const delReply = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "sd");
    expect(delReply).toMatchObject({ ok: true, result: undefined });
  });

  // #10586: an omitted scope must reach the real host as `undefined` (not a
  // defaulted "user") so the host resolves the key's manifest-declared scope. A
  // forwarded "user" would make the host reject a project-scoped key.
  it("forwards settings.get with an omitted scope as undefined", async () => {
    const { host, workerHost } = makeBridge();
    host.settings.get.mockResolvedValueOnce("project-value");
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "sgu",
      method: "settings.get",
      params: { key: "ref" },
    });
    await flush();
    expect(host.settings.get).toHaveBeenCalledWith("ref", undefined);
    const reply = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "sgu");
    expect(reply).toMatchObject({ ok: true, result: "project-value" });
  });

  it("forwards an explicit settings.get scope unchanged", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "sge",
      method: "settings.get",
      params: { key: "ref", scope: "project" },
    });
    await flush();
    expect(host.settings.get).toHaveBeenCalledWith("ref", "project");
  });

  it("opens a storage subscription and pushes events to the worker", async () => {
    const { host, workerHost } = makeBridge();
    let emit: ((v: unknown) => void) | undefined;
    host.storage.onDidChange.mockImplementation((_key: any, cb: any) => {
      emit = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "st1",
      kind: "storage",
      key: "k",
      scope: "worktree",
    });
    await flush();
    expect(host.storage.onDidChange).toHaveBeenCalledWith("k", expect.any(Function), "worktree");
    emit?.("v9");
    const evt = workerHost.sent.find((m) => m.type === "subscription-event");
    expect(evt).toMatchObject({ subscriptionId: "st1", payload: "v9" });
  });

  it("drops a storage subscription that is missing its key", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "st2",
      kind: "storage",
    });
    await flush();
    expect(host.storage.onDidChange).not.toHaveBeenCalled();
    // The bridge never sends a subscription-event for the dropped subscription.
    expect(workerHost.sent.some((m) => m.type === "subscription-event")).toBe(false);
  });

  it("resolves waitForActivation on `activated` and rejects on `activate-error`", async () => {
    const ok = makeBridge();
    const okPromise = ok.bridge.waitForActivation();
    ok.workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
    await expect(okPromise).resolves.toBeUndefined();

    const bad = makeBridge();
    const badPromise = bad.bridge.waitForActivation();
    bad.workerHost.emit("worker-message", { type: "activate-error", error: "nope" });
    await expect(badPromise).rejects.toThrow("nope");
  });

  it("reports every activation outcome, including post-reload, via onActivationResult", async () => {
    const onActivationResult = vi.fn();
    const { workerHost, bridge } = makeBridge({ onActivationResult });
    bridge.waitForActivation().catch(() => {});

    // Initial activation succeeds.
    workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
    // Reload, then the reloaded generation fails to activate.
    workerHost.emit("reloading");
    workerHost.emit("worker-message", { type: "activate-error", error: "broke on reload" });

    expect(onActivationResult).toHaveBeenNthCalledWith(1, { ok: true });
    expect(onActivationResult).toHaveBeenNthCalledWith(2, { ok: false, error: "broke on reload" });
  });

  it("surfaces a dev-worker crash loop as a loadError via onActivationResult", async () => {
    const onActivationResult = vi.fn();
    const { workerHost, bridge } = makeBridge({ onActivationResult });
    bridge.waitForActivation().catch(() => {});

    // Activate first, so the crash loop trips after a successful activation —
    // the regression this guards: the post-activation crash never reached
    // provenance because onCrashLoop only rejected the (already-settled)
    // activation promise.
    workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
    workerHost.emit("crash-loop", 42);

    expect(onActivationResult).toHaveBeenNthCalledWith(1, { ok: true });
    expect(onActivationResult).toHaveBeenNthCalledWith(2, {
      ok: false,
      error: expect.stringContaining("crash loop (code 42)"),
    });
  });

  it("surfaces a crash loop that trips before the first activation", async () => {
    const onActivationResult = vi.fn();
    const { workerHost, bridge } = makeBridge({ onActivationResult });
    const activation = bridge.waitForActivation();
    activation.catch(() => {});

    workerHost.emit("crash-loop", 7);

    await expect(activation).rejects.toThrow("crash loop");
    expect(onActivationResult).toHaveBeenCalledTimes(1);
    expect(onActivationResult).toHaveBeenCalledWith({
      ok: false,
      error: expect.stringContaining("crash loop (code 7)"),
    });
  });

  it("registerFileDecorationProvider wires a proxy impl that round-trips provideDecorations", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerFileDecorationProvider",
      registrationKey: "fileDecorationProvider:acme.demo.deco",
      params: { descriptor: { id: "acme.demo.deco", scopes: ["pr"] } },
    });
    expect(host.registerFileDecorationProvider).toHaveBeenCalledTimes(1);
    const [descriptor, proxyImpl] = host.registerFileDecorationProvider.mock
      .calls[0] as unknown as [
      { id: string },
      { provideDecorations: (s: string, p: string[]) => Promise<unknown> },
    ];
    expect(descriptor).toMatchObject({ id: "acme.demo.deco", scopes: ["pr"] });

    const resultPromise = proxyImpl.provideDecorations("pr", ["a.ts", "b.ts"]);
    const invoke = workerHost.sent.find(
      (m) => m.type === "invoke" && m.kind === "file-decoration-method"
    );
    expect(invoke).toMatchObject({
      providerId: "acme.demo.deco",
      method: "provideDecorations",
      args: ["pr", ["a.ts", "b.ts"]],
    });

    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: invoke.requestId,
      ok: true,
      result: { "a.ts": { badge: "M" } },
    });
    await expect(resultPromise).resolves.toEqual({ "a.ts": { badge: "M" } });
  });

  it("unregisterFileDecorationProvider disposes the host registration", async () => {
    const { host, workerHost } = makeBridge();
    const dispose = vi.fn();
    host.registerFileDecorationProvider.mockReturnValueOnce(dispose);
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerFileDecorationProvider",
      params: { descriptor: { id: "acme.demo.deco" } },
    });
    // registerFileDecorationProvider records its disposer after awaiting the
    // (now Promise-returning) host registration; flush so the unregister finds it.
    await flush();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "unregisterFileDecorationProvider",
      params: { providerId: "acme.demo.deco" },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes registered providers on reload", async () => {
    const { host, workerHost, bridge } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    const dispose = vi.fn();
    host.registerFileDecorationProvider.mockReturnValueOnce(dispose);
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerFileDecorationProvider",
      params: { descriptor: { id: "acme.demo.deco" } },
    });
    // Let the async registration record its disposer before reload tears it down
    // (the register message and the reload event are distinct tasks in prod).
    await flush();
    workerHost.emit("reloading");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("clears prior registrations and fails pending invokes on reload", async () => {
    const { host, workerHost, bridge, clear } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    // Register an action and start an invocation that never gets a reply.
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerAction",
      params: {
        descriptor: {
          id: "greet",
          title: "Greet",
          description: "",
          category: "Demo",
          kind: "command",
          danger: "safe",
        },
      },
    });
    const wrapper = host.registerAction.mock.calls[0][1] as (a: unknown) => Promise<unknown>;
    const pending = wrapper({});
    pending.catch(() => {});

    workerHost.emit("reloading");
    expect(clear).toHaveBeenCalled();
    await expect(pending).rejects.toThrow(/reloaded/);
  });

  it("drops a subscription event queued before a reload (generation guard) (#10526)", async () => {
    const { host, workerHost, bridge } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    let emitActive: ((s: unknown) => void) | undefined;
    host.onDidChangeActiveWorktree.mockImplementation((cb: any) => {
      emitActive = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s1",
      kind: "active-worktree",
    });
    await flush();
    // A reload bumps the generation and tears the old subscription down.
    workerHost.emit("reloading");
    workerHost.sent.length = 0;
    // A late event from the now-dead subscription must NOT reach the new worker
    // (its proxy resets subscriptionIds and could collide on "s1").
    emitActive?.({ id: "stale" });
    expect(workerHost.sent.find((m) => m.type === "subscription-event")).toBeUndefined();
  });

  it("forwards the activate-error stack through onActivationResult (#10526)", async () => {
    const onActivationResult = vi.fn();
    const { workerHost, bridge } = makeBridge({ onActivationResult });
    bridge.waitForActivation().catch(() => {});
    workerHost.emit("worker-message", {
      type: "activate-error",
      error: "boom",
      stack: "Error: boom\n  at activate",
    });
    expect(onActivationResult).toHaveBeenCalledWith({
      ok: false,
      error: "boom",
      stack: "Error: boom\n  at activate",
    });
  });

  describe("host.process relay (#10526)", () => {
    async function spawn(workerHost: any, host: any, handle = makeProcessHandle("p1")) {
      host.process.spawn.mockResolvedValueOnce(handle);
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "spawn1",
        method: "process.spawn",
        params: { command: "node", options: { args: ["x.js"] } },
      });
      await flush();
      return handle;
    }

    it("relays spawn to the host and replies with the handle id", async () => {
      const { host, workerHost } = makeBridge();
      await spawn(workerHost, host);
      expect(host.process.spawn).toHaveBeenCalledWith("node", { args: ["x.js"] });
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "spawn1"
      );
      expect(res).toMatchObject({ ok: true, result: { id: "p1" } });
    });

    it("process.kill notify kills the stored handle", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host);
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.kill",
        params: { processId: "p1" },
      });
      await flush();
      expect(handle.kill).toHaveBeenCalled();
    });

    it("process.restart awaits the stored handle's restart", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host);
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "r1",
        method: "process.restart",
        params: { processId: "p1" },
      });
      await flush();
      expect(handle.restart).toHaveBeenCalled();
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "r1"
      );
      expect(res).toMatchObject({ ok: true });
    });

    it("process.restart for an unknown process replies with an error", async () => {
      const { workerHost } = makeBridge();
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "r2",
        method: "process.restart",
        params: { processId: "ghost" },
      });
      await flush();
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "r2"
      );
      expect(res).toMatchObject({ ok: false });
      expect(res.error).toMatch(/No live process/);
    });

    it("process-exit subscription pushes exit events to the worker", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host);
      workerHost.emit("worker-message", {
        type: "subscribe",
        subscriptionId: "s1",
        kind: "process-exit",
        processId: "p1",
      });
      expect(handle.onExit).toHaveBeenCalled();
      handle.emitExit({ exitCode: 0, signal: null });
      const evt = workerHost.sent.find(
        (m: any) => m.type === "subscription-event" && m.subscriptionId === "s1"
      );
      expect(evt).toMatchObject({ payload: { exitCode: 0, signal: null } });
    });

    it("process-crash subscription wires onCrash", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host);
      workerHost.emit("worker-message", {
        type: "subscribe",
        subscriptionId: "s2",
        kind: "process-crash",
        processId: "p1",
      });
      expect(handle.onCrash).toHaveBeenCalled();
    });

    it("kills spawned processes on dispose", async () => {
      const { host, workerHost, bridge } = makeBridge();
      bridge.waitForActivation().catch(() => {});
      const handle = await spawn(workerHost, host);
      bridge.dispose();
      expect(handle.kill).toHaveBeenCalled();
    });

    it("kills spawned processes on reload", async () => {
      const { host, workerHost, bridge } = makeBridge();
      bridge.waitForActivation().catch(() => {});
      const handle = await spawn(workerHost, host);
      workerHost.emit("reloading");
      expect(handle.kill).toHaveBeenCalled();
    });
  });

  describe("host.fs.watch relay (#10526)", () => {
    it("wires the host watcher and pushes change events keyed by subscription id", async () => {
      const { host, workerHost } = makeBridge();
      let changeCb: ((p: string) => void) | undefined;
      host.fs.watch.mockImplementationOnce(async (_paths: string[], cb: (p: string) => void) => {
        changeCb = cb;
        return vi.fn();
      });
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "w1",
        method: "fs.watch",
        params: { subscriptionId: "fs1", paths: ["/repo/a.ts"] },
      });
      await flush();
      expect(host.fs.watch).toHaveBeenCalledWith(
        ["/repo/a.ts"],
        expect.any(Function),
        expect.objectContaining({ signal: expect.anything() })
      );
      changeCb?.("/repo/a.ts");
      const evt = workerHost.sent.find(
        (m: any) => m.type === "subscription-event" && m.subscriptionId === "fs1"
      );
      expect(evt).toMatchObject({ payload: "/repo/a.ts" });
    });

    it("disposes the watcher on unsubscribe", async () => {
      const { host, workerHost } = makeBridge();
      const dispose = vi.fn();
      host.fs.watch.mockResolvedValueOnce(dispose);
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "w2",
        method: "fs.watch",
        params: { subscriptionId: "fs2", paths: ["/repo"] },
      });
      await flush();
      workerHost.emit("worker-message", { type: "unsubscribe", subscriptionId: "fs2" });
      expect(dispose).toHaveBeenCalled();
    });

    it("replies with an error when the host watch rejects", async () => {
      const { host, workerHost } = makeBridge();
      host.fs.watch.mockRejectedValueOnce(new Error("PERMISSION_REQUIRED: fs:project-read"));
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "w3",
        method: "fs.watch",
        params: { subscriptionId: "fs3", paths: ["/nope"] },
      });
      await flush();
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "w3"
      );
      expect(res).toMatchObject({ ok: false });
      expect(res.error).toMatch(/PERMISSION_REQUIRED/);
    });
  });
});

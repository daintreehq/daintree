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
    // Annotated `Promise<void>` so a test can drive the deep-validation outcome
    // (`mockReturnValueOnce` a still-pending promise, `mockRejectedValueOnce` a
    // rejection); the default-inferred `undefined` return would reject both.
    registerAction: vi.fn((_descriptor: any, _handler: any): Promise<void> => Promise.resolve()),
    registerHandler: vi.fn((_channel: any, _handler: any): Promise<void> => Promise.resolve()),
    broadcastToRenderer: vi.fn(),
    getActiveWorktree: vi.fn(async () => null),
    getWorktrees: vi.fn(async () => [{ id: "w1" }]),
    getWorktreesResult: vi.fn(async () => ({
      status: "ok",
      projectId: "project-1",
      worktrees: [{ id: "w1" }],
    })),
    onDidChangeActiveWorktree: vi.fn((_cb: any) => vi.fn()),
    onDidChangeWorktrees: vi.fn((_cb: any) => vi.fn()),
    onDidWake: vi.fn((_cb: any) => vi.fn()),
    registerForgeProvider: vi.fn(() => vi.fn()),
    registerFileDecorationProvider: vi.fn(() => vi.fn()),
    invalidateFileDecorations: vi.fn(),
    setPanelBadge: vi.fn(async () => {}),
    showToast: vi.fn(async () => {}),
    showQuickPick: vi.fn(async (): Promise<unknown> => undefined),
    showInputBox: vi.fn(async (): Promise<unknown> => undefined),
    showConfirm: vi.fn(async () => false),
    dispatch: vi.fn(async () => ({ ok: true, result: undefined })),
    actions: {
      list: vi.fn(async () => [{ id: "terminal.new", danger: "safe", requiresArgs: false }]),
      get: vi.fn(async (id: string) => ({ id, danger: "safe", requiresArgs: false })),
      canDispatch: vi.fn(async () => "ok"),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      // Annotated `Promise<unknown>` so a test can `mockResolvedValueOnce` a
      // concrete value (the default-inferred `Promise<undefined>` would reject it).
      get: vi.fn(async (): Promise<unknown> => undefined),
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

/** The PTY variant: adds the two methods the bridge's structural check reads. */
function makePtyProcessHandle(id = "p1") {
  const base = makeProcessHandle(id);
  let dataCb: ((chunk: unknown) => void) | undefined;
  return {
    ...base,
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn((cb: (chunk: unknown) => void) => {
      dataCb = cb;
      return vi.fn();
    }),
    emitData: (chunk: unknown) => dataCb?.(chunk),
  };
}

/**
 * The duplex variant (#11871): a writable handle with NO `resize`. This is the
 * shape that must be classified as "duplex", not misread as pipe (which would
 * strand the plugin without a write) or as pty (which would offer a resize the
 * child has no terminal for).
 */
function makeDuplexProcessHandle(id = "p1") {
  const base = makeProcessHandle(id);
  let dataCb: ((chunk: unknown) => void) | undefined;
  return {
    ...base,
    write: vi.fn(),
    onData: vi.fn((cb: (chunk: unknown) => void) => {
      dataCb = cb;
      return vi.fn();
    }),
    emitData: (chunk: unknown) => dataCb?.(chunk),
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

  it("relays getWorktreesResult and returns the union object unchanged (#12174)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-wr",
      method: "getWorktreesResult",
      params: undefined,
    });
    await flush();
    expect(host.getWorktreesResult).toHaveBeenCalled();
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-wr");
    expect(result).toMatchObject({
      ok: true,
      result: { status: "ok", projectId: "project-1", worktrees: [{ id: "w1" }] },
    });
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

  it("forwards setPanelBadge host-notify to the real host (#10585)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "setPanelBadge",
      params: { panelId: "panel-1", badge: { kind: "label", text: "CI", color: "success" } },
    });
    await flush();
    expect(host.setPanelBadge).toHaveBeenCalledWith("panel-1", {
      kind: "label",
      text: "CI",
      color: "success",
    });
  });

  it("forwards a null setPanelBadge (clear) host-notify to the real host (#10585)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "setPanelBadge",
      params: { panelId: "panel-1", badge: null },
    });
    await flush();
    expect(host.setPanelBadge).toHaveBeenCalledWith("panel-1", null);
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

  it("routes a system-wake subscription to host.onDidWake (#12175)", async () => {
    const { host, workerHost } = makeBridge();
    let emitWake: ((e: unknown) => void) | undefined;
    host.onDidWake.mockImplementation((cb: any) => {
      emitWake = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s-wake",
      kind: "system-wake",
    });
    expect(host.onDidWake).toHaveBeenCalled();
    emitWake?.({ sleepDuration: 42_000, timestamp: 1234 });
    const evt = workerHost.sent.find((m) => m.type === "subscription-event");
    expect(evt).toMatchObject({
      subscriptionId: "s-wake",
      payload: { sleepDuration: 42_000, timestamp: 1234 },
    });
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

  describe("required registration activation (#12282)", () => {
    /** A registration whose main-side deep validation the test drives by hand. */
    function deferred(): {
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
    } {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = () => res();
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    /** The shape the worker proxy posts for `registerAction` — keyed, so it is a
     * required registration the activation commit has to account for. */
    const ACTION_NOTIFY = {
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
    };

    it("holds activation open until a required registration settles", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const gate = deferred();
      host.registerAction.mockReturnValueOnce(gate.promise);
      let resolved = false;
      const activation = bridge.waitForActivation().then(() => {
        resolved = true;
      });

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();

      // `activated` has landed, but the contribution the plugin believes it made
      // is still unvalidated — committing here is the bug.
      expect(resolved).toBe(false);
      expect(onActivationResult).not.toHaveBeenCalled();

      gate.resolve();
      await activation;
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
    });

    it("tracks two proposals of the same registration key independently", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const first = deferred();
      const second = deferred();
      host.registerAction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      bridge.waitForActivation().catch(() => {});

      // Re-registering an id is legal (replace semantics), so the key is not a
      // unique handle — only object identity stops one proposal from releasing
      // the other's slot and committing while validation is still outstanding.
      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });

      second.resolve();
      await flush();
      expect(onActivationResult).not.toHaveBeenCalled();

      first.resolve();
      await flush();
      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
    });

    it("does not commit before `activated`, even with every registration settled", async () => {
      const onActivationResult = vi.fn();
      const { workerHost, bridge } = makeBridge({ onActivationResult });
      let resolved = false;
      const activation = bridge.waitForActivation().then(() => {
        resolved = true;
      });

      // activate() registered early and is still awaiting other work. A settled
      // registration is not an activation.
      workerHost.emit("worker-message", ACTION_NOTIFY);
      await flush();
      expect(resolved).toBe(false);
      expect(onActivationResult).not.toHaveBeenCalled();

      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await activation;
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
    });

    it("drops a required registration that settles after dispose", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const gate = deferred();
      host.registerAction.mockReturnValueOnce(gate.promise);
      const activation = bridge.waitForActivation();

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      bridge.dispose();
      await expect(activation).rejects.toThrow(/disposed/);

      onActivationResult.mockClear();
      workerHost.sent.length = 0;
      gate.reject(new Error("host went away"));
      await flush();

      expect(onActivationResult).not.toHaveBeenCalled();
      expect(workerHost.sent).toEqual([]);
    });

    it("fails activation naming the contribution when a required registration is rejected", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      host.registerAction.mockRejectedValueOnce(
        new Error('descriptor.id "greet" is not declared in contributes.actions')
      );
      const activation = bridge.waitForActivation();

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });

      await expect(activation).rejects.toThrow(/action:acme\.demo\.greet/);
      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith({
        ok: false,
        error: expect.stringContaining('registration "action:acme.demo.greet" was rejected'),
        stack: expect.any(String),
      });
      expect(onActivationResult.mock.calls[0][0].error).toContain("contributes.actions");
      // The worker's own terminal feedback must not regress.
      expect(workerHost.sent.find((m) => m.type === "register-error")).toMatchObject({
        registrationKey: "action:acme.demo.greet",
      });
    });

    it("remembers a registration rejection that lands before `activated`", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      host.registerAction.mockRejectedValueOnce(new Error("not declared"));
      bridge.waitForActivation().catch(() => {});

      workerHost.emit("worker-message", ACTION_NOTIFY);
      await flush();
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();

      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    });

    it("neither waits for nor fails activation on notifications without a registration key", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      // A never-settling call and a rejecting one. Neither is a contribution, so
      // neither participates in the activation commit.
      host.setPanelBadge
        .mockReturnValueOnce(deferred().promise)
        .mockRejectedValueOnce(new Error("bad badge"));
      const activation = bridge.waitForActivation();

      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "setPanelBadge",
        params: { panelId: "p1", badge: { kind: "label", text: "CI", color: "success" } },
      });
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "setPanelBadge",
        params: { panelId: "p2", badge: null },
      });
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });

      await expect(activation).resolves.toBeUndefined();
      await flush();
      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
      expect(workerHost.sent.find((m) => m.type === "register-error")).toBeUndefined();
    });

    it("keeps the contribution-specific failure when activate-error follows it", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      host.registerAction.mockRejectedValueOnce(new Error("not declared"));
      bridge.waitForActivation().catch(() => {});

      workerHost.emit("worker-message", ACTION_NOTIFY);
      await flush();
      workerHost.emit("worker-message", { type: "activate-error", error: "activate() threw" });

      // The rejected contribution names what the author has to fix; the vaguer
      // activate-error that follows must not overwrite it.
      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult.mock.calls[0][0].error).toContain("action:acme.demo.greet");
    });

    it("keeps activate-error terminal while a required registration is still pending", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const gate = deferred();
      host.registerAction.mockReturnValueOnce(gate.promise);
      bridge.waitForActivation().catch(() => {});

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      workerHost.emit("worker-message", { type: "activate-error", error: "boom" });
      // The straggler settling successfully must not commit over the failure.
      gate.resolve();
      await flush();

      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: "boom" })
      );
    });

    it("ignores a required registration that rejects after a reload", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const stale = deferred();
      host.registerAction.mockReturnValueOnce(stale.promise);
      bridge.waitForActivation().catch(() => {});

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("reloading");
      // The replacement boots, re-proposes the same contribution, activates.
      workerHost.emit("ready");
      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });

      onActivationResult.mockClear();
      workerHost.sent.length = 0;
      stale.reject(new Error("dead generation"));
      await flush();

      expect(onActivationResult).not.toHaveBeenCalled();
      expect(workerHost.sent.find((m) => m.type === "register-error")).toBeUndefined();
    });

    it("reports a registration rejected after activation already succeeded", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const activation = bridge.waitForActivation();

      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await expect(activation).resolves.toBeUndefined();

      host.registerAction.mockRejectedValueOnce(new Error("too late"));
      workerHost.emit("worker-message", ACTION_NOTIFY);
      await flush();

      // The activation promise has settled and has no listener left, so
      // provenance is the only channel that still reaches the author.
      expect(onActivationResult).toHaveBeenNthCalledWith(1, { ok: true });
      expect(onActivationResult).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          ok: false,
          error: expect.stringContaining("action:acme.demo.greet"),
        })
      );
    });

    it("lets a dying worker's activate-error veto neither the replacement nor its success", async () => {
      const onActivationResult = vi.fn();
      const { workerHost, bridge } = makeBridge({ onActivationResult });
      bridge.waitForActivation().catch(() => {});

      // A reload lands while activate() is still awaiting a host call: worker
      // disposal rejects that call, so the OUTGOING child posts activate-error
      // after `reloading` already bumped the generation. It describes a worker
      // that no longer exists and must not bind the one now booting.
      workerHost.emit("reloading");
      workerHost.emit("worker-message", { type: "activate-error", error: "torn down mid-await" });
      workerHost.emit("exit", 0, true);
      // What the outgoing child died of still reaches provenance...
      expect(onActivationResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: "torn down mid-await" })
      );
      onActivationResult.mockClear();

      // ...but it must not veto the replacement, whose success clears it again.
      workerHost.emit("ready");
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();

      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
    });

    it("does not enlist a required registration posted by a retired worker", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      bridge.waitForActivation().catch(() => {});

      // Same gap, a keyed host-notify this time: the straggler's rejection is
      // still reported to the worker, but it is not the booting generation's
      // contribution and cannot fail its activation.
      workerHost.emit("reloading");
      host.registerAction.mockRejectedValueOnce(new Error("not declared"));
      workerHost.emit("worker-message", ACTION_NOTIFY);
      await flush();
      expect(onActivationResult).not.toHaveBeenCalled();
      // The worker still gets told, exactly as before.
      expect(workerHost.sent.find((m) => m.type === "register-error")).toMatchObject({
        registrationKey: "action:acme.demo.greet",
      });

      workerHost.emit("ready");
      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();

      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
    });

    it("clears a registration failure so the next generation can activate", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      host.registerAction.mockRejectedValueOnce(new Error("not declared"));
      bridge.waitForActivation().catch(() => {});

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();
      expect(onActivationResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));

      // The author fixes the manifest and saves — the reloaded generation starts
      // from a clean verdict.
      workerHost.emit("reloading");
      workerHost.emit("ready");
      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();

      expect(onActivationResult).toHaveBeenLastCalledWith({ ok: true });
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

  it("fails pending invokes when the worker crashes (#12216)", async () => {
    const { host, workerHost, bridge } = makeBridge();
    bridge.waitForActivation().catch(() => {});
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

    // A crash, not a reload: the host respawns a worker that has never seen
    // this request id, so nothing will ever reply to it. Before #12216 the
    // caller simply waited forever.
    workerHost.emit("exit", 139, false);

    await expect(pending).rejects.toThrow(/crashed \(code 139\)/);
  });

  it("fails pending invokes when the worker exits expectedly (#12216)", async () => {
    const { host, workerHost, bridge } = makeBridge();
    bridge.waitForActivation().catch(() => {});
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

    workerHost.emit("exit", 0, true);

    await expect(pending).rejects.toThrow(/stopped before invocation completed/);
  });

  it("aborts in-flight host calls when the worker dies (#12216)", async () => {
    const { host, workerHost, bridge } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    let seenSignal: AbortSignal | undefined;
    host.fs.readFile.mockImplementation((async (_p: string, opts: { signal?: AbortSignal }) => {
      seenSignal = opts.signal;
      return new Promise<string>(() => {});
    }) as unknown as () => Promise<string>);
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "h1",
      method: "fs.readFile",
      params: { path: "/repo/a.txt" },
    });
    await flush();

    workerHost.emit("exit", 139, false);
    // The worker is gone, so the read has nowhere to deliver — cancel the I/O
    // rather than let it complete against a dead generation.
    expect(seenSignal?.aborted).toBe(true);
  });

  // #12279: a prompt is the one host call the user can SEE. Retiring the
  // generation that asked must take the question off the screen, not just drop
  // the answer — otherwise the user is left answering a dead worker, and the
  // per-plugin one-prompt cap makes the successor's first prompt resolve
  // instantly to its cancel value.
  describe.each([
    { method: "showQuickPick", params: { items: [{ id: "a", label: "A" }] }, signalArg: 2 },
    { method: "showInputBox", params: { options: {} }, signalArg: 1 },
    { method: "showConfirm", params: { options: { title: "Sure?" } }, signalArg: 1 },
  ])("$method cancellation (#12279)", ({ method, params, signalArg }) => {
    const openPrompt = async (host: any, workerHost: FakeWorkerHost) => {
      let seenSignal: AbortSignal | undefined;
      host[method].mockImplementation((...args: any[]) => {
        seenSignal = args[signalArg]?.signal;
        // A prompt has no deadline — it stays open until the user answers.
        return new Promise(() => {});
      });
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "p1",
        method,
        params,
      });
      await flush();
      return () => seenSignal;
    };

    it("forwards a signal that the reload boundary aborts", async () => {
      const { host, workerHost, bridge } = makeBridge();
      bridge.waitForActivation().catch(() => {});
      const signal = await openPrompt(host, workerHost);
      expect(signal()).toBeDefined();
      expect(signal()?.aborted).toBe(false);

      workerHost.emit("reloading");

      expect(signal()?.aborted).toBe(true);
    });

    it("aborts the prompt when the worker crashes instead", async () => {
      const { host, workerHost, bridge } = makeBridge();
      bridge.waitForActivation().catch(() => {});
      const signal = await openPrompt(host, workerHost);

      workerHost.emit("exit", 139, false);

      expect(signal()?.aborted).toBe(true);
    });
  });

  it("still cancels prompts when registration cleanup throws on reload (#12279)", async () => {
    const clear = vi.fn(() => {
      throw new Error("registration cleanup exploded");
    });
    const { host, workerHost, bridge } = makeBridge({ clear });
    bridge.waitForActivation().catch(() => {});
    let seenSignal: AbortSignal | undefined;
    (host.showConfirm as any).mockImplementation((_o: any, call?: any) => {
      seenSignal = call?.signal;
      return new Promise(() => {});
    });
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "p1",
      method: "showConfirm",
      params: { options: { title: "Sure?" } },
    });
    await flush();

    // A throwing teardown step must not strand a dialog on the user's screen,
    // nor skip the rest of the cascade (#9322).
    expect(() => workerHost.emit("reloading")).not.toThrow();
    expect(seenSignal?.aborted).toBe(true);
    expect(clear).toHaveBeenCalled();
  });

  it("retires the crashed generation's registrations and subscriptions (#12216)", async () => {
    const { host, workerHost, bridge, clear } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    const disposeProvider = vi.fn();
    host.registerFileDecorationProvider.mockReturnValueOnce(disposeProvider);
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerFileDecorationProvider",
      params: { descriptor: { id: "acme.demo.deco" } },
    });
    await flush();

    workerHost.emit("exit", 139, false);

    // A crash is the same generation boundary a reload is: the replacement
    // re-runs activate() and re-registers, so anything left behind is a
    // duplicate it cannot address.
    expect(disposeProvider).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalled();
  });

  it("drops a late host-result from a crashed generation (#12216)", async () => {
    const { host, workerHost, bridge } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    let settle: ((v: string) => void) | undefined;
    host.fs.readFile.mockImplementation(
      () =>
        new Promise<string>((res) => {
          settle = res;
        })
    );
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "h1",
      method: "fs.readFile",
      params: { path: "/repo/a.txt" },
    });
    await flush();

    workerHost.emit("exit", 139, false);
    workerHost.sent.length = 0;

    // The replacement worker's requestId counter restarts from scratch, so a
    // result from the dead generation could otherwise be delivered against a
    // colliding id.
    settle?.("stale contents");
    await flush();

    expect(workerHost.sent.filter((m) => m.type === "host-result")).toEqual([]);
  });

  it("leaves an idle bridge's generation intact on an expected exit (#12216)", async () => {
    const clear = vi.fn();
    const { host, workerHost, bridge } = makeBridge({ clear });
    bridge.waitForActivation().catch(() => {});
    const disposeProvider = vi.fn();
    host.registerFileDecorationProvider.mockReturnValueOnce(disposeProvider);
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerFileDecorationProvider",
      params: { descriptor: { id: "acme.demo.deco" } },
    });
    await flush();
    clear.mockClear();

    // A reload already emitted `reloading` and retired the generation before
    // this lands, so the exit itself must not tear registrations down a second
    // time — that would drop what the incoming generation just registered.
    workerHost.emit("exit", 0, true);

    expect(disposeProvider).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
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
    async function spawn<T = ReturnType<typeof makeProcessHandle>>(
      workerHost: any,
      host: any,
      handle: T = makeProcessHandle("p1") as T
    ): Promise<T> {
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

    it("reports mode from the handle the host actually built, not the request", async () => {
      const { host, workerHost } = makeBridge();
      await spawn(workerHost, host, makePtyProcessHandle("p1"));
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "spawn1"
      );
      // The worker proxy builds write()/resize() off this value, so it must
      // describe the real backend.
      expect(res).toMatchObject({ ok: true, result: { id: "p1", mode: "pty" } });
    });

    it("classifies a write-only handle as duplex, not pipe (#11871)", async () => {
      const { host, workerHost } = makeBridge();
      await spawn(workerHost, host, makeDuplexProcessHandle("p1"));
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "spawn1"
      );
      // Misreporting this as "pipe" would leave the worker proxy building a
      // handle with no write() for a child whose stdin is genuinely open.
      expect(res).toMatchObject({ ok: true, result: { id: "p1", mode: "duplex" } });
    });

    it("relays write to a duplex handle but refuses resize (#11871)", async () => {
      const { host, workerHost } = makeBridge();
      const handle: any = await spawn(workerHost, host, makeDuplexProcessHandle("p1"));
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.write",
        params: { processId: "p1", data: '{"jsonrpc":"2.0"}\n' },
      });
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.resize",
        params: { processId: "p1", cols: 120, rows: 40 },
      });
      await flush();

      expect(handle.write).toHaveBeenCalledWith('{"jsonrpc":"2.0"}\n');
      // The resize notification must be DROPPED, not rerouted or thrown: exactly
      // one relayed call total, so nothing turned the resize into a second write.
      expect(handle.write).toHaveBeenCalledTimes(1);
      // A duplex child has no terminal, so resize is not part of its shape.
      expect(handle.resize).toBeUndefined();
    });

    it("relays write and resize to an interactive handle", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host, makePtyProcessHandle("p1"));
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.write",
        params: { processId: "p1", data: "q\n" },
      });
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.resize",
        params: { processId: "p1", cols: 120, rows: 40 },
      });
      await flush();
      expect(handle.write).toHaveBeenCalledWith("q\n");
      expect(handle.resize).toHaveBeenCalledWith(120, 40);
    });

    it("refuses a fabricated write/resize against a pipe-mode handle", async () => {
      const { host, workerHost } = makeBridge();
      const handle: any = await spawn(workerHost, host, makeProcessHandle("p1"));
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.write",
        params: { processId: "p1", data: "x" },
      });
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.resize",
        params: { processId: "p1", cols: 10, rows: 10 },
      });
      await flush();
      // A pipe child has stdin closed; the proxy never exposes these, so
      // reaching here means the payload was fabricated.
      expect((handle as any).write).toBeUndefined();
      expect(host.process.spawn).toHaveBeenCalledTimes(1);
    });

    it("ignores a write for an unknown process id", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host, makePtyProcessHandle("p1"));
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.write",
        params: { processId: "nope", data: "x" },
      });
      await flush();
      expect(handle.write).not.toHaveBeenCalled();
    });

    it("opens a process-data subscription and streams chunks to the worker", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host, makePtyProcessHandle("p1"));
      workerHost.emit("worker-message", {
        type: "subscribe",
        subscriptionId: "s9",
        kind: "process-data",
        processId: "p1",
      });
      await flush();
      expect(handle.onData).toHaveBeenCalled();

      handle.emitData({ stream: "data", chunk: "$ " });
      const event = workerHost.sent.find(
        (m: any) => m.type === "subscription-event" && m.subscriptionId === "s9"
      );
      expect(event).toMatchObject({ payload: { stream: "data", chunk: "$ " } });
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

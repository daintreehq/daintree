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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      onDidChange: vi.fn(() => vi.fn()),
    },
  };
}

function makeBridge(
  overrides?: Partial<{
    capabilities: string[];
    clear: () => void;
    onActivationResult: (r: { ok: true } | { ok: false; error: string }) => void;
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
    workerHost.emit("worker-message", { type: "unsubscribe", subscriptionId: "s2" });
    expect(dispose).toHaveBeenCalled();
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
});

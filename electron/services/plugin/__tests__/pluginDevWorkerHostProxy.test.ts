/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginDevWorkerHostProxy } from "../pluginDevWorkerHostProxy.js";

const flush = () => new Promise((r) => setImmediate(r));

function makeProxy() {
  const sent: any[] = [];
  const post = vi.fn((msg: any) => {
    sent.push(msg);
  });
  const proxy = new PluginDevWorkerHostProxy("acme.demo", post);
  return { proxy, post, sent };
}

describe("PluginDevWorkerHostProxy file decoration providers", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("notifies main on registerFileDecorationProvider and keeps the impl in the worker", async () => {
    const { proxy, sent } = makeProxy();
    const impl = { provideDecorations: vi.fn(async () => ({})) };
    const dispose = await proxy.host.registerFileDecorationProvider(
      { id: "deco", scopes: ["pr"] },
      impl
    );

    const notify = sent.find((m) => m.type === "host-notify");
    expect(notify).toMatchObject({
      method: "registerFileDecorationProvider",
      registrationKey: "fileDecorationProvider:deco",
      params: { descriptor: { id: "deco", scopes: ["pr"] } },
    });
    expect(typeof dispose).toBe("function");
  });

  it("round-trips a provideDecorations invocation back to the stored impl", async () => {
    const { proxy, sent } = makeProxy();
    const impl = {
      provideDecorations: vi.fn(async (scope: string, paths: string[]) => ({
        [paths[0]]: { badge: scope },
      })),
    };
    proxy.host.registerFileDecorationProvider({ id: "deco" }, impl);

    proxy.handleMessage({
      type: "invoke",
      requestId: "i1",
      kind: "file-decoration-method",
      providerId: "deco",
      method: "provideDecorations",
      args: ["pr", ["a.ts"]],
    } as any);
    await flush();

    expect(impl.provideDecorations).toHaveBeenCalledWith("pr", ["a.ts"]);
    const result = sent.find((m) => m.type === "invoke-result" && m.requestId === "i1");
    expect(result).toMatchObject({ ok: true, result: { "a.ts": { badge: "pr" } } });
  });

  it("replies with an error when invoking an unregistered provider", async () => {
    const { proxy, sent } = makeProxy();
    proxy.handleMessage({
      type: "invoke",
      requestId: "i2",
      kind: "file-decoration-method",
      providerId: "missing",
      method: "provideDecorations",
      args: ["pr", []],
    } as any);
    await flush();
    const result = sent.find((m) => m.type === "invoke-result" && m.requestId === "i2");
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/No file decoration provider/);
  });

  it("notifies unregister and drops the impl on dispose", async () => {
    const { proxy, sent } = makeProxy();
    const impl = { provideDecorations: vi.fn(async () => ({})) };
    const dispose = await proxy.host.registerFileDecorationProvider({ id: "deco" }, impl);
    dispose();

    const unregister = sent.find(
      (m) => m.type === "host-notify" && m.method === "unregisterFileDecorationProvider"
    );
    expect(unregister).toMatchObject({ params: { providerId: "deco" } });

    // After disposal, an invoke for that provider errors (impl was dropped).
    proxy.handleMessage({
      type: "invoke",
      requestId: "i3",
      kind: "file-decoration-method",
      providerId: "deco",
      method: "provideDecorations",
      args: ["pr", []],
    } as any);
    await flush();
    const result = sent.find((m) => m.type === "invoke-result" && m.requestId === "i3");
    expect(result).toMatchObject({ ok: false });
  });

  it("a stale disposer does not drop a re-registered impl on the same id", async () => {
    const { proxy, sent } = makeProxy();
    const implA = { provideDecorations: vi.fn(async () => ({ a: { badge: "A" } })) };
    const implB = { provideDecorations: vi.fn(async () => ({ b: { badge: "B" } })) };
    const disposeA = await proxy.host.registerFileDecorationProvider({ id: "deco" }, implA);
    await proxy.host.registerFileDecorationProvider({ id: "deco" }, implB); // overwrites A
    disposeA(); // stale — must NOT remove B

    proxy.handleMessage({
      type: "invoke",
      requestId: "i9",
      kind: "file-decoration-method",
      providerId: "deco",
      method: "provideDecorations",
      args: ["pr", ["x"]],
    } as any);
    await flush();
    expect(implB.provideDecorations).toHaveBeenCalled();
    const result = sent.find((m) => m.type === "invoke-result" && m.requestId === "i9");
    expect(result).toMatchObject({ ok: true, result: { b: { badge: "B" } } });
  });

  it("rejects an impl missing provideDecorations", () => {
    const { proxy } = makeProxy();
    expect(() => proxy.host.registerFileDecorationProvider({ id: "deco" }, {} as any)).toThrow(
      /provideDecorations/
    );
  });

  it("warns but does not register forge providers (synchronous-contract limitation)", async () => {
    const { proxy, sent } = makeProxy();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispose = await proxy.host.registerForgeProvider({ id: "gh" } as any, {} as any);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is not supported"));
    expect(sent.find((m) => m.type === "host-notify")).toBeUndefined();
    expect(typeof dispose).toBe("function");
    expect(dispose()).toBeUndefined();
  });
});

/** Reply to the most recent pending `host-call` of `method` with a success result. */
function resolveCall(proxy: any, sent: any[], method: string, result: unknown): void {
  const call = [...sent].reverse().find((m) => m.type === "host-call" && m.method === method);
  proxy.handleMessage({ type: "host-result", requestId: call.requestId, ok: true, result });
}

describe("PluginDevWorkerHostProxy host.process (#10526)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  async function spawnHandle(): Promise<{ proxy: any; sent: any[]; handle: any }> {
    const { proxy, sent } = makeProxy();
    const promise = proxy.host.process.spawn("node", { args: ["x.js"] });
    const call = sent.find((m) => m.type === "host-call" && m.method === "process.spawn");
    expect(call).toMatchObject({ params: { command: "node", options: { args: ["x.js"] } } });
    resolveCall(proxy, sent, "process.spawn", { id: "p1" });
    const handle = await promise;
    return { proxy, sent, handle };
  }

  it("relays spawn over a host-call and returns a handle addressed by id", async () => {
    const { handle } = await spawnHandle();
    expect(handle.id).toBe("p1");
  });

  it("kill posts a fire-and-forget process.kill notify keyed by id", async () => {
    const { sent, handle } = await spawnHandle();
    handle.kill();
    expect(sent.find((m) => m.type === "host-notify" && m.method === "process.kill")).toMatchObject(
      {
        params: { processId: "p1" },
      }
    );
  });

  it("restart awaits a process.restart host-call", async () => {
    const { proxy, sent, handle } = await spawnHandle();
    const restarted = handle.restart();
    const call = sent.find((m) => m.type === "host-call" && m.method === "process.restart");
    expect(call).toMatchObject({ params: { processId: "p1" } });
    resolveCall(proxy, sent, "process.restart", undefined);
    await expect(restarted).resolves.toBeUndefined();
  });

  it("onExit opens a processId-scoped subscription and delivers exit events", async () => {
    const { proxy, sent, handle } = await spawnHandle();
    const onExit = vi.fn();
    const dispose = handle.onExit(onExit);
    const sub = sent.find((m) => m.type === "subscribe" && m.kind === "process-exit");
    expect(sub).toMatchObject({ processId: "p1" });

    proxy.handleMessage({
      type: "subscription-event",
      subscriptionId: sub.subscriptionId,
      payload: { exitCode: 0, signal: null },
    });
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0, signal: null });

    dispose();
    expect(
      sent.find((m) => m.type === "unsubscribe" && m.subscriptionId === sub.subscriptionId)
    ).toBeDefined();
  });

  it("onCrash opens a process-crash subscription", async () => {
    const { sent, handle } = await spawnHandle();
    const onCrash = vi.fn();
    handle.onCrash(onCrash);
    const sub = sent.find((m) => m.type === "subscribe" && m.kind === "process-crash");
    expect(sub).toMatchObject({ processId: "p1" });
  });

  it("propagates a spawn rejection (e.g. missing shell:exec capability)", async () => {
    const { proxy, sent } = makeProxy();
    const promise = proxy.host.process.spawn("node");
    const call = sent.find((m) => m.type === "host-call" && m.method === "process.spawn");
    proxy.handleMessage({
      type: "host-result",
      requestId: call.requestId,
      ok: false,
      error: "PERMISSION_REQUIRED: shell:exec",
    });
    await expect(promise).rejects.toThrow(/PERMISSION_REQUIRED/);
  });
});

describe("PluginDevWorkerHostProxy host.fs.watch (#10526)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("relays watch as a host-call, delivers change events, and disposes via unsubscribe", async () => {
    const { proxy, sent } = makeProxy();
    const onChange = vi.fn();
    const promise = proxy.host.fs.watch(["/repo/a.ts"], onChange);
    const call = sent.find((m) => m.type === "host-call" && m.method === "fs.watch");
    expect(call.params.paths).toEqual(["/repo/a.ts"]);
    const subscriptionId = call.params.subscriptionId;
    proxy.handleMessage({
      type: "host-result",
      requestId: call.requestId,
      ok: true,
      result: undefined,
    });
    const dispose = await promise;

    proxy.handleMessage({ type: "subscription-event", subscriptionId, payload: "/repo/a.ts" });
    expect(onChange).toHaveBeenCalledWith("/repo/a.ts");

    dispose();
    expect(
      sent.find((m) => m.type === "unsubscribe" && m.subscriptionId === subscriptionId)
    ).toBeDefined();
  });

  it("rejects when the host watch fails and stops delivering events", async () => {
    const { proxy, sent } = makeProxy();
    const onChange = vi.fn();
    const promise = proxy.host.fs.watch(["/nope"], onChange);
    const call = sent.find((m) => m.type === "host-call" && m.method === "fs.watch");
    const subscriptionId = call.params.subscriptionId;
    proxy.handleMessage({
      type: "host-result",
      requestId: call.requestId,
      ok: false,
      error: "PERMISSION_REQUIRED: fs:project-read",
    });
    await expect(promise).rejects.toThrow(/PERMISSION_REQUIRED/);

    // The change callback was removed on rejection — a late event is a no-op.
    proxy.handleMessage({ type: "subscription-event", subscriptionId, payload: "/nope" });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("PluginDevWorkerHostProxy host-call post failure (#10526)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects (and drops the pending call) when post throws a DataCloneError", async () => {
    const post = vi.fn(() => {
      throw new Error("DataCloneError: value could not be cloned");
    });
    const proxy = new PluginDevWorkerHostProxy("acme.demo", post);
    await expect(proxy.host.getWorktrees()).rejects.toThrow(/could not be cloned/);
    // The proxy isn't wedged — the failed call posted exactly once and rejected.
    expect(post).toHaveBeenCalledTimes(1);
  });
});

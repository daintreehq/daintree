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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not supported in dev mode"));
    expect(sent.find((m) => m.type === "host-notify")).toBeUndefined();
    expect(typeof dispose).toBe("function");
    expect(dispose()).toBeUndefined();
  });
});

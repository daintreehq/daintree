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

describe("PluginDevWorkerHostProxy host.actions (#10561)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("relays list() as an actions.list host-call and resolves with the entries", async () => {
    const { proxy, sent } = makeProxy();
    const promise = proxy.host.actions.list();
    const call = sent.find((m) => m.type === "host-call" && m.method === "actions.list");
    expect(call).toBeDefined();
    const entries = [{ id: "terminal.new", danger: "safe", requiresArgs: false }];
    resolveCall(proxy, sent, "actions.list", entries);
    await expect(promise).resolves.toEqual(entries);
  });

  it("relays get(id) as an actions.get host-call carrying the action id", async () => {
    const { proxy, sent } = makeProxy();
    const promise = proxy.host.actions.get("terminal.new");
    const call = sent.find((m) => m.type === "host-call" && m.method === "actions.get");
    expect(call).toMatchObject({ params: { actionId: "terminal.new" } });
    const entry = { id: "terminal.new", danger: "safe", requiresArgs: false };
    resolveCall(proxy, sent, "actions.get", entry);
    await expect(promise).resolves.toEqual(entry);
  });

  it("canDispatch derives the verdict from a single actions.get round-trip", async () => {
    const { proxy, sent } = makeProxy();

    const okPromise = proxy.host.actions.canDispatch("worktree.createWithRecipe");
    // Only actions.get is relayed — there is no dedicated canDispatch host-call.
    expect(sent.some((m) => m.type === "host-call" && m.method === "actions.get")).toBe(true);
    expect(sent.some((m) => m.method === "actions.canDispatch")).toBe(false);
    resolveCall(proxy, sent, "actions.get", { id: "worktree.createWithRecipe", danger: "safe" });
    await expect(okPromise).resolves.toBe("ok");

    const confirmPromise = proxy.host.actions.canDispatch("recipe.run");
    resolveCall(proxy, sent, "actions.get", { id: "recipe.run", danger: "confirm" });
    await expect(confirmPromise).resolves.toBe("confirm");

    const restrictedPromise = proxy.host.actions.canDispatch("nope");
    resolveCall(proxy, sent, "actions.get", null);
    await expect(restrictedPromise).resolves.toBe("restricted");
  });

  it("resolves the empty/absent fallback on dispose instead of rejecting", async () => {
    const { proxy } = makeProxy();
    const listPromise = proxy.host.actions.list();
    const getPromise = proxy.host.actions.get("terminal.new");
    const canPromise = proxy.host.actions.canDispatch("terminal.new");
    proxy.dispose();
    await expect(listPromise).resolves.toEqual([]);
    await expect(getPromise).resolves.toBeNull();
    await expect(canPromise).resolves.toBe("restricted");
  });

  it("canDispatch honors the never-throws contract on a host error result", async () => {
    const { proxy, sent } = makeProxy();
    const promise = proxy.host.actions.canDispatch("terminal.new");
    const call = sent.find((m) => m.type === "host-call" && m.method === "actions.get");
    // Underlying get() host-call fails — canDispatch must degrade to "restricted",
    // never reject.
    proxy.handleMessage({
      type: "host-result",
      requestId: call.requestId,
      ok: false,
      error: "boom",
    });
    await expect(promise).resolves.toBe("restricted");
  });
});

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

  it("builds a pipe handle with no writable input when the host reports pipe mode", async () => {
    const { proxy, sent } = makeProxy();
    const promise = proxy.host.process.spawn("node");
    resolveCall(proxy, sent, "process.spawn", { id: "p1", mode: "pipe" });
    const handle: any = await promise;
    // The shape is what PluginDevWorkerMainBridge's structural check reads, so a
    // pipe handle carrying write/resize would let a fabricated write through.
    expect(handle.write).toBeUndefined();
    expect(handle.resize).toBeUndefined();
    expect(typeof handle.onData).toBe("function");
  });

  it("builds an interactive handle whose write/resize post fire-and-forget notifies", async () => {
    const { proxy, sent } = makeProxy();
    const promise = proxy.host.process.spawn("flutter", { mode: "pty" });
    resolveCall(proxy, sent, "process.spawn", { id: "p1", mode: "pty" });
    const handle: any = await promise;

    handle.write("q\n");
    handle.resize(120, 40);
    expect(
      sent.find((m) => m.type === "host-notify" && m.method === "process.write")
    ).toMatchObject({ params: { processId: "p1", data: "q\n" } });
    expect(
      sent.find((m) => m.type === "host-notify" && m.method === "process.resize")
    ).toMatchObject({ params: { processId: "p1", cols: 120, rows: 40 } });
  });

  it("trusts the host's reported mode over what the plugin asked for", async () => {
    const { proxy, sent } = makeProxy();
    const promise = proxy.host.process.spawn("flutter", { mode: "pty" });
    // The host says it allocated a pipe. Handing back write() anyway would give
    // the plugin a method that silently goes nowhere.
    resolveCall(proxy, sent, "process.spawn", { id: "p1", mode: "pipe" });
    const handle: any = await promise;
    expect(handle.write).toBeUndefined();
  });

  it("onData opens a process-data subscription and delivers chunks", async () => {
    const { proxy, sent } = makeProxy();
    const promise = proxy.host.process.spawn("node");
    resolveCall(proxy, sent, "process.spawn", { id: "p1", mode: "pipe" });
    const handle = await promise;

    const onData = vi.fn();
    const dispose = handle.onData(onData);
    const sub = sent.find((m) => m.type === "subscribe" && m.kind === "process-data");
    expect(sub).toMatchObject({ processId: "p1" });

    proxy.handleMessage({
      type: "subscription-event",
      subscriptionId: sub.subscriptionId,
      payload: { stream: "stdout", chunk: "hello" },
    });
    expect(onData).toHaveBeenCalledWith({ stream: "stdout", chunk: "hello" });

    dispose();
    expect(
      sent.find((m) => m.type === "unsubscribe" && m.subscriptionId === sub.subscriptionId)
    ).toBeDefined();
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

describe("PluginDevWorkerHostProxy panel lifecycle (#11301)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("opens a panel-lifecycle subscription and routes events to the callback", async () => {
    const { proxy, sent } = makeProxy();
    const onEvent = vi.fn();
    const dispose = await proxy.host.onDidChangePanelLifecycle(onEvent);

    // The kind is the routing key on main — a wrong or missing one would fall
    // through the bridge's chain and be wired to an unrelated host event.
    const sub = sent.find((m) => m.type === "subscribe" && m.kind === "panel-lifecycle");
    expect(sub).toBeDefined();

    proxy.handleMessage({
      type: "subscription-event",
      subscriptionId: sub.subscriptionId,
      payload: {
        panelId: "p1",
        panelKindId: "acme.demo.dash",
        pluginId: "acme.demo",
        phase: "removed",
      },
    } as any);

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ panelId: "p1", phase: "removed" })
    );

    dispose();
    expect(
      sent.find((m) => m.type === "unsubscribe" && m.subscriptionId === sub.subscriptionId)
    ).toBeDefined();
  });

  it("freezes the delivered event even though the port hop strips main's freeze", async () => {
    const { proxy, sent } = makeProxy();
    const received: any[] = [];
    await proxy.host.onDidChangePanelLifecycle((e) => received.push(e));
    const sub = sent.find((m) => m.type === "subscribe" && m.kind === "panel-lifecycle");

    // A structured-clone payload arrives mutable no matter what main did to it,
    // so the SDK's "events are frozen" contract has to be re-established here or
    // it silently holds only for in-process built-ins.
    proxy.handleMessage({
      type: "subscription-event",
      subscriptionId: sub.subscriptionId,
      payload: {
        panelId: "p1",
        panelKindId: "acme.demo.dash",
        pluginId: "acme.demo",
        phase: "hidden",
      },
    } as any);

    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it("rejects a subscription opened after the activation window closes", async () => {
    const { proxy } = makeProxy();
    proxy.revoke();
    expect(() => proxy.host.onDidChangePanelLifecycle(vi.fn())).toThrow(
      /onDidChangePanelLifecycle/
    );
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

describe("PluginDevWorkerHostProxy runtime-surface validation rejects, never throws (#10617)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("postToPanel rejects an empty or colon-bearing channel without notifying main", async () => {
    const { proxy, sent } = makeProxy();
    await expect(proxy.host.postToPanel("bad:channel", null)).rejects.toThrow(
      /postToPanel: channel/
    );
    await expect(proxy.host.postToPanel("", null)).rejects.toThrow(/postToPanel: channel/);
    // No host-notify for postToPanel was sent — the call rejected before forwarding.
    expect(sent.some((m) => m.type === "host-notify" && m.method === "postToPanel")).toBe(false);
  });

  it("postToPanel rejection is catchable on a non-awaited call (no sync throw)", async () => {
    const { proxy } = makeProxy();
    let caught: unknown;
    const pending = proxy.host.postToPanel("also:bad", null).catch((err) => {
      caught = err;
    });
    await pending;
    expect(caught).toBeInstanceOf(Error);
  });

  it("setPanelBadge rejects a non-string panelId without notifying main", async () => {
    const { proxy, sent } = makeProxy();
    await expect(proxy.host.setPanelBadge("", { kind: "dot" })).rejects.toThrow(
      /setPanelBadge: panelId/
    );
    expect(sent.some((m) => m.type === "host-notify" && m.method === "setPanelBadge")).toBe(false);
  });

  it("invalidateFileDecorations rejects an empty scope without notifying main", async () => {
    const { proxy, sent } = makeProxy();
    await expect(proxy.host.invalidateFileDecorations("", undefined)).rejects.toThrow(
      /invalidateFileDecorations: scope/
    );
    expect(
      sent.some((m) => m.type === "host-notify" && m.method === "invalidateFileDecorations")
    ).toBe(false);
  });
});

describe("PluginDevWorkerHostProxy host.postToPanel (#10618)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("forwards panelId in the host-notify so main can route per-instance", async () => {
    const { proxy, sent } = makeProxy();

    await proxy.host.postToPanel("tick", { count: 3 }, "panel-a");
    expect(sent.find((m) => m.type === "host-notify" && m.method === "postToPanel")).toMatchObject({
      method: "postToPanel",
      params: { channel: "tick", payload: { count: 3 }, panelId: "panel-a" },
    });
  });

  it("forwards an undefined panelId (broadcast) — the real host coerces it", async () => {
    const { proxy, sent } = makeProxy();

    await proxy.host.postToPanel("tick", { count: 1 });
    const notify = sent.find((m) => m.type === "host-notify" && m.method === "postToPanel");
    expect(notify.params.channel).toBe("tick");
    expect(notify.params.panelId).toBeUndefined();
  });

  it("rejects an empty-string panelId before posting", async () => {
    const { proxy, post } = makeProxy();

    expect(() => proxy.host.postToPanel("tick", { n: 1 }, "")).toThrow(/postToPanel: panelId/);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("PluginDevWorkerHostProxy host.system / clipboard.writeImage (#11299)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["openPath", "system.openPath"],
    ["showItemInFolder", "system.showItemInFolder"],
  ])("relays host.system.%s with the path intact", async (method, wireMethod) => {
    const { proxy, sent } = makeProxy();
    const promise = (proxy.host.system as any)[method]("/tmp/data/shot.png");

    const call = sent.find((m) => m.type === "host-call" && m.method === wireMethod);
    expect(call.params).toEqual({ targetPath: "/tmp/data/shot.png" });
    resolveCall(proxy, sent, wireMethod, undefined);
    await expect(promise).resolves.toBeUndefined();
  });

  it("relays clipboard.writeImage with the typed array's own bytes", async () => {
    // A subarray is the case that breaks if anything copies `.buffer`
    // wholesale — the wire payload must carry this view, not its backing
    // store, or the host decodes the wrong 64 bytes.
    const backing = new Uint8Array(64).fill(7);
    const view = backing.subarray(16, 32);
    const { proxy, sent } = makeProxy();
    const promise = proxy.host.clipboard.writeImage(view);

    const call = sent.find((m) => m.type === "host-call" && m.method === "clipboard.writeImage");
    expect(call.params.pngData.byteLength).toBe(16);
    resolveCall(proxy, sent, "clipboard.writeImage", undefined);
    await expect(promise).resolves.toBeUndefined();
  });

  it("carries an action's requires across the port, including an empty array", async () => {
    // The bridge rebuilds the descriptor field by field, so a dropped
    // `requires` wouldn't fail to compile — it would silently send a dev
    // plugin's one-click action back to whole-manifest elevation, visible
    // only in the dev loop.
    const { proxy, sent } = makeProxy();
    proxy.host.registerAction(
      {
        id: "open-panel",
        title: "Open Panel",
        description: "Opens it",
        category: "Test",
        kind: "command",
        danger: "safe",
        requires: [],
      } as any,
      async () => undefined
    );

    const notify = sent.find((m) => m.type === "host-notify" && m.method === "registerAction");
    expect(notify.params.descriptor.requires).toEqual([]);
  });

  it("does not invent a requires array when the action declared none", async () => {
    // Omitted must stay omitted: `[]` is the meaningful de-escalation, so
    // manufacturing one here would silently relax every dev-plugin action.
    const { proxy, sent } = makeProxy();
    proxy.host.registerAction(
      {
        id: "run-build",
        title: "Run Build",
        description: "Builds",
        category: "Test",
        kind: "command",
        danger: "safe",
      } as any,
      async () => undefined
    );

    const notify = sent.find((m) => m.type === "host-notify" && m.method === "registerAction");
    expect(notify.params.descriptor.requires).toBeUndefined();
  });
});

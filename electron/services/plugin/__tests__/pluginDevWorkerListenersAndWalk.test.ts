/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PluginDevWorkerMainBridge } from "../PluginDevWorkerMainBridge.js";
import { PluginDevWorkerHostProxy } from "../pluginDevWorkerHostProxy.js";
import { parseWorkerToHostMessage } from "../../../schemas/pluginDevWorker.js";

const flush = () => new Promise((r) => setImmediate(r));

class FakeWorkerHost extends EventEmitter {
  sent: any[] = [];
  deliver: ((msg: any) => void) | null = null;
  send = vi.fn((msg: any) => {
    const cloned = structuredClone(msg);
    this.sent.push(cloned);
    this.deliver?.(cloned);
    return true;
  });
  isReady = () => true;
  off = this.removeListener;
  dispose = vi.fn();
}

/** A main-side host whose listener state a test flips per channel. */
function makeListenerHost() {
  const state = new Map<string, boolean>();
  const watchers = new Map<string, Set<(has: boolean) => void>>();
  const host = {
    pluginId: "acme.demo",
    hasListeners: vi.fn((channel: string) => state.get(channel) ?? true),
    onDidChangeListeners: vi.fn((channel: string, cb: (has: boolean) => void) => {
      let set = watchers.get(channel);
      if (!set) watchers.set(channel, (set = new Set()));
      set.add(cb);
      return vi.fn(() => set!.delete(cb));
    }),
    fs: {
      walk: vi.fn(async () => ({ entries: [{ path: "a.ts", type: "file" }], truncated: false })),
    },
  };
  const set = (channel: string, has: boolean) => {
    if ((state.get(channel) ?? true) === has) return;
    state.set(channel, has);
    for (const cb of watchers.get(channel) ?? []) cb(has);
  };
  return { host, set, watchers };
}

function connect(host: any) {
  const workerHost = new FakeWorkerHost();
  new PluginDevWorkerMainBridge({
    pluginId: "acme.demo",
    host,
    workerHost: workerHost as any,
    getCapabilities: () => [],
    clearPriorRegistrations: vi.fn(),
    onActivationResult: vi.fn(),
    onTerminalFailure: vi.fn(),
    onPushRejected: vi.fn(),
  });
  const wire: any[] = [];
  const proxy = new PluginDevWorkerHostProxy(
    "acme.demo",
    (msg) => {
      const cloned = structuredClone(msg);
      wire.push(cloned);
      const parsed = parseWorkerToHostMessage(cloned);
      if (!parsed.ok) throw new Error(`schema rejected: ${parsed.issues}`);
      workerHost.emit("worker-message", parsed.message);
    },
    {
      instanceId: "acme.demo",
      manifestId: "acme.demo",
      origin: "global",
      projectId: null,
      projectRoot: null,
    }
  );
  workerHost.deliver = (msg) => proxy.handleMessage(msg);
  return { proxy, workerHost, wire };
}

describe("worker host.hasListeners / onDidChangeListeners", () => {
  it("answers true before main reports, then tracks main's answer", async () => {
    const { host, set } = makeListenerHost();
    set("tick", false);
    const { proxy, wire } = connect(host);
    // The subscribe and main's first answer cross synchronously in this
    // harness; in a real worker the first read can precede the answer.
    expect(proxy.host.hasListeners!("tick")).toBe(false);
    expect(wire.filter((m) => m.type === "subscribe" && m.kind === "push-listeners")).toEqual([
      expect.objectContaining({ key: "tick" }),
    ]);
    set("tick", true);
    expect(proxy.host.hasListeners!("tick")).toBe(true);
  });

  it("opens one main subscription per channel however often it is read", async () => {
    const { host } = makeListenerHost();
    const { proxy, wire } = connect(host);
    proxy.host.hasListeners!("tick");
    proxy.host.hasListeners!("tick");
    proxy.host.onDidChangeListeners!("tick", () => {});
    await flush();
    expect(wire.filter((m) => m.kind === "push-listeners")).toHaveLength(1);
    expect(host.onDidChangeListeners).toHaveBeenCalledTimes(1);
  });

  it("calls back on each change and stops after dispose", async () => {
    const { host, set } = makeListenerHost();
    const { proxy } = connect(host);
    const seen: boolean[] = [];
    const dispose = proxy.host.onDidChangeListeners!("tick", (has) => seen.push(has));
    set("tick", false);
    set("tick", true);
    dispose();
    set("tick", false);
    expect(seen).toEqual([false, true]);
  });

  it("starts from true in the worker until the first report", () => {
    const sent: any[] = [];
    const proxy = new PluginDevWorkerHostProxy("acme.demo", (m) => void sent.push(m), {
      instanceId: "acme.demo",
      manifestId: "acme.demo",
      origin: "global",
      projectId: null,
      projectRoot: null,
    });
    const seen: boolean[] = [];
    proxy.host.onDidChangeListeners!("tick", (has) => seen.push(has));
    expect(proxy.host.hasListeners!("tick")).toBe(true);
    const sub = sent.find((m) => m.kind === "push-listeners");
    proxy.handleMessage({
      type: "subscription-event",
      subscriptionId: sub.subscriptionId,
      payload: true,
    });
    expect(seen).toEqual([]);
    proxy.handleMessage({
      type: "subscription-event",
      subscriptionId: sub.subscriptionId,
      payload: false,
    });
    expect(seen).toEqual([false]);
    expect(proxy.host.hasListeners!("tick")).toBe(false);
    proxy.dispose();
    expect(proxy.host.hasListeners!("tick")).toBe(false);
  });

  it("validates the channel in the worker", () => {
    const { host } = makeListenerHost();
    const { proxy } = connect(host);
    expect(() => proxy.host.hasListeners!("a:b")).toThrow(/channel/);
    expect(() => proxy.host.onDidChangeListeners!("tick", null as never)).toThrow(/callback/);
  });

  it("answers true on a host without listener tracking", async () => {
    const { proxy } = connect({ pluginId: "acme.demo", fs: {} });
    await flush();
    expect(proxy.host.hasListeners!("tick")).toBe(true);
  });
});

describe("worker host.fs.walk", () => {
  it("relays the call with its options and the bridge's signal", async () => {
    const { host } = makeListenerHost();
    const { proxy } = connect(host);
    const result = await proxy.host.fs.walk!("/repo", {
      include: ["**/*.ts"],
      limit: 5,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ entries: [{ path: "a.ts", type: "file" }], truncated: false });
    expect(host.fs.walk).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ include: ["**/*.ts"], limit: 5, signal: expect.any(AbortSignal) })
    );
  });

  it("forwards a malformed options value for the host to reject", async () => {
    const { host } = makeListenerHost();
    const { proxy } = connect(host);
    await proxy.host.fs.walk!("/repo", null as never);
    expect(host.fs.walk).toHaveBeenCalledWith("/repo", null);
  });
});

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createPluginPushTransport, type PluginPushTransport } from "../pluginPush.js";
import { FakeIpcRenderer } from "./fakeIpcRenderer.js";

const REPORT = "plugin:report-push-listeners";
const reports = (ipc: FakeIpcRenderer) =>
  ipc.send.mock.calls.filter(([channel]) => channel === REPORT).map(([, listeners]) => listeners);

describe("createPluginPushTransport", () => {
  let ipc: FakeIpcRenderer;
  let invoke: Mock<PluginPushTransport["invoke"]>;
  let transport: PluginPushTransport;

  beforeEach(() => {
    ipc = new FakeIpcRenderer();
    invoke = vi.fn<PluginPushTransport["invoke"]>(() => Promise.resolve("ok"));
    transport = createPluginPushTransport(ipc.asPreloadIpc(), invoke);
  });

  it("reports an empty listener set once at creation", async () => {
    await Promise.resolve();
    expect(reports(ipc)).toEqual([[]]);
  });

  it("routes broadcast and targeted envelopes only to their own panel buckets", () => {
    const broadcast = vi.fn();
    const panelA = vi.fn();
    const panelB = vi.fn();
    transport.on("p", "ch", null, broadcast);
    transport.on("p", "ch", "a", panelA);
    transport.on("p", "ch", "b", panelB);
    expect(ipc.listenerCount("plugin:p:ch")).toBe(1);

    ipc.emit("plugin:p:ch", {}, { panelId: null, payload: 1 });
    ipc.emit("plugin:p:ch", {}, { panelId: "a", payload: 2 });
    ipc.emit("plugin:p:ch", {}, "raw");

    expect(broadcast.mock.calls).toEqual([[1], ["raw"]]);
    expect(panelA.mock.calls).toEqual([[2]]);
    expect(panelB).not.toHaveBeenCalled();
  });

  it("replays batched pushes through the per-channel dispatcher in order", () => {
    const received: unknown[] = [];
    transport.on("p", "ch", null, (payload) => received.push(payload));
    ipc.emit("plugin-push:batch", {}, [
      ["plugin:p:ch", { panelId: null, payload: 1 }],
      ["plugin:other:ch", { panelId: null, payload: 2 }],
      ["plugin:p:ch", { panelId: null, payload: 3 }],
    ]);
    expect(received).toEqual([1, 3]);
  });

  it("detaches the channel listener and reports the change once every bucket empties", async () => {
    await Promise.resolve();
    ipc.send.mockClear();

    const disposeA = transport.on("p", "ch", "a", vi.fn());
    const broadcast = vi.fn();
    const disposeB = transport.on("p", "ch", null, broadcast);
    await Promise.resolve();
    expect(reports(ipc)).toEqual([
      [
        ["plugin:p:ch", "a"],
        ["plugin:p:ch", null],
      ],
    ]);

    disposeA();
    expect(ipc.listenerCount("plugin:p:ch")).toBe(1);
    ipc.emit("plugin:p:ch", {}, { panelId: null, payload: 1 });
    expect(broadcast).toHaveBeenCalledWith(1);
    await Promise.resolve();
    expect(reports(ipc).at(-1)).toEqual([["plugin:p:ch", null]]);

    disposeB();
    expect(ipc.listenerCount("plugin:p:ch")).toBe(0);
    await Promise.resolve();
    expect(reports(ipc).at(-1)).toEqual([]);
  });

  it("removes only the disposed registration when one callback subscribes twice", () => {
    const cb = vi.fn();
    const disposeFirst = transport.on("p", "ch", null, cb);
    const disposeSecond = transport.on("p", "ch", null, cb);

    ipc.emit("plugin:p:ch", {}, { panelId: null, payload: 1 });
    expect(cb).toHaveBeenCalledTimes(2);
    disposeFirst();
    ipc.emit("plugin:p:ch", {}, { panelId: null, payload: 2 });
    expect(cb).toHaveBeenCalledTimes(3);
    disposeSecond();
    expect(ipc.listenerCount("plugin:p:ch")).toBe(0);
  });

  it("keeps a subscriber's own registry separate from another transport instance", () => {
    const otherIpc = new FakeIpcRenderer();
    const other = createPluginPushTransport(otherIpc.asPreloadIpc(), invoke);
    const mine = vi.fn();
    const theirs = vi.fn();
    transport.on("p", "ch", null, mine);
    other.on("p", "ch", null, theirs);

    ipc.emit("plugin:p:ch", {}, { panelId: null, payload: 1 });
    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
  });

  it("flushes a pending listener report before forwarding an invoke", async () => {
    await Promise.resolve();
    ipc.send.mockClear();
    transport.on("p", "ch", null, vi.fn());
    let reportsAtInvoke: unknown[] = [];
    invoke.mockImplementation(() => {
      reportsAtInvoke = reports(ipc);
      return Promise.resolve("ok");
    });

    await expect(transport.invoke("plugin:invoke", "p", "snapshot")).resolves.toBe("ok");
    expect(reportsAtInvoke).toEqual([[["plugin:p:ch", null]]]);
    expect(invoke).toHaveBeenCalledWith("plugin:invoke", "p", "snapshot");
    await Promise.resolve();
    expect(reports(ipc)).toHaveLength(1);
  });

  it("attributes deliveries to the plugin whose subscriber ran in the window", () => {
    transport.on("p", "ch", null, vi.fn());
    const before = performance.now();
    ipc.emit("plugin:p:ch", {}, { panelId: null, payload: 1 });
    const after = performance.now();

    expect(transport.pluginsWithPushDeliveriesDuring(before, after)).toEqual(["p"]);
    expect(transport.pluginsWithPushDeliveriesDuring("x", after)).toEqual([]);
  });
});

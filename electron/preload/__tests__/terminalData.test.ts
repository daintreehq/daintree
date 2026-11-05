import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalDataMultiplexer } from "../terminalData.js";
import { FakeIpcRenderer } from "./fakeIpcRenderer.js";

describe("createTerminalDataMultiplexer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("routes typed arrays and rejects malformed chunks without Node globals in the sandbox", () => {
    const ipc = new FakeIpcRenderer();
    const mux = createTerminalDataMultiplexer(ipc.asPreloadIpc());
    const subscriber = vi.fn();
    const data = Buffer.from([1, 2]);
    mux.on("t", subscriber);
    vi.stubGlobal("Buffer", undefined);

    ipc.emit("terminal:data", {}, "t", data);
    ipc.emit("terminal:data", {}, "t", { invalid: true });

    expect(subscriber.mock.calls).toEqual([[data]]);
  });

  it("attaches one terminal:data listener lazily and routes chunks by terminal id", () => {
    const ipc = new FakeIpcRenderer();
    const mux = createTerminalDataMultiplexer(ipc.asPreloadIpc());
    expect(ipc.listenerCount("terminal:data")).toBe(0);

    const a = vi.fn();
    const b = vi.fn();
    mux.on("a", a);
    mux.on("b", b);
    expect(ipc.listenerCount("terminal:data")).toBe(1);

    ipc.emit("terminal:data", {}, "a", "hello", 5);
    ipc.emit("terminal:data", {}, "b", new Uint8Array([1]));
    ipc.emit("terminal:data", {}, "a", { not: "data" });

    expect(a.mock.calls).toEqual([["hello"]]);
    expect(b.mock.calls).toEqual([[new Uint8Array([1])]]);
  });

  it("removes only the disposed registration when one callback subscribes twice", () => {
    const ipc = new FakeIpcRenderer();
    const mux = createTerminalDataMultiplexer(ipc.asPreloadIpc());
    const cb = vi.fn();
    const disposeFirst = mux.on("t", cb);
    mux.on("t", cb);

    disposeFirst();
    ipc.emit("terminal:data", {}, "t", "x");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

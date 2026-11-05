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

    expect(subscriber.mock.calls).toEqual([[data, undefined]]);
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

    expect(a.mock.calls).toStrictEqual([["hello", 5]]);
    expect(b.mock.calls).toStrictEqual([[new Uint8Array([1]), undefined]]);
  });

  it("hands every subscriber the chunk's stream offset, and undefined without a numeric one", () => {
    const ipc = new FakeIpcRenderer();
    const mux = createTerminalDataMultiplexer(ipc.asPreloadIpc());
    const first = vi.fn();
    const second = vi.fn();
    mux.on("t", first);
    mux.on("t", second);
    mux.on("t", second);

    ipc.emit("terminal:data", {}, "t", "x", 7);
    ipc.emit("terminal:data", {}, "t", "y");
    ipc.emit("terminal:data", {}, "t", "z", "9");

    const expected = [
      ["x", 7],
      ["y", undefined],
      ["z", undefined],
    ];
    expect(first.mock.calls).toStrictEqual(expected);
    expect(second.mock.calls).toStrictEqual(expected.flatMap((call) => [call, call]));
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

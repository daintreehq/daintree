import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus, type EventBus } from "../eventBus.js";
import { FakeIpcRenderer } from "./fakeIpcRenderer.js";

const push = (ipc: FakeIpcRenderer, name: string, payload: unknown) =>
  ipc.emit("events:push", {}, { name, payload });

describe("createEventBus", () => {
  let ipc: FakeIpcRenderer;
  let bus: EventBus;

  beforeEach(() => {
    ipc = new FakeIpcRenderer();
    bus = createEventBus(ipc.asPreloadIpc());
  });

  it("wires its single events:push listener at creation, before any subscriber", () => {
    expect(ipc.listenerCount("events:push")).toBe(1);
    bus.on("window:fullscreen-change", vi.fn());
    bus.on("terminal:exit", vi.fn());
    expect(ipc.listenerCount("events:push")).toBe(1);
  });

  it("replays only the latest latest-wins event to a late first subscriber", () => {
    push(ipc, "window:disk-space-status", { status: "warning" });
    push(ipc, "window:disk-space-status", { status: "critical" });

    const received: unknown[] = [];
    bus.on("window:disk-space-status", (payload) => received.push(payload));
    expect(received).toEqual([{ status: "critical" }]);

    const second: unknown[] = [];
    bus.on("window:disk-space-status", (payload) => second.push(payload));
    expect(second).toEqual([]);
  });

  it("replays every FIFO event in arrival order", () => {
    push(ipc, "plugin:archive-install-intent", { path: "a.dntr" });
    push(ipc, "plugin:archive-install-intent", { path: "b.dntr" });

    const received: unknown[] = [];
    bus.on("plugin:archive-install-intent", (payload) => received.push(payload));
    expect(received).toEqual([{ path: "a.dntr" }, { path: "b.dntr" }]);
  });

  it("drops non-replayable events that arrive before any subscriber", () => {
    push(ipc, "window:fullscreen-change", true);
    const received: unknown[] = [];
    bus.on("window:fullscreen-change", (payload) => received.push(payload));
    expect(received).toEqual([]);
  });

  it("dispatches each push to the subscribers present when it arrived", () => {
    const received: string[] = [];
    let disposeSecond = (): void => {};
    bus.on("window:fullscreen-change", () => {
      received.push("first");
      disposeSecond();
      bus.on("window:fullscreen-change", () => received.push("late"));
    });
    disposeSecond = bus.on("window:fullscreen-change", () => received.push("second"));

    push(ipc, "window:fullscreen-change", true);
    expect(received).toEqual(["first", "second"]);
  });

  it("gives each bus instance its own subscribers and buffer", () => {
    const otherIpc = new FakeIpcRenderer();
    const other = createEventBus(otherIpc.asPreloadIpc());
    push(ipc, "plugin:deep-link", { url: "daintree://one" });

    const received: unknown[] = [];
    other.on("plugin:deep-link", (payload) => received.push(payload));
    expect(received).toEqual([]);

    const mine = vi.fn();
    bus.on("window:fullscreen-change", mine);
    push(otherIpc, "window:fullscreen-change", true);
    expect(mine).not.toHaveBeenCalled();
  });
});

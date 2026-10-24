import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreePortClient, connectWorktreePortClient } from "../worktreePortClient.js";
import { FakeIpcRenderer } from "./fakeIpcRenderer.js";

class FakePort {
  onmessage: ((msg: { data: unknown }) => void) | null = null;
  postMessage = vi.fn();
  // A local close fires the port's own close event, once.
  close = vi.fn(() => this.fireClose());
  private closed = false;
  private closeListeners: Array<() => void> = [];

  addEventListener(type: string, listener: () => void): void {
    if (type === "close") this.closeListeners.push(listener);
  }

  fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const asPort = (port: FakePort) => port as unknown as MessagePort;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorktreePortClient", () => {
  it("rejects a request with an encoded HOST_EXITED while no port is attached", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new WorktreePortClient();
    await expect(client.request("get-all-states")).rejects.toThrow(
      "[BrokerError|HOST_EXITED] Worktree port not ready"
    );
  });

  it("correlates responses to requests and fans host events out by type", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = new WorktreePortClient();
    const port = new FakePort();
    client.attach(asPort(port));

    const first = client.request("get-all-states");
    const second = client.request("get-all-states");
    const [[a], [b]] = port.postMessage.mock.calls as Array<[{ id: string; action: string }]>;
    expect(a!.action).toBe("get-all-states");
    expect(a!.id).not.toBe(b!.id);
    port.reply({ id: b!.id, result: ["second"] });
    port.reply({ id: a!.id, result: ["first"] });
    await expect(first).resolves.toEqual(["first"]);
    await expect(second).resolves.toEqual(["second"]);

    const listener = vi.fn();
    const other = vi.fn();
    const dispose = client.onEvent("worktree-update", listener);
    client.onEvent("worktree-removed", other);
    port.reply({ type: "event", event: { type: "worktree-update", id: "w" } });
    expect(other).not.toHaveBeenCalled();
    dispose();
    port.reply({ type: "event", event: { type: "worktree-update", id: "w2" } });
    expect(listener.mock.calls).toEqual([[{ type: "worktree-update", id: "w" }]]);
  });

  it("ignores a replaced port's late close and disconnects only on the current port's close", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = new WorktreePortClient();
    const disconnected = vi.fn();
    client.onDisconnected(disconnected);
    const oldPort = new FakePort();
    client.attach(asPort(oldPort));
    const pending = client.request("get-all-states");

    const newPort = new FakePort();
    client.attach(asPort(newPort));
    expect(oldPort.close).toHaveBeenCalled();
    await expect(pending).rejects.toThrow("[BrokerError|HOST_EXITED] Worktree port replaced");
    oldPort.fireClose();
    expect(client.isReady()).toBe(true);
    expect(disconnected).not.toHaveBeenCalled();

    const current = client.request("get-all-states");
    newPort.fireClose();
    await expect(current).rejects.toThrow("[BrokerError|HOST_EXITED] Worktree port disconnected");
    expect(client.isReady()).toBe(false);
    client._handlePortClose(2);
    expect(disconnected).toHaveBeenCalledTimes(1);
  });
});

describe("connectWorktreePortClient", () => {
  it("attaches a delivered port and acks only a numeric token", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ipc = new FakeIpcRenderer();
    const client = connectWorktreePortClient(ipc.asPreloadIpc());
    const order: string[] = [];
    const ready = vi.fn(() => order.push("ready"));
    client.onReady(ready);
    ipc.send.mockImplementation(() => order.push("ack"));

    ipc.emit("worktree-port", { ports: [asPort(new FakePort())] }, { token: 7 });
    expect(order).toEqual(["ready", "ack"]);
    expect(ipc.send).toHaveBeenCalledWith("worktree:port-ack", { token: 7 });

    ipc.send.mockClear();
    ipc.emit("worktree-port", { ports: [asPort(new FakePort())] }, { token: "7" });
    ipc.emit("worktree-port", { ports: [] }, { token: 8 });
    expect(ipc.send).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("fires fatal callbacks only for a fatal host-disconnected broadcast", () => {
    const ipc = new FakeIpcRenderer();
    const client = connectWorktreePortClient(ipc.asPreloadIpc());
    const fatal = vi.fn();
    client.onFatalDisconnect(fatal);

    ipc.emit("worktree:host-disconnected", {}, { fatal: false });
    ipc.emit("worktree:host-disconnected", {}, undefined);
    expect(fatal).not.toHaveBeenCalled();
    ipc.emit("worktree:host-disconnected", {}, { fatal: true });
    expect(fatal).toHaveBeenCalledTimes(1);
  });
});

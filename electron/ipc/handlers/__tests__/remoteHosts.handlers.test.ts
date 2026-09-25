import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "1.2.3" },
}));

const storeValues = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../../store.js", () => ({
  store: { get: (key: string) => storeValues.get(key) },
}));

const { remoteHostsNamespace } = await import("../remoteHosts.js");
const { registerRemoteService, _resetRemoteServicesForTest } =
  await import("../../../remote/runtime.js");

type Handler = (...args: unknown[]) => Promise<unknown>;
const ops = remoteHostsNamespace.ops as unknown as Record<string, { handler: Handler }>;

const ctx = { event: null, webContentsId: 5, senderWindow: null, projectId: null };

afterEach(() => {
  _resetRemoteServicesForTest();
  storeValues.clear();
});

describe("remoteHosts handlers", () => {
  it("answers with this machine and an empty list before the remote runtime starts", async () => {
    await expect(ops.list!.handler()).resolves.toEqual([]);
    await expect(ops.getWindowHost!.handler(ctx)).resolves.toMatchObject({
      hostId: "local",
      descriptor: null,
      connection: { status: "local" },
      hostPlatform: process.platform,
    });
  });

  it("refuses mutations with a typed error until the runtime is running", async () => {
    await expect(ops.add!.handler({ name: "box", sshTarget: "box.example" })).rejects.toMatchObject(
      { code: "UNSUPPORTED" }
    );
    await expect(
      ops.switchWindowHost!.handler(ctx, { hostId: "box", newWindow: false })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("delegates to the running client", async () => {
    const client = {
      list: vi.fn(() => ["entry"]),
      add: vi.fn(() => ({ id: "box" })),
      update: vi.fn(async () => ({ id: "box" })),
      forget: vi.fn(async () => {}),
      connect: vi.fn(() => ({ status: "connecting", attempt: 1 })),
      disconnect: vi.fn(async () => {}),
      getWindowHost: vi.fn(() => ({ hostId: "box" })),
      switchWindowHost: vi.fn(async () => {}),
    };
    registerRemoteService("remoteHostsClient", client as never);

    await expect(ops.list!.handler()).resolves.toEqual(["entry"]);
    await ops.add!.handler({ name: "box", sshTarget: "box.example" });
    await ops.connect!.handler({ hostId: "box" });
    await expect(ops.getWindowHost!.handler(ctx)).resolves.toEqual({ hostId: "box" });
    await ops.switchWindowHost!.handler(ctx, { hostId: "box", newWindow: true });

    expect(client.add).toHaveBeenCalledWith({ name: "box", sshTarget: "box.example" });
    expect(client.connect).toHaveBeenCalledWith({ hostId: "box" });
    expect(client.switchWindowHost).toHaveBeenCalledWith(ctx, { hostId: "box", newWindow: true });
  });

  it("reports not in use for a user who never set up a host", async () => {
    expect(ops.isInUse!.handler()).toBe(false);
    storeValues.set("remoteHosts", { hosts: [] });
    storeValues.set("hostMode", { enabled: false, startAtLogin: false });
    expect(ops.isInUse!.handler()).toBe(false);
  });

  it("reports in use once a host is configured", async () => {
    storeValues.set("remoteHosts", { hosts: [{ id: "box", name: "box", sshTarget: "box" }] });
    expect(ops.isInUse!.handler()).toBe(true);
  });

  it("reports in use while Host mode is enabled or running", async () => {
    storeValues.set("hostMode", { enabled: true, startAtLogin: false });
    expect(ops.isInUse!.handler()).toBe(true);
    storeValues.clear();
    // A `--host-mode` launch runs the server without the setting.
    registerRemoteService("hostServer", {} as never);
    expect(ops.isInUse!.handler()).toBe(true);
  });

  it("leaves discovery and probing to a later change", async () => {
    await expect(ops.discover!.handler()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

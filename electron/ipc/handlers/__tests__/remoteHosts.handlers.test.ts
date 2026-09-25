import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "1.2.3" },
}));

const { remoteHostsNamespace } = await import("../remoteHosts.js");
const { registerRemoteService, _resetRemoteServicesForTest } =
  await import("../../../remote/runtime.js");

type Handler = (...args: unknown[]) => Promise<unknown>;
const ops = remoteHostsNamespace.ops as unknown as Record<string, { handler: Handler }>;

const ctx = { event: null, webContentsId: 5, senderWindow: null, projectId: null };

afterEach(() => {
  _resetRemoteServicesForTest();
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

  it("leaves discovery and probing to a later change", async () => {
    await expect(ops.discover!.handler()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

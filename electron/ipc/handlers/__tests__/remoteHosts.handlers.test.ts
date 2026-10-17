import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "1.2.3" },
}));

const storeValues = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../../store.js", () => ({
  store: { get: (key: string) => storeValues.get(key) },
}));

const getProjectSummaries = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getProjectSummaries },
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
  getProjectSummaries.mockReset();
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
    await expect(
      ops.add!.handler({ name: "box", connection: { kind: "ssh", target: "box.example" } })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
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
    await ops.add!.handler({ name: "box", connection: { kind: "ssh", target: "box.example" } });
    await ops.connect!.handler({ hostId: "box" });
    await expect(ops.getWindowHost!.handler(ctx)).resolves.toEqual({ hostId: "box" });
    await ops.switchWindowHost!.handler(ctx, { hostId: "box", newWindow: true });

    expect(client.add).toHaveBeenCalledWith({
      name: "box",
      connection: { kind: "ssh", target: "box.example" },
    });
    expect(client.connect).toHaveBeenCalledWith({ hostId: "box" });
    expect(client.switchWindowHost).toHaveBeenCalledWith(ctx, { hostId: "box", newWindow: true });
  });

  it("lists this machine's projects from its own store, even before the runtime starts", async () => {
    getProjectSummaries.mockReturnValue([
      { id: "p1", name: "App", path: "/work/app", emoji: "🌲", status: "active" },
      { id: "p2", name: "Lib", path: "/work/lib", emoji: "" },
    ]);
    await expect(ops.listHostProjects!.handler({ hostId: "local" })).resolves.toEqual([
      { id: "p1", name: "App", path: "/work/app", emoji: "🌲" },
      { id: "p2", name: "Lib", path: "/work/lib" },
    ]);
  });

  it("asks the running client for a remote host's projects", async () => {
    await expect(ops.listHostProjects!.handler({ hostId: "box" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    const listHostProjects = vi.fn(async () => [{ id: "r1", name: "Remote", path: "/srv/r" }]);
    registerRemoteService("remoteHostsClient", { listHostProjects } as never);
    await expect(ops.listHostProjects!.handler({ hostId: "box" })).resolves.toEqual([
      { id: "r1", name: "Remote", path: "/srv/r" },
    ]);
    expect(listHostProjects).toHaveBeenCalledWith({ hostId: "box" });
    expect(getProjectSummaries).not.toHaveBeenCalled();
  });

  it("reports not in use for a user who never set up a host", async () => {
    expect(ops.isInUse!.handler()).toBe(false);
    storeValues.set("remoteHosts", { hosts: [] });
    storeValues.set("hostMode", { enabled: false, startAtLogin: false });
    expect(ops.isInUse!.handler()).toBe(false);
  });

  it("reports in use once a host is configured", async () => {
    storeValues.set("remoteHosts", {
      hosts: [{ id: "box", name: "box", connection: { kind: "ssh", target: "box" } }],
    });
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
});

describe("remoteHosts assistant exchange handlers", () => {
  const live = {
    taskId: "t-1",
    senderId: "sender",
    messageId: "m-1",
    contextId: "ctx-1",
    referenceTaskIds: [],
    receiver: { hostId: "local", laneId: "proj\u00000", enrollmentGeneration: "g" },
    state: "submitted",
    outcome: null,
    bodyDigest: "secret-digest",
    bodyBytes: 4,
    replyDigest: null,
    replyBytes: null,
    delivery: {
      attemptedAt: null,
      acceptedAt: null,
      wakeTypedAt: null,
      inboxFetchedAt: null,
      replyReceivedAt: null,
      ambiguousAt: null,
    },
    cancelRequestedAt: null,
    createdAt: 100,
    updatedAt: 100,
    expiresAt: Date.now() + 60_000,
    terminalAt: null,
    tombstonedAt: null,
    revision: 1,
  };
  const entry = (record: unknown, messageId = "m-1", sentAt = 100) => ({
    hostId: "box",
    messageId,
    sentAt,
    unresolvedAt: record ? null : sentAt,
    lapsedAt: null,
    record,
    updatedAt: sentAt,
  });

  it("lists nothing before the exchange client exists", async () => {
    await expect(ops.listAssistantExchanges!.handler({ hostId: "box" })).resolves.toEqual([]);
    await expect(ops.listAssistantExchanges!.handler({})).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("lists the journal newest first, as views without digests", async () => {
    const listKnown = vi.fn(() => [entry(live), entry(null, "m-2", 200)]);
    registerRemoteService("assistantExchangeClient", { listKnown } as never);
    const views = (await ops.listAssistantExchanges!.handler({ hostId: "box" })) as Array<
      Record<string, unknown>
    >;
    expect(listKnown).toHaveBeenCalledWith("box");
    expect(views.map((view) => view.messageId)).toEqual(["m-2", "m-1"]);
    expect(views[0]).toMatchObject({ state: null, delivery: "unconfirmed", cancel: null });
    expect(views[1]).toMatchObject({
      hostId: "box",
      state: "submitted",
      cancel: "cancel",
      receiver: { projectId: "proj", slot: 0 },
    });
    expect(JSON.stringify(views)).not.toContain("secret-digest");
  });

  it("cancels a recorded exchange and answers with what the journal then holds", async () => {
    const canceled = { ...live, state: "canceled", cancelRequestedAt: 300, revision: 3 };
    const known = vi.fn().mockReturnValueOnce(entry(live)).mockReturnValueOnce(entry(canceled));
    const cancel = vi.fn(async () => ({ ...live, revision: 2 }));
    registerRemoteService("assistantExchangeClient", { known, cancel } as never);
    await expect(
      ops.cancelAssistantExchange!.handler({ hostId: "box", messageId: "m-1" })
    ).resolves.toMatchObject({ state: "canceled", cancel: null });
    expect(cancel).toHaveBeenCalledWith("box", "m-1");
  });

  it("refuses to cancel what this Shell holds no record of", async () => {
    const cancel = vi.fn();
    registerRemoteService("assistantExchangeClient", {
      known: () => entry(null),
      cancel,
    } as never);
    await expect(
      ops.cancelAssistantExchange!.handler({ hostId: "box", messageId: "m-1" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      ops.cancelAssistantExchange!.handler({ hostId: "box", messageId: "" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(cancel).not.toHaveBeenCalled();
  });
});

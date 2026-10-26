import { afterEach, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({
  readLocalSettings: vi.fn(async () => ({ from: "local" })),
  updateLocalSettings: vi.fn(async () => ({ from: "local" })),
}));
vi.mock("../../../remote/settingsControl/local.js", () => local);

const { hostSettingsNamespace } = await import("../hostSettings.js");
const { registerRemoteService, _resetRemoteServicesForTest } =
  await import("../../../remote/runtime.js");

type Handler = (...args: unknown[]) => Promise<unknown>;
const ops = hostSettingsNamespace.ops as unknown as Record<string, { handler: Handler }>;

const update = {
  patch: { "sessionRestore.enabled": false },
  expect: { instanceId: "launch", revisions: { "sessionRestore.enabled": "v:true" } },
};

afterEach(() => {
  _resetRemoteServicesForTest();
  local.readLocalSettings.mockClear();
  local.updateLocalSettings.mockClear();
});

describe("hostSettings handlers (#14706)", () => {
  it("sends `local` to this machine's own settings and every other host over its link", async () => {
    const client = {
      read: vi.fn(async () => ({ from: "link" })),
      update: vi.fn(async () => ({ from: "link" })),
    };
    registerRemoteService("settingsControlClient", client as never);

    await expect(ops.read!.handler({ hostId: "local" })).resolves.toEqual({ from: "local" });
    await expect(ops.update!.handler({ hostId: "local", ...update })).resolves.toEqual({
      from: "local",
    });
    expect(local.readLocalSettings).toHaveBeenCalledWith({ hostId: "local" });
    expect(local.updateLocalSettings).toHaveBeenCalledWith({ hostId: "local", ...update });
    expect(client.read).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();

    await expect(ops.read!.handler({ hostId: "studio-01" })).resolves.toEqual({ from: "link" });
    await expect(ops.update!.handler({ hostId: "studio-01", ...update })).resolves.toEqual({
      from: "link",
    });
    expect(client.read).toHaveBeenCalledWith({ hostId: "studio-01" });
    expect(client.update).toHaveBeenCalledWith({ hostId: "studio-01", ...update });
    expect(local.readLocalSettings).toHaveBeenCalledTimes(1);
    expect(local.updateLocalSettings).toHaveBeenCalledTimes(1);
  });

  it("never lets a paired host's change fall back to this machine when the link isn't running", async () => {
    await expect(ops.update!.handler({ hostId: "studio-01", ...update })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(local.updateLocalSettings).not.toHaveBeenCalled();
  });
});

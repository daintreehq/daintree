import { describe, expect, it, vi } from "vitest";
import { ClientSettingsControl, type SettingsControlSession } from "../ClientSettingsControl.js";
import { SettingsControlLinkMethod } from "../linkMethods.js";

const HOST = "studio-01";

/**
 * A host as the link reaches it, answering reads and updates in the shape the
 * real host does. `knowsModel: false` is a Daintree from before Canopy read
 * locally: its schema refuses any read that names `canopyModel`.
 */
function host({
  knowsModel,
  failReadsWith,
  dropReplies = false,
}: {
  knowsModel: boolean;
  /** Reads fail with this code instead, as a timeout or a disconnect would. */
  failReadsWith?: string;
  /** Updates land but their reply never comes. */
  dropReplies?: boolean;
}) {
  const values: Record<string, unknown> = {
    canopyMode: "unset",
    canopyModel: "daintreehq/canopy-reader-17m",
    "agentDefaults.defaultAgent": "claude",
    "agentDefaults.assistantAgentId": null,
    "idleTerminalNotify.enabled": false,
    "idleTerminalNotify.thresholdMinutes": 60,
  };
  const updates: unknown[] = [];
  const session: SettingsControlSession = {
    isOpen: true,
    call: vi.fn(async (method: string, payload: unknown) => {
      const p = payload as { keys?: string[]; patch?: Record<string, unknown> };
      if (method === SettingsControlLinkMethod.READ) {
        if (failReadsWith) throw Object.assign(new Error("failed"), { code: failReadsWith });
        if (!knowsModel && p.keys!.includes("canopyModel")) {
          throw Object.assign(new Error("Invalid params"), { code: "VALIDATION" });
        }
        return {
          instanceId: "launch-1",
          settings: p.keys!.map((key) => ({ key, value: values[key], revision: "r1" })),
        };
      }
      updates.push(p.patch);
      Object.assign(values, p.patch);
      if (dropReplies) throw Object.assign(new Error("no reply"), { code: "TIMEOUT" });
      return {
        outcome: "applied",
        instanceId: "launch-1",
        settings: Object.keys(p.patch!).map((key) => ({ key, value: values[key], revision: "r2" })),
      };
    }),
  };
  const client = new ClientSettingsControl({
    sessionFor: () => session,
    isKnownHost: (hostId) => hostId === HOST,
    hostLabel: () => "Studio",
  });
  return { client, updates };
}

describe("host settings on a host from before Canopy read locally", () => {
  it("still reads the host's other settings, with no model among them", async () => {
    const { client } = host({ knowsModel: false });
    const snapshot = await client.read({ hostId: HOST });
    const keys = snapshot.settings.map((leaf) => leaf.key);
    expect(keys).toContain("canopyMode");
    expect(keys).toContain("agentDefaults.defaultAgent");
    expect(keys).not.toContain("canopyModel");
  });

  it("refuses to turn Canopy on there, and sends nothing", async () => {
    const { client, updates } = host({ knowsModel: false });
    await expect(
      client.update({
        hostId: HOST,
        patch: { canopyMode: "on" },
        expect: { instanceId: "launch-1", revisions: { canopyMode: "r1" } },
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("Update Daintree on Studio") });
    expect(updates).toEqual([]);
  });

  it("still lets Canopy be turned off there", async () => {
    const { client, updates } = host({ knowsModel: false });
    await client.update({
      hostId: HOST,
      patch: { canopyMode: "unset" },
      expect: { instanceId: "launch-1", revisions: { canopyMode: "r1" } },
    });
    expect(updates).toEqual([{ canopyMode: "unset" }]);
  });

  it("turns Canopy on, model and all, on a host that reads locally", async () => {
    const { client, updates } = host({ knowsModel: true });
    const snapshot = await client.read({ hostId: HOST });
    expect(snapshot.settings.find((leaf) => leaf.key === "canopyModel")?.value).toBe(
      "daintreehq/canopy-reader-17m"
    );
    await client.update({
      hostId: HOST,
      patch: { canopyMode: "on", canopyModel: "daintreehq/canopy-reader-68m" },
      expect: { instanceId: "launch-1", revisions: { canopyMode: "r1", canopyModel: "r1" } },
    });
    expect(updates).toEqual([{ canopyMode: "on", canopyModel: "daintreehq/canopy-reader-68m" }]);
  });

  it("says a transport failure is a failure, never that the host is outdated", async () => {
    const { client, updates } = host({ knowsModel: true, failReadsWith: "HOST_DISCONNECTED" });
    await expect(client.read({ hostId: HOST })).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    await expect(
      client.update({
        hostId: HOST,
        patch: { canopyMode: "on" },
        expect: { instanceId: "launch-1", revisions: { canopyMode: "r1" } },
      })
    ).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(updates).toEqual([]);
  });

  it("never calls a change applied that its readback couldn't cover", async () => {
    // The reply is lost, and the host (reading as old) can't report the model that was asked for.
    const { client } = host({ knowsModel: false, dropReplies: true });
    const result = await client.update({
      hostId: HOST,
      patch: { canopyMode: "unset", canopyModel: "daintreehq/canopy-reader-68m" },
      expect: { instanceId: "launch-1", revisions: { canopyMode: "r1", canopyModel: "r1" } },
    });
    expect(result.outcome).toBe("unconfirmed");
  });
});

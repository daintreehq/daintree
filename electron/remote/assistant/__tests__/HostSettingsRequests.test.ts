// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  HOST_SETTING_KEYS,
  type HostSettingKey,
  type HostSettingValue,
  type HostSettingsSnapshot,
  type HostSettingsUpdatePayload,
  type HostSettingsUpdateResult,
} from "../../../../shared/types/hostSettings.js";
import type { HostSettingsArgs } from "../../../../shared/types/hostControl.js";
import { AppError } from "../../../utils/errorTypes.js";
import { HostSettingsRequests, type HostSettingsRequestDeps } from "../HostSettingsRequests.js";

type Values = Record<HostSettingKey, HostSettingValue>;

function defaults(): Values {
  return {
    canopyMode: "unset",
    "agentDefaults.defaultAgent": "claude",
    "agentDefaults.assistantAgentId": null,
    "idleTerminalNotify.enabled": false,
    "idleTerminalNotify.thresholdMinutes": 60,
  };
}

/** Hosts as the Shell's settings client reaches them, with the host's own guards. */
function fakeHosts(names: Record<string, string>) {
  const hosts = new Map(
    Object.entries(names).map(([hostId, name]) => [
      hostId,
      { name, values: defaults(), instanceId: `${hostId}-launch`, canopyRevision: 0 },
    ])
  );
  const revisionOf = (hostId: string, key: HostSettingKey) => {
    const host = hosts.get(hostId)!;
    return key === "canopyMode"
      ? `${host.canopyRevision}`
      : `v:${JSON.stringify(host.values[key])}`;
  };
  const leaves = (hostId: string, keys: readonly HostSettingKey[]) =>
    keys.map((key) => ({
      key,
      value: hosts.get(hostId)!.values[key],
      revision: revisionOf(hostId, key),
    }));
  const updates: HostSettingsUpdatePayload[] = [];
  const offline = new Set<string>();
  const client = {
    read: vi.fn(async ({ hostId, keys }: { hostId: string; keys?: HostSettingKey[] }) => {
      const host = hosts.get(hostId);
      if (!host || offline.has(hostId)) {
        throw new AppError({ code: "HOST_DISCONNECTED", message: "gone" });
      }
      return {
        hostId,
        hostName: host.name,
        scope: "host",
        instanceId: host.instanceId,
        settings: leaves(hostId, keys ?? [...HOST_SETTING_KEYS]),
      } satisfies HostSettingsSnapshot;
    }),
    update: vi.fn(async (payload: HostSettingsUpdatePayload): Promise<HostSettingsUpdateResult> => {
      updates.push(structuredClone(payload));
      const host = hosts.get(payload.hostId)!;
      const keys = HOST_SETTING_KEYS.filter((key) => key in payload.patch);
      const base = { hostId: payload.hostId, hostName: host.name, scope: "host" as const };
      const current =
        payload.expect.instanceId === host.instanceId &&
        keys.every((key) => payload.expect.revisions[key] === revisionOf(payload.hostId, key));
      if (!current) {
        return {
          ...base,
          outcome: "conflict",
          confirmedBy: null,
          instanceId: host.instanceId,
          settings: leaves(payload.hostId, keys),
        };
      }
      if (payload.patch.canopyMode === "on" && host.values.canopyMode === "hidden") {
        throw new AppError({
          code: "PERMISSION",
          message: "hidden",
          userMessage: "Show Canopy first.",
        });
      }
      for (const key of keys) {
        const value = payload.patch[key] as HostSettingValue;
        if (key === "canopyMode" && value !== host.values.canopyMode) host.canopyRevision++;
        host.values[key] = value;
      }
      return {
        ...base,
        outcome: "applied",
        confirmedBy: "reply",
        instanceId: host.instanceId,
        settings: leaves(payload.hostId, keys),
      };
    }),
  };
  return { hosts, client, updates, offline };
}

function setup(
  names: Record<string, string> = { a: "Alpha", b: "Beta" },
  overrides: Partial<HostSettingsRequestDeps> = {}
) {
  const fake = fakeHosts(names);
  let now = 1_000;
  let id = 0;
  const control = new Set(Object.keys(names));
  const askApproval = vi.fn<NonNullable<HostSettingsRequestDeps["askApproval"]>>(
    async () => "approved"
  );
  const requests = new HostSettingsRequests({
    client: () => fake.client,
    hostName: (hostId) => fake.hosts.get(hostId)?.name ?? null,
    controlOn: (hostId) => control.has(hostId),
    askApproval,
    now: () => now,
    newId: () => `ticket-${++id}`,
    ...overrides,
  });
  let running = true;
  const run = (args: HostSettingsArgs, session = "s1") =>
    requests.run(session, () => running, args);
  return {
    ...fake,
    requests,
    run,
    control,
    askApproval,
    advance: (ms: number) => (now += ms),
    stop: () => (running = false),
  };
}

describe("host.settings (#14167)", () => {
  it("reads named settings on each host, and never this machine or a host it can't reach", async () => {
    const t = setup();
    t.control.delete("b");
    const result = await t.run({
      operation: "read",
      hostIds: ["a", "b", "local", "nope"],
      keys: ["canopyMode"],
    });
    expect(result.hosts.map(({ hostId, outcome }) => [hostId, outcome])).toEqual([
      ["a", "ok"],
      ["b", "opted_out"],
      ["local", "policy_rejected"],
      ["nope", "not_found"],
    ]);
    expect(result.hosts[0]!.settings).toEqual([{ key: "canopyMode", value: "unset" }]);
    expect(t.client.read).toHaveBeenCalledTimes(1);
  });

  it("previews without changing anything, and a ticket only covers hosts that could all be read", async () => {
    const t = setup();
    const preview = await t.run({
      operation: "preview",
      hostIds: ["a", "b"],
      patch: { canopyMode: "on" },
    });
    expect(preview.ticket).toBe("ticket-1");
    expect(preview.hosts[1]!.settings).toEqual([
      { key: "canopyMode", value: "unset", proposed: "on" },
    ]);
    expect(t.client.update).not.toHaveBeenCalled();

    t.offline.add("b");
    const blocked = await t.run({
      operation: "preview",
      hostIds: ["a", "b"],
      patch: { canopyMode: "on" },
    });
    expect(blocked.ticket).toBeNull();
    expect(blocked.hosts.map((host) => host.outcome)).toEqual(["ok", "disconnected"]);
  });

  it("gives no ticket when every host is already set, or for a value the host wouldn't store", async () => {
    const t = setup();
    const same = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { "agentDefaults.defaultAgent": "claude" },
    });
    expect(same.ticket).toBeNull();
    const invalid = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { "agentDefaults.defaultAgent": "not-an-agent" },
    });
    expect(invalid).toMatchObject({ outcome: "policy_rejected", ticket: null });
    expect(t.client.read).toHaveBeenCalledTimes(1);
  });

  it("turns Canopy on across exact hosts after one approval of what was previewed, showing a hidden one first", async () => {
    const t = setup();
    t.hosts.get("b")!.values.canopyMode = "hidden";
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["a", "b"],
      patch: { canopyMode: "on" },
    });
    const result = await t.run({ operation: "apply", ticket: ticket! });

    expect(t.askApproval).toHaveBeenCalledTimes(1);
    const ask = t.askApproval.mock.calls[0]![0];
    expect(ask).toMatchObject({
      helpSessionId: "s1",
      actionId: "host.settings",
      subject: "Change settings on 2 hosts",
    });
    expect(ask.lines).toEqual(
      expect.arrayContaining([
        "Alpha: Canopy off → on",
        "Beta: Canopy hidden → on",
        "Beta: Canopy is hidden there, and will be shown first",
      ])
    );
    expect(
      result.hosts.map(({ hostId, outcome, settings }) => [hostId, outcome, settings])
    ).toEqual([
      ["a", "ok", [{ key: "canopyMode", value: "on" }]],
      ["b", "ok", [{ key: "canopyMode", value: "on" }]],
    ]);
    expect(t.updates.filter((u) => u.hostId === "b").map((u) => u.patch.canopyMode)).toEqual([
      "unset",
      "on",
    ]);
  });

  it("writes exactly the previewed values against the previewed revisions, reporting the readback", async () => {
    const t = setup({ a: "Alpha" });
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { "idleTerminalNotify.enabled": true, "idleTerminalNotify.thresholdMinutes": 30 },
    });
    const result = await t.run({ operation: "apply", ticket: ticket! });
    expect(t.updates).toEqual([
      {
        hostId: "a",
        patch: { "idleTerminalNotify.enabled": true, "idleTerminalNotify.thresholdMinutes": 30 },
        expect: {
          instanceId: "a-launch",
          revisions: {
            "idleTerminalNotify.enabled": "v:false",
            "idleTerminalNotify.thresholdMinutes": "v:60",
          },
        },
      },
    ]);
    expect(result.hosts[0]).toMatchObject({
      outcome: "ok",
      settings: [
        { key: "idleTerminalNotify.enabled", value: true },
        { key: "idleTerminalNotify.thresholdMinutes", value: 30 },
      ],
    });
  });

  it("changes nothing when the person declines, can't be asked, or the run was replaced meanwhile", async () => {
    for (const [decision, expected] of [
      ["rejected", "policy_rejected"],
      [null, "policy_rejected"],
    ] as const) {
      const t = setup();
      t.askApproval.mockResolvedValueOnce(decision);
      const { ticket } = await t.run({
        operation: "preview",
        hostIds: ["a"],
        patch: { canopyMode: "on" },
      });
      expect((await t.run({ operation: "apply", ticket: ticket! })).outcome).toBe(expected);
      expect(t.client.update).not.toHaveBeenCalled();
    }
    const t = setup();
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { canopyMode: "on" },
    });
    t.askApproval.mockImplementationOnce(async () => {
      t.stop();
      return "approved";
    });
    expect((await t.run({ operation: "apply", ticket: ticket! })).outcome).toBe("policy_rejected");
    expect(t.client.update).not.toHaveBeenCalled();
  });

  it("never applies without a way to ask the person, whatever the caller says", async () => {
    const t = setup(undefined, { askApproval: undefined });
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { canopyMode: "on" },
    });
    const forged = { operation: "apply", ticket: ticket!, confirmed: true } as HostSettingsArgs;
    expect((await t.run(forged)).outcome).toBe("policy_rejected");
    expect(t.client.update).not.toHaveBeenCalled();
  });

  it("spends a ticket on its first apply, and holds it to the session and lifetime it was made for", async () => {
    const t = setup();
    const first = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { canopyMode: "on" },
    });
    expect((await t.run({ operation: "apply", ticket: first.ticket! }, "s2")).outcome).toBe(
      "expired"
    );

    const second = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { canopyMode: "on" },
    });
    t.advance(5 * 60_000);
    expect((await t.run({ operation: "apply", ticket: second.ticket! })).outcome).toBe("expired");

    const third = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { canopyMode: "on" },
    });
    expect((await t.run({ operation: "apply", ticket: third.ticket! })).outcome).toBe("ok");
    expect((await t.run({ operation: "apply", ticket: third.ticket! })).outcome).toBe("expired");
    expect(t.askApproval).toHaveBeenCalledTimes(1);
  });

  it("asks nothing once control of a named host is turned off", async () => {
    const t = setup();
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["a", "b"],
      patch: { canopyMode: "on" },
    });
    t.control.delete("b");
    expect((await t.run({ operation: "apply", ticket: ticket! })).outcome).toBe("opted_out");
    expect(t.askApproval).not.toHaveBeenCalled();
  });

  it("leaves a host whose setting moved, or that restarted, since the preview", async () => {
    const t = setup();
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["a", "b"],
      patch: { canopyMode: "on", "idleTerminalNotify.enabled": true },
    });
    t.hosts.get("a")!.canopyRevision = 3;
    t.hosts.get("b")!.instanceId = "b-relaunch";
    const result = await t.run({ operation: "apply", ticket: ticket! });
    expect(result.hosts.map((host) => host.outcome)).toEqual(["conflict", "conflict"]);
    expect(t.client.update).not.toHaveBeenCalled();
    expect(t.hosts.get("a")!.values).toMatchObject({
      canopyMode: "unset",
      "idleTerminalNotify.enabled": false,
    });
    expect(t.hosts.get("b")!.values).toMatchObject({
      canopyMode: "unset",
      "idleTerminalNotify.enabled": false,
    });
  });
});

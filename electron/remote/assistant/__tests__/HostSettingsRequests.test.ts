// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_HOST_SETTING_KEYS,
  type AssistantHostSettingKey,
  type HostSettingKey,
  type HostSettingValue,
  type HostSettingsSnapshot,
  type HostSettingsUpdatePayload,
  type HostSettingsUpdateResult,
} from "../../../../shared/types/hostSettings.js";
import type { HostSettingsArgs } from "../../../../shared/types/hostControl.js";
import { AppError } from "../../../utils/errorTypes.js";
import { canopyLocalOn, canopyStopOn } from "../../../../shared/config/canopyTerms.js";
import { HostSettingsRequests, type HostSettingsRequestDeps } from "../HostSettingsRequests.js";

type Values = Record<AssistantHostSettingKey, HostSettingValue>;

function defaults(): Values {
  return {
    canopyMode: "unset",
    canopyModel: "daintreehq/canopy-reader-17m",
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
  const revisionOf = (hostId: string, key: AssistantHostSettingKey) => {
    const host = hosts.get(hostId)!;
    return key === "canopyMode"
      ? `${host.canopyRevision}`
      : `v:${JSON.stringify(host.values[key])}`;
  };
  const leaves = (hostId: string, keys: readonly AssistantHostSettingKey[]) =>
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
        unavailable: [],
        settings: leaves(
          hostId,
          ASSISTANT_HOST_SETTING_KEYS.filter((key) => (keys ?? [key]).includes(key))
        ),
      } satisfies HostSettingsSnapshot;
    }),
    update: vi.fn(async (payload: HostSettingsUpdatePayload): Promise<HostSettingsUpdateResult> => {
      updates.push(structuredClone(payload));
      const host = hosts.get(payload.hostId)!;
      const keys = ASSISTANT_HOST_SETTING_KEYS.filter((key) => key in payload.patch);
      const base = { hostId: payload.hostId, hostName: host.name, scope: "host" as const };
      const current =
        payload.expect.instanceId === host.instanceId &&
        keys.every((key) => payload.expect.revisions[key] === revisionOf(payload.hostId, key));
      if (!current) {
        return {
          ...base,
          outcome: "conflict",
          confirmedBy: "reply",
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
    // One guarded update per host, made whole or not at all: the idle alert
    // whose own revision still held isn't written either.
    expect(t.client.update).toHaveBeenCalledTimes(2);
    expect(result.hosts[0]!.detail).toMatch(/Nothing was changed/);
    expect(t.hosts.get("a")!.values).toMatchObject({
      canopyMode: "unset",
      "idleTerminalNotify.enabled": false,
    });
    expect(t.hosts.get("b")!.values).toMatchObject({
      canopyMode: "unset",
      "idleTerminalNotify.enabled": false,
    });
  });

  it("asks the person with the same consent Settings states before Canopy reads a host", async () => {
    const t = setup({ a: "Alpha" });
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { canopyMode: "on" },
    });
    await t.run({ operation: "apply", ticket: ticket! });
    const lines = t.askApproval.mock.calls[0]![0].lines;
    expect(lines).toContain(canopyLocalOn("Alpha"));
    expect(lines).toContain(canopyStopOn("Alpha"));
  });

  it("leaves a host already set as asked untouched, and reports it as it is", async () => {
    const t = setup();
    t.hosts.get("b")!.values.canopyMode = "on";
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["a", "b"],
      patch: { canopyMode: "on" },
    });
    const result = await t.run({ operation: "apply", ticket: ticket! });
    expect(result.hosts.map(({ outcome, settings }) => [outcome, settings])).toEqual([
      ["ok", [{ key: "canopyMode", value: "on" }]],
      ["ok", [{ key: "canopyMode", value: "on" }]],
    ]);
    expect(t.updates.map((update) => update.hostId)).toEqual(["a"]);
  });

  it("stops before the next write once control is turned off, and says what had landed", async () => {
    const t = setup({ b: "Beta" });
    t.hosts.get("b")!.values.canopyMode = "hidden";
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["b"],
      patch: { canopyMode: "on" },
    });
    const update = t.client.update.getMockImplementation()!;
    t.client.update.mockImplementation(async (payload) => {
      const answer = await update(payload);
      t.control.delete("b");
      return answer;
    });
    const result = await t.run({ operation: "apply", ticket: ticket! });
    expect(t.updates.map((u) => u.patch.canopyMode)).toEqual(["unset"]);
    expect(result.hosts[0]).toMatchObject({
      outcome: "policy_rejected",
      detail: expect.stringMatching(/^Canopy was shown there, but not turned on/),
      settings: [{ key: "canopyMode", value: "unset" }],
    });
  });

  it("reports a hidden Canopy shown but not turned on when it changes between the steps", async () => {
    const t = setup({ b: "Beta" });
    t.hosts.get("b")!.values.canopyMode = "hidden";
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["b"],
      patch: { canopyMode: "on" },
    });
    const update = t.client.update.getMockImplementation()!;
    t.client.update.mockImplementation(async (payload) => {
      const answer = await update(payload);
      if (payload.patch.canopyMode === "unset") t.hosts.get("b")!.canopyRevision += 1;
      return answer;
    });
    const result = await t.run({ operation: "apply", ticket: ticket! });
    expect(result.hosts[0]).toMatchObject({
      outcome: "conflict",
      detail: expect.stringMatching(/^Canopy was shown there, but not turned on/),
      settings: [{ key: "canopyMode", value: "unset" }],
    });
  });

  it("names a host limiting its changes as rate limited, not unreachable", async () => {
    const t = setup({ a: "Alpha" });
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { canopyMode: "on" },
    });
    t.client.update.mockRejectedValueOnce(new AppError({ code: "RATE_LIMITED", message: "slow" }));
    const result = await t.run({ operation: "apply", ticket: ticket! });
    expect(result.hosts[0]!.outcome).toBe("rate_limited");
  });

  it("keeps at most four live previews per assistant, without touching another's", async () => {
    const t = setup({ a: "Alpha" });
    const other = await t.run(
      { operation: "preview", hostIds: ["a"], patch: { canopyMode: "on" } },
      "s2"
    );
    const mine: string[] = [];
    for (let i = 0; i < 5; i++) {
      mine.push(
        (await t.run({ operation: "preview", hostIds: ["a"], patch: { canopyMode: "on" } })).ticket!
      );
    }
    expect((await t.run({ operation: "apply", ticket: mine[0]! })).outcome).toBe("expired");
    expect((await t.run({ operation: "apply", ticket: other.ticket! }, "s2")).outcome).toBe("ok");
  });

  it("doesn't claim nothing changed when the answer was lost, nor repeat values it can't vouch for", async () => {
    const t = setup({ a: "Alpha" });
    const { ticket } = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { canopyMode: "on", "idleTerminalNotify.enabled": true },
    });
    const lost = (outcome: "conflict" | "unconfirmed"): HostSettingsUpdateResult => ({
      hostId: "a",
      hostName: "Alpha",
      scope: "host",
      outcome,
      confirmedBy: outcome === "conflict" ? "readback" : null,
      instanceId: outcome === "conflict" ? "a-launch" : null,
      settings:
        outcome === "conflict"
          ? [
              { key: "canopyMode", value: "unset", revision: "2" },
              { key: "idleTerminalNotify.enabled", value: true, revision: "v:true" },
            ]
          : [],
    });
    t.client.update.mockResolvedValueOnce(lost("conflict"));
    const seen = await t.run({ operation: "apply", ticket: ticket! });
    expect(seen.hosts[0]).toMatchObject({ outcome: "ambiguous" });
    expect(seen.hosts[0]!.detail).not.toMatch(/Nothing was changed/);

    const again = await t.run({
      operation: "preview",
      hostIds: ["a"],
      patch: { canopyMode: "on", "idleTerminalNotify.enabled": true },
    });
    t.client.update.mockResolvedValueOnce(lost("unconfirmed"));
    const unknown = await t.run({ operation: "apply", ticket: again.ticket! });
    expect(unknown.hosts[0]).toMatchObject({ outcome: "ambiguous", settings: [] });
  });
});

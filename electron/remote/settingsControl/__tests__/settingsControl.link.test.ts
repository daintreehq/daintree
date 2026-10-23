// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostSettingRefusal,
  type HostSettingKey,
  type HostSettingValue,
  type HostSettingsPatch,
} from "../../../../shared/types/hostSettings.js";
import { AppError } from "../../../utils/errorTypes.js";
import type { LinkSession } from "../../link/session.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import { ClientSettingsControl, type SettingsControlSession } from "../ClientSettingsControl.js";
import { HostSettingsControl, type HostSettingsLeaves } from "../HostSettingsControl.js";
import { SettingsControlLinkMethod } from "../linkMethods.js";

const HOST = "studio-01";

/**
 * A host's settings in memory, with the same revision rules as the real
 * setters: Canopy counts its own changes, everything else is its value's digest.
 */
function fakeHost() {
  const values: Record<HostSettingKey, HostSettingValue> = {
    canopyMode: "unset",
    "agentDefaults.defaultAgent": "claude",
    "agentDefaults.assistantAgentId": null,
    "idleTerminalNotify.enabled": false,
    "idleTerminalNotify.thresholdMinutes": 60,
  };
  const box = { instanceId: "launch-1", canopyRevision: 0, writes: 0 };
  const leaves = (): HostSettingsLeaves => ({
    instanceId: box.instanceId,
    read: (key) => ({
      value: values[key],
      revision: key === "canopyMode" ? `${box.canopyRevision}` : `v:${JSON.stringify(values[key])}`,
    }),
    refusal: hostSettingRefusal,
    write: (patch: HostSettingsPatch) => {
      if (patch.canopyMode === "on" && values.canopyMode === "hidden") {
        throw new AppError({
          code: "PERMISSION",
          message: "Canopy is hidden",
          userMessage: "Show Canopy on this host before turning it on.",
        });
      }
      for (const [key, value] of Object.entries(patch) as Array<
        [HostSettingKey, HostSettingValue]
      >) {
        if (key === "canopyMode" && value !== values.canopyMode) box.canopyRevision++;
        values[key] = value;
        box.writes++;
      }
      return { reconcile: Object.keys(patch).some((key) => key.startsWith("idleTerminalNotify.")) };
    },
  });
  return { values, box, leaves };
}

let dir: string;
let sessions: { host: LinkSession; client: LinkSession };
let state: ReturnType<typeof fakeHost>;
let reconcile: ReturnType<typeof vi.fn<() => Promise<void>>>;
let client: ClientSettingsControl;

function clientOver(session: () => SettingsControlSession | null): ClientSettingsControl {
  return new ClientSettingsControl({
    sessionFor: (hostId) => (hostId === HOST ? session() : null),
    isKnownHost: (hostId) => hostId === HOST,
    hostLabel: () => "Studio",
  });
}

beforeEach(async () => {
  dir = await makeTempDir();
  sessions = await openSessionPair(dir);
  state = fakeHost();
  reconcile = vi.fn(async () => {});
  // A host with no project registered and no window open: nothing here needs one.
  new HostSettingsControl({
    load: async () => state.leaves(),
    runWrite: (write) => write(),
    reconcile,
  }).attach(sessions.host);
  client = clientOver(() => sessions.client);
});

afterEach(async () => {
  sessions.host.close("test");
  sessions.client.close("test");
  await removeTempDir(dir);
});

describe("host settings over a link, with no project or window on the host", () => {
  it("reads the host's own values by name, naming the host and its scope", async () => {
    const snapshot = await client.read({
      hostId: HOST,
      keys: ["canopyMode", "idleTerminalNotify.enabled"],
    });
    expect(snapshot).toMatchObject({
      hostId: HOST,
      hostName: "Studio",
      scope: "host",
      instanceId: "launch-1",
    });
    expect(snapshot.settings.map(({ key, value }) => [key, value])).toEqual([
      ["canopyMode", "unset"],
      ["idleTerminalNotify.enabled", false],
    ]);
  });

  it("writes only the named key, reports the host's readback, and refreshes its views", async () => {
    const before = await client.read({ hostId: HOST });
    const leaf = before.settings.find((s) => s.key === "idleTerminalNotify.enabled")!;
    const result = await client.update({
      hostId: HOST,
      patch: { "idleTerminalNotify.enabled": true },
      expect: {
        instanceId: before.instanceId,
        revisions: { "idleTerminalNotify.enabled": leaf.revision },
      },
    });
    expect(result).toMatchObject({ outcome: "applied", confirmedBy: "reply", scope: "host" });
    expect(result.settings).toEqual([
      { key: "idleTerminalNotify.enabled", value: true, revision: "v:true" },
    ]);
    expect(state.values["idleTerminalNotify.thresholdMinutes"]).toBe(60);
    expect(state.values["agentDefaults.defaultAgent"]).toBe("claude");
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("keeps two clients' changes to sibling keys, and refuses a stale one with how it stands", async () => {
    const seenByA = await client.read({ hostId: HOST });
    const seenByB = await client.read({ hostId: HOST });
    const rev = (seen: typeof seenByA, key: HostSettingKey) =>
      seen.settings.find((s) => s.key === key)!.revision;

    const a = await client.update({
      hostId: HOST,
      patch: { "idleTerminalNotify.enabled": true },
      expect: {
        instanceId: seenByA.instanceId,
        revisions: { "idleTerminalNotify.enabled": rev(seenByA, "idleTerminalNotify.enabled") },
      },
    });
    const b = await client.update({
      hostId: HOST,
      patch: { "idleTerminalNotify.thresholdMinutes": 30 },
      expect: {
        instanceId: seenByB.instanceId,
        revisions: {
          "idleTerminalNotify.thresholdMinutes": rev(
            seenByB,
            "idleTerminalNotify.thresholdMinutes"
          ),
        },
      },
    });
    expect([a.outcome, b.outcome]).toEqual(["applied", "applied"]);
    expect(state.values["idleTerminalNotify.enabled"]).toBe(true);
    expect(state.values["idleTerminalNotify.thresholdMinutes"]).toBe(30);

    const writes = state.box.writes;
    const stale = await client.update({
      hostId: HOST,
      patch: { "idleTerminalNotify.enabled": false, "agentDefaults.defaultAgent": "codex" },
      expect: {
        instanceId: seenByB.instanceId,
        revisions: {
          "idleTerminalNotify.enabled": rev(seenByB, "idleTerminalNotify.enabled"),
          "agentDefaults.defaultAgent": rev(seenByB, "agentDefaults.defaultAgent"),
        },
      },
    });
    expect(stale.outcome).toBe("conflict");
    expect(stale.settings.find((s) => s.key === "idleTerminalNotify.enabled")?.value).toBe(true);
    // Nothing of a stale patch is written, not even its still-current key.
    expect(state.box.writes).toBe(writes);
    expect(state.values["agentDefaults.defaultAgent"]).toBe("claude");
  });

  it("never takes a revision read before a restart, even once the counter is back where it was", async () => {
    const before = await client.read({ hostId: HOST, keys: ["canopyMode"] });
    state.box.instanceId = "launch-2";
    state.box.canopyRevision = 0;
    const result = await client.update({
      hostId: HOST,
      patch: { canopyMode: "on" },
      expect: {
        instanceId: before.instanceId,
        revisions: { canopyMode: before.settings[0]!.revision },
      },
    });
    expect(result).toMatchObject({ outcome: "conflict", instanceId: "launch-2" });
    expect(state.values.canopyMode).toBe("unset");
  });

  it("passes on the host's own refusal of a hidden Canopy, writing nothing else in the patch", async () => {
    state.values.canopyMode = "hidden";
    const before = await client.read({
      hostId: HOST,
      keys: ["canopyMode", "idleTerminalNotify.enabled"],
    });
    const revisions = Object.fromEntries(before.settings.map((s) => [s.key, s.revision]));
    await expect(
      client.update({
        hostId: HOST,
        patch: { canopyMode: "on", "idleTerminalNotify.enabled": true },
        expect: { instanceId: before.instanceId, revisions },
      })
    ).rejects.toMatchObject({
      code: "PERMISSION",
      userMessage: expect.stringContaining("Show Canopy"),
    });
    expect(state.values).toMatchObject({
      canopyMode: "hidden",
      "idleTerminalNotify.enabled": false,
    });
  });

  it("refuses an agent the host can't store, in the host's words", async () => {
    const before = await client.read({ hostId: HOST, keys: ["agentDefaults.defaultAgent"] });
    await expect(
      client.update({
        hostId: HOST,
        patch: { "agentDefaults.defaultAgent": "not-an-agent" },
        expect: {
          instanceId: before.instanceId,
          revisions: { "agentDefaults.defaultAgent": before.settings[0]!.revision },
        },
      })
    ).rejects.toMatchObject({
      code: "VALIDATION",
      userMessage: "Studio: Not an agent this host can start.",
    });
    expect(state.values["agentDefaults.defaultAgent"]).toBe("claude");
  });

  it("refuses anything that isn't one of the named host settings before it leaves this machine", async () => {
    const call = vi.spyOn(sessions.client, "call");
    await expect(
      client.update({
        hostId: HOST,
        patch: { appTheme: "daintree" } as unknown as HostSettingsPatch,
        expect: { instanceId: "launch-1", revisions: {} },
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      client.read({ hostId: HOST, keys: ["terminalConfig.fontSize" as HostSettingKey] })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(call).not.toHaveBeenCalled();
  });

  it("tells a host too old to answer apart from one that refused", async () => {
    const bare = await openSessionPair(dir);
    const old = clientOver(() => bare.client);
    await expect(old.read({ hostId: HOST })).rejects.toMatchObject({
      code: "UNSUPPORTED",
      userMessage: expect.stringContaining("too old"),
    });
    bare.host.close("test");
    bare.client.close("test");
  });

  it("says the host isn't connected rather than guessing", async () => {
    const offline = clientOver(() => null);
    await expect(offline.read({ hostId: HOST })).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
  });

  describe("a reply that never comes", () => {
    /** Forwards the update so the host writes it, then loses the answer. */
    function losingReplies(): SettingsControlSession {
      return {
        get isOpen() {
          return sessions.client.isOpen;
        },
        call: async (method, payload, options) => {
          const answer = await sessions.client.call(method, payload, options);
          if (method === SettingsControlLinkMethod.UPDATE) {
            throw new AppError({ code: "INTERNAL", message: "No reply" });
          }
          return answer;
        },
      };
    }

    it("is reconciled by reading the host back: a change it shows is applied", async () => {
      const lossy = clientOver(losingReplies);
      const before = await lossy.read({
        hostId: HOST,
        keys: ["idleTerminalNotify.thresholdMinutes"],
      });
      const result = await lossy.update({
        hostId: HOST,
        patch: { "idleTerminalNotify.thresholdMinutes": 120 },
        expect: {
          instanceId: before.instanceId,
          revisions: { "idleTerminalNotify.thresholdMinutes": before.settings[0]!.revision },
        },
      });
      expect(result).toMatchObject({ outcome: "applied", confirmedBy: "readback" });
    });

    it("is a conflict when someone else's change stands there instead", async () => {
      const racing: SettingsControlSession = {
        get isOpen() {
          return sessions.client.isOpen;
        },
        call: async (method, payload, options) => {
          if (method === SettingsControlLinkMethod.UPDATE) {
            state.values["idleTerminalNotify.thresholdMinutes"] = 45;
            throw new AppError({ code: "INTERNAL", message: "No reply" });
          }
          return sessions.client.call(method, payload, options);
        },
      };
      const racy = clientOver(() => racing);
      const before = await racy.read({
        hostId: HOST,
        keys: ["idleTerminalNotify.thresholdMinutes"],
      });
      const result = await racy.update({
        hostId: HOST,
        patch: { "idleTerminalNotify.thresholdMinutes": 120 },
        expect: {
          instanceId: before.instanceId,
          revisions: { "idleTerminalNotify.thresholdMinutes": before.settings[0]!.revision },
        },
      });
      expect(result.outcome).toBe("conflict");
      expect(result.settings[0]?.value).toBe(45);
    });

    it("never takes an incomplete readback for a confirmation", async () => {
      const call = vi.fn(async (method: string, _payload: unknown): Promise<unknown> => {
        if (method === SettingsControlLinkMethod.UPDATE) {
          throw new AppError({ code: "INTERNAL", message: "No reply" });
        }
        return { instanceId: "launch-1", settings: [] };
      });
      const hollow = clientOver(() => ({ isOpen: true, call }));
      const result = await hollow.update({
        hostId: HOST,
        patch: { "idleTerminalNotify.enabled": true },
        expect: { instanceId: "launch-1", revisions: { "idleTerminalNotify.enabled": "v:false" } },
      });
      expect(result.outcome).toBe("unconfirmed");
    });

    it("tells Canopy reaching the asked-for mode through someone else's changes from this one landing", async () => {
      const racing: SettingsControlSession = {
        get isOpen() {
          return sessions.client.isOpen;
        },
        call: async (method, payload, options) => {
          if (method === SettingsControlLinkMethod.UPDATE) {
            state.values.canopyMode = "on";
            state.box.canopyRevision = 3;
            throw new AppError({ code: "INTERNAL", message: "No reply" });
          }
          return sessions.client.call(method, payload, options);
        },
      };
      const racy = clientOver(() => racing);
      const result = await racy.update({
        hostId: HOST,
        patch: { canopyMode: "on" },
        expect: { instanceId: "launch-1", revisions: { canopyMode: "0" } },
      });
      expect(result.outcome).toBe("conflict");
    });

    it("keeps another Shell's change to a sibling key when this one's reply is lost (#14169)", async () => {
      // A second Shell on its own link to the same host.
      const other = await openSessionPair(dir);
      new HostSettingsControl({
        load: async () => state.leaves(),
        runWrite: (write) => write(),
        reconcile,
      }).attach(other.host);
      const otherClient = clientOver(() => other.client);
      const updates = vi.fn();
      const lossy = clientOver(() => ({
        get isOpen() {
          return sessions.client.isOpen;
        },
        call: async (method, payload, options) => {
          const answer = await sessions.client.call(method, payload, options);
          if (method === SettingsControlLinkMethod.UPDATE) {
            updates();
            throw new AppError({ code: "INTERNAL", message: "No reply" });
          }
          return answer;
        },
      }));

      const seen = await lossy.read({
        hostId: HOST,
        keys: ["idleTerminalNotify.thresholdMinutes"],
      });
      const theirs = await otherClient.read({ hostId: HOST, keys: ["idleTerminalNotify.enabled"] });
      await expect(
        otherClient.update({
          hostId: HOST,
          patch: { "idleTerminalNotify.enabled": true },
          expect: {
            instanceId: theirs.instanceId,
            revisions: { "idleTerminalNotify.enabled": theirs.settings[0]!.revision },
          },
        })
      ).resolves.toMatchObject({ outcome: "applied", confirmedBy: "reply" });
      const writes = state.box.writes;

      const mine = await lossy.update({
        hostId: HOST,
        patch: { "idleTerminalNotify.thresholdMinutes": 120 },
        expect: {
          instanceId: seen.instanceId,
          revisions: { "idleTerminalNotify.thresholdMinutes": seen.settings[0]!.revision },
        },
      });

      expect(mine).toMatchObject({ outcome: "applied", confirmedBy: "readback" });
      expect(updates).toHaveBeenCalledTimes(1);
      expect(state.box.writes).toBe(writes + 1);
      // The final values, read from the host by a third look: both changes stand.
      const final = await otherClient.read({ hostId: HOST });
      expect(
        Object.fromEntries(final.settings.map(({ key, value }) => [key, value]))
      ).toMatchObject({
        "idleTerminalNotify.enabled": true,
        "idleTerminalNotify.thresholdMinutes": 120,
        canopyMode: "unset",
        "agentDefaults.defaultAgent": "claude",
      });
      other.host.close("test");
      other.client.close("test");
    });

    it("is unconfirmed when the link is gone too, and nothing is resent", async () => {
      const call = vi.fn(async (_method: string, _payload: unknown): Promise<unknown> => {
        throw new AppError({ code: "HOST_DISCONNECTED", message: "gone" });
      });
      const gone = clientOver(() => ({ isOpen: true, call }));
      const result = await gone.update({
        hostId: HOST,
        patch: { "idleTerminalNotify.enabled": true },
        expect: { instanceId: "launch-1", revisions: { "idleTerminalNotify.enabled": "v:false" } },
      });
      expect(result).toMatchObject({ outcome: "unconfirmed", confirmedBy: null, settings: [] });
      expect(
        call.mock.calls.filter(([method]) => method === SettingsControlLinkMethod.UPDATE)
      ).toHaveLength(1);
    });
  });
});

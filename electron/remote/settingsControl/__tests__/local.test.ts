// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostSettingRefusal,
  type HostSettingKey,
  type HostSettingValue,
  type HostSettingsPatch,
} from "../../../../shared/types/hostSettings.js";
import type { HostSettingsLeaves } from "../HostSettingsControl.js";

const machine = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  write: vi.fn(),
}));
const config = vi.hoisted(() => ({
  runConfigWrite: vi.fn(<T>(write: () => Promise<T>) => write()),
  reconcileAfterConfigWrite: vi.fn(async () => {}),
}));

vi.mock("../hostLeaves.js", () => ({
  loadHostSettingsLeaves: async (): Promise<HostSettingsLeaves> => ({
    instanceId: "this-launch",
    read: (key: HostSettingKey) => ({
      value: machine.values[key] as HostSettingValue,
      revision: `v:${JSON.stringify(machine.values[key])}`,
    }),
    refusal: hostSettingRefusal,
    write: (patch: HostSettingsPatch) => {
      machine.write(patch);
      Object.assign(machine.values, patch);
      return { reconcile: true };
    },
  }),
}));
vi.mock("../../../services/configBundleRuntime.js", () => config);

import { readLocalSettings, updateLocalSettings } from "../local.js";

const revisionOf = (value: unknown) => `v:${JSON.stringify(value)}`;

beforeEach(() => {
  machine.values = {
    "sessionRestore.enabled": true,
    globalEnvironmentVariables: { LANG: "en_US.UTF-8" },
    "idleTerminalNotify.enabled": false,
  };
  machine.write.mockReset();
  config.runConfigWrite.mockClear();
  config.reconcileAfterConfigWrite.mockClear();
});

describe("this machine's own settings, from a window attached to another host (#14706)", () => {
  it("reads only named host settings, as this machine with none unavailable", async () => {
    await expect(
      readLocalSettings({
        hostId: "local",
        keys: ["terminalConfig.scrollbackLines" as HostSettingKey],
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(readLocalSettings({ hostId: "local", keys: [] })).rejects.toMatchObject({
      code: "VALIDATION",
    });

    const snapshot = await readLocalSettings({
      hostId: "local",
      keys: ["sessionRestore.enabled", "globalEnvironmentVariables"],
    });
    expect(snapshot).toMatchObject({
      hostId: "local",
      scope: "host",
      unavailable: [],
      instanceId: "this-launch",
    });
    expect(snapshot.settings).toEqual([
      {
        key: "globalEnvironmentVariables",
        value: { LANG: "en_US.UTF-8" },
        revision: expect.any(String),
      },
      { key: "sessionRestore.enabled", value: true, revision: revisionOf(true) },
    ]);
  });

  it("refuses a key that isn't a host setting, such as one this device keeps, and writes nothing", async () => {
    await expect(
      updateLocalSettings({
        hostId: "local",
        patch: { "terminalConfig.scrollbackLines": 5000 } as unknown as HostSettingsPatch,
        expect: {
          instanceId: "this-launch",
          revisions: { "terminalConfig.scrollbackLines": "v:1000" } as never,
        },
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(machine.write).not.toHaveBeenCalled();
    expect(config.runConfigWrite).not.toHaveBeenCalled();
  });

  it("refuses a change to a key it wasn't given the revision of, and writes nothing", async () => {
    await expect(
      updateLocalSettings({
        hostId: "local",
        patch: { "sessionRestore.enabled": false, "idleTerminalNotify.enabled": true },
        expect: {
          instanceId: "this-launch",
          revisions: { "sessionRestore.enabled": revisionOf(true) },
        },
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(machine.write).not.toHaveBeenCalled();
  });

  it("writes a change made against the current revision and reports this machine's readback", async () => {
    const result = await updateLocalSettings({
      hostId: "local",
      patch: { "sessionRestore.enabled": false },
      expect: {
        instanceId: "this-launch",
        revisions: { "sessionRestore.enabled": revisionOf(true) },
      },
    });
    expect(result).toMatchObject({
      hostId: "local",
      scope: "host",
      outcome: "applied",
      confirmedBy: "reply",
      instanceId: "this-launch",
      settings: [{ key: "sessionRestore.enabled", value: false, revision: revisionOf(false) }],
    });
    expect(machine.write).toHaveBeenCalledWith({ "sessionRestore.enabled": false });
    expect(config.runConfigWrite).toHaveBeenCalled();
    expect(config.reconcileAfterConfigWrite).toHaveBeenCalledTimes(1);
  });

  it("writes nothing over a change made since it was read, and says how things stand", async () => {
    const stale = {
      instanceId: "this-launch",
      revisions: { "sessionRestore.enabled": revisionOf(true) },
    };
    machine.values["sessionRestore.enabled"] = false;
    const result = await updateLocalSettings({
      hostId: "local",
      patch: { "sessionRestore.enabled": true },
      expect: stale,
    });
    expect(result).toMatchObject({
      hostId: "local",
      outcome: "conflict",
      confirmedBy: "reply",
      settings: [{ key: "sessionRestore.enabled", value: false, revision: revisionOf(false) }],
    });
    expect(machine.write).not.toHaveBeenCalled();
    expect(config.reconcileAfterConfigWrite).not.toHaveBeenCalled();

    // Nor over one read in an earlier launch.
    const earlier = await updateLocalSettings({
      hostId: "local",
      patch: { "sessionRestore.enabled": true },
      expect: {
        instanceId: "last-launch",
        revisions: { "sessionRestore.enabled": revisionOf(false) },
      },
    });
    expect(earlier.outcome).toBe("conflict");
    expect(machine.write).not.toHaveBeenCalled();
  });

  it("refuses a value this machine wouldn't store before writing anything", async () => {
    await expect(
      updateLocalSettings({
        hostId: "local",
        patch: { globalEnvironmentVariables: { "A=B": "x" } },
        expect: {
          instanceId: "this-launch",
          revisions: { globalEnvironmentVariables: "v:any" },
        },
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(machine.write).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { HostSettingsPatchSchema, hostSettingRefusal } from "../hostSettings.js";

describe("hostSettings canopyModel", () => {
  it("takes only one of Canopy's published models, refusing anything a host would refuse", () => {
    expect(hostSettingRefusal("canopyModel", "daintreehq/canopy-reader-68m")).toBeNull();
    for (const value of [
      "someone/canopy-reader-68m",
      "daintreehq/canopy-reader-../../x",
      "daintreehq/other",
      null,
      7,
    ]) {
      expect(hostSettingRefusal("canopyModel", value)).not.toBeNull();
    }
  });

  it("parses a patch that changes the model, and rejects one naming another repo", () => {
    expect(
      HostSettingsPatchSchema.safeParse({ canopyModel: "daintreehq/canopy-reader-68m" }).success
    ).toBe(true);
    expect(HostSettingsPatchSchema.safeParse({ canopyModel: "evil/model" }).success).toBe(false);
  });
});

describe("work settings on a host (#14706)", () => {
  it("keeps every key past the original six out of an assistant's reach", async () => {
    const { HostSettingsArgsSchema } = await import("../hostControl.js");
    const { ASSISTANT_HOST_SETTING_KEYS, HOST_SETTING_KEYS } = await import("../hostSettings.js");
    const extra = HOST_SETTING_KEYS.filter(
      (key) => !(ASSISTANT_HOST_SETTING_KEYS as readonly string[]).includes(key)
    );
    expect(extra).toContain("globalEnvironmentVariables");
    for (const key of extra) {
      expect(HostSettingsArgsSchema.safeParse({ operation: "read", keys: [key] }).success).toBe(
        false
      );
    }
    expect(
      HostSettingsArgsSchema.safeParse({
        operation: "preview",
        patch: { globalEnvironmentVariables: { A: "1" } },
      }).success
    ).toBe(false);
  });

  it("takes an environment a host would store, and refuses one it wouldn't", () => {
    expect(
      hostSettingRefusal("globalEnvironmentVariables", { PATH: "/bin", lower_ok: "" })
    ).toBeNull();
    for (const value of [
      null,
      [],
      { "A=B": "x" },
      { "": "x" },
      { A: 1 },
      { A: "x".repeat(40_000) },
    ]) {
      expect(hostSettingRefusal("globalEnvironmentVariables", value)).not.toBeNull();
    }
    expect(
      HostSettingsPatchSchema.safeParse({ globalEnvironmentVariables: { "A=B": "x" } }).success
    ).toBe(false);
  });

  it("holds terminal and idle-project values to the ranges their own Settings allows", () => {
    expect(hostSettingRefusal("terminalConfig.memoryLeakAutoRestartThresholdMb", 1024)).toBeNull();
    expect(
      hostSettingRefusal("terminalConfig.memoryLeakAutoRestartThresholdMb", 512)
    ).not.toBeNull();
    expect(hostSettingRefusal("idleBackgroundAutoClose.idleShellThresholdMinutes", 240)).toBeNull();
    expect(
      hostSettingRefusal("idleBackgroundAutoClose.idleShellThresholdMinutes", 90)
    ).not.toBeNull();
    expect(hostSettingRefusal("agentSettings.resumeOnRestart", "on-focus")).toBeNull();
    expect(hostSettingRefusal("agentSettings.resumeOnRestart", "sometimes")).not.toBeNull();
  });
});

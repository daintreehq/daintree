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
    const { HOST_SETTING_KEYS } = await import("../hostSettings.js");
    // Named here, not derived from the allowlist under test.
    const original = [
      "canopyMode",
      "canopyModel",
      "agentDefaults.defaultAgent",
      "agentDefaults.assistantAgentId",
      "idleTerminalNotify.enabled",
      "idleTerminalNotify.thresholdMinutes",
    ];
    const extra = HOST_SETTING_KEYS.filter((key) => !original.includes(key));
    expect(extra.length).toBeGreaterThan(0);
    for (const key of extra) {
      expect(HostSettingsArgsSchema.safeParse({ operation: "read", keys: [key] }).success).toBe(
        false
      );
    }
    for (const key of original) {
      expect(HostSettingsArgsSchema.safeParse({ operation: "read", keys: [key] }).success).toBe(
        true
      );
    }
    const patches: Record<string, unknown> = {
      globalEnvironmentVariables: { A: "1" },
      "agentSettings.globalUseAltScreen": true,
      "sessionRestore.enabled": false,
      "terminalConfig.resourceMonitoringEnabled": true,
    };
    for (const [key, value] of Object.entries(patches)) {
      expect(
        HostSettingsArgsSchema.safeParse({ operation: "preview", patch: { [key]: value } }).success,
        key
      ).toBe(false);
    }
  });

  it("reads an environment saved before these limits, without letting one be written", async () => {
    const { hostSettingReadable } = await import("../hostSettings.js");
    const long = { BIG: "x".repeat(40_000) };
    expect(hostSettingReadable("globalEnvironmentVariables", long)).toBe(true);
    expect(hostSettingRefusal("globalEnvironmentVariables", long)).not.toBeNull();
    expect(hostSettingReadable("globalEnvironmentVariables", { A: 1 })).toBe(false);
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

  it("refuses an environment too large as a whole, though each variable is within its own limits", async () => {
    const { HOST_ENV_LIMITS, HOST_ENV_MAX_BYTES, hostSettingReadable } =
      await import("../hostSettings.js");
    const set = (count: number, char: string) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `VAR_${i}`,
          char.repeat(HOST_ENV_LIMITS.valueLength),
        ])
      );
    const fits = set(60, "x");
    expect(new TextEncoder().encode(JSON.stringify(fits)).length).toBeLessThan(HOST_ENV_MAX_BYTES);
    expect(hostSettingRefusal("globalEnvironmentVariables", fits)).toBeNull();

    const tooMany = set(100, "x");
    expect(Object.keys(tooMany).length).toBeLessThan(HOST_ENV_LIMITS.entries);
    expect(hostSettingRefusal("globalEnvironmentVariables", tooMany)).not.toBeNull();
    expect(HostSettingsPatchSchema.safeParse({ globalEnvironmentVariables: tooMany }).success).toBe(
      false
    );
    // Counted in encoded bytes, not characters.
    const wide = set(40, "é");
    expect(JSON.stringify(wide).length).toBeLessThan(HOST_ENV_MAX_BYTES);
    expect(hostSettingRefusal("globalEnvironmentVariables", wide)).not.toBeNull();
    // A set stored that large on the host itself still reads.
    expect(hostSettingReadable("globalEnvironmentVariables", tooMany)).toBe(true);
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

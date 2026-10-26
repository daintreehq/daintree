// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const canopy = vi.hoisted(() => ({
  state: { mode: "unset" as "unset" | "on" | "hidden", modeRevision: 4, hostEpoch: "epoch" },
  changeCanopyMode: vi.fn(),
  checkCanopyModeRate: vi.fn(),
}));
const defaults = vi.hoisted(() => ({
  values: { defaultAgent: "claude" } as Record<string, string | null>,
  setAgentDefaults: vi.fn(),
}));
const idle = vi.hoisted(() => ({
  config: { enabled: false, thresholdMinutes: 60 },
  updateConfig: vi.fn(),
}));

vi.mock("../../../ipc/handlers/canopy.js", () => ({
  canopyModeState: () => ({ ...canopy.state }),
  changeCanopyMode: canopy.changeCanopyMode,
  checkCanopyModeRate: canopy.checkCanopyModeRate,
}));
vi.mock("../../../services/agentDefaults.js", () => ({
  readAgentDefaults: () => ({ ...defaults.values }),
  setAgentDefaults: defaults.setAgentDefaults,
}));
vi.mock("../../../services/IdleTerminalNotificationService.js", () => ({
  getIdleTerminalNotificationService: () => ({
    getConfig: () => ({ ...idle.config }),
    updateConfig: idle.updateConfig,
  }),
}));
vi.mock("../../../services/hostInstance.js", () => ({ hostInstanceId: "this-launch" }));
const stored = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  set: vi.fn(),
}));
vi.mock("../../../store.js", () => ({
  store: {
    get: (key: string) => stored.values[key],
    set: stored.set,
  },
}));
const pty = vi.hoisted(() => ({ setResourceMonitoring: vi.fn() }));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => pty }));
const sleep = vi.hoisted(() => ({
  config: { enabled: false, thresholdMinutes: 60, includeIdleShells: false, idleShellThresholdMinutes: 120 },
  updateConfig: vi.fn(),
}));
vi.mock("../../../services/IdleBackgroundAutoCloseService.js", () => ({
  getIdleBackgroundAutoCloseService: () => ({
    getConfig: () => ({ ...sleep.config }),
    updateConfig: sleep.updateConfig,
  }),
}));

import { loadHostSettingsLeaves } from "../hostLeaves.js";

beforeEach(() => {
  canopy.state.mode = "unset";
  canopy.changeCanopyMode.mockReset();
  canopy.checkCanopyModeRate.mockReset();
  defaults.setAgentDefaults.mockReset();
  idle.updateConfig.mockReset();
  stored.values = {};
  stored.set.mockReset();
  pty.setResourceMonitoring.mockReset();
  sleep.updateConfig.mockReset();
});

describe("the host's own setters for named settings (#14167)", () => {
  it("reads through each setting's own reader, with Canopy's own revision count", async () => {
    const leaves = await loadHostSettingsLeaves();
    expect(leaves.instanceId).toBe("this-launch");
    expect(leaves.read("canopyMode")).toEqual({ value: "unset", revision: "4" });
    expect(leaves.read("agentDefaults.assistantAgentId").value).toBeNull();
    const a = leaves.read("idleTerminalNotify.thresholdMinutes");
    idle.config.thresholdMinutes = 30;
    expect(leaves.read("idleTerminalNotify.thresholdMinutes").revision).not.toBe(a.revision);
    idle.config.thresholdMinutes = 60;
  });

  it("writes through the same setters this machine's Settings uses, Canopy guarded", async () => {
    const leaves = await loadHostSettingsLeaves();
    const written = leaves.write({
      canopyMode: "on",
      "agentDefaults.defaultAgent": "codex",
      "idleTerminalNotify.enabled": true,
    });
    expect(canopy.changeCanopyMode).toHaveBeenCalledWith("on", 4, "epoch");
    expect(defaults.setAgentDefaults).toHaveBeenCalledWith({ defaultAgent: "codex" });
    expect(idle.updateConfig).toHaveBeenCalledWith({ enabled: true });
    // Idle alerts have no change broadcast of their own; the others do.
    expect(written.reconcile).toBe(true);
    expect(leaves.write({ "agentDefaults.defaultAgent": null }).reconcile).toBe(false);
  });

  it("holds a Canopy change to the same rate limit as this machine's views, before any write", async () => {
    canopy.checkCanopyModeRate.mockImplementationOnce(() => {
      throw Object.assign(new Error("Rate limit exceeded"), { code: "RATE_LIMITED" });
    });
    const leaves = await loadHostSettingsLeaves();
    expect(() =>
      leaves.write({ canopyMode: "hidden", "idleTerminalNotify.enabled": true })
    ).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));
    expect(idle.updateConfig).not.toHaveBeenCalled();
    expect(leaves.write({ "idleTerminalNotify.enabled": true }).reconcile).toBe(true);
    expect(canopy.checkCanopyModeRate).toHaveBeenCalledTimes(1);
  });

  it("refuses to turn a hidden Canopy on before writing anything else in the patch", async () => {
    canopy.state.mode = "hidden";
    const leaves = await loadHostSettingsLeaves();
    expect(() => leaves.write({ canopyMode: "on", "idleTerminalNotify.enabled": true })).toThrow(
      expect.objectContaining({ code: "PERMISSION" })
    );
    expect(idle.updateConfig).not.toHaveBeenCalled();
    expect(canopy.changeCanopyMode).not.toHaveBeenCalled();
  });

  it("reads stored work settings as this host's views read them, defaults included (#14706)", async () => {
    const leaves = await loadHostSettingsLeaves();
    expect(leaves.read("sessionRestore.enabled").value).toBe(true);
    expect(leaves.read("agentSettings.resumeOnRestart").value).toBe("always");
    expect(leaves.read("terminalConfig.memoryLeakAutoRestartThresholdMb").value).toBe(8192);
    // Leak detection follows resource monitoring until it is set on its own.
    stored.values.terminalConfig = { resourceMonitoringEnabled: true };
    expect(leaves.read("terminalConfig.memoryLeakDetectionEnabled").value).toBe(true);
    expect(leaves.read("globalEnvironmentVariables").value).toEqual({});
  });

  it("gives an environment the same revision whatever order its variables were stored in", async () => {
    const leaves = await loadHostSettingsLeaves();
    stored.values.globalEnvironmentVariables = { B: "2", A: "1" };
    const first = leaves.read("globalEnvironmentVariables");
    stored.values.globalEnvironmentVariables = { A: "1", B: "2" };
    expect(leaves.read("globalEnvironmentVariables").revision).toBe(first.revision);
    stored.values.globalEnvironmentVariables = { A: "1", B: "3" };
    expect(leaves.read("globalEnvironmentVariables").revision).not.toBe(first.revision);
  });

  it("writes stored work settings one leaf at a time, tells the pty host, and asks for a refresh", async () => {
    const leaves = await loadHostSettingsLeaves();
    const written = leaves.write({
      "terminalConfig.resourceMonitoringEnabled": true,
      "sessionRestore.enabled": false,
      globalEnvironmentVariables: { B: "2", A: "1" },
      "idleBackgroundAutoClose.idleShellThresholdMinutes": 240,
    });
    expect(stored.set).toHaveBeenCalledWith("terminalConfig.resourceMonitoringEnabled", true);
    expect(pty.setResourceMonitoring).toHaveBeenCalledWith(true);
    expect(stored.set).toHaveBeenCalledWith("sessionRestore", { enabled: false });
    expect(stored.set).toHaveBeenCalledWith("globalEnvironmentVariables", { A: "1", B: "2" });
    expect(sleep.updateConfig).toHaveBeenCalledWith({ idleShellThresholdMinutes: 240 });
    expect(stored.set).not.toHaveBeenCalledWith("agentSettings", expect.anything());
    expect(written.reconcile).toBe(true);
  });
});

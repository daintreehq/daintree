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

import { loadHostSettingsLeaves } from "../hostLeaves.js";

beforeEach(() => {
  canopy.state.mode = "unset";
  canopy.changeCanopyMode.mockReset();
  canopy.checkCanopyModeRate.mockReset();
  defaults.setAgentDefaults.mockReset();
  idle.updateConfig.mockReset();
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
});

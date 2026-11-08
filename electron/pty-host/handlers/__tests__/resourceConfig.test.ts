import { afterEach, describe, expect, it, vi } from "vitest";
import { createResourceConfigHandlers } from "../resourceConfig.js";
import type { HostContext } from "../types.js";
import {
  getPtyPowerLevel,
  resetPtyPowerLevelForTesting,
} from "../../../services/pty/ptyPowerPolicy.js";
import {
  clearPluginAgentRegistryForTests,
  getPluginAgentRegistry,
} from "../../../../shared/config/pluginAgentRegistry.js";

function makeCtx(withPool = true) {
  const resourceGovernor = { setPowerLevel: vi.fn(), setResourceProfile: vi.fn() };
  const analysisWorkerPool = withPool ? { setPowerLevel: vi.fn() } : null;
  const ctx = {
    processTreeCache: { setPollInterval: vi.fn() },
    terminalResourceMonitor: { setEnabled: vi.fn() },
    resourceGovernor,
    analysisWorkerPool,
    ptyManager: {},
  } as unknown as HostContext;
  return { ctx, resourceGovernor, analysisWorkerPool };
}

describe("set-power-policy (#12515)", () => {
  afterEach(() => {
    resetPtyPowerLevelForTesting();
  });

  it("reaches the host mirror, the governor, and every analysis worker", () => {
    const { ctx, resourceGovernor, analysisWorkerPool } = makeCtx();

    createResourceConfigHandlers(ctx)["set-power-policy"]({
      level: "deep",
      observationLevel: "deep",
    });

    expect(getPtyPowerLevel()).toBe("deep");
    expect(resourceGovernor.setPowerLevel).toHaveBeenCalledWith("deep");
    expect(analysisWorkerPool!.setPowerLevel).toHaveBeenCalledWith("deep", "deep");
  });

  it("ignores a level it does not know", () => {
    const { ctx, resourceGovernor, analysisWorkerPool } = makeCtx();

    createResourceConfigHandlers(ctx)["set-power-policy"]({ level: "turbo" });

    expect(getPtyPowerLevel()).toBe("active");
    expect(resourceGovernor.setPowerLevel).not.toHaveBeenCalled();
    expect(analysisWorkerPool!.setPowerLevel).not.toHaveBeenCalled();
  });

  it("still applies in-thread when the host runs without a worker pool", () => {
    const { ctx, resourceGovernor } = makeCtx(false);

    createResourceConfigHandlers(ctx)["set-power-policy"]({ level: "saving" });

    expect(getPtyPowerLevel()).toBe("saving");
    expect(resourceGovernor.setPowerLevel).toHaveBeenCalledWith("saving");
  });
});

describe("set-plugin-agent-registry (#16469)", () => {
  afterEach(() => {
    clearPluginAgentRegistryForTests();
  });

  it("revokes against the registry it just installed", () => {
    const registry = {
      pi: { id: "pi", name: "Pi", command: "pi", color: "#3366ff", iconId: "terminal" },
    };
    const seen: unknown[] = [];
    const revokeUnregisteredAgents = vi.fn(() => seen.push(getPluginAgentRegistry()));
    const ctx = {
      analysisWorkerPool: { setPluginAgentRegistry: vi.fn() },
      ptyManager: { revokeUnregisteredAgents },
    } as unknown as HostContext;

    createResourceConfigHandlers(ctx)["set-plugin-agent-registry"]({ registry });

    expect(revokeUnregisteredAgents).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([registry]);
  });

  it("still installs the registry when a revocation sweep throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = {};
    const revokeUnregisteredAgents = vi.fn(() => {
      throw new Error("boom");
    });
    const ctx = {
      analysisWorkerPool: null,
      ptyManager: { revokeUnregisteredAgents },
    } as unknown as HostContext;

    expect(() =>
      createResourceConfigHandlers(ctx)["set-plugin-agent-registry"]({ registry })
    ).not.toThrow();
    expect(revokeUnregisteredAgents).toHaveBeenCalledTimes(1);
    expect(getPluginAgentRegistry()).toBe(registry);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

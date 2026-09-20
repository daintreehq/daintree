import { afterEach, describe, expect, it, vi } from "vitest";
import { createResourceConfigHandlers } from "../resourceConfig.js";
import type { HostContext } from "../types.js";
import {
  getPtyPowerLevel,
  resetPtyPowerLevelForTesting,
} from "../../../services/pty/ptyPowerPolicy.js";

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

    createResourceConfigHandlers(ctx)["set-power-policy"]({ level: "deep" });

    expect(getPtyPowerLevel()).toBe("deep");
    expect(resourceGovernor.setPowerLevel).toHaveBeenCalledWith("deep");
    expect(analysisWorkerPool!.setPowerLevel).toHaveBeenCalledWith("deep");
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

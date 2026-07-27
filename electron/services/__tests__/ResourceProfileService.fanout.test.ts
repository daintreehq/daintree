/**
 * ResourceProfileService — fan-out isolation under failure.
 *
 * The base and adversarial suites cover the entry-path isolation (one PVM
 * throwing on efficiency entry). This file pins the EXIT path and the
 * provider itself: leaving efficiency must restore every healthy window's
 * cached-view limit and unfreeze its renderers no matter which sibling setter
 * throws, and a throwing getAllProjectViewManagers must not swallow the rest
 * of the fan-out (pty/workspace/hibernation/stats/renderer broadcast). A
 * frozen renderer after profile exit has no recovery trigger — these paths
 * must be unconditionally safe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";

vi.mock("electron", () => ({
  app: {
    getAppMetrics: vi.fn(() => []),
  },
  powerMonitor: {
    isOnBatteryPower: vi.fn(() => false),
    getCurrentThermalState: vi.fn(() => "unknown" as const),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
}));

import { ResourceProfileService, type ResourceProfileDeps } from "../ResourceProfileService.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { RESOURCE_PROFILE_CONFIGS } from "../../../shared/types/resourceProfile.js";
import type { PtyClient } from "../PtyClient.js";
import type { WorkspaceClient } from "../WorkspaceClient.js";
import type { HibernationService } from "../HibernationService.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";
import type { ProjectStatsService } from "../ProjectStatsService.js";

const EIGHT_GB = 8 * 1024 * 1024 * 1024;

function makeMockPvm() {
  return {
    setCachedViewLimit: vi.fn(),
    setMemoryPressurePolicy: vi.fn(),
    setEfficiencyFreeze: vi.fn(),
    setPaintGateTimeoutMs: vi.fn(),
    setPaintGateHardTimeoutMs: vi.fn(),
    setWarmPaintGateTimeoutMs: vi.fn(),
    setWarmPaintGateHardTimeoutMs: vi.fn(),
    setViewLoadTimeoutMs: vi.fn(),
    setViewLoadHardTimeoutMs: vi.fn(),
  };
}

type MockPvm = ReturnType<typeof makeMockPvm>;

function createDeps(overrides?: Partial<ResourceProfileDeps>) {
  const pty = {
    setResourceProfile: vi.fn(),
    setProcessTreePollInterval: vi.fn(),
    getAllTerminalsAsync: vi.fn().mockResolvedValue([]),
  };
  const workspace = {
    updateMonitorConfig: vi.fn(),
  };
  const hibernation = { setMemoryPressureThresholdMs: vi.fn() };
  const stats = { updatePollInterval: vi.fn() };

  const deps: ResourceProfileDeps = {
    getPtyClient: () => pty as unknown as PtyClient,
    getWorkspaceClient: () => workspace as unknown as WorkspaceClient,
    getHibernationService: () => hibernation as unknown as HibernationService,
    getAllProjectViewManagers: () => [],
    getProjectStatsService: () => stats as unknown as ProjectStatsService,
    getUserCachedViewLimit: () => 2,
    ...overrides,
  };
  return { deps, pty, workspace, hibernation, stats };
}

function asPvms(pvms: MockPvm[]): ProjectViewManager[] {
  return pvms as unknown as ProjectViewManager[];
}

describe("ResourceProfileService fan-out isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(os, "totalmem").mockReturnValue(EIGHT_GB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("efficiency exit path", () => {
    it("restores the cached-view limit even when setEfficiencyFreeze throws on exit", () => {
      const pvm = makeMockPvm();
      pvm.setEfficiencyFreeze.mockImplementation((enabled: boolean) => {
        if (!enabled) throw new Error("unfreeze exploded");
      });
      const { deps } = createDeps({ getAllProjectViewManagers: () => asPvms([pvm]) });
      const service = new ResourceProfileService(deps);

      service._forceProfileForTesting("efficiency");
      service._forceProfileForTesting("balanced");

      expect(pvm.setCachedViewLimit).toHaveBeenCalledWith(2);
      // The exit still reached the renderer broadcast: entry + exit.
      expect(vi.mocked(broadcastToRenderer)).toHaveBeenCalledTimes(2);
    });

    it("still unfreezes and restores healthy windows when one window's exit setters all throw", () => {
      const broken = makeMockPvm();
      broken.setCachedViewLimit.mockImplementation(() => {
        throw new Error("limit exploded");
      });
      broken.setEfficiencyFreeze.mockImplementation(() => {
        throw new Error("freeze exploded");
      });
      const healthy = makeMockPvm();
      const { deps, pty } = createDeps({
        getAllProjectViewManagers: () => asPvms([broken, healthy]),
      });
      const service = new ResourceProfileService(deps);

      service._forceProfileForTesting("efficiency");
      service._forceProfileForTesting("balanced");

      // The healthy window got the full exit sequence despite the broken
      // sibling being iterated first. Expectations derive from the config
      // table — this suite pins the routing, not the tuning values.
      const balanced = RESOURCE_PROFILE_CONFIGS.balanced;
      expect(healthy.setCachedViewLimit).toHaveBeenCalledWith(2);
      expect(healthy.setEfficiencyFreeze).toHaveBeenLastCalledWith(false);
      // The reclaim band rides along on transitions so a missed start() arm can
      // heal, but it is read off the service's machine-derived field — never the
      // profile config — so every push carries the identical pair (#11469).
      const bands = healthy.setMemoryPressurePolicy.mock.calls.map(([policy]) => policy);
      expect(bands.length).toBeGreaterThan(0);
      for (const pushedBand of bands) {
        expect(pushedBand).toEqual(bands[0]);
      }
      expect(healthy.setPaintGateTimeoutMs).toHaveBeenLastCalledWith(balanced.paintGateTimeoutMs);
      expect(healthy.setWarmPaintGateHardTimeoutMs).toHaveBeenLastCalledWith(
        balanced.warmPaintGateHardTimeoutMs
      );
      expect(healthy.setViewLoadTimeoutMs).toHaveBeenLastCalledWith(balanced.viewLoadTimeoutMs);
      expect(healthy.setViewLoadHardTimeoutMs).toHaveBeenLastCalledWith(
        balanced.viewLoadHardTimeoutMs
      );
      // Downstream consumers after the PVM loop still ran.
      expect(pty.setResourceProfile).toHaveBeenLastCalledWith("balanced");
      expect(vi.mocked(broadcastToRenderer)).toHaveBeenCalledTimes(2);
    });

    it("a throwing getUserCachedViewLimit still unfreezes the same window", () => {
      const pvm = makeMockPvm();
      const { deps } = createDeps({
        getAllProjectViewManagers: () => asPvms([pvm]),
        getUserCachedViewLimit: () => {
          throw new Error("settings store unavailable");
        },
      });
      const service = new ResourceProfileService(deps);

      service._forceProfileForTesting("efficiency");
      service._forceProfileForTesting("balanced");

      expect(pvm.setCachedViewLimit).not.toHaveBeenCalled();
      // The unfreeze is the load-bearing exit action — it must not be skipped.
      expect(pvm.setEfficiencyFreeze).toHaveBeenLastCalledWith(false);
    });
  });

  describe("provider failure", () => {
    it("a throwing getAllProjectViewManagers does not skip the rest of the fan-out", () => {
      const { deps, pty, workspace, hibernation, stats } = createDeps({
        getAllProjectViewManagers: () => {
          throw new Error("window registry torn down");
        },
      });
      const service = new ResourceProfileService(deps);

      expect(() => service._forceProfileForTesting("efficiency")).not.toThrow();

      expect(workspace.updateMonitorConfig).toHaveBeenCalled();
      expect(hibernation.setMemoryPressureThresholdMs).toHaveBeenCalledWith(
        RESOURCE_PROFILE_CONFIGS.efficiency.memoryPressureInactiveMs
      );
      expect(pty.setResourceProfile).toHaveBeenCalledWith("efficiency");
      expect(stats.updatePollInterval).toHaveBeenCalled();
      // The renderer broadcast — the only signal cached views get — still fired.
      expect(vi.mocked(broadcastToRenderer)).toHaveBeenCalledTimes(1);
    });

    it("start() survives a throwing getAllProjectViewManagers and keeps evaluating", () => {
      vi.useFakeTimers();
      try {
        let shouldThrow = true;
        const pvm = makeMockPvm();
        const { deps } = createDeps({
          getAllProjectViewManagers: () => {
            if (shouldThrow) throw new Error("registry not ready yet");
            return asPvms([pvm]);
          },
        });
        const service = new ResourceProfileService(deps);

        expect(() => service.start()).not.toThrow();

        // Once the provider recovers, a forced transition reaches the PVM.
        shouldThrow = false;
        service._forceProfileForTesting("efficiency");
        expect(pvm.setEfficiencyFreeze).toHaveBeenCalledWith(true);

        service.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("worker-governance trim fan-out", () => {
    it("requests a worker trim on efficiency entry, after the other consumers", () => {
      const requestWorkerTrim = vi.fn();
      const { deps, pty } = createDeps({ requestWorkerTrim });
      const service = new ResourceProfileService(deps);

      service._forceProfileForTesting("efficiency");
      expect(requestWorkerTrim).toHaveBeenCalledTimes(1);
      expect(pty.setResourceProfile).toHaveBeenCalledWith("efficiency");

      // Leaving efficiency must not request another trim.
      service._forceProfileForTesting("balanced");
      expect(requestWorkerTrim).toHaveBeenCalledTimes(1);
    });

    it("a throwing requestWorkerTrim cannot skip the renderer broadcast", () => {
      const { deps } = createDeps({
        requestWorkerTrim: () => {
          throw new Error("governance exploded");
        },
      });
      const service = new ResourceProfileService(deps);

      expect(() => service._forceProfileForTesting("efficiency")).not.toThrow();
      expect(vi.mocked(broadcastToRenderer)).toHaveBeenCalledTimes(1);
    });

    it("a rejecting async requestWorkerTrim is absorbed without unhandled rejection", async () => {
      const { deps } = createDeps({
        requestWorkerTrim: async () => {
          throw new Error("async governance failure");
        },
      });
      const service = new ResourceProfileService(deps);

      expect(() => service._forceProfileForTesting("efficiency")).not.toThrow();
      expect(vi.mocked(broadcastToRenderer)).toHaveBeenCalledTimes(1);
      // Let the rejection settle through the isolation .catch.
      await new Promise((resolve) => setImmediate(resolve));
    });

    it("profile transitions never await worker cleanup — the trim is fire-and-forget", () => {
      let resolveTrim: () => void = () => {};
      const { deps } = createDeps({
        requestWorkerTrim: () =>
          new Promise<void>((resolve) => {
            resolveTrim = resolve;
          }),
      });
      const service = new ResourceProfileService(deps);

      service._forceProfileForTesting("efficiency");
      // The broadcast landed synchronously while the trim is still pending.
      expect(vi.mocked(broadcastToRenderer)).toHaveBeenCalledTimes(1);
      resolveTrim();
    });
  });

  describe("late-created PVM under a throwing sibling setter", () => {
    it("applyCurrentProfileTo pushes the remaining settings when an early setter throws", () => {
      const pvm = makeMockPvm();
      pvm.setMemoryPressurePolicy.mockImplementation(() => {
        throw new Error("threshold exploded");
      });
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service._forceProfileForTesting("efficiency");

      expect(() =>
        service.applyCurrentProfileTo(pvm as unknown as ProjectViewManager)
      ).not.toThrow();

      // The throwing setter was genuinely reached — without this the rest of the
      // assertions would pass even if the policy push were dropped entirely.
      expect(pvm.setMemoryPressurePolicy).toHaveBeenCalledOnce();
      // Every setter after the throwing one still landed with efficiency values.
      const efficiency = RESOURCE_PROFILE_CONFIGS.efficiency;
      expect(pvm.setEfficiencyFreeze).toHaveBeenCalledWith(true);
      expect(pvm.setPaintGateTimeoutMs).toHaveBeenCalledWith(efficiency.paintGateTimeoutMs);
      expect(pvm.setPaintGateHardTimeoutMs).toHaveBeenCalledWith(efficiency.paintGateHardTimeoutMs);
      expect(pvm.setWarmPaintGateTimeoutMs).toHaveBeenCalledWith(efficiency.warmPaintGateTimeoutMs);
      expect(pvm.setWarmPaintGateHardTimeoutMs).toHaveBeenCalledWith(
        efficiency.warmPaintGateHardTimeoutMs
      );
      expect(pvm.setViewLoadTimeoutMs).toHaveBeenCalledWith(efficiency.viewLoadTimeoutMs);
      expect(pvm.setViewLoadHardTimeoutMs).toHaveBeenCalledWith(efficiency.viewLoadHardTimeoutMs);
    });

    it("a throwing soft view-load setter still lets the hard bound land", () => {
      // The two bounds must not share a try block: a soft-setter throw that
      // skipped the hard setter would leave the ceiling on the previous
      // profile's value while the soft bound moved.
      const pvm = makeMockPvm();
      pvm.setViewLoadTimeoutMs.mockImplementation(() => {
        throw new Error("soft bound exploded");
      });
      const { deps } = createDeps();
      const service = new ResourceProfileService(deps);
      service._forceProfileForTesting("efficiency");

      expect(() =>
        service.applyCurrentProfileTo(pvm as unknown as ProjectViewManager)
      ).not.toThrow();

      expect(pvm.setViewLoadHardTimeoutMs).toHaveBeenCalledWith(
        RESOURCE_PROFILE_CONFIGS.efficiency.viewLoadHardTimeoutMs
      );
    });
  });
});

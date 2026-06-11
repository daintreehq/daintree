import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HydrateResult } from "@shared/types/ipc/app";

const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notify", () => ({
  notify: (args: unknown) => notifyMock(args),
}));

const { dispatchRecoveryNotifications, __resetGpuAccelNotifiedForTests } =
  await import("../recoveryNotifications");

function makeHydrateResult(overrides: Partial<HydrateResult>): HydrateResult {
  // dispatchRecoveryNotifications only reads gpuHardwareAccelerationDisabled,
  // gpuDisabledReason, settingsRecovery, and projectStateRecovery — the rest
  // is fixture noise satisfied via a single boundary cast.
  const base: Partial<HydrateResult> = {
    appState: { terminals: [], sidebarWidth: 240 },
    project: null,
    gpuWebGLHardware: true,
    gpuHardwareAccelerationDisabled: false,
    gpuDisabledReason: null,
    gpuAngleFallbackActive: false,
    safeMode: false,
    settingsRecovery: null,
    projectStateRecovery: null,
    crashLoopStateRecovery: null,
  };
  return Object.assign(base, overrides) as HydrateResult;
}

beforeEach(() => {
  notifyMock.mockReset();
  __resetGpuAccelNotifiedForTests();
});

describe("dispatchRecoveryNotifications", () => {
  it("does nothing when no recovery flags are set", () => {
    dispatchRecoveryNotifications(makeHydrateResult({}));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  describe("GPU hardware acceleration", () => {
    it("fires the GPU disabled toast once per renderer lifecycle", () => {
      const result = makeHydrateResult({
        gpuHardwareAccelerationDisabled: true,
        gpuDisabledReason: "crash",
      });

      dispatchRecoveryNotifications(result);
      dispatchRecoveryNotifications(result);
      dispatchRecoveryNotifications(result);

      const gpuCalls = notifyMock.mock.calls.filter(
        ([arg]) => arg.title === "Hardware acceleration disabled"
      );
      expect(gpuCalls).toHaveLength(1);
      expect(gpuCalls[0]![0]).toMatchObject({
        type: "warning",
        priority: "watch",
        duration: 0,
      });
    });

    it("does not fire when the flag is false", () => {
      dispatchRecoveryNotifications(makeHydrateResult({ gpuHardwareAccelerationDisabled: false }));
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("stays silent when the user disabled acceleration manually", () => {
      dispatchRecoveryNotifications(
        makeHydrateResult({
          gpuHardwareAccelerationDisabled: true,
          gpuDisabledReason: "user",
        })
      );
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("stays silent when disabled with no recorded reason", () => {
      dispatchRecoveryNotifications(
        makeHydrateResult({
          gpuHardwareAccelerationDisabled: true,
          gpuDisabledReason: null,
        })
      );
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("offers a re-enable action that calls the GPU IPC bridge", () => {
      const setHardwareAcceleration = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("window", {
        electron: { gpu: { setHardwareAcceleration } },
      });
      try {
        dispatchRecoveryNotifications(
          makeHydrateResult({
            gpuHardwareAccelerationDisabled: true,
            gpuDisabledReason: "crash",
          })
        );
        const arg = notifyMock.mock.calls[0]![0];
        expect(arg.action.label).toBe("Re-enable");
        arg.action.onClick();
        expect(setHardwareAcceleration).toHaveBeenCalledWith(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("GPU ANGLE fallback", () => {
    it("does not fire a toast — ANGLE state is surfaced only as an inline Settings banner", () => {
      dispatchRecoveryNotifications(makeHydrateResult({ gpuAngleFallbackActive: true }));
      expect(notifyMock).not.toHaveBeenCalled();
    });
  });

  describe("settings recovery", () => {
    it("notifies on restored-from-backup with backup messaging", () => {
      dispatchRecoveryNotifications(
        makeHydrateResult({
          settingsRecovery: { kind: "restored-from-backup", quarantinedPath: "/tmp/bad" },
        })
      );

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const arg = notifyMock.mock.calls[0]![0];
      expect(arg.title).toBe("Settings restored from backup");
      expect(arg.duration).toBe(8000);
      expect(arg.message).toContain("/tmp/bad");
    });

    it("notifies on reset-to-defaults with reset messaging", () => {
      dispatchRecoveryNotifications(
        makeHydrateResult({
          settingsRecovery: { kind: "reset-to-defaults", quarantinedPath: "/tmp/bad2" },
        })
      );

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const arg = notifyMock.mock.calls[0]![0];
      expect(arg.title).toBe("Settings reset to defaults");
      expect(arg.duration).toBe(0);
      expect(arg.message).toContain("/tmp/bad2");
    });

    it("omits the path note when quarantinedPath is missing", () => {
      dispatchRecoveryNotifications(
        makeHydrateResult({
          settingsRecovery: { kind: "reset-to-defaults" },
        })
      );

      const arg = notifyMock.mock.calls[0]![0];
      expect(arg.message).not.toContain("Corrupt file preserved at");
    });
  });

  describe("project state recovery", () => {
    it("notifies with the quarantined path", () => {
      dispatchRecoveryNotifications(
        makeHydrateResult({
          projectStateRecovery: { quarantinedPath: "/tmp/proj.bad" },
        })
      );

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const arg = notifyMock.mock.calls[0]![0];
      expect(arg.title).toBe("Project state corrupted");
      expect(arg.message).toContain("/tmp/proj.bad");
      expect(arg.priority).toBe("high");
    });
  });

  describe("crash-loop state recovery", () => {
    it("notifies with the quarantined path", () => {
      dispatchRecoveryNotifications(
        makeHydrateResult({
          crashLoopStateRecovery: { quarantinedPath: "/tmp/crash-loop.bad" },
        })
      );

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const arg = notifyMock.mock.calls[0]![0];
      expect(arg.title).toBe("Crash-loop state corrupted");
      expect(arg.message).toContain("/tmp/crash-loop.bad");
      expect(arg.priority).toBe("high");
      expect(arg.duration).toBe(0);
    });

    it("does not fire when crashLoopStateRecovery is null", () => {
      dispatchRecoveryNotifications(makeHydrateResult({ crashLoopStateRecovery: null }));
      expect(notifyMock).not.toHaveBeenCalled();
    });
  });

  it("can fire all four notifications in one call", () => {
    dispatchRecoveryNotifications(
      makeHydrateResult({
        gpuHardwareAccelerationDisabled: true,
        gpuDisabledReason: "crash",
        settingsRecovery: { kind: "restored-from-backup" },
        projectStateRecovery: { quarantinedPath: "/tmp/p" },
        crashLoopStateRecovery: { quarantinedPath: "/tmp/c" },
      })
    );

    expect(notifyMock).toHaveBeenCalledTimes(4);
  });
});

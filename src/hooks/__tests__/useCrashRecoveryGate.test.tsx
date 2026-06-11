// @vitest-environment jsdom
import { StrictMode } from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useCrashRecoveryGate } from "../app/useCrashRecoveryGate";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";
import type { PendingCrash, CrashRecoveryConfig, CrashRecoveryAction } from "@shared/types/ipc";
import type { BootResult } from "@shared/types/ipc/app";

const mockPanels = [
  { id: "t1", kind: "terminal", title: "Shell", location: "grid" as const, isSuspect: false },
  { id: "t2", kind: "terminal", title: "Claude", location: "dock" as const, isSuspect: false },
];

const mockCrash: PendingCrash = {
  logPath: "/fake/crashes/crash-1.json",
  entry: {
    id: "crash-1",
    timestamp: Date.now(),
    appVersion: "1.0.0",
    platform: "darwin",
    osVersion: "22.0",
    arch: "arm64",
  },
  hasBackup: true,
  panels: mockPanels,
};

const mockConfig: CrashRecoveryConfig = { autoRestoreOnCrash: false };

function makeBootResult(overrides?: Partial<BootResult>): BootResult {
  return {
    appState: {
      terminals: [],
      sidebarWidth: 350,
    } as BootResult["appState"],
    terminalConfig: {} as BootResult["terminalConfig"],
    project: null,
    agentSettings: {} as BootResult["agentSettings"],
    gpuWebGLHardware: true,
    gpuHardwareAccelerationDisabled: false,
    gpuDisabledReason: null,
    gpuAngleFallbackActive: false,
    safeMode: false,
    isWindowsStore: false,
    settingsRecovery: null,
    projectStateRecovery: null,
    crashPending: null,
    crashConfig: mockConfig,
    ...overrides,
  };
}

function installElectronStub(overrides?: {
  resolve?: (action: CrashRecoveryAction) => Promise<void>;
  setConfig?: (patch: Partial<CrashRecoveryConfig>) => Promise<CrashRecoveryConfig>;
}) {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      crashRecovery: {
        resolve: overrides?.resolve ?? vi.fn(async () => {}),
        setConfig:
          overrides?.setConfig ??
          vi.fn(async (patch: Partial<CrashRecoveryConfig>) => ({
            ...mockConfig,
            ...patch,
          })),
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useRestoreConfirmationStore.setState({ visible: false, suspectCount: 0, crashCount: 0 });
  installElectronStub();
});

describe("useCrashRecoveryGate", () => {
  it("transitions to none when boot carries no pending crash", async () => {
    const { result } = renderHook(() =>
      useCrashRecoveryGate(makeBootResult({ crashPending: null }))
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("none");
  });

  it("transitions to pending when boot carries a crash", async () => {
    const { result } = renderHook(() =>
      useCrashRecoveryGate(makeBootResult({ crashPending: mockCrash }))
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("pending");
    if (result.current.state.status === "pending") {
      expect(result.current.state.crash).toEqual(mockCrash);
    }
  });

  it("auto-restores with all panel IDs when autoRestoreOnCrash is true", async () => {
    const resolve = vi.fn(async () => {});
    installElectronStub({ resolve });

    const { result } = renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: mockCrash,
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalledWith({ kind: "restore", panelIds: ["t1", "t2"] });
    expect(result.current.state.status).toBe("none");
  });

  it("skips auto-restore at crashCount 2 and surfaces the dialog", async () => {
    const resolve = vi.fn(async () => {});
    installElectronStub({ resolve });

    const { result } = renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: { ...mockCrash, crashCount: 2 },
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe("pending");
  });

  it("auto-restores at crashCount 1 (below crash-loop threshold)", async () => {
    const resolve = vi.fn(async () => {});
    installElectronStub({ resolve });

    const { result } = renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: { ...mockCrash, crashCount: 1 },
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalledWith({ kind: "restore", panelIds: ["t1", "t2"] });
    expect(result.current.state.status).toBe("none");
  });

  it("surfaces the dialog instead of silent-restoring when hasBackup is false", async () => {
    const resolve = vi.fn(async () => {});
    installElectronStub({ resolve });

    const { result } = renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: { ...mockCrash, hasBackup: false },
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe("pending");
  });

  it("fires crashRecovery.resolve exactly once under StrictMode double-mount", async () => {
    const resolve = vi.fn(async () => {});
    installElectronStub({ resolve });

    // Strict Mode double-invokes the effect (mount→cleanup→mount). The
    // `hasProcessed` ref is the sole guard against a duplicate auto-restore IPC.
    renderHook(
      () =>
        useCrashRecoveryGate(
          makeBootResult({
            crashPending: { ...mockCrash, crashCount: 1 },
            crashConfig: { autoRestoreOnCrash: true },
          })
        ),
      { wrapper: StrictMode }
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("auto-restores with empty panelIds when no panels available", async () => {
    const resolve = vi.fn(async () => {});
    installElectronStub({ resolve });
    const crashNoPanels: PendingCrash = { ...mockCrash, panels: undefined };

    const { result } = renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: crashNoPanels,
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalledWith({ kind: "restore", panelIds: [] });
    expect(result.current.state.status).toBe("none");
  });

  it("resolve sets state to none", async () => {
    const { result } = renderHook(() =>
      useCrashRecoveryGate(makeBootResult({ crashPending: mockCrash }))
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("pending");

    await act(async () => {
      await result.current.resolve({ kind: "restore", panelIds: ["t1"] });
    });

    expect(result.current.state.status).toBe("none");
  });

  it("updateConfig updates config in pending state", async () => {
    const { result } = renderHook(() =>
      useCrashRecoveryGate(makeBootResult({ crashPending: mockCrash }))
    );

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.updateConfig({ autoRestoreOnCrash: true });
    });

    expect(result.current.state.status).toBe("pending");
    if (result.current.state.status === "pending") {
      expect(result.current.state.config.autoRestoreOnCrash).toBe(true);
    }
  });

  it("falls back to none when boot failed (null result)", async () => {
    const { result } = renderHook(() => useCrashRecoveryGate(null));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("none");
  });

  it("signals restore confirmation store on silent auto-restore with suspect panels", async () => {
    const resolve = vi.fn(async () => {});
    installElectronStub({ resolve });
    const suspectPanels = [
      { id: "t1", kind: "terminal", title: "Shell", location: "grid" as const, isSuspect: true },
      { id: "t2", kind: "terminal", title: "Claude", location: "dock" as const, isSuspect: false },
      { id: "t3", kind: "terminal", title: "Server", location: "grid" as const, isSuspect: true },
    ];

    renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: { ...mockCrash, panels: suspectPanels, crashCount: 1 },
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalled();
    const storeState = useRestoreConfirmationStore.getState();
    expect(storeState.visible).toBe(true);
    expect(storeState.suspectCount).toBe(2);
    expect(storeState.crashCount).toBe(1);
  });

  it("signals restore confirmation store with zero suspects on clean restore", async () => {
    const resolve = vi.fn(async () => {});
    installElectronStub({ resolve });

    renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: { ...mockCrash, crashCount: 1 },
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalled();
    const storeState = useRestoreConfirmationStore.getState();
    expect(storeState.visible).toBe(true);
    expect(storeState.suspectCount).toBe(0);
    expect(storeState.crashCount).toBe(1);
  });

  it("signals restore confirmation store with zero suspects when panels is undefined", async () => {
    const resolve = vi.fn(async () => {});
    installElectronStub({ resolve });

    renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: { ...mockCrash, panels: undefined, crashCount: 0 },
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalled();
    const storeState = useRestoreConfirmationStore.getState();
    expect(storeState.visible).toBe(true);
    expect(storeState.suspectCount).toBe(0);
    expect(storeState.crashCount).toBe(0);
  });

  it("does not signal restore confirmation on explicit dialog path", async () => {
    renderHook(() => useCrashRecoveryGate(makeBootResult({ crashPending: mockCrash })));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const storeState = useRestoreConfirmationStore.getState();
    expect(storeState.visible).toBe(false);
  });

  it("does not signal restore confirmation when resolve rejects", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("resolve failed");
    });
    installElectronStub({ resolve });

    renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: { ...mockCrash, crashCount: 1 },
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalled();
    const storeState = useRestoreConfirmationStore.getState();
    expect(storeState.visible).toBe(false);
  });

  it("transitions to failed state when auto-restore resolve rejects", async () => {
    // The IPC handler now rejects when `restoreBackup()` returns false
    // (no snapshot, zero-match filter, no restorable content, or apply
    // exception). The gate must (a) keep the dialog mounted so the user
    // can retry and the "Recovery failed" banner renders, and (b) skip
    // the false-positive "Session restored" confirmation. The recovery
    // source is preserved on disk by the service, so the user can retry.
    const resolve = vi.fn(async () => {
      throw new Error("Crash recovery restore failed");
    });
    installElectronStub({ resolve });
    const pendingCrash = { ...mockCrash, crashCount: 1 };

    const { result } = renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: pendingCrash,
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("failed");
    if (result.current.state.status === "failed") {
      expect(result.current.state.crash).toEqual(pendingCrash);
      expect(result.current.state.config).toEqual({ autoRestoreOnCrash: true });
      expect(result.current.state.errorMessage).toBe("Crash recovery restore failed");
    }
    const storeState = useRestoreConfirmationStore.getState();
    expect(storeState.visible).toBe(false);
  });

  it("uses the fallback error message when reject is a non-Error without a message property", async () => {
    // `formatErrorMessage` accepts Error instances and plain string throws,
    // returning their message. Only an opaque non-Error, non-string rejection
    // triggers the fallback string.
    const resolve = vi.fn(async () => {
      throw { unexpected: "shape" };
    });
    installElectronStub({ resolve });

    const { result } = renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: { ...mockCrash, crashCount: 1 },
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("failed");
    if (result.current.state.status === "failed") {
      expect(result.current.state.errorMessage).toBe("Crash recovery restore failed");
    }
  });

  it("fires crashRecovery.resolve exactly once when auto-restore fails under StrictMode double-mount", async () => {
    // The hasProcessed ref must continue to guard against a duplicate
    // auto-restore IPC even on the failure path — a fast-failing restore
    // must not be retried by a StrictMode remount.
    const resolve = vi.fn(async () => {
      throw new Error("Crash recovery restore failed");
    });
    installElectronStub({ resolve });

    renderHook(
      () =>
        useCrashRecoveryGate(
          makeBootResult({
            crashPending: { ...mockCrash, crashCount: 1 },
            crashConfig: { autoRestoreOnCrash: true },
          })
        ),
      { wrapper: StrictMode }
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("updateConfig patches local config in failed state so the auto-restore switch reflects the change", async () => {
    // After an auto-restore failure, the user can toggle the auto-restore
    // switch in the dialog. The dialog's local config must update so the
    // switch position matches the persisted value (not the stale boot config).
    const resolve = vi.fn(async () => {
      throw new Error("Crash recovery restore failed");
    });
    installElectronStub({ resolve });

    const { result } = renderHook(() =>
      useCrashRecoveryGate(
        makeBootResult({
          crashPending: { ...mockCrash, crashCount: 1 },
          crashConfig: { autoRestoreOnCrash: true },
        })
      )
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("failed");

    await act(async () => {
      await result.current.updateConfig({ autoRestoreOnCrash: false });
    });

    expect(result.current.state.status).toBe("failed");
    if (result.current.state.status === "failed") {
      expect(result.current.state.config.autoRestoreOnCrash).toBe(false);
    }
  });

  describe("perf instrumentation", () => {
    beforeEach(() => {
      window.__DAINTREE_PERF_MARKS__ = [];
    });

    afterEach(() => {
      delete window.__DAINTREE_PERF_MARKS__;
    });

    function gateMarks(): string[] {
      return (window.__DAINTREE_PERF_MARKS__ ?? [])
        .map((entry) => entry.mark)
        .filter((mark) => typeof mark === "string" && mark.startsWith("crash_recovery_gate"));
    }

    it("emits crash_recovery_gate start/end on no-crash path", async () => {
      renderHook(() => useCrashRecoveryGate(makeBootResult({ crashPending: null })));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(gateMarks()).toEqual(["crash_recovery_gate:start", "crash_recovery_gate:end"]);
    });

    it("emits crash_recovery_gate start/end on auto-restore path", async () => {
      const resolve = vi.fn(async () => {});
      installElectronStub({ resolve });

      renderHook(() =>
        useCrashRecoveryGate(
          makeBootResult({
            crashPending: { ...mockCrash, crashCount: 1 },
            crashConfig: { autoRestoreOnCrash: true },
          })
        )
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(gateMarks()).toEqual(["crash_recovery_gate:start", "crash_recovery_gate:end"]);
    });

    it("emits crash_recovery_gate start/end on manual dialog path", async () => {
      renderHook(() => useCrashRecoveryGate(makeBootResult({ crashPending: mockCrash })));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(gateMarks()).toEqual(["crash_recovery_gate:start", "crash_recovery_gate:end"]);
    });

    it("emits crash_recovery_gate start/end when auto-restore resolve rejects", async () => {
      const resolve = vi.fn(async () => {
        throw new Error("resolve failed");
      });
      installElectronStub({ resolve });

      renderHook(() =>
        useCrashRecoveryGate(
          makeBootResult({
            crashPending: { ...mockCrash, crashCount: 1 },
            crashConfig: { autoRestoreOnCrash: true },
          })
        )
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(gateMarks()).toEqual(["crash_recovery_gate:start", "crash_recovery_gate:end"]);
    });

    it("emits crash_recovery_gate start/end when boot failed (null result)", async () => {
      renderHook(() => useCrashRecoveryGate(null));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(gateMarks()).toEqual(["crash_recovery_gate:start", "crash_recovery_gate:end"]);
    });

    it("does not emit any crash_recovery_gate marks when electron is unavailable", async () => {
      Object.defineProperty(window, "electron", {
        configurable: true,
        writable: true,
        value: undefined,
      });

      renderHook(() => useCrashRecoveryGate(makeBootResult({ crashPending: null })));

      await act(async () => {
        await Promise.resolve();
      });

      expect(gateMarks()).toEqual([]);
    });

    it("records a finite, non-negative durationMs on the end mark", async () => {
      renderHook(() => useCrashRecoveryGate(makeBootResult({ crashPending: null })));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const endMark = (window.__DAINTREE_PERF_MARKS__ ?? []).find(
        (entry) => entry.mark === "crash_recovery_gate:end"
      );
      expect(endMark).toBeDefined();
      const durationMs = (endMark?.meta as { durationMs?: number } | undefined)?.durationMs;
      expect(typeof durationMs).toBe("number");
      expect(Number.isFinite(durationMs)).toBe(true);
      expect(durationMs).toBeGreaterThanOrEqual(0);
    });

    it("emits crash_recovery_gate start/end when window.electron.crashRecovery.resolve throws synchronously", async () => {
      // Simulate a malformed bridge whose resolve() throws synchronously on the
      // auto-restore path — the span must still close and the gate must clear.
      Object.defineProperty(window, "electron", {
        configurable: true,
        writable: true,
        value: {
          crashRecovery: {
            resolve: vi.fn(() => {
              throw new Error("bridge malformed");
            }),
            setConfig: vi.fn(async () => mockConfig),
          },
        },
      });

      renderHook(() =>
        useCrashRecoveryGate(
          makeBootResult({
            crashPending: { ...mockCrash, crashCount: 1 },
            crashConfig: { autoRestoreOnCrash: true },
          })
        )
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(gateMarks()).toEqual(["crash_recovery_gate:start", "crash_recovery_gate:end"]);
    });
  });
});

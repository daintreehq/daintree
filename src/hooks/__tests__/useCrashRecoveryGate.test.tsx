// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useCrashRecoveryGate } from "../app/useCrashRecoveryGate";
import type { PendingCrash, CrashRecoveryConfig } from "@shared/types/ipc";

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
  hasBackup: false,
};

const mockConfig: CrashRecoveryConfig = { autoRestoreOnCrash: false };

function makeElectron(overrides?: {
  pending?: PendingCrash | null;
  config?: CrashRecoveryConfig;
  resolve?: () => Promise<void>;
  setConfig?: (patch: Partial<CrashRecoveryConfig>) => Promise<CrashRecoveryConfig>;
}) {
  return {
    crashRecovery: {
      getPending: vi.fn(async () => overrides?.pending ?? null),
      getConfig: vi.fn(async () => overrides?.config ?? mockConfig),
      resolve: overrides?.resolve ?? vi.fn(async () => {}),
      setConfig:
        overrides?.setConfig ??
        vi.fn(async (patch: Partial<CrashRecoveryConfig>) => ({
          ...mockConfig,
          ...patch,
        })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useCrashRecoveryGate", () => {
  it("starts in loading state", () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: makeElectron({ pending: null }),
    });

    const { result } = renderHook(() => useCrashRecoveryGate());
    expect(result.current.state.status).toBe("loading");
  });

  it("transitions to none when no pending crash", async () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: makeElectron({ pending: null }),
    });

    const { result } = renderHook(() => useCrashRecoveryGate());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("none");
  });

  it("transitions to pending when crash is detected", async () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: makeElectron({ pending: mockCrash }),
    });

    const { result } = renderHook(() => useCrashRecoveryGate());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("pending");
    if (result.current.state.status === "pending") {
      expect(result.current.state.crash).toEqual(mockCrash);
    }
  });

  it("auto-restores without showing dialog when autoRestoreOnCrash is true", async () => {
    const resolve = vi.fn(async () => {});
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: makeElectron({
        pending: mockCrash,
        config: { autoRestoreOnCrash: true },
        resolve,
      }),
    });

    const { result } = renderHook(() => useCrashRecoveryGate());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalledWith("restore");
    expect(result.current.state.status).toBe("none");
  });

  it("resolve sets state to none", async () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: makeElectron({ pending: mockCrash }),
    });

    const { result } = renderHook(() => useCrashRecoveryGate());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("pending");

    await act(async () => {
      await result.current.resolve("restore");
    });

    expect(result.current.state.status).toBe("none");
  });

  it("updateConfig updates config in pending state", async () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: makeElectron({ pending: mockCrash }),
    });

    const { result } = renderHook(() => useCrashRecoveryGate());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.updateConfig({ autoRestoreOnCrash: true });
    });

    if (result.current.state.status === "pending") {
      expect(result.current.state.config.autoRestoreOnCrash).toBe(true);
    }
  });

  it("falls back to none when electron API fails", async () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        crashRecovery: {
          getPending: vi.fn(async () => {
            throw new Error("IPC failed");
          }),
          getConfig: vi.fn(async () => mockConfig),
          resolve: vi.fn(async () => {}),
          setConfig: vi.fn(async () => mockConfig),
        },
      },
    });

    const { result } = renderHook(() => useCrashRecoveryGate());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("none");
  });
});

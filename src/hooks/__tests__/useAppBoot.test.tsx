// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useAppBoot } from "../app/useAppBoot";
import type { BootResult } from "@shared/types/ipc/app";

function makeBootResult(): BootResult {
  return {
    appState: { terminals: [], sidebarWidth: 350 } as BootResult["appState"],
    terminalConfig: {} as BootResult["terminalConfig"],
    project: null,
    agentSettings: {} as BootResult["agentSettings"],
    gpuWebGLHardware: true,
    gpuHardwareAccelerationDisabled: false,
    gpuAngleFallbackActive: false,
    safeMode: false,
    isWindowsStore: false,
    settingsRecovery: null,
    projectStateRecovery: null,
    crashPending: null,
    crashConfig: { autoRestoreOnCrash: false },
  };
}

function installElectron(boot: () => Promise<BootResult>) {
  const bootFn = vi.fn(boot);
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      app: { boot: bootFn },
    },
  });
  return bootFn;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useAppBoot", () => {
  it("starts unsettled and transitions to ready", async () => {
    const result = makeBootResult();
    installElectron(async () => result);

    const { result: hook } = renderHook(() => useAppBoot());
    expect(hook.current.settled).toBe(false);
    expect(hook.current.result).toBeNull();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook.current.settled).toBe(true);
    expect(hook.current.result).toBe(result);
    expect(hook.current.error).toBeNull();
  });

  it("settles with error when boot rejects", async () => {
    installElectron(async () => {
      throw new Error("boom");
    });

    const { result: hook } = renderHook(() => useAppBoot());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook.current.settled).toBe(true);
    expect(hook.current.result).toBeNull();
    expect(hook.current.error).toBeInstanceOf(Error);
    expect(hook.current.error?.message).toBe("boom");
  });

  it("fires boot() exactly once across rerenders", async () => {
    const bootFn = installElectron(async () => makeBootResult());

    const { rerender } = renderHook(() => useAppBoot());

    await act(async () => {
      await Promise.resolve();
    });
    rerender();
    await act(async () => {
      await Promise.resolve();
    });

    expect(bootFn).toHaveBeenCalledTimes(1);
  });

  it("fires boot() exactly once under React StrictMode double-mount", async () => {
    const bootFn = installElectron(async () => makeBootResult());

    // Strict mode mounts the component twice in dev. Simulate by rendering
    // inside <StrictMode>. The hook's useRef guard must survive the unmount
    // /remount caused by Strict Mode's intentional double invocation of the
    // effect setup phase.
    const { StrictMode } = await import("react");
    renderHook(() => useAppBoot(), { wrapper: StrictMode });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bootFn).toHaveBeenCalledTimes(1);
  });
});

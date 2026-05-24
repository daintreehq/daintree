// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useResourceProfile } from "../useResourceProfile";
import {
  getWebglLowerThreshold,
  getWebglUpperThreshold,
  setWebglThresholds,
} from "../../services/terminal/TerminalWebGLConfig";
import { useResourceProfileStore } from "../../store/resourceProfileStore";
import { terminalInstanceService } from "../../services/terminal/TerminalInstanceService";
import type { ResourceProfilePayload } from "@shared/types/resourceProfile";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(),
}));

type ResourceCallback = (payload: ResourceProfilePayload) => void;

let capturedCallback: ResourceCallback | null = null;
const cleanupFn = vi.fn();
const originalUpper = getWebglUpperThreshold();
const originalLower = getWebglLowerThreshold();

function makePayload(upper: number, lower: number): ResourceProfilePayload {
  return {
    profile: "balanced",
    config: { webglUpperThreshold: upper, webglLowerThreshold: lower },
  } as unknown as ResourceProfilePayload;
}

describe("useResourceProfile", () => {
  beforeEach(() => {
    capturedCallback = null;
    cleanupFn.mockClear();

    window.electron = {
      system: {
        onResourceProfileChanged: vi.fn((cb: ResourceCallback) => {
          capturedCallback = cb;
          return cleanupFn;
        }),
      },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    setWebglThresholds(originalUpper, originalLower);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  it("subscribes on mount and cleans up on unmount", () => {
    const { unmount } = renderHook(() => useResourceProfile());

    expect(window.electron.system.onResourceProfileChanged).toHaveBeenCalledTimes(1);
    expect(capturedCallback).toBeInstanceOf(Function);

    unmount();
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it("propagates both thresholds to the shared config singleton", () => {
    renderHook(() => useResourceProfile());

    act(() => {
      capturedCallback!(makePayload(7, 5));
    });

    expect(getWebglUpperThreshold()).toBe(7);
    expect(getWebglLowerThreshold()).toBe(5);
  });

  it("payload mutations are visible to TerminalWebGLManager via the shared config", async () => {
    renderHook(() => useResourceProfile());

    act(() => {
      capturedCallback!(makePayload(6, 4));
    });

    const { TerminalWebGLManager } = await import("../../services/terminal/TerminalWebGLManager");
    expect(TerminalWebGLManager.UPPER_THRESHOLD).toBe(6);
    expect(TerminalWebGLManager.LOWER_THRESHOLD).toBe(4);
  });

  it("updates the resource-profile store on each payload", () => {
    renderHook(() => useResourceProfile());

    act(() => {
      capturedCallback!({
        profile: "efficiency",
        config: { webglUpperThreshold: 8, webglLowerThreshold: 6 },
      } as unknown as ResourceProfilePayload);
    });

    expect(useResourceProfileStore.getState().profile).toBe("efficiency");
  });

  it("calls refreshWebGLMode so threshold changes flip live managers immediately", () => {
    // Spy on the service method so a regression that drops the refresh call
    // (e.g. someone reorders or removes the line in useResourceProfile) is
    // caught here — otherwise the threshold-changes-don't-flip bug from the
    // pre-fix code would silently return.
    const refreshSpy = vi.spyOn(terminalInstanceService, "refreshWebGLMode");
    renderHook(() => useResourceProfile());

    act(() => {
      capturedCallback!(makePayload(5, 3));
    });

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    refreshSpy.mockRestore();
  });
});

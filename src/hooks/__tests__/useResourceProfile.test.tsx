// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useResourceProfile } from "../useResourceProfile";
import {
  getWebglLowerThreshold,
  getWebglUpperThreshold,
  setWebglThresholds,
} from "../../services/terminal/TerminalWebGLConfig";
import {
  getAgentScrollbackMaxLines,
  setAgentScrollbackMaxLines,
} from "../../utils/scrollbackConfig";
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
const originalAgentScrollbackMax = getAgentScrollbackMaxLines();

function makePayload(
  upper: number,
  lower: number,
  agentScrollbackMaxLines = 5000
): ResourceProfilePayload {
  return {
    profile: "balanced",
    config: { webglUpperThreshold: upper, webglLowerThreshold: lower, agentScrollbackMaxLines },
  } as unknown as ResourceProfilePayload;
}

let pullResolve: ((payload: ResourceProfilePayload) => void) | null = null;
let getResourceProfileMock: ReturnType<typeof vi.fn>;

describe("useResourceProfile", () => {
  beforeEach(() => {
    capturedCallback = null;
    cleanupFn.mockClear();
    pullResolve = null;
    getResourceProfileMock = vi.fn(
      () =>
        new Promise<ResourceProfilePayload>((resolve) => {
          pullResolve = resolve;
        })
    );

    window.electron = {
      system: {
        onResourceProfileChanged: vi.fn((cb: ResourceCallback) => {
          capturedCallback = cb;
          return cleanupFn;
        }),
        getResourceProfile: getResourceProfileMock,
      },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    setWebglThresholds(originalUpper, originalLower);
    setAgentScrollbackMaxLines(originalAgentScrollbackMax);
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
        config: {
          webglUpperThreshold: 8,
          webglLowerThreshold: 6,
          agentScrollbackMaxLines: 2500,
        },
      } as unknown as ResourceProfilePayload);
    });

    expect(useResourceProfileStore.getState().profile).toBe("efficiency");
  });

  it("pulls the current profile on mount and applies it when no push arrived", async () => {
    renderHook(() => useResourceProfile());

    expect(getResourceProfileMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pullResolve!({
        profile: "efficiency",
        config: { webglUpperThreshold: 8, webglLowerThreshold: 6 },
      } as unknown as ResourceProfilePayload);
    });

    expect(getWebglUpperThreshold()).toBe(8);
    expect(getWebglLowerThreshold()).toBe(6);
    expect(useResourceProfileStore.getState().profile).toBe("efficiency");
  });

  it("discards the pull result when a push arrived first (push is fresher)", async () => {
    renderHook(() => useResourceProfile());

    act(() => {
      capturedCallback!(makePayload(14, 12));
    });

    await act(async () => {
      pullResolve!(makePayload(8, 6));
    });

    expect(getWebglUpperThreshold()).toBe(14);
    expect(getWebglLowerThreshold()).toBe(12);
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

  it("propagates the agent scrollback ceiling and re-derives live terminals", () => {
    const restoreSpy = vi.spyOn(terminalInstanceService, "restoreScrollbackAllForeground");
    renderHook(() => useResourceProfile());

    act(() => {
      capturedCallback!(makePayload(8, 6, 2500));
    });

    expect(getAgentScrollbackMaxLines()).toBe(2500);
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    restoreSpy.mockRestore();
  });
});

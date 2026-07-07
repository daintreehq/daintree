import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  freezeWebContents,
  unfreezeWebContents,
  throttleCpuWebContents,
  unthrottleCpuWebContents,
  purgeMemoryWebContents,
} from "../webContentsLifecycle.js";

interface MockDebugger {
  isAttached: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
}

interface MockWebContents {
  isDestroyed: ReturnType<typeof vi.fn>;
  debugger: MockDebugger;
}

function createMockWc(opts: { attached?: boolean; destroyed?: boolean } = {}): MockWebContents {
  return {
    isDestroyed: vi.fn(() => opts.destroyed ?? false),
    debugger: {
      isAttached: vi.fn(() => opts.attached ?? false),
      attach: vi.fn(),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("webContentsLifecycle", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warnSpy.mockRestore();
  });

  describe("freezeWebContents", () => {
    it("attaches the debugger when not already attached", async () => {
      const wc = createMockWc();
      await freezeWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.isAttached).toHaveBeenCalled();
      expect(wc.debugger.attach).toHaveBeenCalledWith("1.3");
    });

    it("skips attach when already attached", async () => {
      const wc = createMockWc({ attached: true });
      await freezeWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.attach).not.toHaveBeenCalled();
    });

    it("sends Page.enable before Page.setWebLifecycleState", async () => {
      const wc = createMockWc();
      await freezeWebContents(wc as unknown as Electron.WebContents);
      const calls = wc.debugger.sendCommand.mock.calls;
      expect(calls.length).toBe(2);
      expect(calls[0][0]).toBe("Page.enable");
      expect(calls[1][0]).toBe("Page.setWebLifecycleState");
      expect(calls[1][1]).toEqual({ state: "frozen" });
    });

    it("returns early when wc is destroyed", async () => {
      const wc = createMockWc({ destroyed: true });
      await freezeWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.isAttached).not.toHaveBeenCalled();
      expect(wc.debugger.attach).not.toHaveBeenCalled();
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });
  });

  describe("unfreezeWebContents", () => {
    it("sends state: active", async () => {
      const wc = createMockWc();
      await unfreezeWebContents(wc as unknown as Electron.WebContents);
      const lifecycle = wc.debugger.sendCommand.mock.calls.find(
        (c) => c[0] === "Page.setWebLifecycleState"
      );
      expect(lifecycle?.[1]).toEqual({ state: "active" });
    });

    it("returns early when wc is destroyed", async () => {
      const wc = createMockWc({ destroyed: true });
      await unfreezeWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });
  });

  describe("error swallowing", () => {
    const expectedErrors = [
      "Target closed",
      "Inspected target navigated",
      "Cannot attach to the target with an attached client",
      "Another debugger is already attached to this target",
      "No debugger attached",
    ];

    for (const msg of expectedErrors) {
      it(`swallows "${msg}" silently`, async () => {
        const wc = createMockWc();
        wc.debugger.sendCommand.mockRejectedValueOnce(new Error(msg));
        await expect(
          freezeWebContents(wc as unknown as Electron.WebContents)
        ).resolves.toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      });
    }

    it("warns once for an unexpected CDP error", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("Unknown protocol failure"));
      await expect(
        freezeWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("setWebLifecycleState(frozen) failed");
    });

    it("swallows synchronous throw from debugger.attach", async () => {
      const wc = createMockWc();
      wc.debugger.attach.mockImplementation(() => {
        throw new Error("Another debugger is already attached to this target");
      });
      await expect(
        freezeWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("swallows Page.enable rejection without calling setWebLifecycleState", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockImplementation(async (method: string) => {
        if (method === "Page.enable") throw new Error("Target closed");
        return undefined;
      });
      await expect(
        freezeWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      const methods = wc.debugger.sendCommand.mock.calls.map((c: unknown[]) => c[0]);
      expect(methods).toEqual(["Page.enable"]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("never throws when wc.debugger is missing entirely", async () => {
      // A teardown race can leave wc with no debugger getter — confirm the
      // utility absorbs the synchronous TypeError without rejecting.
      const wc = { isDestroyed: vi.fn(() => false) } as unknown as Electron.WebContents;
      await expect(freezeWebContents(wc)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("repeated calls re-evaluate attach state each time", async () => {
    const wc = createMockWc();
    await freezeWebContents(wc as unknown as Electron.WebContents);
    expect(wc.debugger.isAttached).toHaveBeenCalledTimes(1);

    wc.debugger.isAttached.mockReturnValue(true);
    await unfreezeWebContents(wc as unknown as Electron.WebContents);
    expect(wc.debugger.isAttached).toHaveBeenCalledTimes(2);
    expect(wc.debugger.attach).toHaveBeenCalledTimes(1);
  });

  describe("throttleCpuWebContents / unthrottleCpuWebContents", () => {
    it("skips CPU throttling when Windows E2E disables cached-view CDP throttles", async () => {
      vi.stubEnv("DAINTREE_E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE", "1");
      const wc = createMockWc();
      await throttleCpuWebContents(wc as unknown as Electron.WebContents);
      await unthrottleCpuWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.isAttached).not.toHaveBeenCalled();
      expect(wc.debugger.attach).not.toHaveBeenCalled();
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("throttleCpuWebContents sends Emulation.setCPUThrottlingRate with rate: 4", async () => {
      const wc = createMockWc();
      await throttleCpuWebContents(wc as unknown as Electron.WebContents);
      const calls = wc.debugger.sendCommand.mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe("Emulation.setCPUThrottlingRate");
      expect(calls[0][1]).toEqual({ rate: 4 });
    });

    it("unthrottleCpuWebContents sends rate: 1", async () => {
      const wc = createMockWc();
      await unthrottleCpuWebContents(wc as unknown as Electron.WebContents);
      const calls = wc.debugger.sendCommand.mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe("Emulation.setCPUThrottlingRate");
      expect(calls[0][1]).toEqual({ rate: 1 });
    });

    it("does not call Page.enable or Emulation.enable", async () => {
      const wc = createMockWc();
      await throttleCpuWebContents(wc as unknown as Electron.WebContents);
      await unthrottleCpuWebContents(wc as unknown as Electron.WebContents);
      const methods = wc.debugger.sendCommand.mock.calls.map((c: unknown[]) => c[0]);
      expect(methods).not.toContain("Page.enable");
      expect(methods).not.toContain("Emulation.enable");
    });

    it("attaches the debugger when not already attached", async () => {
      const wc = createMockWc();
      await throttleCpuWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.attach).toHaveBeenCalledWith("1.3");
    });

    it("skips attach when already attached", async () => {
      const wc = createMockWc({ attached: true });
      await throttleCpuWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.attach).not.toHaveBeenCalled();
    });

    it("returns early when wc is destroyed", async () => {
      const wc = createMockWc({ destroyed: true });
      await throttleCpuWebContents(wc as unknown as Electron.WebContents);
      await unthrottleCpuWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("swallows expected CDP errors silently (throttle)", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("Target closed"));
      await expect(
        throttleCpuWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("swallows expected CDP errors silently (unthrottle)", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("Inspected target navigated"));
      await expect(
        unthrottleCpuWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns once for an unexpected CDP error (throttle, rate 4)", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("Unknown protocol failure"));
      await expect(
        throttleCpuWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("setCPUThrottlingRate(4) failed");
    });

    it("warns once for an unexpected CDP error (unthrottle, rate 1)", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("Unknown protocol failure"));
      await expect(
        unthrottleCpuWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("setCPUThrottlingRate(1) failed");
    });

    it("swallows synchronous throw from debugger.attach", async () => {
      const wc = createMockWc();
      wc.debugger.attach.mockImplementation(() => {
        throw new Error("Another debugger is already attached to this target");
      });
      await expect(
        throttleCpuWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("never throws when wc.debugger is missing entirely (throttle)", async () => {
      const wc = { isDestroyed: vi.fn(() => false) } as unknown as Electron.WebContents;
      await expect(throttleCpuWebContents(wc)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("never throws when wc.debugger is missing entirely (unthrottle)", async () => {
      const wc = { isDestroyed: vi.fn(() => false) } as unknown as Electron.WebContents;
      await expect(unthrottleCpuWebContents(wc)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("purgeMemoryWebContents", () => {
    it("sends the pressure notification before the HeapProfiler GC sequence", async () => {
      const wc = createMockWc();
      await purgeMemoryWebContents(wc as unknown as Electron.WebContents);
      const methods = wc.debugger.sendCommand.mock.calls.map((c: unknown[]) => c[0]);
      expect(methods).toEqual([
        "Memory.simulatePressureNotification",
        "HeapProfiler.enable",
        "HeapProfiler.collectGarbage",
        "HeapProfiler.disable",
      ]);
      expect(wc.debugger.sendCommand.mock.calls[0][1]).toEqual({ level: "critical" });
    });

    it("never sends Memory.forciblyPurgeJavaScriptMemory (SIGSEGVs throttled hidden views)", async () => {
      const wc = createMockWc();
      await purgeMemoryWebContents(wc as unknown as Electron.WebContents);
      const methods = wc.debugger.sendCommand.mock.calls.map((c: unknown[]) => c[0]);
      expect(methods).not.toContain("Memory.forciblyPurgeJavaScriptMemory");
    });

    it("skips entirely when Windows E2E disables cached-view CDP throttles", async () => {
      vi.stubEnv("DAINTREE_E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE", "1");
      const wc = createMockWc();
      await purgeMemoryWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.attach).not.toHaveBeenCalled();
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("returns early when wc is destroyed", async () => {
      const wc = createMockWc({ destroyed: true });
      await purgeMemoryWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("swallows expected CDP errors silently", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("Target closed"));
      await expect(
        purgeMemoryWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns once for an unexpected CDP error", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("boom"));
      await expect(
        purgeMemoryWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});

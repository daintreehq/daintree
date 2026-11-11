import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import * as lifecycle from "../webContentsLifecycle.js";

import {
  freezeWebContents,
  unfreezeWebContents,
  unthrottleCpuWebContents,
  purgeMemoryWebContents,
  readJsHeapUsedBytes,
  isWebContentsFrozen,
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
  });

  describe("isWebContentsFrozen (#16810)", () => {
    const asWc = (wc: MockWebContents) => wc as unknown as Electron.WebContents;

    /** Route every CDP command through `handle`; a throw or rejection fails it. */
    function onCommand(
      wc: MockWebContents,
      handle: (method: string, state: string | undefined) => Promise<void> | void
    ): void {
      wc.debugger.sendCommand.mockImplementation(
        async (method: string, params?: { state?: string }) => handle(method, params?.state)
      );
    }

    function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
      let resolve!: () => void;
      let reject!: () => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = () => rej(new Error("Target closed"));
      });
      return { promise, resolve, reject };
    }

    /** Each `setWebLifecycleState` call waits on the next deferred, in order. */
    function queueLifecycleCommands(wc: MockWebContents, count: number) {
      const pending = Array.from({ length: count }, deferred);
      let next = 0;
      onCommand(wc, (method) =>
        method === "Page.setWebLifecycleState" ? pending[next++]!.promise : undefined
      );
      return pending;
    }

    it("holds from the freeze request until the thaw succeeds", async () => {
      const wc = createMockWc();
      expect(isWebContentsFrozen(asWc(wc))).toBe(false);

      const freezing = freezeWebContents(asWc(wc));
      expect(isWebContentsFrozen(asWc(wc))).toBe(true);
      await freezing;
      expect(isWebContentsFrozen(asWc(wc))).toBe(true);

      const thawing = unfreezeWebContents(asWc(wc));
      expect(isWebContentsFrozen(asWc(wc))).toBe(true);
      await thawing;
      expect(isWebContentsFrozen(asWc(wc))).toBe(false);
    });

    it("is per renderer, and a thaw of a renderer never frozen never holds it", async () => {
      const frozen = createMockWc();
      const thawed = createMockWc();
      await freezeWebContents(asWc(frozen));
      const [thaw] = queueLifecycleCommands(thawed, 1);

      const thawing = unfreezeWebContents(asWc(thawed));
      expect(isWebContentsFrozen(asWc(thawed))).toBe(false);
      thaw!.reject();
      await thawing;

      expect(isWebContentsFrozen(asWc(thawed))).toBe(false);
      expect(isWebContentsFrozen(asWc(frozen))).toBe(true);
    });

    it("never holds a destroyed renderer", async () => {
      const wc = createMockWc({ destroyed: true });
      await freezeWebContents(asWc(wc));
      expect(isWebContentsFrozen(asWc(wc))).toBe(false);
    });

    it.each(["Target closed", "Debugger.sendCommand blew up"])(
      "keeps holding through a freeze or thaw that failed once sent (%s)",
      async (message) => {
        const wc = createMockWc();
        await freezeWebContents(asWc(wc));
        onCommand(wc, (method) => {
          if (method === "Page.setWebLifecycleState") throw new Error(message);
        });

        await freezeWebContents(asWc(wc));
        expect(isWebContentsFrozen(asWc(wc))).toBe(true);
        await unfreezeWebContents(asWc(wc));
        expect(isWebContentsFrozen(asWc(wc))).toBe(true);

        wc.debugger.sendCommand.mockResolvedValue(undefined);
        await unfreezeWebContents(asWc(wc));
        expect(isWebContentsFrozen(asWc(wc))).toBe(false);
      }
    );

    it("a first freeze that failed once sent still holds, since it may have landed", async () => {
      const wc = createMockWc();
      onCommand(wc, (method) => {
        if (method === "Page.setWebLifecycleState") throw new Error("Target closed");
      });
      await freezeWebContents(asWc(wc));
      expect(isWebContentsFrozen(asWc(wc))).toBe(true);
    });

    it.each([
      [
        "Page.enable rejects",
        (wc: MockWebContents) =>
          onCommand(wc, (method) => {
            if (method === "Page.enable") throw new Error("Target closed");
          }),
      ],
      [
        "the debugger won't attach",
        (wc: MockWebContents) =>
          wc.debugger.attach.mockImplementation(() => {
            throw new Error("Cannot attach");
          }),
      ],
    ])("a freeze that never went out takes its hold back (%s)", async (_, breakCdp) => {
      const wc = createMockWc();
      breakCdp(wc);
      await freezeWebContents(asWc(wc));
      expect(isWebContentsFrozen(asWc(wc))).toBe(false);
      expect(
        wc.debugger.sendCommand.mock.calls.some((c) => c[0] === "Page.setWebLifecycleState")
      ).toBe(false);
    });

    it("a freeze that never went out puts back the hold before it, for its thaw to release", async () => {
      const wc = createMockWc({ attached: true });
      await freezeWebContents(asWc(wc));
      const thaw = deferred();
      onCommand(wc, (method, state) => {
        if (method === "Page.setWebLifecycleState" && state === "active") return thaw.promise;
      });
      const thawing = unfreezeWebContents(asWc(wc));
      await vi.waitFor(() =>
        expect(wc.debugger.sendCommand).toHaveBeenCalledWith("Page.setWebLifecycleState", {
          state: "active",
        })
      );

      onCommand(wc, (method) => {
        if (method === "Page.enable") throw new Error("Target closed");
      });
      await freezeWebContents(asWc(wc));
      expect(isWebContentsFrozen(asWc(wc))).toBe(true);

      thaw.resolve();
      await thawing;
      expect(isWebContentsFrozen(asWc(wc))).toBe(false);
    });

    it("a thaw that lands after a newer freeze leaves that freeze's hold", async () => {
      const wc = createMockWc();
      await freezeWebContents(asWc(wc));
      const [thaw, refreeze] = queueLifecycleCommands(wc, 2);

      const thawing = unfreezeWebContents(asWc(wc));
      const refreezing = freezeWebContents(asWc(wc));
      thaw!.resolve();
      refreeze!.resolve();
      await Promise.all([thawing, refreezing]);

      expect(isWebContentsFrozen(asWc(wc))).toBe(true);
    });

    it.each([
      ["the first succeeds and the second fails", "resolve", "reject"],
      ["the first fails and the second succeeds", "reject", "resolve"],
    ] as const)(
      "of two overlapping thaws where %s, the success releases the hold",
      async (_, first, second) => {
        const wc = createMockWc();
        await freezeWebContents(asWc(wc));
        const [a, b] = queueLifecycleCommands(wc, 2);

        const thawA = unfreezeWebContents(asWc(wc));
        const thawB = unfreezeWebContents(asWc(wc));
        await vi.waitFor(() =>
          expect(
            wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === "Page.setWebLifecycleState")
          ).toHaveLength(3)
        );
        a![first]();
        await thawA;
        expect(isWebContentsFrozen(asWc(wc))).toBe(first === "reject");
        b![second]();
        await thawB;

        expect(isWebContentsFrozen(asWc(wc))).toBe(false);
      }
    );

    it("a thaw requested while a freeze is in flight releases it", async () => {
      const wc = createMockWc();
      const freezing = freezeWebContents(asWc(wc));
      const thawing = unfreezeWebContents(asWc(wc));
      await Promise.all([freezing, thawing]);
      expect(isWebContentsFrozen(asWc(wc))).toBe(false);
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

  describe("unthrottleCpuWebContents", () => {
    it("sends only Emulation.setCPUThrottlingRate rate 1 on an attached session", async () => {
      const wc = createMockWc({ attached: true });
      await unthrottleCpuWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.sendCommand.mock.calls).toEqual([
        ["Emulation.setCPUThrottlingRate", { rate: 1 }],
      ]);
      expect(wc.debugger.attach).not.toHaveBeenCalled();
    });

    it("never attaches a debugger just to reset the rate (#12456)", async () => {
      const wc = createMockWc({ attached: false });
      await unthrottleCpuWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.attach).not.toHaveBeenCalled();
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("reads attachment per call, so a session attached later is reset", async () => {
      const wc = createMockWc({ attached: false });
      await unthrottleCpuWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();

      wc.debugger.isAttached.mockReturnValue(true);
      await unthrottleCpuWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.sendCommand).toHaveBeenCalledWith("Emulation.setCPUThrottlingRate", {
        rate: 1,
      });
    });

    it("skips entirely when Windows E2E disables cached-view CDP commands", async () => {
      vi.stubEnv("DAINTREE_E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE", "1");
      const wc = createMockWc({ attached: true });
      await unthrottleCpuWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.isAttached).not.toHaveBeenCalled();
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("returns early when wc is destroyed", async () => {
      const wc = createMockWc({ attached: true, destroyed: true });
      await unthrottleCpuWebContents(wc as unknown as Electron.WebContents);
      expect(wc.debugger.isAttached).not.toHaveBeenCalled();
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("swallows expected CDP errors silently", async () => {
      const wc = createMockWc({ attached: true });
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("Inspected target navigated"));
      await expect(
        unthrottleCpuWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns once for an unexpected CDP error", async () => {
      const wc = createMockWc({ attached: true });
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("Unknown protocol failure"));
      await expect(
        unthrottleCpuWebContents(wc as unknown as Electron.WebContents)
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("setCPUThrottlingRate(1) failed");
    });

    it("never throws when wc.debugger is missing entirely", async () => {
      const wc = { isDestroyed: vi.fn(() => false) } as unknown as Electron.WebContents;
      await expect(unthrottleCpuWebContents(wc)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("exposes no helper that raises the CPU throttling rate (#12456)", async () => {
    // Module-level rather than per caller: guest call sites run inside
    // forEachGuest's catch, so a caller-side test can miss a re-added
    // throttle. Chromium's throttler busy-spins the renderer at any rate > 1.
    const exported = Object.entries(lifecycle).filter(
      (entry): entry is [string, (wc: Electron.WebContents) => unknown] =>
        typeof entry[1] === "function"
    );
    expect(exported.length).toBeGreaterThan(0);
    for (const [, helper] of exported) {
      const wc = createMockWc({ attached: true });
      await helper(wc as unknown as Electron.WebContents);
      const rates = wc.debugger.sendCommand.mock.calls
        .filter((call: unknown[]) => call[0] === "Emulation.setCPUThrottlingRate")
        .map((call: unknown[]) => (call[1] as { rate: number }).rate);
      expect(rates.every((rate: number) => rate === 1)).toBe(true);
    }
  });

  describe("purgeMemoryWebContents", () => {
    it("sends only the HeapProfiler GC sequence", async () => {
      const wc = createMockWc();
      await purgeMemoryWebContents(wc as unknown as Electron.WebContents);
      const methods = wc.debugger.sendCommand.mock.calls.map((c: unknown[]) => c[0]);
      expect(methods).toEqual([
        "HeapProfiler.enable",
        "HeapProfiler.collectGarbage",
        "HeapProfiler.disable",
      ]);
    });

    it("skips entirely when Windows E2E disables cached-view CDP commands", async () => {
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
      await expect(purgeMemoryWebContents(wc as unknown as Electron.WebContents)).resolves.toBe(
        false
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns once for an unexpected CDP error", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("boom"));
      await expect(purgeMemoryWebContents(wc as unknown as Electron.WebContents)).resolves.toBe(
        false
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("reports that a collection was issued", async () => {
      const wc = createMockWc();
      await expect(
        purgeMemoryWebContents(wc as unknown as Electron.WebContents, { shouldCollect: () => true })
      ).resolves.toBe(true);
    });

    it("reports no collection when skipped or destroyed", async () => {
      await expect(
        purgeMemoryWebContents(createMockWc({ destroyed: true }) as unknown as Electron.WebContents)
      ).resolves.toBe(false);
      vi.stubEnv("DAINTREE_E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE", "1");
      await expect(
        purgeMemoryWebContents(createMockWc() as unknown as Electron.WebContents)
      ).resolves.toBe(false);
    });

    it("checks shouldCollect after enabling, and skips the collection but still disables", async () => {
      const wc = createMockWc();
      // Recorded rather than asserted inline: the helper's own catch would
      // swallow a failed expectation thrown from inside the callback.
      let enabledFirst = false;
      const shouldCollect = vi.fn(() => {
        enabledFirst = wc.debugger.sendCommand.mock.calls.some(
          (c: unknown[]) => c[0] === "HeapProfiler.enable"
        );
        return false;
      });

      await expect(
        purgeMemoryWebContents(wc as unknown as Electron.WebContents, { shouldCollect })
      ).resolves.toBe(false);

      expect(enabledFirst).toBe(true);
      expect(shouldCollect).toHaveBeenCalledTimes(1);
      const methods = wc.debugger.sendCommand.mock.calls.map((c: unknown[]) => c[0]);
      expect(methods).toEqual(["HeapProfiler.enable", "HeapProfiler.disable"]);
    });

    it("still disables the profiler when the collection itself fails", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Target closed"));

      await expect(purgeMemoryWebContents(wc as unknown as Electron.WebContents)).resolves.toBe(
        false
      );

      const methods = wc.debugger.sendCommand.mock.calls.map((c: unknown[]) => c[0]);
      expect(methods).toEqual([
        "HeapProfiler.enable",
        "HeapProfiler.collectGarbage",
        "HeapProfiler.disable",
      ]);
    });

    it("never sends disable when enable itself failed", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("Cannot attach"));

      await purgeMemoryWebContents(wc as unknown as Electron.WebContents);

      const methods = wc.debugger.sendCommand.mock.calls.map((c: unknown[]) => c[0]);
      expect(methods).toEqual(["HeapProfiler.enable"]);
    });
  });

  describe("readJsHeapUsedBytes", () => {
    it("returns usedSize from Runtime.getHeapUsage, attaching when needed", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockResolvedValueOnce({
        usedSize: 48_000_000,
        totalSize: 64_000_000,
      });

      await expect(readJsHeapUsedBytes(wc as unknown as Electron.WebContents)).resolves.toBe(
        48_000_000
      );
      expect(wc.debugger.attach).toHaveBeenCalledWith("1.3");
      expect(wc.debugger.sendCommand.mock.calls).toEqual([["Runtime.getHeapUsage"]]);
    });

    it("returns null for a malformed response", async () => {
      for (const response of [undefined, {}, { usedSize: "big" }, { usedSize: Number.NaN }]) {
        const wc = createMockWc({ attached: true });
        wc.debugger.sendCommand.mockResolvedValueOnce(response);
        await expect(
          readJsHeapUsedBytes(wc as unknown as Electron.WebContents)
        ).resolves.toBeNull();
      }
    });

    it("returns null without CDP when the wc is destroyed", async () => {
      const wc = createMockWc({ destroyed: true });
      await expect(readJsHeapUsedBytes(wc as unknown as Electron.WebContents)).resolves.toBeNull();
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("returns null without CDP when Windows E2E disables cached-view CDP commands", async () => {
      vi.stubEnv("DAINTREE_E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE", "1");
      const wc = createMockWc();
      await expect(readJsHeapUsedBytes(wc as unknown as Electron.WebContents)).resolves.toBeNull();
      expect(wc.debugger.attach).not.toHaveBeenCalled();
      expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("returns null and stays quiet on an expected CDP error", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("Target closed"));
      await expect(readJsHeapUsedBytes(wc as unknown as Electron.WebContents)).resolves.toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("returns null and warns once on an unexpected CDP error", async () => {
      const wc = createMockWc();
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error("boom"));
      await expect(readJsHeapUsedBytes(wc as unknown as Electron.WebContents)).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("readJsHeapUsedBytes failed");
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isNativeAddonLoadFailure, loadPtyIntegration } from "./helpers/nativePtyCapability.js";

const addonFailure = () =>
  new Error(
    "Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-x64: Error: Cannot find module '../build/Release/pty.node'"
  );

describe("loadPtyIntegration", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it("loads the suite modules only after node-pty loads, and returns them", async () => {
    const calls: string[] = [];
    const result = await loadPtyIntegration(
      async () => {
        calls.push("modules");
        return { marker: 42 };
      },
      {
        ci: false,
        loadNativePty: async () => {
          calls.push("node-pty");
        },
      }
    );

    expect(calls).toEqual(["node-pty", "modules"]);
    expect(result).toEqual({ available: true, modules: { marker: 42 } });
  });

  it("skips off CI when the node-pty addon cannot load, naming what is missing", async () => {
    const original = addonFailure();
    const loadModules = vi.fn();

    const result = await loadPtyIntegration(loadModules, {
      ci: false,
      loadNativePty: () => Promise.reject(original),
    });

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("node-pty native addon");
    expect(result.reason).toContain(process.version);
    expect(result.reason).toContain(original.message);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(result.reason));
    expect(loadModules).not.toHaveBeenCalled();
  });

  it("fails on CI when the node-pty addon cannot load, keeping the original error as cause", async () => {
    const original = addonFailure();
    const loadModules = vi.fn();

    const error = await loadPtyIntegration(loadModules, {
      ci: true,
      loadNativePty: () => Promise.reject(original),
    }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("required on CI");
    expect((error as Error).cause).toBe(original);
    expect(loadModules).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["a TypeError", new TypeError("Cannot read properties of undefined (reading 'spawn')")],
    [
      "a missing transitive dependency",
      Object.assign(new Error("Cannot find module 'some-dependency'"), {
        code: "MODULE_NOT_FOUND",
      }),
    ],
  ])("rethrows %s from loading node-pty unchanged, even off CI", async (_label, original) => {
    const loadModules = vi.fn();

    await expect(
      loadPtyIntegration(loadModules, { ci: false, loadNativePty: () => Promise.reject(original) })
    ).rejects.toBe(original);
    expect(loadModules).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rethrows a production module or helper import error unchanged (ci: %s)",
    async (ci) => {
      // Addon-shaped on purpose: only the probe's catch may classify it, never the suite's imports.
      const original = addonFailure();

      await expect(
        loadPtyIntegration(() => Promise.reject(original), {
          ci,
          loadNativePty: async () => {},
        })
      ).rejects.toBe(original);
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it("fails rather than skips when an imported module throws during evaluation", async () => {
    await expect(
      loadPtyIntegration(() => import("./fixtures/throwsAtImport.js"), {
        ci: false,
        loadNativePty: async () => {},
      })
    ).rejects.toThrow("throwsAtImport fixture: module evaluation failed");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an empty CI variable as a developer machine and any set one as CI", async () => {
    const loadNativePty = () => Promise.reject(addonFailure());

    vi.stubEnv("CI", "");
    await expect(loadPtyIntegration(vi.fn(), { loadNativePty })).resolves.toMatchObject({
      available: false,
    });

    for (const value of ["true", "1"]) {
      vi.stubEnv("CI", value);
      await expect(loadPtyIntegration(vi.fn(), { loadNativePty })).rejects.toThrow(
        "required on CI"
      );
    }

    await expect(loadPtyIntegration(vi.fn(), { ci: false, loadNativePty })).resolves.toMatchObject({
      available: false,
    });
  });

  it("probes the real node-pty module by default", async () => {
    let probed = false;
    vi.doMock("node-pty", () => {
      probed = true;
      return {};
    });
    try {
      const result = await loadPtyIntegration(async () => "loaded", { ci: false });
      expect(probed).toBe(true);
      expect(result).toEqual({ available: true, modules: "loaded" });
    } finally {
      vi.doUnmock("node-pty");
    }
  });
});

describe("isNativeAddonLoadFailure", () => {
  it("matches node-pty's wrapped addon load failure for any addon name", () => {
    expect(isNativeAddonLoadFailure(addonFailure())).toBe(true);
    expect(
      isNativeAddonLoadFailure(
        new Error(
          "Failed to load native module: conpty.node, checked: build/Release, build/Debug, prebuilds/win32-x64: Error: The specified module could not be found."
        )
      )
    ).toBe(true);
  });

  it("rejects other errors and non-errors", () => {
    expect(isNativeAddonLoadFailure(new Error("Cannot find module 'node-pty'"))).toBe(false);
    expect(isNativeAddonLoadFailure(new Error("Failed to load native module: pty.node"))).toBe(
      false
    );
    expect(
      isNativeAddonLoadFailure(
        new Error("wrapped: Failed to load native module: pty.node, checked: x")
      )
    ).toBe(false);
    expect(isNativeAddonLoadFailure(undefined)).toBe(false);
    expect(isNativeAddonLoadFailure("Failed to load native module: pty.node, checked: x")).toBe(
      false
    );
  });
});

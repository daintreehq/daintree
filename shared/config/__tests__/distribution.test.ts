import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getBuildChannel,
  getBuildChannelLabel,
  getRuntimePlatform,
  isWindowsStoreBuild,
} from "../distribution.js";

type WithStoreFlag = NodeJS.Process & { windowsStore?: boolean };

describe("distribution config", () => {
  describe("isWindowsStoreBuild", () => {
    let originalStoreFlag: boolean | undefined;
    let originalHadFlag: boolean;

    beforeEach(() => {
      const proc = process as any;
      originalHadFlag = "windowsStore" in proc;
      originalStoreFlag = proc.windowsStore;
      delete proc.windowsStore;
    });

    afterEach(() => {
      const proc = process as any;
      if (originalHadFlag) {
        proc.windowsStore = originalStoreFlag;
      } else {
        delete proc.windowsStore;
      }
    });

    it("returns true when an explicit value of true is supplied (renderer bridge path)", () => {
      expect(isWindowsStoreBuild(true)).toBe(true);
    });

    it("returns false when an explicit value of false is supplied (NSIS renderer path)", () => {
      expect(isWindowsStoreBuild(false)).toBe(false);
    });

    it("returns false when process.windowsStore is undefined (NSIS install or non-Windows)", () => {
      expect(isWindowsStoreBuild()).toBe(false);
    });

    it("returns true when process.windowsStore is true (main-process MSIX detection)", () => {
      (process as WithStoreFlag).windowsStore = true;
      expect(isWindowsStoreBuild()).toBe(true);
    });

    it("returns false when process.windowsStore is false (main-process NSIS detection)", () => {
      (process as WithStoreFlag).windowsStore = false;
      expect(isWindowsStoreBuild()).toBe(false);
    });

    it("explicit argument wins over process.windowsStore", () => {
      (process as WithStoreFlag).windowsStore = true;
      expect(isWindowsStoreBuild(false)).toBe(false);
    });
  });

  describe("getBuildChannel", () => {
    it("classifies a plain semantic version as stable", () => {
      expect(getBuildChannel("0.25.0")).toBe("stable");
      expect(getBuildChannel("1.0.0")).toBe("stable");
    });

    it("classifies the nightly stamp format as nightly", () => {
      expect(getBuildChannel("0.25.0-nightly.20260713120000.abc1234")).toBe("nightly");
    });

    it("classifies beta and rc prerelease tags", () => {
      expect(getBuildChannel("1.0.0-beta.1")).toBe("beta");
      expect(getBuildChannel("1.0.0-rc.2")).toBe("rc");
    });

    it("applies deterministic precedence for combined tags (nightly > rc > beta)", () => {
      expect(getBuildChannel("1.0.0-nightly.1-rc.1")).toBe("nightly");
      expect(getBuildChannel("1.0.0-rc.1-beta.1")).toBe("rc");
    });

    it("falls back to stable for unrecognized prerelease tags", () => {
      expect(getBuildChannel("1.0.0-alpha.1")).toBe("stable");
      expect(getBuildChannel("1.0.0-canary")).toBe("stable");
    });
  });

  describe("getBuildChannelLabel", () => {
    it("returns null for stable builds so callers render no channel marker", () => {
      expect(getBuildChannelLabel("1.0.0")).toBeNull();
      expect(getBuildChannelLabel("0.25.0")).toBeNull();
    });

    it("returns a distinct, visible label for every prerelease channel", () => {
      // Assert the invariants (non-stable → shown, one label per channel), not
      // the exact display strings, which would just duplicate the label table.
      const versions = ["0.25.0-nightly.20260713120000.abc1234", "1.0.0-beta.1", "1.0.0-rc.2"];
      const labels = versions.map((version) => {
        const label = getBuildChannelLabel(version);
        expect(label).toBeTruthy();
        expect(getBuildChannel(version)).not.toBe("stable");
        return label;
      });
      // Each channel maps to its own label — guards against a table where every
      // channel collapses to the same string.
      expect(new Set(labels).size).toBe(versions.length);
    });
  });

  describe("getRuntimePlatform", () => {
    it("falls back to navigator detection when process.platform is not an OS platform", () => {
      const originalProcess = globalThis.process;
      const originalNavigator = globalThis.navigator;

      Object.defineProperty(globalThis, "process", {
        value: { platform: "browser" },
        configurable: true,
      });
      Object.defineProperty(globalThis, "navigator", {
        value: { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        configurable: true,
      });

      try {
        expect(getRuntimePlatform()).toBe("win32");
      } finally {
        Object.defineProperty(globalThis, "process", {
          value: originalProcess,
          configurable: true,
        });
        Object.defineProperty(globalThis, "navigator", {
          value: originalNavigator,
          configurable: true,
        });
      }
    });
  });
});

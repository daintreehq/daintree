import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  GPU_DISABLED_FLAG_FILENAME,
  LEGACY_GPU_FLAG_VERSION,
  parseGpuDisabledFlag,
  readGpuDisabledFlagData,
  shouldRetryGpuAfterUpdate,
  writeGpuDisabledFlagFile,
} from "../gpuDisabledFlag.js";

describe("gpuDisabledFlag", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-flag-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("parseGpuDisabledFlag", () => {
    it("parses structured JSON content", () => {
      expect(
        parseGpuDisabledFlag('{"reason":"user","version":"1.2.3","timestamp":1718105000000}')
      ).toEqual({ reason: "user", version: "1.2.3", timestamp: 1718105000000 });
    });

    it("treats a legacy bare timestamp as a crash flag with the legacy version", () => {
      const data = parseGpuDisabledFlag("1718105000000");
      expect(data).toEqual({
        reason: "crash",
        version: LEGACY_GPU_FLAG_VERSION,
        timestamp: 1718105000000,
      });
    });

    it("treats unparseable content as a crash flag with zeroed timestamp", () => {
      const data = parseGpuDisabledFlag("not a flag {{{");
      expect(data.reason).toBe("crash");
      expect(data.version).toBe(LEGACY_GPU_FLAG_VERSION);
      expect(data.timestamp).toBe(0);
    });

    it("coerces unknown reason values to crash", () => {
      const data = parseGpuDisabledFlag('{"reason":"gremlins","version":"1.0.0","timestamp":5}');
      expect(data.reason).toBe("crash");
      expect(data.version).toBe("1.0.0");
    });

    it("fills missing version/timestamp fields with safe fallbacks", () => {
      const data = parseGpuDisabledFlag('{"reason":"user"}');
      expect(data).toEqual({ reason: "user", version: LEGACY_GPU_FLAG_VERSION, timestamp: 0 });
    });

    it("ignores surrounding whitespace", () => {
      expect(parseGpuDisabledFlag("  1718105000000\n").timestamp).toBe(1718105000000);
    });

    it("treats valid JSON without a reason field as a legacy crash flag", () => {
      for (const raw of ["{}", "[]", "null", "true"]) {
        const data = parseGpuDisabledFlag(raw);
        expect(data.reason).toBe("crash");
        expect(data.version).toBe(LEGACY_GPU_FLAG_VERSION);
      }
    });

    it("zeroes a non-numeric timestamp field", () => {
      const data = parseGpuDisabledFlag('{"reason":"user","version":"1.0.0","timestamp":"soon"}');
      expect(data.timestamp).toBe(0);
    });
  });

  describe("readGpuDisabledFlagData", () => {
    it("returns null when the flag file is absent", () => {
      expect(readGpuDisabledFlagData(tmpDir)).toBeNull();
    });

    it("round-trips data written by writeGpuDisabledFlagFile", () => {
      const data = { reason: "user" as const, version: "3.1.4", timestamp: 1718105000000 };
      writeGpuDisabledFlagFile(tmpDir, data);
      expect(readGpuDisabledFlagData(tmpDir)).toEqual(data);
    });

    it("reads a legacy timestamp-only flag file", () => {
      fs.writeFileSync(path.join(tmpDir, GPU_DISABLED_FLAG_FILENAME), "1718105000000", "utf8");
      expect(readGpuDisabledFlagData(tmpDir)).toEqual({
        reason: "crash",
        version: LEGACY_GPU_FLAG_VERSION,
        timestamp: 1718105000000,
      });
    });
  });

  describe("shouldRetryGpuAfterUpdate", () => {
    it("returns false when no flag exists", () => {
      expect(shouldRetryGpuAfterUpdate(null, "2.0.0")).toBe(false);
    });

    it("retries a crash flag written by a different app version", () => {
      expect(
        shouldRetryGpuAfterUpdate({ reason: "crash", version: "1.0.0", timestamp: 1 }, "2.0.0")
      ).toBe(true);
    });

    it("does not retry a crash flag written by the current version", () => {
      expect(
        shouldRetryGpuAfterUpdate({ reason: "crash", version: "2.0.0", timestamp: 1 }, "2.0.0")
      ).toBe(false);
    });

    it("never retries a user-written flag, even across versions", () => {
      expect(
        shouldRetryGpuAfterUpdate({ reason: "user", version: "1.0.0", timestamp: 1 }, "2.0.0")
      ).toBe(false);
    });

    it("retries legacy flags after any update (legacy version never matches)", () => {
      const legacy = parseGpuDisabledFlag("1718105000000");
      expect(shouldRetryGpuAfterUpdate(legacy, "2.0.0")).toBe(true);
    });
  });
});

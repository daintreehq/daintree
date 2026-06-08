import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const copyMock = vi.hoisted(() => vi.fn());
const configCreateMock = vi.hoisted(() => vi.fn());

vi.mock("copytree", () => ({
  copy: copyMock,
  ConfigManager: {
    create: configCreateMock,
  },
}));

import { copyTreeService } from "../CopyTreeService.js";

describe("CopyTreeService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-copytree-service-"));
    vi.clearAllMocks();
    configCreateMock.mockResolvedValue(undefined);
    copyMock.mockResolvedValue({
      output: "<context />",
      manifest: [],
      stats: {
        totalFiles: 1,
        totalSize: 10,
        duration: 5,
      },
    });
  });

  afterEach(async () => {
    copyTreeService.cancelAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects non-absolute root paths", async () => {
    const result = await copyTreeService.generate("relative/path");

    expect(result.error).toContain("absolute path");
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("returns accessible-path error when root path does not exist", async () => {
    const missingPath = path.join(tempDir, "missing");

    const result = await copyTreeService.generate(missingPath);

    expect(result.error).toContain("does not exist or is not accessible");
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("maps validation errors into a stable user-facing error", async () => {
    const error = new Error("Bad include pattern");
    error.name = "ValidationError";
    copyMock.mockRejectedValue(error);

    const result = await copyTreeService.generate(tempDir);

    expect(result).toEqual(
      expect.objectContaining({
        error: "Validation Error: Bad include pattern",
      })
    );
  });

  it("cancels a specific in-flight operation by trace id", async () => {
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    copyMock.mockImplementation(
      (_rootPath: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          startedResolve?.();
          if (options.signal.aborted) {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
            return;
          }
          options.signal.addEventListener("abort", () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        })
    );

    const pending = copyTreeService.generate(tempDir, {}, undefined, "op-1");
    await started;
    const cancelled = copyTreeService.cancel("op-1");
    const result = await pending;

    expect(cancelled).toBe(true);
    expect(result.error).toBe("Context generation cancelled");
    expect(copyTreeService.cancel("op-1")).toBe(false);
  });

  it("cancels an in-flight testConfig operation by trace id", async () => {
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    copyMock.mockImplementation(
      (_rootPath: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          startedResolve?.();
          if (options.signal?.aborted) {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
            return;
          }
          options.signal?.addEventListener("abort", () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        })
    );

    const pending = copyTreeService.testConfig(tempDir, {}, "test-op-1");
    await started;
    const cancelled = copyTreeService.cancel("test-op-1");
    const result = await pending;

    expect(cancelled).toBe(true);
    expect(result.error).toBe("Context generation cancelled");
    expect(copyTreeService.cancel("test-op-1")).toBe(false);
  });

  it("cancelAll aborts in-flight testConfig operations", async () => {
    let resolveStarted: (() => void) | null = null;
    const startedAll = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    let startedCount = 0;
    copyMock.mockImplementation(
      (_rootPath: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          startedCount += 1;
          if (startedCount === 2) resolveStarted?.();
          options.signal?.addEventListener("abort", () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        })
    );

    const a = copyTreeService.testConfig(tempDir, {}, "test-op-a");
    const b = copyTreeService.testConfig(tempDir, {}, "test-op-b");

    await startedAll;
    copyTreeService.cancelAll();

    await expect(a).resolves.toEqual(
      expect.objectContaining({ error: "Context generation cancelled" })
    );
    await expect(b).resolves.toEqual(
      expect.objectContaining({ error: "Context generation cancelled" })
    );
  });

  it("cancelAll aborts all active operations", async () => {
    let startedCount = 0;
    let resolveStarted: (() => void) | null = null;
    const allStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    copyMock.mockImplementation(
      (_rootPath: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          startedCount += 1;
          if (startedCount === 2) {
            resolveStarted?.();
          }
          if (options.signal.aborted) {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
            return;
          }
          options.signal.addEventListener("abort", () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        })
    );

    const first = copyTreeService.generate(tempDir, {}, undefined, "op-a");
    const second = copyTreeService.generate(tempDir, {}, undefined, "op-b");

    await allStarted;
    copyTreeService.cancelAll();

    await expect(first).resolves.toEqual(
      expect.objectContaining({ error: "Context generation cancelled" })
    );
    await expect(second).resolves.toEqual(
      expect.objectContaining({ error: "Context generation cancelled" })
    );
  });

  describe("testConfig", () => {
    it("returns files populated from the SDK manifest", async () => {
      const manifest = [
        { path: "src/index.ts", size: 1024 },
        { path: "src/utils.ts", size: 512 },
        { path: "README.md", size: 256 },
      ];
      copyMock.mockResolvedValue({
        output: "",
        manifest,
        stats: {
          totalFiles: manifest.length,
          totalSize: manifest.reduce((sum, entry) => sum + entry.size, 0),
          duration: 5,
          dryRun: true,
        },
      });

      const result = await copyTreeService.testConfig(tempDir);

      expect(result.error).toBeUndefined();
      expect(result.files).toHaveLength(manifest.length);
      for (const [index, entry] of manifest.entries()) {
        expect(result.files?.[index]).toEqual({ path: entry.path, size: entry.size });
      }
    });

    it("maps stats onto includedFiles and includedSize", async () => {
      const stats = { totalFiles: 7, totalSize: 4096, duration: 5, dryRun: true };
      copyMock.mockResolvedValue({ output: "", manifest: [], stats });

      const result = await copyTreeService.testConfig(tempDir);

      expect(result.includedFiles).toBe(stats.totalFiles);
      expect(result.includedSize).toBe(stats.totalSize);
    });

    it("returns an empty files array when the manifest is empty", async () => {
      const result = await copyTreeService.testConfig(tempDir);

      expect(result.error).toBeUndefined();
      expect(result.files).toEqual([]);
    });

    it("returns an empty files array when the SDK omits the manifest", async () => {
      copyMock.mockResolvedValue({
        output: "",
        stats: { totalFiles: 0, totalSize: 0, duration: 5, dryRun: true },
      });

      const result = await copyTreeService.testConfig(tempDir);

      expect(result.error).toBeUndefined();
      expect(result.files).toEqual([]);
    });

    it("runs the SDK in dry-run mode", async () => {
      await copyTreeService.testConfig(tempDir);

      expect(copyMock).toHaveBeenCalledTimes(1);
      const sdkOptions = copyMock.mock.calls[0][1] as Record<string, unknown>;
      expect(sdkOptions.dryRun).toBe(true);
    });

    it("rejects non-absolute root paths without files", async () => {
      const result = await copyTreeService.testConfig("relative/path");

      expect(result.error).toContain("absolute path");
      expect(result.files).toBeUndefined();
      expect(copyMock).not.toHaveBeenCalled();
    });
  });

  it("omits config from sdkOptions when ConfigManager.create() fails", async () => {
    configCreateMock.mockRejectedValue(new Error("No config"));

    await copyTreeService.generate(tempDir);

    expect(copyMock).toHaveBeenCalledTimes(1);
    const sdkOptions = copyMock.mock.calls[0][1] as Record<string, unknown>;
    expect(sdkOptions).not.toHaveProperty("config");
    expect("config" in sdkOptions).toBe(false);
  });
});

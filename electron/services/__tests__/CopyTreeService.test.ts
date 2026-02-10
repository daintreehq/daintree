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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-copytree-service-"));
    vi.clearAllMocks();
    configCreateMock.mockResolvedValue(undefined);
    copyMock.mockResolvedValue({
      output: "<context />",
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
});

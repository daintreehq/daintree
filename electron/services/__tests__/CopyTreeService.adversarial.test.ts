import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { CopyOptions as SdkCopyOptions, ProgressEvent } from "copytree";

const copyMock = vi.hoisted(() => vi.fn());
const configCreateMock = vi.hoisted(() => vi.fn());

vi.mock("copytree", () => ({
  copy: copyMock,
  ConfigManager: { create: configCreateMock },
}));

import { copyTreeService } from "../CopyTreeService.js";

type CapturedOptions = SdkCopyOptions & { signal: AbortSignal };

describe("CopyTreeService adversarial", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-copytree-adv-"));
    vi.clearAllMocks();
    configCreateMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    copyTreeService.cancelAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("cancel called before the operation is registered no-ops and generate still completes", async () => {
    copyMock.mockResolvedValue({
      output: "<ok/>",
      stats: { totalFiles: 1, totalSize: 10, duration: 5 },
    });

    const pending = copyTreeService.generate(tempDir, {}, undefined, "op-early");
    const cancelled = copyTreeService.cancel("op-early");
    const result = await pending;

    expect(cancelled).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("<ok/>");
  });

  it("overlapping concurrent operations use independent signals", async () => {
    // Each generate() awaits fs.access + ConfigManager.create before it hits
    // copyMock, so the two mock invocations can arrive in either order under
    // parallel-run scheduling. Keying by the captured AbortSignal avoids
    // depending on call order.
    const pendingOps: Array<{
      options: CapturedOptions;
      resolve: (value: unknown) => void;
    }> = [];

    copyMock.mockImplementation((_root: string, options: CapturedOptions) => {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
        pendingOps.push({ options, resolve });
      });
    });

    const parent = copyTreeService.generate(tempDir, {}, undefined, "parent");
    const child = copyTreeService.generate(tempDir, {}, undefined, "child");

    await vi.waitFor(() => {
      expect(pendingOps.length).toBe(2);
    });

    copyTreeService.cancel("parent");

    // Exactly one op's signal should be aborted — the parent's.
    const aborted = pendingOps.filter((op) => op.options.signal.aborted);
    const surviving = pendingOps.filter((op) => !op.options.signal.aborted);
    expect(aborted).toHaveLength(1);
    expect(surviving).toHaveLength(1);

    surviving[0].resolve({
      output: "<ok/>",
      stats: { totalFiles: 1, totalSize: 10, duration: 5 },
    });

    const [p, c] = await Promise.all([parent, child]);
    expect(p.error).toBe("Context generation cancelled");
    expect(c.error).toBeUndefined();
    expect(c.content).toBe("<ok/>");
  });

  it("progress events arriving after cancel are suppressed", async () => {
    const progressCalls: string[] = [];
    const emitters: Array<(e: ProgressEvent) => void> = [];
    copyMock.mockImplementation(
      (_root: string, options: CapturedOptions & { onProgress?: (e: ProgressEvent) => void }) => {
        if (options.onProgress) emitters.push(options.onProgress);
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      }
    );

    const onProgress = (p: { stage: string }) => progressCalls.push(p.stage);
    const pending = copyTreeService.generate(tempDir, {}, onProgress, "op-p");

    await vi.waitFor(() => {
      expect(emitters.length).toBe(1);
    });

    emitters[0]({ stage: "before", percent: 10 } as ProgressEvent);
    copyTreeService.cancel("op-p");
    emitters[0]({ stage: "after", percent: 90 } as ProgressEvent);

    await pending;

    expect(progressCalls).toEqual(["before"]);
  });

  it("ENOENT error from copy is mapped to a stable CopyTree Error code", async () => {
    const err = new Error("missing file") as Error & { code?: string };
    err.code = "ENOENT";
    copyMock.mockRejectedValue(err);

    const result = await copyTreeService.generate(tempDir);

    expect(result.error).toBe("CopyTree Error [ENOENT]: missing file");
    expect(result.content).toBe("");
    expect(result.fileCount).toBe(0);
  });

  it("EACCES error from copy is mapped to a stable CopyTree Error code", async () => {
    const err = new Error("permission denied") as Error & { code?: string };
    err.code = "EACCES";
    copyMock.mockRejectedValue(err);

    const result = await copyTreeService.generate(tempDir);

    expect(result.error).toBe("CopyTree Error [EACCES]: permission denied");
  });

  it("non-Error thrown value is still wrapped into a CopyTree Error", async () => {
    copyMock.mockRejectedValue("unexpected string");

    const result = await copyTreeService.generate(tempDir);

    expect(result.error).toContain("CopyTree Error");
    expect(result.error).toContain("unexpected string");
  });

  it("activeOperations map is drained on success so future cancels return false", async () => {
    copyMock.mockResolvedValue({
      output: "<ok/>",
      stats: { totalFiles: 1, totalSize: 10, duration: 5 },
    });

    await copyTreeService.generate(tempDir, {}, undefined, "op-drain");

    expect(copyTreeService.cancel("op-drain")).toBe(false);
  });

  it("activeOperations map is drained on error so future cancels return false", async () => {
    copyMock.mockRejectedValue(new Error("boom"));

    await copyTreeService.generate(tempDir, {}, undefined, "op-err");

    expect(copyTreeService.cancel("op-err")).toBe(false);
  });
});

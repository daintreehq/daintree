import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

function mockCopytreeModule() {
  return {
    copy: vi.fn().mockResolvedValue({
      output: "<context />",
      stats: { totalFiles: 1, totalSize: 10, duration: 5 },
    }),
    ConfigManager: { create: vi.fn().mockResolvedValue({ isDefaultsLoaded: true }) },
  };
}

describe("CopyTreeService lazy copytree import", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-copytree-lazy-"));
  });

  afterEach(async () => {
    vi.doUnmock("copytree");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not evaluate copytree until first use", async () => {
    const factory = vi.fn(mockCopytreeModule);
    vi.doMock("copytree", factory);

    const { copyTreeService } = await import("../CopyTreeService.js");
    expect(factory).not.toHaveBeenCalled();

    const result = await copyTreeService.generate(tempDir);

    expect(result.error).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("evaluates copytree once across concurrent operations", async () => {
    const factory = vi.fn(mockCopytreeModule);
    vi.doMock("copytree", factory);

    const { copyTreeService } = await import("../CopyTreeService.js");

    const [first, second] = await Promise.all([
      copyTreeService.generate(tempDir),
      copyTreeService.testConfig(tempDir),
    ]);

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("returns a structured error when the copytree import fails", async () => {
    const factory = vi.fn(() => {
      throw new Error("module load failed");
    });
    vi.doMock("copytree", factory);

    const { copyTreeService } = await import("../CopyTreeService.js");

    const result = await copyTreeService.generate(tempDir, {}, undefined, "trace-import-fail");

    expect(result.content).toBe("");
    expect(result.fileCount).toBe(0);
    expect(result.error).toBe("Failed to generate context");
    expect(result.error).not.toContain("module load failed");
    expect(copyTreeService.cancel("trace-import-fail")).toBe(false);

    const retry = await copyTreeService.generate(tempDir);

    expect(retry.error).toBe("Failed to generate context");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("returns a structured testConfig error when the copytree import fails", async () => {
    vi.doMock("copytree", () => {
      throw new Error("module load failed");
    });

    const { copyTreeService } = await import("../CopyTreeService.js");

    const result = await copyTreeService.testConfig(tempDir, {}, "trace-test-config-fail");

    expect(result.includedFiles).toBe(0);
    expect(result.includedSize).toBe(0);
    expect(result.error).toBeTruthy();
    expect(copyTreeService.cancel("trace-test-config-fail")).toBe(false);
  });

  it("treats cancellation during the copytree import as cancelled", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const copyMock = vi.fn();
    vi.doMock("copytree", async () => {
      await gate;
      return {
        copy: copyMock,
        ConfigManager: { create: vi.fn().mockResolvedValue({ isDefaultsLoaded: true }) },
      };
    });

    const { copyTreeService } = await import("../CopyTreeService.js");

    const pending = copyTreeService.generate(tempDir, {}, undefined, "trace-cancel");
    await vi.waitFor(() => {
      expect(copyTreeService.cancel("trace-cancel")).toBe(true);
    });
    release();

    const result = await pending;

    expect(result.error).toBe("Context generation cancelled");
    expect(copyMock).not.toHaveBeenCalled();
  });
});

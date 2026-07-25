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

import { copyTreeService, _resetConfigCacheForTests } from "../CopyTreeService.js";

describe("CopyTreeService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-copytree-service-"));
    vi.clearAllMocks();
    // The defaults-only config is cached for the isolate's lifetime, so a test
    // that stubs a config failure would otherwise inherit a previous test's
    // successful load (or leak its own failure forward).
    _resetConfigCacheForTests();
    configCreateMock.mockResolvedValue({ isDefaultsLoaded: true });
    copyMock.mockResolvedValue({
      output: "<context />",
      outputFormatVersion: "copytree-xml@1",
      manifest: [],
      stats: {
        totalFiles: 1,
        totalSize: 10,
        duration: 5,
        estimatedOutputChars: 400,
        estimatedTokens: 100,
        noFilesMatched: false,
        excluded: { total: 0, byReason: {} },
      },
    });
  });

  function sdkOptions() {
    return copyMock.mock.calls[0][1] as Record<string, unknown>;
  }

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

    expect(result.error).toBe("Project path is unavailable");
    // The path itself is the user's filesystem layout and must not cross to the
    // renderer with the error.
    expect(result.error).not.toContain(missingPath);
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("maps validation errors into a stable user-facing error", async () => {
    const error = new Error("Bad include pattern");
    error.name = "ValidationError";
    copyMock.mockRejectedValue(error);

    const result = await copyTreeService.generate(tempDir);

    expect(result).toEqual(
      expect.objectContaining({
        error: "Context settings are invalid",
      })
    );
    expect(result.error).not.toContain("Bad include pattern");
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
        { path: "src/index.ts", size: 1024, outcome: "included" },
        { path: "src/utils.ts", size: 512, outcome: "included" },
        { path: "README.md", size: 256, outcome: "included" },
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

    it("keeps includedFiles and includedSize consistent with the previewed files", async () => {
      // stats.totalFiles counts everything the run processed, which in 0.16
      // includes outcomes that never reach the output, so the headline numbers
      // are derived from the same list the preview renders.
      copyMock.mockResolvedValue({
        output: "",
        manifest: [
          { path: "kept.ts", size: 1024, outcome: "included" },
          { path: "gone.mp4", size: 3072, outcome: "excluded:configExclude" },
        ],
        stats: { totalFiles: 7, totalSize: 4096, duration: 5, dryRun: true },
      });

      const result = await copyTreeService.testConfig(tempDir);

      expect(result.includedFiles).toBe(result.files?.length);
      expect(result.includedSize).toBe(result.files?.reduce((sum, file) => sum + file.size, 0));
      expect(result.includedFiles).toBe(1);
      expect(result.includedSize).toBe(1024);
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

  describe("configuration loading", () => {
    it("loads configuration without the user config directory", async () => {
      await copyTreeService.generate(tempDir);

      expect(configCreateMock).toHaveBeenCalledWith(expect.objectContaining({ userConfig: false }));
    });

    it("refuses to run when config fails, rather than generating without exclusions", async () => {
      configCreateMock.mockRejectedValue(new Error("No config"));

      const result = await copyTreeService.generate(tempDir);

      expect(copyMock).not.toHaveBeenCalled();
      expect(result.error).toBe("Context configuration couldn't be loaded");
      expect(result.content).toBe("");
    });

    it("fails the dry run closed when config cannot be loaded", async () => {
      configCreateMock.mockRejectedValue(new Error("No config"));

      const result = await copyTreeService.testConfig(tempDir);

      expect(copyMock).not.toHaveBeenCalled();
      expect(result.error).toBe("Context configuration couldn't be loaded");
      expect(result.includedFiles).toBe(0);
    });

    it.each([
      ["generate", () => copyTreeService.generate(tempDir)],
      ["testConfig", () => copyTreeService.testConfig(tempDir)],
    ])(
      "refuses to run %s when config resolved without the exclusion defaults",
      async (_name, run) => {
        // strict only throws when a source errors; an absent config directory
        // resolves successfully and empty, carrying no exclusion lists at all.
        configCreateMock.mockResolvedValue({ isDefaultsLoaded: false });

        const result = await run();

        expect(copyMock).not.toHaveBeenCalled();
        expect(result.error).toBe("Context configuration couldn't be loaded");
      }
    );

    it("proceeds when the defaults did load", async () => {
      configCreateMock.mockResolvedValue({ isDefaultsLoaded: true });

      const result = await copyTreeService.generate(tempDir);

      expect(copyMock).toHaveBeenCalledTimes(1);
      expect(result.error).toBeUndefined();
    });
  });

  describe("SDK option policy", () => {
    it("disables the per-file gate when the user set no max file size", async () => {
      await copyTreeService.generate(tempDir);

      expect(sdkOptions().sizeGate).toBe(false);
    });

    it("routes the user's max file size to the overridable gate, not the memory ceiling", async () => {
      await copyTreeService.generate(tempDir, { maxFileSize: 50_000 });

      const options = sdkOptions();
      expect(options.sizeGate).toBe(50_000);
      // maxFileSize is the SDK's memory ceiling and cannot be lifted by
      // `always`, so the user-facing limit must not be routed there.
      expect(options.maxFileSize).toBeUndefined();
    });

    it.each([0, -1])("treats a non-positive max file size (%i) as no gate", async (maxFileSize) => {
      await copyTreeService.generate(tempDir, { maxFileSize });

      expect(sdkOptions().sizeGate).toBe(false);
    });

    it("keeps redaction off so it cannot rewrite source handed to an agent", async () => {
      await copyTreeService.generate(tempDir);

      expect(sdkOptions().secretsGuard).toBe(false);
    });

    it("orders a modified-first run descending so budgets keep the newest files", async () => {
      await copyTreeService.generate(tempDir, { sort: "modified" });

      expect(sdkOptions()).toMatchObject({ sort: "modified", sortOrder: "desc" });
    });

    it("leaves sort order unset for non-modified strategies", async () => {
      await copyTreeService.generate(tempDir, { sort: "path" });

      expect(sdkOptions().sortOrder).toBeUndefined();
    });

    it("passes the remaining budgets through untouched", async () => {
      await copyTreeService.generate(tempDir, {
        maxTotalSize: 1234,
        maxFileCount: 7,
        charLimit: 99,
      });

      expect(sdkOptions()).toMatchObject({
        maxTotalSize: 1234,
        maxFileCount: 7,
        charLimit: 99,
      });
    });
  });

  describe("result mapping", () => {
    it("forwards budget estimates and the format version to the renderer", async () => {
      const result = await copyTreeService.generate(tempDir);

      expect(result.outputFormatVersion).toBe("copytree-xml@1");
      expect(result.stats).toMatchObject({
        estimatedTokens: 100,
        estimatedOutputChars: 400,
        noFilesMatched: false,
      });
    });

    it("drops excluded entries but keeps every outcome that reaches the output", async () => {
      // truncated / structure-only / binary-placeholder files all still occupy a
      // slot in the generated context, so the preview must count them.
      copyMock.mockResolvedValue({
        output: "",
        outputFormatVersion: null,
        manifest: [
          { path: "a.ts", size: 10, outcome: "included" },
          { path: "big.bin", size: 900, outcome: "excluded:sizeGate" },
          { path: "lock.json", size: 40, outcome: "structure-only" },
          { path: "logo.png", size: 60, outcome: "binary-placeholder" },
          { path: "long.md", size: 80, outcome: "truncated" },
          { path: "vendored.js", size: 500, outcome: "excluded:gitignore" },
        ],
        stats: {
          totalFiles: 6,
          totalSize: 1590,
          duration: 1,
          estimatedOutputChars: 0,
          estimatedTokens: 0,
          noFilesMatched: false,
          excluded: { total: 2, byReason: { sizeGate: 1, gitignore: 1 } },
        },
      });

      const result = await copyTreeService.testConfig(tempDir);

      expect(result.files?.map((file) => file.path)).toEqual([
        "a.ts",
        "lock.json",
        "logo.png",
        "long.md",
      ]);
      expect(result.includedFiles).toBe(4);
      expect(result.includedSize).toBe(190);
      expect(result.excluded).toEqual({ total: 2, byReason: { sizeGate: 1, gitignore: 1 } });
    });

    it("surfaces which budget truncated the run", async () => {
      copyMock.mockResolvedValue({
        output: "",
        outputFormatVersion: null,
        manifest: [],
        stats: {
          totalFiles: 0,
          totalSize: 0,
          duration: 1,
          estimatedOutputChars: 0,
          estimatedTokens: 0,
          noFilesMatched: false,
          excluded: { total: 3, byReason: { totalSizeBudget: 3 } },
          truncated: true,
          truncatedCount: 3,
          truncatedBy: "maxTotalSize",
        },
      });

      const result = await copyTreeService.testConfig(tempDir);

      expect(result).toMatchObject({
        truncated: true,
        truncatedCount: 3,
        truncatedBy: "maxTotalSize",
      });
    });

    it("does not fail a run that reported recoverable scan errors", async () => {
      copyMock.mockResolvedValue({
        output: "<context />",
        outputFormatVersion: "copytree-xml@1",
        manifest: [],
        stats: {
          totalFiles: 2,
          totalSize: 20,
          duration: 1,
          estimatedOutputChars: 0,
          estimatedTokens: 0,
          noFilesMatched: false,
          excluded: { total: 1, byReason: { unreadable: 1 } },
          scanErrors: ["EACCES: locked.txt"],
        },
      });

      const result = await copyTreeService.generate(tempDir);

      expect(result.error).toBeUndefined();
      expect(result.fileCount).toBe(2);
    });
  });

  describe("error message sanitization", () => {
    it.each([
      ["ERR_PATH_NOT_FOUND", "Project path is unavailable"],
      ["ERR_SCOPE_OUTSIDE_ROOT", "Selected paths must stay inside the project"],
      ["ERR_NO_FILES_MATCHED", "No files matched the current context settings"],
      ["ERR_CONFIG_INVALID", "Context configuration couldn't be loaded"],
    ])("maps %s to a static message", async (code, expected) => {
      copyMock.mockRejectedValue(
        Object.assign(new Error(`/Users/someone/secret/path exploded`), { code })
      );

      const result = await copyTreeService.generate(tempDir);

      expect(result.error).toBe(expected);
    });

    it("never leaks an unrecognized SDK message to the renderer", async () => {
      copyMock.mockRejectedValue(
        Object.assign(new Error("/Users/someone/private/repo is bad"), { code: "ERR_WAT" })
      );

      const result = await copyTreeService.generate(tempDir);

      expect(result.error).toBe("Failed to generate context");
      expect(result.error).not.toContain("/Users/someone");
    });
  });
});

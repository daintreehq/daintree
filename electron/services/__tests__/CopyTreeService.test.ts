import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { CopyOptions as SdkCopyOptions, ManifestOutcome, ProgressEvent } from "copytree";

const copyMock = vi.hoisted(() => vi.fn());
const copyStreamMock = vi.hoisted(() => vi.fn());
const configCreateMock = vi.hoisted(() => vi.fn());
const configSetMock = vi.hoisted(() => vi.fn());

vi.mock("copytree", () => ({
  copy: copyMock,
  copyStream: copyStreamMock,
  ConfigManager: {
    create: configCreateMock,
  },
}));

import { copyTreeService, _resetConfigCacheForTests } from "../CopyTreeService.js";
import { _resetBaseRealpathCacheForTests } from "../FileTreeService.js";

describe("CopyTreeService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-copytree-service-"));
    vi.clearAllMocks();
    // The defaults-only config is cached for the isolate's lifetime, so a test
    // that stubs a config failure would otherwise inherit a previous test's
    // successful load (or leak its own failure forward).
    _resetConfigCacheForTests();
    configCreateMock.mockResolvedValue({ isDefaultsLoaded: true, set: configSetMock });
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

    it("enables bounded parallel discovery on the shared SDK config", async () => {
      await copyTreeService.generate(tempDir);

      expect(configSetMock).toHaveBeenCalledWith("copytree.discovery.parallelEnabled", true);
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

    it("routes scoped paths to scope and patterns to filter, keeping them independent", async () => {
      await copyTreeService.generate(tempDir, {
        scopePaths: ["src/panels"],
        includePaths: ["**/*.ts"],
      });

      const options = sdkOptions();
      // Scope walks literal paths under the root ignore stack; filter is a
      // pattern match. Collapsing either into the other is the bug this guards.
      expect(options.scope).toEqual(["src/panels"]);
      expect(options.filter).toEqual(["**/*.ts"]);
    });

    it("leaves scope unset when no scoped paths were requested", async () => {
      await copyTreeService.generate(tempDir, { includePaths: ["src/**"] });

      expect(sdkOptions().scope).toBeUndefined();
    });

    it("treats an empty scope list as no scoping rather than an empty walk", async () => {
      // Unreachable through IPC — both option schemas reject an empty list —
      // but the service must not invent a scope of nothing if one slips past.
      await copyTreeService.generate(tempDir, { scopePaths: [] });

      expect(sdkOptions().scope).toBeUndefined();
    });

    it("never lifts the ignore rules a scope was meant to respect", async () => {
      await copyTreeService.generate(tempDir, { scopePaths: ["src"] });

      const options = sdkOptions();
      expect(options.scopeIgnoresIgnoreFiles).toBeFalsy();
      expect(options.scopeIgnoresConfigExcludes).toBeFalsy();
      expect(options.respectGitignore).toBe(true);
    });

    // #11750: the caller-facing opt-out, and the blast radius it must NOT widen.
    it("opens only the ignore-file escape when the caller asks for it", async () => {
      await copyTreeService.generate(tempDir, {
        scopePaths: ["docs"],
        scopeIgnoresIgnoreFiles: true,
      });

      const options = sdkOptions();
      expect(options.scopeIgnoresIgnoreFiles).toBe(true);
      // The companion escape lifts node_modules and the configured excludes. It
      // answers a different question and was never asked, so opting into one
      // must never drag in the other.
      expect(options.scopeIgnoresConfigExcludes).toBeFalsy();
      expect(options.respectGitignore).toBe(true);
    });

    it("leaves the selection out of always, so no other exclusion layer moves", async () => {
      await copyTreeService.generate(tempDir, {
        scopePaths: ["docs"],
        includePaths: ["docs/**"],
        exclude: ["**/*.secret"],
        scopeIgnoresIgnoreFiles: true,
      });

      const options = sdkOptions();
      // The rejected design promoted the selection into `always`, which globs
      // with `ignore: []` and then outranks `exclude` in ProfileFilterStage —
      // silently resurrecting files the caller (or the project's settings)
      // explicitly excluded. The selection has to stay in `filter` alone.
      expect(options.always).toBeUndefined();
      expect(options.filter).toEqual(["docs/**", "docs/**/.*", "docs/**/.*/**"]);
      expect(options.exclude).toEqual(["**/*.secret"]);
    });

    it("lets a selection reach the dotfiles its own globs name", async () => {
      await copyTreeService.generate(tempDir, { includePaths: ["docs/**"] });

      const options = sdkOptions();
      expect(options.includeHidden).toBe(true);
      // Widening what the walk sees must not loosen the ignore stack with it —
      // a gitignored `.env` stays out either way.
      expect(options.respectGitignore).toBe(true);
    });

    it("keeps the SDK's hidden-file default for an unfiltered whole-project copy", async () => {
      await copyTreeService.generate(tempDir);

      expect(sdkOptions().includeHidden).toBeFalsy();
    });

    it.each([
      ["omitted", undefined],
      ["explicitly false", false],
      // Only the exact boolean opens it: the field crosses IPC from an MCP
      // caller, so a truthy read here would let a stray string through.
      ["a truthy non-boolean", "yes"],
    ])("keeps the escape shut when the flag is %s", async (_label, value) => {
      await copyTreeService.generate(tempDir, {
        scopePaths: ["docs"],
        ...(value === undefined ? {} : { scopeIgnoresIgnoreFiles: value as boolean }),
      });

      expect(sdkOptions().scopeIgnoresIgnoreFiles).toBe(false);
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

    // #11731: `noFilesMatched: true` alone left a caller that had passed a bare
    // directory to `includePaths` with nothing to correct, so it guessed at the
    // option shape for 13 rounds. The blame is derived rather than reported by
    // the SDK: `filterPattern` counts files the walker produced and the include
    // patterns then rejected, so a non-zero count on an empty run proves the
    // patterns emptied it. The real-SDK direction of that claim is pinned in
    // CopyTreeService.sdk-contract.test.ts; these rows pin the mapping.
    describe("blaming a selector for an empty run", () => {
      function mockEmptyRun(byReason: Record<string, number>) {
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
            noFilesMatched: true,
            excluded: {
              total: Object.values(byReason).reduce((sum, count) => sum + count, 0),
              byReason,
            },
          },
        });
      }

      // Named the way the CALLER spelled it. Both spellings collapse into one
      // SDK `filter` before it runs, so telling a caller that only ever sent
      // `includePaths` that its `filter` missed would name a field it never set.
      it.each([
        { supplied: { includePaths: ["src/panels"] }, expected: "includePaths" },
        { supplied: { filter: "src/panels" }, expected: "filter" },
        { supplied: { filter: ["src/panels"] }, expected: "filter" },
        // A scalar filter is wrapped into a one-entry list by
        // `mergeSelectionPatterns`, so even a blank one is a real, unmatchable
        // pattern the SDK enforces. Counting it as absent here would leave the
        // caller whose selection emptied the run with nothing to correct — the
        // very thing this field exists to prevent.
        { supplied: { filter: "" }, expected: "filter" },
        {
          supplied: { includePaths: ["src/panels"], filter: "docs" },
          expected: "filterAndIncludePaths",
        },
      ])("names $expected when that is what was supplied", async ({ supplied, expected }) => {
        mockEmptyRun({ filterPattern: 4 });

        const result = await copyTreeService.testConfig(tempDir, supplied);

        expect(result.noFilesMatched).toBe(true);
        expect(result.unmatchedSelector).toBe(expected);
      });

      it("stays quiet when the patterns never got the chance to reject anything", async () => {
        // Zero `filterPattern` means nothing survived the walk to reach the
        // pattern check — an empty scope, an empty repo, a `modified` run with
        // no changes. Blaming the patterns there would send a caller to rewrite
        // the one part of its request that was fine.
        mockEmptyRun({ scopeFilter: 2 });

        const result = await copyTreeService.testConfig(tempDir, {
          includePaths: ["src/**"],
          scopePaths: ["empty"],
        });

        expect(result.noFilesMatched).toBe(true);
        expect(result.unmatchedSelector).toBeUndefined();
      });

      it("stays quiet on a successful narrow selection, where the count is normal", async () => {
        // Every file outside a narrow selection is booked as `filterPattern`, so
        // the count alone flags healthy runs. `noFilesMatched` is the other half
        // of the gate for exactly this row.
        copyMock.mockResolvedValue({
          output: "",
          outputFormatVersion: null,
          manifest: [{ path: "a.ts", size: 10, outcome: "included" }],
          stats: {
            totalFiles: 1,
            totalSize: 10,
            duration: 1,
            estimatedOutputChars: 0,
            estimatedTokens: 0,
            noFilesMatched: false,
            excluded: { total: 9, byReason: { filterPattern: 9 } },
          },
        });

        const result = await copyTreeService.testConfig(tempDir, { includePaths: ["a.ts"] });

        expect(result.unmatchedSelector).toBeUndefined();
      });

      // `noFilesMatched` is measured after the WHOLE pipeline, so a decoy that
      // failed the patterns and a real match that a later stage then dropped
      // satisfy both halves of the old gate while the patterns did their job.
      // Each reason here belongs to a stage that runs after the pattern check.
      it.each(["sizeGate", "gitFilter", "charBudget", "duplicate", "fileCountBudget"])(
        "stays quiet when %s removed a file that had already passed the patterns",
        async (reason) => {
          mockEmptyRun({ filterPattern: 4, [reason]: 1 });

          const result = await copyTreeService.testConfig(tempDir, {
            includePaths: ["src/panels/**"],
          });

          expect(result.noFilesMatched).toBe(true);
          expect(result.unmatchedSelector).toBeUndefined();
        }
      );

      it("stays quiet on a reason it has never heard of", async () => {
        // A future SDK stage books an exclusion under a new key. Unknown has to
        // mean "ran after the patterns" — going silent costs a caller one
        // diagnostic, blaming the wrong field costs it the retry loop.
        mockEmptyRun({ filterPattern: 4, someFutureStage: 1 });

        const result = await copyTreeService.testConfig(tempDir, { includePaths: ["src/**"] });

        expect(result.unmatchedSelector).toBeUndefined();
      });

      it.each([
        "gitignore",
        "copytreeignore",
        "globalGitignore",
        "gitInfoExclude",
        "configExclude",
        // `exclude` is a walker ignore layer, not a later stage — and the IPC
        // handler injects a project's excludedPaths/alwaysExclude into it, so
        // suppressing here would silence the hint on configured repositories.
        "optionExclude",
        "scopeFilter",
        "testExclude",
        "unreadable",
        "symlinkEscape",
      ])(
        "still blames the patterns when the only company is %s, pruned on the way in",
        async (reason) => {
          // These are booked by the walker before a file ever reaches the
          // pattern check, so they say nothing about whether the patterns
          // matched. Suppressing on them would silence the hint on any real
          // repository, where a .gitignore is a given.
          mockEmptyRun({ filterPattern: 4, [reason]: 12 });

          const result = await copyTreeService.testConfig(tempDir, {
            includePaths: ["src/panels"],
          });

          expect(result.unmatchedSelector).toBe("includePaths");
        }
      );

      it("stays quiet when a budget truncated the run without booking a reason", async () => {
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
            noFilesMatched: true,
            excluded: { total: 4, byReason: { filterPattern: 4 } },
            truncated: true,
            truncatedCount: 1,
            truncatedBy: "charLimit",
          },
        });

        const result = await copyTreeService.testConfig(tempDir, { includePaths: ["a.ts"] });

        expect(result.unmatchedSelector).toBeUndefined();
      });

      it("stays quiet when no selector was supplied at all", async () => {
        // A whole-worktree copy of an empty directory has nothing to blame.
        mockEmptyRun({ filterPattern: 3 });

        const result = await copyTreeService.testConfig(tempDir);

        expect(result.noFilesMatched).toBe(true);
        expect(result.unmatchedSelector).toBeUndefined();
      });

      it("reaches the generated bundle, not just the dry run", async () => {
        mockEmptyRun({ filterPattern: 4 });

        const result = await copyTreeService.generate(tempDir, { includePaths: ["src/panels"] });

        expect(result.stats?.unmatchedSelector).toBe("includePaths");
      });
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

type CapturedOptions = SdkCopyOptions & { signal: AbortSignal };

describe("CopyTreeService adversarial", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-copytree-adv-"));
    vi.clearAllMocks();
    // The defaults-only config is cached for the isolate's lifetime, so a test
    // that stubs a config failure would otherwise inherit a previous test's
    // successful load (or leak its own failure forward).
    _resetConfigCacheForTests();
    configCreateMock.mockResolvedValue({ isDefaultsLoaded: true, set: vi.fn() });
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

    emitters[0]({ stage: "discover", percent: 10, message: "Discovering" });
    copyTreeService.cancel("op-p");
    emitters[0]({ stage: "format", percent: 90, message: "Formatting" });

    await pending;

    expect(progressCalls).toEqual(["discover"]);
  });

  it("ENOENT error from copy is mapped to a stable user-facing message", async () => {
    const err = new Error("missing file") as Error & { code?: string };
    err.code = "ENOENT";
    copyMock.mockRejectedValue(err);

    const result = await copyTreeService.generate(tempDir);

    expect(result.error).toBe("Project path is unavailable");
    expect(result.content).toBe("");
    expect(result.fileCount).toBe(0);
  });

  it("EACCES error from copy is mapped to a stable user-facing message", async () => {
    const err = new Error("permission denied") as Error & { code?: string };
    err.code = "EACCES";
    copyMock.mockRejectedValue(err);

    const result = await copyTreeService.generate(tempDir);

    expect(result.error).toBe("Can't read the project files");
  });

  it("non-Error thrown value does not reach the renderer verbatim", async () => {
    copyMock.mockRejectedValue("unexpected string");

    const result = await copyTreeService.generate(tempDir);

    expect(result.error).toBe("Failed to generate context");
    expect(result.error).not.toContain("unexpected string");
  });

  it("activeOperations map is drained on success so future cancels return false", async () => {
    copyMock.mockResolvedValue({
      output: "<ok/>",
      stats: { totalFiles: 1, totalSize: 10, duration: 5 },
    });

    await copyTreeService.generate(tempDir, {}, undefined, "op-drain");

    expect(copyTreeService.cancel("op-drain")).toBe(false);
  });

  it("cancelling a testConfig op leaves a concurrent generate untouched", async () => {
    const pending: Array<{
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
        pending.push({ options, resolve });
      });
    });

    const generation = copyTreeService.generate(tempDir, {}, undefined, "gen-op");
    const probe = copyTreeService.testConfig(tempDir, {}, "probe-op");

    await vi.waitFor(() => {
      expect(pending.length).toBe(2);
    });

    copyTreeService.cancel("probe-op");

    const aborted = pending.filter((op) => op.options.signal.aborted);
    const surviving = pending.filter((op) => !op.options.signal.aborted);
    expect(aborted).toHaveLength(1);
    expect(surviving).toHaveLength(1);

    surviving[0].resolve({
      output: "<ok/>",
      stats: { totalFiles: 3, totalSize: 30, duration: 5 },
    });

    const [genResult, probeResult] = await Promise.all([generation, probe]);
    expect(probeResult.error).toBe("Context generation cancelled");
    expect(genResult.error).toBeUndefined();
    expect(genResult.fileCount).toBe(3);
  });
});

const STATS = {
  totalFiles: 3,
  totalSize: 4096,
  duration: 12,
  estimatedOutputChars: 400,
  estimatedTokens: 100,
  noFilesMatched: false,
  excluded: { total: 0, byReason: {} },
};

type StreamOptions = {
  signal?: AbortSignal;
  onComplete?: (result: {
    outputFormatVersion: string | null;
    manifest: unknown[];
    stats: typeof STATS;
  }) => void;
};

/**
 * Stand in for the SDK generator: yield the given chunks, then report
 * completion exactly as `copyStream` does — only on a run that finished.
 */
function streamYielding(
  chunks: string[],
  options: { complete?: boolean; stats?: typeof STATS } = {}
) {
  return (_rootPath: string, streamOptions: StreamOptions) =>
    (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
      if (options.complete !== false) {
        streamOptions.onComplete?.({
          outputFormatVersion: "copytree-xml@1",
          manifest: [],
          stats: options.stats ?? STATS,
        });
      }
    })();
}

describe("CopyTreeService streaming to a file", () => {
  let tempDir: string;
  let outputPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-copytree-stream-"));
    outputPath = path.join(tempDir, "bundle.xml");
    vi.clearAllMocks();
    _resetConfigCacheForTests();
    configCreateMock.mockResolvedValue({ isDefaultsLoaded: true, set: vi.fn() });
  });

  afterEach(async () => {
    copyTreeService.cancelAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Files this run left in the output directory, so leftovers are visible. */
  async function residue(): Promise<string[]> {
    return (await fs.readdir(tempDir)).sort();
  }

  it("streams the whole document to the file and keeps it out of the result", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files>", "<file/>", "</files>"]));

    const result = await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(result.error).toBeUndefined();
    expect(result.filePath).toBe(outputPath);
    // The point of the change: the bundle went to disk, not into the result.
    expect(result.content).toBe("");
    expect(await fs.readFile(outputPath, "utf8")).toBe("<files><file/></files>");
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("reports the byte size the file actually has", async () => {
    // Multi-byte on purpose: a character count would disagree with the file.
    copyStreamMock.mockImplementation(streamYielding(["héllo ", "☃", "😀"]));

    const result = await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(result.outputBytes).toBe((await fs.stat(outputPath)).size);
    expect(await fs.readFile(outputPath, "utf8")).toBe("héllo ☃😀");
  });

  it("carries the completion stats through unchanged", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    const result = await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(result.fileCount).toBe(STATS.totalFiles);
    expect(result.outputFormatVersion).toBe("copytree-xml@1");
    expect(result.stats).toMatchObject({
      totalSize: STATS.totalSize,
      duration: STATS.duration,
      estimatedTokens: STATS.estimatedTokens,
    });
  });

  // This is the branch production actually takes: the IPC handler passes an
  // output path, so `copyTree.generate` and `copyTree.generateAndCopyFile` both
  // land here rather than in the buffered `copy()` path. A selector captured in
  // `generate()` and not threaded this far would leave two of the three
  // advertised MCP actions without the hint (#11731).
  it("attributes an empty streamed bundle to the selector that emptied it", async () => {
    copyStreamMock.mockImplementation(
      streamYielding(["<files/>"], {
        stats: {
          ...STATS,
          totalFiles: 0,
          noFilesMatched: true,
          excluded: { total: 4, byReason: { filterPattern: 4 } },
        },
      })
    );

    const result = await copyTreeService.generate(
      tempDir,
      { includePaths: ["src/panels"], filter: "docs" },
      undefined,
      "op-1",
      outputPath
    );

    // Both spellings were supplied and neither can be singled out once they are
    // unioned, so the pair is what the caller gets.
    expect(result.stats?.unmatchedSelector).toBe("filterAndIncludePaths");
  });

  it("leaves a streamed bundle that found files unattributed", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    const result = await copyTreeService.generate(
      tempDir,
      { includePaths: ["src/**"] },
      undefined,
      "op-1",
      outputPath
    );

    expect(result.stats?.unmatchedSelector).toBeUndefined();
  });

  it("publishes atomically, leaving no partial behind", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(await residue()).toEqual(["bundle.xml"]);
  });

  it("writes the bundle owner-only", async () => {
    if (process.platform === "win32") return;
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it("leaves nothing on disk when the source fails midway", async () => {
    copyStreamMock.mockImplementation(() =>
      (async function* () {
        yield "<files>";
        throw new Error("scan blew up");
      })()
    );

    const result = await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(result.error).toBe("Failed to generate context");
    // Neither the destination nor the partial survives — a caller that finds
    // the final path must never find a prefix of a bundle.
    expect(await residue()).toEqual([]);
  });

  it("refuses to publish a run that never reported completion", async () => {
    // `onComplete` fires only on normal completion, so its absence means the
    // source stopped early and the bytes on disk are a prefix.
    copyStreamMock.mockImplementation(
      streamYielding(["<files>", "truncated"], { complete: false })
    );

    const result = await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(result.error).toBe("Context generation ended before it finished");
    expect(await residue()).toEqual([]);
  });

  it("cleans up both files when the run is cancelled mid-stream", async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let markStarted: () => void = () => {};
    // Resolved from inside the generator: by then the operation is registered
    // and the first chunk is on its way to the writer, which is the only point
    // at which a cancel is actually testing mid-stream teardown.
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    copyStreamMock.mockImplementation((_rootPath: string, streamOptions: StreamOptions) =>
      (async function* () {
        yield "<files>";
        markStarted();
        await gate;
        if (streamOptions.signal?.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        yield "</files>";
      })()
    );

    const pending = copyTreeService.generate(tempDir, {}, undefined, "op-cancel", outputPath);
    await started;
    expect(copyTreeService.cancel("op-cancel")).toBe(true);
    releaseGate();

    const result = await pending;

    expect(result.error).toBe("Context generation cancelled");
    expect(await residue()).toEqual([]);
  });

  it("does not touch the file when no output path is given", async () => {
    copyMock.mockResolvedValue({
      output: "<context />",
      outputFormatVersion: "copytree-xml@1",
      manifest: [],
      stats: STATS,
    });

    const result = await copyTreeService.generate(tempDir);

    expect(result.content).toBe("<context />");
    expect(result.filePath).toBeUndefined();
    expect(result.outputBytes).toBeUndefined();
    expect(copyStreamMock).not.toHaveBeenCalled();
  });

  it("hands the streamed run the same options the copy() run would get", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    await copyTreeService.generate(
      tempDir,
      { format: "markdown", charLimit: 1000, maxFileCount: 5 },
      undefined,
      "op-1",
      outputPath
    );

    const streamOptions = copyStreamMock.mock.calls[0][1];
    expect(streamOptions).toMatchObject({
      format: "markdown",
      charLimit: 1000,
      maxFileCount: 5,
      respectGitignore: true,
      secretsGuard: false,
    });
    // Cancellation still has to reach the SDK, not just the pipeline.
    expect(streamOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("names the output file as the problem when the destination can't be created", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    const result = await copyTreeService.generate(
      tempDir,
      {},
      undefined,
      "op-1",
      path.join(tempDir, "missing-dir", "bundle.xml")
    );

    // The raw ENOENT would map to "Project path is unavailable", which points
    // at the project being read rather than the file being written.
    expect(result.error).toBe("Can't write the context file");
    expect(result.filePath).toBeUndefined();
    // Nothing was generated, so the SDK should never have been started.
    expect(copyStreamMock).not.toHaveBeenCalled();
  });
});

/**
 * The context listing composes a raw directory read with the verdict of a
 * CopyTree dry run. These tests own that composition: the raw side is a real
 * temp directory, the SDK side is a stubbed manifest, and the assertions are
 * about which entries survive and why.
 */
describe("CopyTreeService.getFileTree", () => {
  let tempDir: string;

  function manifest(entries: Array<[path: string, outcome?: ManifestOutcome]>) {
    return entries.map(([entryPath, outcome]) => ({
      path: entryPath,
      size: 1,
      outcome: outcome ?? ("included" as ManifestOutcome),
    }));
  }

  function dryRunResult(manifestEntries: ReturnType<typeof manifest>) {
    return {
      output: "",
      outputFormatVersion: "copytree-xml@1",
      manifest: manifestEntries,
      stats: {
        totalFiles: manifestEntries.length,
        totalSize: 0,
        duration: 1,
        estimatedOutputChars: 0,
        estimatedTokens: 0,
        noFilesMatched: manifestEntries.length === 0,
        excluded: { total: 0, byReason: {} },
      },
    };
  }

  /** See the note in `FileTreeService.test.ts`: skip, never silently return. */
  async function symlinkOrSkip(
    ctx: { skip: () => void },
    target: string,
    linkPath: string,
    type?: "file" | "dir"
  ): Promise<void> {
    try {
      await fs.symlink(target, linkPath, type);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") ctx.skip();
      throw error;
    }
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-context-tree-"));
    vi.clearAllMocks();
    _resetConfigCacheForTests();
    _resetBaseRealpathCacheForTests();
    configCreateMock.mockResolvedValue({ isDefaultsLoaded: true, set: vi.fn() });
    copyMock.mockResolvedValue(dryRunResult([]));
  });

  afterEach(async () => {
    copyTreeService.cancelAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function sdkOptions() {
    return copyMock.mock.calls[0][1] as Record<string, unknown>;
  }

  it("keeps every outcome that still reaches the output", async () => {
    // A truncated file, a structure-only lock file and a binary placeholder all
    // occupy a slot in the generated context, so all of them belong in a
    // listing of what the context contains. Only `excluded:*` does not.
    await fs.writeFile(path.join(tempDir, "a.ts"), "");
    await fs.writeFile(path.join(tempDir, "b.lock"), "");
    await fs.writeFile(path.join(tempDir, "c.png"), "");
    await fs.writeFile(path.join(tempDir, "d.md"), "");
    copyMock.mockResolvedValue(
      dryRunResult(
        manifest([
          ["a.ts", "included"],
          ["b.lock", "structure-only"],
          ["c.png", "binary-placeholder"],
          ["d.md", "truncated"],
        ])
      )
    );

    const nodes = await copyTreeService.getFileTree(tempDir);

    expect(nodes.map((node) => node.name)).toEqual(["a.ts", "b.lock", "c.png", "d.md"]);
  });

  it("routes a symlink by the kind the raw listing reports (#11939)", async (ctx) => {
    // The verdict overlay branches on `isDirectory` to choose between the
    // manifest's file set and the derived populated-directory set. Now that
    // the raw listing surfaces symlinks — reporting the TARGET's kind — a link
    // to a file has to be looked up as a file and a link to a directory as a
    // directory, or each would be judged against the wrong set and vanish.
    await fs.mkdir(path.join(tempDir, "real"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "real", "inner.ts"), "");
    await fs.writeFile(path.join(tempDir, "app.ts"), "");
    await symlinkOrSkip(ctx, path.join(tempDir, "app.ts"), path.join(tempDir, "app-link.ts"));
    await symlinkOrSkip(ctx, path.join(tempDir, "real"), path.join(tempDir, "dir-link"), "dir");
    // What the SDK walker would report having followed both links.
    copyMock.mockResolvedValue(
      dryRunResult(
        manifest([["app.ts"], ["app-link.ts"], ["dir-link/inner.ts"], ["real/inner.ts"]])
      )
    );

    const nodes = await copyTreeService.getFileTree(tempDir);

    expect(nodes.map((node) => node.name)).toEqual(["dir-link", "real", "app-link.ts", "app.ts"]);
  });

  it("drops a symlink the dry run excluded, exactly like any other entry", async (ctx) => {
    // CopyTree owns the bundling policy — `symlinkEscape` is one of its own
    // exclusion reasons. The picker preview must inherit that verdict rather
    // than acquire an opinion of its own now that links are listed.
    //
    // Asserted through `includeExcluded` rather than by absence: a plain
    // `["app.ts"]` expectation would hold just as well if the listing
    // regressed to hiding every symlink, which is the bug this PR fixes.
    await fs.writeFile(path.join(tempDir, "app.ts"), "");
    await symlinkOrSkip(ctx, path.join(tempDir, "app.ts"), path.join(tempDir, "escaping.ts"));
    copyMock.mockResolvedValue(dryRunResult(manifest([["app.ts"]])));

    const withExcluded = await copyTreeService.getFileTree(
      tempDir,
      "",
      {},
      { includeExcluded: true }
    );
    expect(withExcluded.map((node) => [node.name, node.excluded ?? false])).toEqual([
      ["app.ts", false],
      ["escaping.ts", true],
    ]);

    // ...and the default listing, which the picker uses, omits it entirely.
    const nodes = await copyTreeService.getFileTree(tempDir);
    expect(nodes.map((node) => node.name)).toEqual(["app.ts"]);
  });

  it("hides a file the dry run never recorded", async () => {
    // CopyTree's manifest lists only what survived, so an excluded path has no
    // entry at all. Absence is the exclusion signal, and it covers every layer
    // — ignore files, config excludes, binary classification, the size gate,
    // the budgets — without this code enumerating any of them.
    await fs.writeFile(path.join(tempDir, "kept.ts"), "");
    await fs.writeFile(path.join(tempDir, "ignored.log"), "");
    copyMock.mockResolvedValue(dryRunResult(manifest([["kept.ts"]])));

    const nodes = await copyTreeService.getFileTree(tempDir);

    expect(nodes.map((node) => node.name)).toEqual(["kept.ts"]);
  });

  it("hides a file whose entry carries an excluded outcome", async () => {
    // Belt and braces: 0.16 drops excluded paths from the manifest rather than
    // recording them, but the outcome type still admits `excluded:*` and a
    // future version reporting them must not flip them to visible.
    await fs.writeFile(path.join(tempDir, "kept.ts"), "");
    await fs.writeFile(path.join(tempDir, "big.ts"), "");
    copyMock.mockResolvedValue(
      dryRunResult(
        manifest([
          ["kept.ts", "included"],
          ["big.ts", "excluded:sizeGate"],
        ])
      )
    );

    const nodes = await copyTreeService.getFileTree(tempDir);

    expect(nodes.map((node) => node.name)).toEqual(["kept.ts"]);
  });

  it("returns excluded entries flagged when the caller opts in", async () => {
    await fs.writeFile(path.join(tempDir, "kept.ts"), "");
    await fs.writeFile(path.join(tempDir, "ignored.log"), "");
    copyMock.mockResolvedValue(dryRunResult(manifest([["kept.ts"]])));

    const nodes = await copyTreeService.getFileTree(tempDir, "", {}, { includeExcluded: true });

    expect(nodes.map((node) => ({ name: node.name, excluded: node.excluded }))).toEqual([
      { name: "ignored.log", excluded: true },
      { name: "kept.ts", excluded: undefined },
    ]);
  });

  it("keeps a directory that has an includable descendant at any depth", async () => {
    await fs.mkdir(path.join(tempDir, "src", "deep", "deeper"), { recursive: true });
    copyMock.mockResolvedValue(dryRunResult(manifest([["src/deep/deeper/c.ts"]])));

    const nodes = await copyTreeService.getFileTree(tempDir);

    expect(nodes.map((node) => node.name)).toEqual(["src"]);
  });

  it("hides a directory whose every file is excluded", async () => {
    // It would expand into nothing, which is its own flavour of the
    // picker/output disagreement this listing exists to remove.
    await fs.mkdir(path.join(tempDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "logs", "run.log"), "");
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src", "a.ts"), "");
    copyMock.mockResolvedValue(dryRunResult(manifest([["src/a.ts"]])));

    const nodes = await copyTreeService.getFileTree(tempDir);

    expect(nodes.map((node) => node.name)).toEqual(["src"]);
  });

  it("hides a pruned directory that produced no manifest entries", async () => {
    // CopyTree does not descend into a directory it has pruned, so `.git` and
    // `node_modules` are simply absent from the manifest — no special-casing
    // here, unlike the raw listing which returns them.
    await fs.mkdir(path.join(tempDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "node_modules", "pkg", "index.js"), "");
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "a.ts"), "");
    copyMock.mockResolvedValue(dryRunResult(manifest([["a.ts"]])));

    const nodes = await copyTreeService.getFileTree(tempDir);

    expect(nodes.map((node) => node.name)).toEqual(["a.ts"]);
  });

  it("does not treat a path-prefix sibling as an ancestor", async () => {
    // `src2/deep/a.ts` must not make `src` look populated. Ancestors are matched
    // by exact set membership for this reason — a `startsWith` check here would
    // surface an excluded directory because a differently-named sibling shares
    // its prefix.
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src", "ignored.log"), "");
    await fs.mkdir(path.join(tempDir, "src2", "deep"), { recursive: true });
    copyMock.mockResolvedValue(dryRunResult(manifest([["src2/deep/a.ts"]])));

    const nodes = await copyTreeService.getFileTree(tempDir);

    expect(nodes.map((node) => node.name)).toEqual(["src2"]);
  });

  it("returns nothing when listing inside a directory the context excludes", async () => {
    // Expanding into `node_modules` is a legitimate request with an empty
    // answer: none of it reaches the context.
    await fs.mkdir(path.join(tempDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "node_modules", "pkg", "index.js"), "");
    copyMock.mockResolvedValue(dryRunResult(manifest([["a.ts"]])));

    await expect(copyTreeService.getFileTree(tempDir, "node_modules")).resolves.toEqual([]);
  });

  it("flags every child as excluded when listing inside an excluded directory under opt-in", async () => {
    await fs.mkdir(path.join(tempDir, "node_modules", "pkg"), { recursive: true });
    copyMock.mockResolvedValue(dryRunResult(manifest([["a.ts"]])));

    const nodes = await copyTreeService.getFileTree(
      tempDir,
      "node_modules",
      {},
      { includeExcluded: true }
    );

    // `mtimeMs` rides along like `size` does: the verdict is applied to the raw
    // FileTreeService nodes rather than to freshly built ones, so every field
    // that listing reads reaches this surface. Matched loosely because it is a
    // real filesystem timestamp.
    expect(nodes).toEqual([
      {
        name: "pkg",
        path: "node_modules/pkg",
        isDirectory: true,
        excluded: true,
        mtimeMs: expect.any(Number),
      },
    ]);
  });

  it("rejects a dirPath that names a file rather than a directory", async () => {
    await fs.writeFile(path.join(tempDir, "a.ts"), "");

    await expect(copyTreeService.getFileTree(tempDir, "a.ts")).rejects.toThrow(
      "Failed to read the project files"
    );
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("hides files by default when the manifest is empty but the directory is not", async () => {
    await fs.writeFile(path.join(tempDir, "a.ts"), "");
    await fs.mkdir(path.join(tempDir, "sub"), { recursive: true });
    copyMock.mockResolvedValue(dryRunResult([]));

    await expect(copyTreeService.getFileTree(tempDir)).resolves.toEqual([]);
  });

  it("flags an empty directory as excluded under opt-in without inventing a reason", async () => {
    await fs.mkdir(path.join(tempDir, "empty"), { recursive: true });
    copyMock.mockResolvedValue(dryRunResult([]));

    const nodes = await copyTreeService.getFileTree(tempDir, "", {}, { includeExcluded: true });

    expect(nodes).toEqual([
      {
        name: "empty",
        path: "empty",
        isDirectory: true,
        excluded: true,
        mtimeMs: expect.any(Number),
      },
    ]);
  });

  it("preserves the raw listing's directories-first ordering while filtering", async () => {
    await fs.mkdir(path.join(tempDir, "zeta"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "zeta", "in.ts"), "");
    await fs.writeFile(path.join(tempDir, "alpha.ts"), "");
    await fs.writeFile(path.join(tempDir, "dropped.ts"), "");
    copyMock.mockResolvedValue(dryRunResult(manifest([["zeta/in.ts"], ["alpha.ts"]])));

    const nodes = await copyTreeService.getFileTree(tempDir);

    expect(nodes.map((node) => node.name)).toEqual(["zeta", "alpha.ts"]);
  });

  it("lists a subdirectory relative to the worktree root", async () => {
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src", "a.ts"), "");
    await fs.writeFile(path.join(tempDir, "src", "a.log"), "");
    copyMock.mockResolvedValue(dryRunResult(manifest([["src/a.ts"]])));

    const nodes = await copyTreeService.getFileTree(tempDir, "src");

    expect(nodes).toEqual([
      { name: "a.ts", path: "src/a.ts", isDirectory: false, size: 0, mtimeMs: expect.any(Number) },
    ]);
  });

  it("scans the whole root rather than scoping to the listed directory", async () => {
    // `scope` would be far cheaper, but the global budgets (maxFileCount,
    // maxTotalSize, charLimit, plus CopyTree's own defaults) are applied to
    // whatever the traversal found. Scoping recomputes which files win the
    // budget from one subtree, so it would list a file the real run drops.
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });

    await copyTreeService.getFileTree(tempDir, "src");

    expect(copyMock.mock.calls[0][0]).toBe(tempDir);
    const options = sdkOptions();
    expect(options.scope).toBeUndefined();
    expect(options.maxDepth).toBeUndefined();
    expect(options.dryRun).toBe(true);
  });

  it("drops scoped paths a caller merged into the listing options", async () => {
    // A folder copy sets `scopePaths`; if those same merged options ever reach
    // the listing it must still walk the root, or the picker goes back to
    // predicting a different bundle than generation produces.
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });

    await copyTreeService.getFileTree(tempDir, "src", { scopePaths: ["src"] });

    expect(sdkOptions().scope).toBeUndefined();
  });

  it("selects files under exactly the options generation would use", async () => {
    // Comparing the two option objects — rather than spot-checking the
    // listing's — is what actually proves parity. If the listing built its
    // selection differently in any respect, the picker and the bundle would
    // disagree again, which is the whole bug (#11439).
    const options = {
      exclude: ["docs/**"],
      always: ["README.md"],
      maxFileSize: 1024,
      maxFileCount: 7,
      sort: "modified" as const,
    };

    await copyTreeService.getFileTree(tempDir, "", options);
    const listingOptions = copyMock.mock.calls[0][1] as Record<string, unknown>;

    copyMock.mockClear();
    await copyTreeService.generate(tempDir, options);
    const generateOptions = copyMock.mock.calls[0][1] as Record<string, unknown>;

    // Legitimately different: the listing plans instead of reading, reports no
    // progress, and each operation carries its own abort signal.
    const operational = new Set(["dryRun", "onProgress", "progressThrottleMs", "signal", "config"]);
    const selectionOf = (all: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(all).filter(([key]) => !operational.has(key)));

    expect(selectionOf(listingOptions)).toEqual(selectionOf(generateOptions));
    // And the mapping itself is right: the user-facing "max file size" is the
    // liftable per-file gate, not the SDK's memory ceiling.
    expect(listingOptions).toMatchObject({
      sizeGate: 1024,
      sort: "modified",
      sortOrder: "desc",
      respectGitignore: true,
    });
    expect(listingOptions.maxFileSize).toBeUndefined();
  });

  it("shares one config load across concurrent operations without cross-cancelling them", async () => {
    // The cache is a shared promise, so a cancel landing while another caller
    // awaits it must not take that caller down with it.
    let releaseConfig!: (value: {
      isDefaultsLoaded: boolean;
      set: (path: string, value: unknown) => void;
    }) => void;
    configCreateMock.mockReturnValue(
      new Promise<{
        isDefaultsLoaded: boolean;
        set: (path: string, value: unknown) => void;
      }>((resolve) => {
        releaseConfig = resolve;
      })
    );
    await fs.writeFile(path.join(tempDir, "a.ts"), "");
    copyMock.mockResolvedValue(dryRunResult(manifest([["a.ts"]])));

    const listing = copyTreeService.getFileTree(tempDir, "", {}, {}, "op-listing");
    const generation = copyTreeService.generate(tempDir, {}, undefined, "op-generate");
    // Both do real filesystem work before reaching the config, so wait for them
    // to arrive rather than counting microtasks. One call for two operations is
    // the property under test.
    await vi.waitFor(() => expect(configCreateMock).toHaveBeenCalledTimes(1));

    copyTreeService.cancel("op-listing");
    releaseConfig({ isDefaultsLoaded: true, set: vi.fn() });

    await expect(listing).rejects.toThrow("Context generation cancelled");
    // The survivor is unaffected: it got the shared config and ran to completion.
    expect((await generation).error).toBeUndefined();
    expect(copyMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-absolute root before scanning", async () => {
    await expect(copyTreeService.getFileTree("relative/path")).rejects.toThrow("absolute path");
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("rejects a traversing dirPath before scanning", async () => {
    // The raw listing owns the containment guards, and it runs first precisely
    // so an escape attempt never starts a repository-wide walk.
    await expect(copyTreeService.getFileTree(tempDir, "../outside")).rejects.toThrow();
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("fails closed when the configuration cannot be loaded", async () => {
    // Without the packaged config there are no exclusion lists, so a listing
    // would show everything. Refuse rather than leak.
    await fs.writeFile(path.join(tempDir, "secret.env"), "");
    configCreateMock.mockResolvedValue({ isDefaultsLoaded: false });

    await expect(copyTreeService.getFileTree(tempDir)).rejects.toThrow(
      "Context configuration couldn't be loaded"
    );
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("fails closed when the dry run returns no manifest", async () => {
    await fs.writeFile(path.join(tempDir, "secret.env"), "");
    copyMock.mockResolvedValue({ ...dryRunResult([]), manifest: undefined });

    await expect(copyTreeService.getFileTree(tempDir)).rejects.toThrow(
      "Failed to read the project files"
    );
  });

  it("fails closed when the dry run throws, without leaking the SDK message", async () => {
    const raw = `ENOENT: no such file, open '${path.join(tempDir, "vanished.ts")}'`;
    copyMock.mockRejectedValue(new Error(raw));

    await expect(copyTreeService.getFileTree(tempDir)).rejects.toThrow(
      "Failed to read the project files"
    );
    await expect(copyTreeService.getFileTree(tempDir)).rejects.not.toThrow(raw);
  });

  it("reports a cancel as a cancel and drains the operation", async () => {
    copyMock.mockImplementation(async () => {
      copyTreeService.cancelAll();
      return dryRunResult([]);
    });

    await expect(copyTreeService.getFileTree(tempDir, "", {}, {}, "op-1")).rejects.toThrow(
      "Context generation cancelled"
    );
    // A second cancel of the same id finds nothing left to abort.
    expect(copyTreeService.cancel("op-1")).toBe(false);
  });

  it("loads the configuration once across listings", async () => {
    // Loading parses every config file and compiles a JSON schema; a listing
    // runs per directory expansion, so paying that per call is pure waste.
    await copyTreeService.getFileTree(tempDir);
    await copyTreeService.getFileTree(tempDir);

    expect(configCreateMock).toHaveBeenCalledTimes(1);
  });

  it("retries the configuration after a failure instead of caching it", async () => {
    configCreateMock.mockRejectedValueOnce(new Error("disk hiccup"));

    await expect(copyTreeService.getFileTree(tempDir)).rejects.toThrow(
      "Context configuration couldn't be loaded"
    );

    configCreateMock.mockResolvedValue({ isDefaultsLoaded: true, set: vi.fn() });
    await expect(copyTreeService.getFileTree(tempDir)).resolves.toEqual([]);
    expect(configCreateMock).toHaveBeenCalledTimes(2);
  });
});

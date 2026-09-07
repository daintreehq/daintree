import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const copyMock = vi.hoisted(() => vi.fn());
const configCreateMock = vi.hoisted(() => vi.fn());
const configSetMock = vi.hoisted(() => vi.fn());

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

    it("proceeds when the defaults did load", async () => {
      configCreateMock.mockResolvedValue({ isDefaultsLoaded: true, set: configSetMock });

      const result = await copyTreeService.generate(tempDir);

      expect(copyMock).toHaveBeenCalledTimes(1);
      expect(result.error).toBeUndefined();
    });

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

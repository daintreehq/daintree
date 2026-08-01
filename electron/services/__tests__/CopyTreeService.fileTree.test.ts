import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { ManifestOutcome } from "copytree";

const copyMock = vi.hoisted(() => vi.fn());
const configCreateMock = vi.hoisted(() => vi.fn());

vi.mock("copytree", () => ({
  copy: copyMock,
  ConfigManager: {
    create: configCreateMock,
  },
}));

import { copyTreeService, _resetConfigCacheForTests } from "../CopyTreeService.js";
import { _resetBaseRealpathCacheForTests } from "../FileTreeService.js";

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

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-context-tree-"));
    vi.clearAllMocks();
    _resetConfigCacheForTests();
    _resetBaseRealpathCacheForTests();
    configCreateMock.mockResolvedValue({ isDefaultsLoaded: true });
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
    let releaseConfig!: (value: { isDefaultsLoaded: boolean }) => void;
    configCreateMock.mockReturnValue(
      new Promise<{ isDefaultsLoaded: boolean }>((resolve) => {
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
    releaseConfig({ isDefaultsLoaded: true });

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

    configCreateMock.mockResolvedValue({ isDefaultsLoaded: true });
    await expect(copyTreeService.getFileTree(tempDir)).resolves.toEqual([]);
    expect(configCreateMock).toHaveBeenCalledTimes(2);
  });
});

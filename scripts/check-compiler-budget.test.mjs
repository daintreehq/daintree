// Tests the real exports, not copies of them.
//
// The previous version of this file duplicated the implementation inline and
// asserted against the duplicate, which is why it stayed green through a
// rewrite that deleted the helpers it was describing. Everything here imports
// from the module under test.

import { describe, it, expect } from "vitest";
import { classifyBaselineEntries, coverageShortfall } from "./check-compiler-budget.mjs";
import { isInScanSurface, toPosixRelative } from "./lib/compiler-scan-surface.mjs";

function makeScan({ scanned = [], filtered = [] } = {}) {
  return { scanned, filtered };
}

describe("classifyBaselineEntries", () => {
  const baselineFiles = {
    "src/a.tsx": { hintCount: 1 },
    "src/b.tsx": { hintCount: 2 },
    "src/c.tsx": { hintCount: 3 },
    "src/d.tsx": { hintCount: 4 },
  };

  it("keeps entries that still report diagnostics out of every bucket", () => {
    const result = classifyBaselineEntries({
      baselineFiles,
      reportFiles: { "src/a.tsx": {}, "src/b.tsx": {}, "src/c.tsx": {}, "src/d.tsx": {} },
      scan: makeScan({ scanned: Object.keys(baselineFiles) }),
      fileExists: () => true,
    });
    expect(result.deletedFiles).toEqual([]);
    expect(result.cleanedFiles).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });

  it("separates deletion, cleanup and lost coverage", () => {
    const result = classifyBaselineEntries({
      baselineFiles,
      reportFiles: { "src/a.tsx": {} },
      // b was compiled and came back clean, c was rejected by the source
      // filter, d was never looked at.
      scan: makeScan({ scanned: ["src/a.tsx", "src/b.tsx"], filtered: ["src/c.tsx"] }),
      fileExists: () => true,
    });
    expect(result.cleanedFiles).toEqual(["src/b.tsx", "src/c.tsx"]);
    expect(result.uncovered).toEqual(["src/d.tsx"]);
  });

  it("treats a file that left the tree as deleted rather than uncovered", () => {
    const result = classifyBaselineEntries({
      baselineFiles: { "src/gone.tsx": {} },
      reportFiles: {},
      scan: makeScan(),
      fileExists: () => false,
    });
    expect(result.deletedFiles).toEqual(["src/gone.tsx"]);
    expect(result.uncovered).toEqual([]);
  });

  // The distinction the whole rewrite turns on: a file the scan deliberately
  // rejected reports nothing for a good reason, while a file the scan never
  // reached reports nothing because coverage was lost. Collapsing them either
  // way reintroduces the original bug.
  it("does not let an unprocessed file hide behind the filtered list", () => {
    const scanned = classifyBaselineEntries({
      baselineFiles: { "src/x.tsx": {} },
      reportFiles: {},
      scan: makeScan({ filtered: ["src/x.tsx"] }),
      fileExists: () => true,
    });
    const dropped = classifyBaselineEntries({
      baselineFiles: { "src/x.tsx": {} },
      reportFiles: {},
      scan: makeScan(),
      fileExists: () => true,
    });
    expect(scanned.cleanedFiles).toEqual(["src/x.tsx"]);
    expect(dropped.uncovered).toEqual(["src/x.tsx"]);
  });
});

describe("coverageShortfall", () => {
  const baselineFiles = { "src/a.tsx": {}, "src/b.tsx": {}, "src/c.tsx": {}, "src/d.tsx": {} };

  it("reports no shortfall when the scan covered what the baseline implies", () => {
    const drop = coverageShortfall({
      baselineFiles,
      baselineCoverage: { scanned: 100 },
      scannedCount: 100,
      fileExists: () => true,
    });
    expect(drop).toBe(0);
  });

  it("does not blame deletions for a smaller scan", () => {
    // All four baseline files are gone, so the scan is expected to be four
    // smaller. That is not a collapse.
    const drop = coverageShortfall({
      baselineFiles,
      baselineCoverage: { scanned: 100 },
      scannedCount: 96,
      fileExists: () => false,
    });
    expect(drop).toBe(0);
  });

  it("reports a shortfall the deletions cannot account for", () => {
    const drop = coverageShortfall({
      baselineFiles,
      baselineCoverage: { scanned: 100 },
      scannedCount: 50,
      fileExists: () => true,
    });
    expect(drop).toBeCloseTo(0.5, 5);
  });

  it("stays silent when the baseline predates the coverage record", () => {
    expect(
      coverageShortfall({
        baselineFiles,
        baselineCoverage: undefined,
        scannedCount: 0,
        fileExists: () => true,
      })
    ).toBe(0);
  });
});

describe("scan surface", () => {
  it("admits renderer sources and builtin plugin renderers", () => {
    expect(isInScanSurface("src/components/Foo.tsx")).toBe(true);
    expect(isInScanSurface("src/hooks/useFoo.ts")).toBe(true);
    expect(isInScanSurface("plugins/builtin/github/renderer/components/Foo.tsx")).toBe(true);
  });

  it("excludes tests, declarations and non-renderer code", () => {
    for (const file of [
      "src/components/Foo.test.tsx",
      "src/components/Foo.spec.tsx",
      "src/components/__tests__/Foo.tsx",
      "src/types/foo.d.ts",
      "electron/main.ts",
      "plugins/builtin/github/main/index.ts",
    ]) {
      expect(isInScanSurface(file), file).toBe(false);
    }
  });

  // The sample plugin builds through its own Vite config, which never
  // registers the compiler — budgeting it would track files nothing compiles.
  it("excludes the sample plugin's renderer", () => {
    expect(isInScanSurface("plugins/sample/rich-daintree/renderer/hook-panel-view.tsx")).toBe(
      false
    );
  });

  it("normalises Windows separators so baseline keys match on either platform", () => {
    expect(toPosixRelative("src\\components\\Foo.tsx")).toBe("src/components/Foo.tsx");
    expect(isInScanSurface("src\\components\\Foo.tsx")).toBe(true);
  });
});

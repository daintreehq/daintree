import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  analyzeSource,
  buildBaseline,
  checkShrinkageGuard,
  compareToBaseline,
  isExcluded,
  scanE2e,
} from "./check-e2e-waits.mjs";

describe("analyzeSource — waitForTimeout", () => {
  it("flags an unannotated waitForTimeout with its 1-based line", () => {
    const src = [
      "test('x', async ({ page }) => {",
      "  await page.waitForTimeout(500);",
      "});",
    ].join("\n");
    expect(analyzeSource(src).waitForTimeout).toEqual([2]);
  });

  it("exempts a waitForTimeout with a timer comment on the previous line", () => {
    const src = ["// timer: debounce-300ms", "await page.waitForTimeout(400);"].join("\n");
    expect(analyzeSource(src).waitForTimeout).toEqual([]);
  });

  it("exempts a waitForTimeout with a trailing timer comment on the same line", () => {
    const src = "await page.waitForTimeout(400); // timer: idle-sweep";
    expect(analyzeSource(src).waitForTimeout).toEqual([]);
  });

  it("does not exempt when the timer comment is two lines above", () => {
    const src = ["// timer: debounce", "", "await page.waitForTimeout(400);"].join("\n");
    expect(analyzeSource(src).waitForTimeout).toEqual([3]);
  });

  it("does not let a trailing timer comment on the previous line annotate the next call", () => {
    const src = [
      "await page.waitForTimeout(1); // timer: first",
      "await page.waitForTimeout(2);",
    ].join("\n");
    expect(analyzeSource(src).waitForTimeout).toEqual([2]);
  });

  it("requires a timer name after the colon", () => {
    const src = ["// timer:", "await page.waitForTimeout(400);"].join("\n");
    expect(analyzeSource(src).waitForTimeout).toEqual([2]);
  });

  it("ignores waitForTimeout inside strings and comments", () => {
    const src = [
      "const s = 'page.waitForTimeout(1)';",
      "// await page.waitForTimeout(1);",
      "/* page.waitForTimeout(2) */",
    ].join("\n");
    expect(analyzeSource(src).waitForTimeout).toEqual([]);
  });

  it("reports the method-name line for a chained call split across lines", () => {
    const src = ["await window", "  .waitForTimeout(100);"].join("\n");
    expect(analyzeSource(src).waitForTimeout).toEqual([2]);
  });

  it("detects bracket, parenthesised and non-null callee forms", () => {
    const src = [
      'page["waitForTimeout"](500);',
      "(page.waitForTimeout)(500);",
      "page.waitForTimeout!(500);",
      "page?.waitForTimeout(500);",
    ].join("\n");
    expect(analyzeSource(src).waitForTimeout).toEqual([1, 2, 3, 4]);
  });

  it("does not let a timer comment earlier in a call chain exempt the sleep", () => {
    const src = [
      'page.locator("x") // timer: unrelated',
      "  .click()",
      "  .waitForTimeout(500);",
    ].join("\n");
    expect(analyzeSource(src).waitForTimeout).toEqual([3]);
  });

  it("does not treat a `timer:` property as a timer comment", () => {
    const src = ["const o = { timer: 1 };", "await page.waitForTimeout(1);"].join("\n");
    expect(analyzeSource(src).waitForTimeout).toEqual([2]);
  });
});

describe("analyzeSource — isVisibleTimeout", () => {
  it("flags isVisible with a timeout option", () => {
    const src = [
      "if (await btn.isVisible({ timeout: 500 })) {}",
      "const timeout = 1;",
      "await btn.isVisible({ timeout });",
    ].join("\n");
    expect(analyzeSource(src).isVisibleTimeout).toEqual([1, 3]);
  });

  it("sees through computed keys, wrappers, assertions and spread literals", () => {
    const src = [
      'btn.isVisible({ ["timeout"]: 500 });',
      "btn.isVisible(({ timeout: 500 }));",
      "btn.isVisible({ timeout: 500 } as const);",
      "btn.isVisible({ ...{ timeout: 500 } });",
      'btn["isVisible"]({ timeout: 500 });',
    ].join("\n");
    expect(analyzeSource(src).isVisibleTimeout).toEqual([1, 2, 3, 4, 5]);
  });

  it("ignores isVisible without a timeout", () => {
    const src = ["await btn.isVisible();", "await btn.isVisible({ other: 1 });"].join("\n");
    expect(analyzeSource(src).isVisibleTimeout).toEqual([]);
  });
});

describe("isExcluded", () => {
  it("excludes opt-in harness directories only at the top of e2e/", () => {
    expect(isExcluded("e2e/screenshots/a.spec.ts")).toBe(true);
    expect(isExcluded("e2e/demo/intro/harness.ts")).toBe(true);
    expect(isExcluded("e2e/plugins/helpers/x.ts")).toBe(true);
    expect(isExcluded("e2e/full/plugins/a.spec.ts")).toBe(false);
    expect(isExcluded("e2e/helpers/launch.ts")).toBe(false);
  });
});

describe("baseline comparison", () => {
  const scan = {
    "e2e/core/a.spec.ts": { waitForTimeout: [3, 9], isVisibleTimeout: [] },
    "e2e/full/b.spec.ts": { waitForTimeout: [], isVisibleTimeout: [4] },
  };

  it("builds per-file counts and totals, omitting zero rules", () => {
    expect(buildBaseline(scan)).toEqual({
      totals: { waitForTimeout: 2, isVisibleTimeout: 1 },
      files: {
        "e2e/core/a.spec.ts": { waitForTimeout: 2 },
        "e2e/full/b.spec.ts": { isVisibleTimeout: 1 },
      },
    });
  });

  it("passes when counts match the baseline", () => {
    const result = compareToBaseline(scan, buildBaseline(scan));
    expect(result).toEqual({ violations: [], decreases: [] });
  });

  it("fails on a per-file increase even when another file decreased", () => {
    const baseline = {
      files: {
        "e2e/core/a.spec.ts": { waitForTimeout: 1 },
        "e2e/full/b.spec.ts": { isVisibleTimeout: 1, waitForTimeout: 5 },
      },
    };
    const { violations, decreases } = compareToBaseline(scan, baseline);
    expect(violations).toEqual([
      { file: "e2e/core/a.spec.ts", rule: "waitForTimeout", count: 2, baseline: 1, lines: [3, 9] },
    ]);
    expect(decreases).toEqual([
      { file: "e2e/full/b.spec.ts", rule: "waitForTimeout", count: 0, baseline: 5 },
    ]);
  });

  it("treats a file missing from the baseline as baseline 0", () => {
    const { violations } = compareToBaseline(scan, { files: {} });
    expect(violations.map((v) => `${v.file}:${v.rule}`)).toEqual([
      "e2e/core/a.spec.ts:waitForTimeout",
      "e2e/full/b.spec.ts:isVisibleTimeout",
    ]);
  });

  it("reports a file that disappeared as a decrease", () => {
    const { violations, decreases } = compareToBaseline(
      {},
      { files: { "e2e/gone.spec.ts": { waitForTimeout: 2 } } }
    );
    expect(violations).toEqual([]);
    expect(decreases).toEqual([
      { file: "e2e/gone.spec.ts", rule: "waitForTimeout", count: 0, baseline: 2 },
    ]);
  });
});

describe("checkShrinkageGuard", () => {
  const prior = { waitForTimeout: 100, isVisibleTimeout: 10 };

  it("blocks a drop larger than the threshold in any rule", () => {
    const res = checkShrinkageGuard(prior, { waitForTimeout: 100, isVisibleTimeout: 5 }, false);
    expect(res.blocked).toBe(true);
    expect(res.message).toContain("isVisibleTimeout");
  });

  it("allows small drops, --force, and a missing prior baseline", () => {
    expect(checkShrinkageGuard(prior, { waitForTimeout: 95, isVisibleTimeout: 10 }, false)).toEqual(
      { blocked: false }
    );
    expect(checkShrinkageGuard(prior, { waitForTimeout: 0, isVisibleTimeout: 0 }, true)).toEqual({
      blocked: false,
    });
    expect(checkShrinkageGuard(null, { waitForTimeout: 0, isVisibleTimeout: 0 }, false)).toEqual({
      blocked: false,
    });
  });
});

describe("scanE2e", () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("walks e2e/, skips excluded directories, and keys files by POSIX path", () => {
    root = mkdtempSync(join(tmpdir(), "e2e-waits-"));
    const write = (rel, body) => {
      const full = join(root, ...rel.split("/"));
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body);
    };
    write("e2e/core/a.spec.ts", "await page.waitForTimeout(1);\n");
    write("e2e/helpers/h.ts", "await el.isVisible({ timeout: 5 });\n");
    write("e2e/screenshots/s.spec.ts", "await page.waitForTimeout(1);\n");
    write("e2e/full/clean.spec.ts", "await expect(el).toBeVisible();\n");
    write("e2e/full/types.d.ts", "declare function waitForTimeout(n: number): void;\n");

    expect(scanE2e(root)).toEqual({
      "e2e/core/a.spec.ts": { waitForTimeout: [1], isVisibleTimeout: [] },
      "e2e/helpers/h.ts": { waitForTimeout: [], isVisibleTimeout: [1] },
    });
  });
});

// Tests the severity split both compiler commands depend on, against the real
// export rather than a copy of it.
//
// The previous version of this file tested a locally re-implemented normalizer
// and modelled a `CompilerDiagnostic` shape the installed compiler does not
// expose, so it could not have caught either the throwing-getter hazard or the
// wrong-line attribution that this suite now pins.

import { describe, it, expect } from "vitest";
import { LintRules } from "babel-plugin-react-compiler";
import {
  MAX_SAMPLE_LENGTH,
  MAX_SAMPLES_PER_FILE,
  bucketCompileError,
  emptyEntry,
  recordCompileError,
} from "./lib/compiler-scan.mjs";
import { formatBailoutReport } from "./find-critical-compiler-errors.mjs";

const HINT_CATEGORY = LintRules.find((r) => r.severity === "Hint")?.category;
const ERROR_CATEGORY = LintRules.find((r) => r.severity === "Error")?.category;
const WARNING_CATEGORY = LintRules.find((r) => r.severity === "Warning")?.category;

describe("bucketCompileError", () => {
  // A Todo abandons the whole function, so triage has to be able to say where:
  // the diagnostic's own line and the line of the function it cost.
  it("keeps a Hint-severity bailout's reason and lines, outside the strict list", () => {
    const { hints, hintBailouts, strict } = bucketCompileError({
      kind: "CompileError",
      fnLoc: { start: { line: 185 } },
      detail: {
        category: HINT_CATEGORY,
        reason: "Unsupported declaration type for hoisting",
        loc: { start: { line: 435 } },
      },
    });
    expect(hints).toBe(1);
    expect(hintBailouts).toEqual([
      {
        category: HINT_CATEGORY,
        severity: "Hint",
        reason: "Unsupported declaration type for hoisting",
        line: 435,
        fnLine: 185,
      },
    ]);
    expect(strict).toEqual([]);
  });

  it("records a Hint with no function location as such rather than guessing", () => {
    const { hintBailouts } = bucketCompileError({
      kind: "CompileError",
      fnLoc: null,
      detail: { category: HINT_CATEGORY, reason: "todo", loc: { start: { line: 9 } } },
    });
    expect(hintBailouts[0].fnLine).toBeNull();
    expect(hintBailouts[0].line).toBe(9);
  });

  it("counts Error and Warning categories as strict bailouts", () => {
    for (const category of [ERROR_CATEGORY, WARNING_CATEGORY]) {
      const { hints, strict } = bucketCompileError({
        kind: "CompileError",
        detail: { category, reason: "boom" },
      });
      expect(hints, category).toBe(0);
      expect(strict, category).toHaveLength(1);
      expect(strict[0].category, category).toBe(category);
    }
  });

  // A category the installed plugin does not know about must fail loud rather
  // than be written off as cosmetic — otherwise an upstream taxonomy change
  // silently retires real debt.
  it("treats an unrecognised category as strict", () => {
    const { hints, strict } = bucketCompileError({
      kind: "CompileError",
      detail: { category: "SomeFutureCategory", reason: "new rule" },
    });
    expect(hints).toBe(0);
    expect(strict[0].severity).toBe("Error");
  });

  it("never reads detail.severity, which throws for unknown categories", () => {
    const detail = {
      category: "SomeFutureCategory",
      reason: "new rule",
      get severity() {
        throw new Error("Unsupported category SomeFutureCategory");
      },
    };
    expect(() => bucketCompileError({ kind: "CompileError", detail })).not.toThrow();
  });

  it("records a malformed event strictly rather than dropping it", () => {
    const { hints, strict } = bucketCompileError({ kind: "CompileError" });
    expect(hints).toBe(0);
    expect(strict).toHaveLength(1);
    expect(strict[0].reason).toMatch(/malformed/i);
  });

  // `CompilerDiagnostic` keeps its children under `options.details`, not
  // `details`. Reading the public-looking property alone collapses a
  // multi-location diagnostic to a single entry.
  it("expands the children a CompilerDiagnostic keeps under options.details", () => {
    const { strict } = bucketCompileError({
      kind: "CompileError",
      detail: {
        category: ERROR_CATEGORY,
        reason: "parent",
        options: {
          details: [
            { category: ERROR_CATEGORY, reason: "first", loc: { start: { line: 12 } } },
            { category: ERROR_CATEGORY, reason: "second", loc: { start: { line: 34 } } },
          ],
        },
      },
    });
    expect(strict.map((b) => b.line)).toEqual([12, 34]);
  });

  it("prefers primaryLocation() over the enclosing function's line", () => {
    const { strict } = bucketCompileError({
      kind: "CompileError",
      fnLoc: { start: { line: 3 } },
      detail: {
        category: ERROR_CATEGORY,
        reason: "ref read",
        primaryLocation: () => ({ start: { line: 52 } }),
      },
    });
    expect(strict[0].line).toBe(52);
  });

  it("falls back to the function location when nothing more precise exists", () => {
    const { strict } = bucketCompileError({
      kind: "CompileError",
      fnLoc: { start: { line: 7 } },
      detail: { category: ERROR_CATEGORY, reason: "no location" },
    });
    expect(strict[0].line).toBe(7);
  });

  it("splits a mixed diagnostic across both buckets", () => {
    const { hints, strict } = bucketCompileError({
      kind: "CompileError",
      detail: {
        category: ERROR_CATEGORY,
        reason: "parent",
        options: {
          details: [
            { category: HINT_CATEGORY, reason: "todo" },
            { category: ERROR_CATEGORY, reason: "real" },
          ],
        },
      },
    });
    expect(hints).toBe(1);
    expect(strict).toHaveLength(1);
    expect(strict[0].reason).toBe("real");
  });
});

function entry(overrides = {}) {
  return { hintCount: 0, hintBailouts: [], errorBailouts: [], ...overrides };
}

describe("formatBailoutReport", () => {
  it("lists Hint bailouts by file, with the function each one cost", () => {
    const text = formatBailoutReport({
      scanned: ["src/Toolbar.tsx", "src/Clean.tsx"],
      failures: [],
      files: {
        "src/Toolbar.tsx": entry({
          hintCount: 1,
          hintBailouts: [
            { category: "Todo", severity: "Hint", reason: "hoisting", line: 435, fnLine: 185 },
          ],
        }),
      },
    }).join("\n");
    expect(text).toContain("Hint (`Todo`), 1 in 1 file(s)");
    expect(text).toContain("  src/Toolbar.tsx\n    :435  hoisting  (function at :185)");
    expect(text).toContain("Total: 1 Hint diagnostic(s) across 2 scanned files");
    expect(text).not.toContain("Error,");
  });

  it("lists Error and Warning bailouts in their own sections, Error first", () => {
    const text = formatBailoutReport({
      scanned: ["src/a.tsx"],
      failures: [],
      files: {
        "src/a.tsx": entry({
          hintCount: 1,
          hintBailouts: [{ category: "Todo", severity: "Hint", reason: "todo", line: 1 }],
          errorBailouts: [
            { category: WARNING_CATEGORY, severity: "Warning", reason: "lib", line: 2 },
            { category: ERROR_CATEGORY, severity: "Error", reason: "refs", line: 3 },
          ],
        }),
      },
    }).join("\n");
    const error = text.indexOf("Error, 1 in 1 file(s)");
    const warning = text.indexOf("Warning, 1 in 1 file(s)");
    const hint = text.indexOf("Hint (`Todo`), 1 in 1 file(s)");
    expect(error).toBeGreaterThan(-1);
    expect(warning).toBeGreaterThan(error);
    expect(hint).toBeGreaterThan(warning);
    expect(text).toContain("    :3  refs");
    expect(text).toContain("    :2  lib");
    expect(text).toContain("Total: 1 Error, 1 Warning, 1 Hint diagnostic(s)");
  });

  // The samples are bounded; the count is not. A total read off the samples
  // would understate a file that hit the cap.
  it("counts Hints from the exact total and says how many went unlisted", () => {
    const text = formatBailoutReport({
      scanned: ["src/big.tsx"],
      failures: [],
      files: {
        "src/big.tsx": entry({
          hintCount: 25,
          hintBailouts: [{ category: "Todo", severity: "Hint", reason: "todo", line: 4 }],
        }),
      },
    }).join("\n");
    expect(text).toContain("Hint (`Todo`), 25 in 1 file(s)");
    expect(text).toContain("(+24 more not listed)");
  });

  // An entry shaped before `hintCount` existed, or one whose count lags its
  // samples, still reports every sample it lists.
  it("never counts fewer Hints than it lists", () => {
    const text = formatBailoutReport({
      scanned: ["src/a.tsx"],
      failures: [],
      files: {
        "src/a.tsx": {
          hintBailouts: [
            { category: "Todo", severity: "Hint", reason: "one", line: 1 },
            { category: "Todo", severity: "Hint", reason: "two", line: 2 },
          ],
        },
      },
    }).join("\n");
    expect(text).toContain("Hint (`Todo`), 2 in 1 file(s)");
    expect(text).not.toContain("more not listed");
  });

  it("never prints a bare all-clear over files that failed to scan", () => {
    const clean = formatBailoutReport({ scanned: ["src/a.tsx"], failures: [], files: {} });
    expect(clean).toEqual(["No compiler bailouts across 1 scanned files."]);
    const partial = formatBailoutReport({
      scanned: ["src/a.tsx"],
      failures: [{ file: "src/b.tsx", stage: "transform", message: "boom" }],
      files: {},
    }).join("\n");
    expect(partial).toContain("not a clean bill of health");
  });
});

function todoEvent(reason, line, fnLine = 10) {
  return {
    kind: "CompileError",
    fnLoc: { start: { line: fnLine } },
    detail: { category: HINT_CATEGORY, reason, loc: { start: { line } } },
  };
}

describe("recordCompileError", () => {
  it("counts every Hint exactly while keeping a bounded sample", () => {
    const entry = emptyEntry();
    for (let i = 0; i < MAX_SAMPLES_PER_FILE + 5; i++)
      recordCompileError(entry, todoEvent("todo", i));
    expect(entry.hintCount).toBe(MAX_SAMPLES_PER_FILE + 5);
    expect(entry.error).toBe(MAX_SAMPLES_PER_FILE + 5);
    expect(entry.hintBailouts).toHaveLength(MAX_SAMPLES_PER_FILE);
    expect(entry.hintBailouts[0]).toMatchObject({ reason: "todo", line: 0, fnLine: 10 });
  });

  it("samples a repeated Todo once but counts it each time", () => {
    const entry = emptyEntry();
    recordCompileError(entry, todoEvent("same", 4));
    recordCompileError(entry, todoEvent("same", 4));
    recordCompileError(entry, todoEvent("same", 4, 99));
    expect(entry.hintCount).toBe(3);
    expect(entry.hintBailouts.map((b) => b.fnLine)).toEqual([10, 99]);
  });

  it("truncates a long reason in the sample", () => {
    const entry = emptyEntry();
    recordCompileError(entry, todoEvent("x".repeat(MAX_SAMPLE_LENGTH + 50), 1));
    expect(entry.hintBailouts[0].reason).toHaveLength(MAX_SAMPLE_LENGTH);
  });

  it("keeps strict bailouts out of the Hint sample", () => {
    const entry = emptyEntry();
    recordCompileError(entry, {
      kind: "CompileError",
      detail: { category: ERROR_CATEGORY, reason: "refs", loc: { start: { line: 3 } } },
    });
    expect(entry.hintCount).toBe(0);
    expect(entry.hintBailouts).toEqual([]);
    expect(entry.errorBailouts).toHaveLength(1);
  });
});

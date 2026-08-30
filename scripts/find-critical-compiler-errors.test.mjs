// Tests the severity split both compiler commands depend on, against the real
// export rather than a copy of it.
//
// The previous version of this file tested a locally re-implemented normalizer
// and modelled a `CompilerDiagnostic` shape the installed compiler does not
// expose, so it could not have caught either the throwing-getter hazard or the
// wrong-line attribution that this suite now pins.

import { describe, it, expect } from "vitest";
import { LintRules } from "babel-plugin-react-compiler";
import { bucketCompileError } from "./lib/compiler-scan.mjs";

const HINT_CATEGORY = LintRules.find((r) => r.severity === "Hint")?.category;
const ERROR_CATEGORY = LintRules.find((r) => r.severity === "Error")?.category;
const WARNING_CATEGORY = LintRules.find((r) => r.severity === "Warning")?.category;

describe("bucketCompileError", () => {
  it("counts a Hint-severity category as cosmetic noise, not debt", () => {
    const { hints, strict } = bucketCompileError({
      kind: "CompileError",
      detail: { category: HINT_CATEGORY, reason: "some todo" },
    });
    expect(hints).toBe(1);
    expect(strict).toEqual([]);
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
            { category: HINT_CATEGORY, reason: "cosmetic" },
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

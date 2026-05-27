import { describe, expect, it } from "vitest";
import { parse } from "../parser.js";
import { evaluate } from "../evaluator.js";
import type { WhenClauseContext } from "../types.js";

describe("when clause evaluator", () => {
  describe("literals", () => {
    it("evaluates true literal", () => {
      expect(evaluate(parse("true"), {})).toBe(true);
    });

    it("evaluates false literal", () => {
      expect(evaluate(parse("false"), {})).toBe(false);
    });

    it("evaluates non-empty string as truthy", () => {
      expect(evaluate(parse("'hello'"), {})).toBe(true);
    });

    it("evaluates empty string as falsy", () => {
      expect(evaluate(parse("''"), {})).toBe(false);
    });
  });

  describe("identifiers", () => {
    it("evaluates boolean true from context", () => {
      const ctx: WhenClauseContext = { ready: true };
      expect(evaluate(parse("ready"), ctx)).toBe(true);
    });

    it("evaluates boolean false from context", () => {
      const ctx: WhenClauseContext = { ready: false };
      expect(evaluate(parse("ready"), ctx)).toBe(false);
    });

    it("evaluates non-empty string as truthy", () => {
      const ctx: WhenClauseContext = { mode: "dark" };
      expect(evaluate(parse("mode"), ctx)).toBe(true);
    });

    it("evaluates empty string as falsy", () => {
      const ctx: WhenClauseContext = { mode: "" };
      expect(evaluate(parse("mode"), ctx)).toBe(false);
    });

    it("evaluates missing key as falsy", () => {
      expect(evaluate(parse("nonexistent"), {})).toBe(false);
    });

    it("evaluates null context value as falsy", () => {
      const ctx: WhenClauseContext = { ready: null };
      expect(evaluate(parse("ready"), ctx)).toBe(false);
    });

    it("evaluates undefined context value as falsy", () => {
      const ctx: WhenClauseContext = { ready: undefined };
      expect(evaluate(parse("ready"), ctx)).toBe(false);
    });

    it("evaluates dotted path from nested context", () => {
      const ctx: WhenClauseContext = { panel: { kind: "terminal" } };
      expect(evaluate(parse("panel.kind"), ctx)).toBe(true);
    });

    it("evaluates missing nested key as falsy", () => {
      const ctx: WhenClauseContext = { panel: { kind: "terminal" } };
      expect(evaluate(parse("panel.nonexistent"), ctx)).toBe(false);
    });

    it("evaluates path through null as falsy", () => {
      const ctx: WhenClauseContext = { panel: null };
      expect(evaluate(parse("panel.kind"), ctx)).toBe(false);
    });
  });

  describe("equality", () => {
    it("evaluates == true when values match", () => {
      const ctx: WhenClauseContext = { kind: "terminal" };
      expect(evaluate(parse("kind == 'terminal'"), ctx)).toBe(true);
    });

    it("evaluates == false when values differ", () => {
      const ctx: WhenClauseContext = { kind: "browser" };
      expect(evaluate(parse("kind == 'terminal'"), ctx)).toBe(false);
    });

    it("evaluates != true when values differ", () => {
      const ctx: WhenClauseContext = { kind: "browser" };
      expect(evaluate(parse("kind != 'terminal'"), ctx)).toBe(true);
    });

    it("evaluates != false when values match", () => {
      const ctx: WhenClauseContext = { kind: "terminal" };
      expect(evaluate(parse("kind != 'terminal'"), ctx)).toBe(false);
    });

    it("evaluates == with boolean", () => {
      const ctx: WhenClauseContext = { ready: true };
      expect(evaluate(parse("ready == false"), ctx)).toBe(false);
    });
  });

  describe("boolean operators", () => {
    it("evaluates && truth table (TT)", () => {
      const ctx: WhenClauseContext = { a: true, b: true };
      expect(evaluate(parse("a && b"), ctx)).toBe(true);
    });

    it("evaluates && truth table (TF)", () => {
      const ctx: WhenClauseContext = { a: true, b: false };
      expect(evaluate(parse("a && b"), ctx)).toBe(false);
    });

    it("evaluates && truth table (FT)", () => {
      const ctx: WhenClauseContext = { a: false, b: true };
      expect(evaluate(parse("a && b"), ctx)).toBe(false);
    });

    it("evaluates && truth table (FF)", () => {
      const ctx: WhenClauseContext = { a: false, b: false };
      expect(evaluate(parse("a && b"), ctx)).toBe(false);
    });

    it("evaluates || truth table (TT)", () => {
      const ctx: WhenClauseContext = { a: true, b: true };
      expect(evaluate(parse("a || b"), ctx)).toBe(true);
    });

    it("evaluates || truth table (TF)", () => {
      const ctx: WhenClauseContext = { a: true, b: false };
      expect(evaluate(parse("a || b"), ctx)).toBe(true);
    });

    it("evaluates || truth table (FT)", () => {
      const ctx: WhenClauseContext = { a: false, b: true };
      expect(evaluate(parse("a || b"), ctx)).toBe(true);
    });

    it("evaluates || truth table (FF)", () => {
      const ctx: WhenClauseContext = { a: false, b: false };
      expect(evaluate(parse("a || b"), ctx)).toBe(false);
    });

    it("evaluates ! (not)", () => {
      const ctx: WhenClauseContext = { a: true };
      expect(evaluate(parse("!a"), ctx)).toBe(false);
      expect(evaluate(parse("!!a"), ctx)).toBe(true);
    });

    it("short-circuits &&", () => {
      const ctx: WhenClauseContext = { a: false, b: true };
      expect(evaluate(parse("a && b"), ctx)).toBe(false);
    });

    it("short-circuits ||", () => {
      const ctx: WhenClauseContext = { a: true, b: false };
      expect(evaluate(parse("a || b"), ctx)).toBe(true);
    });
  });

  describe("integration: parse + evaluate", () => {
    it("evaluates real-world when clause", () => {
      const ctx: WhenClauseContext = {
        panel: { kind: "terminal", agentState: "idle" },
      };
      expect(evaluate(parse("panel.kind == 'terminal' && panel.agentState == 'idle'"), ctx)).toBe(
        true
      );
    });

    it("fails when condition doesn't match", () => {
      const ctx: WhenClauseContext = {
        panel: { kind: "browser" },
      };
      expect(evaluate(parse("panel.kind == 'terminal'"), ctx)).toBe(false);
    });

    it("handles deeply nested context", () => {
      const ctx: WhenClauseContext = {
        nested: { deeply: { value: "target" } },
      };
      expect(evaluate(parse("nested.deeply.value == 'target'"), ctx)).toBe(true);
    });

    it("undefined propagates through dotted path as falsy", () => {
      const ctx: WhenClauseContext = { a: undefined };
      expect(evaluate(parse("a.b"), ctx)).toBe(false);
    });
  });
});

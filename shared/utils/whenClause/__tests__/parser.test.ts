import { describe, expect, it } from "vitest";
import { parse, ParseError } from "../parser";

describe("when clause parser", () => {
  describe("literals", () => {
    it("parses boolean true", () => {
      const ast = parse("true");
      expect(ast).toEqual({ kind: "literal", value: true });
    });

    it("parses boolean false", () => {
      const ast = parse("false");
      expect(ast).toEqual({ kind: "literal", value: false });
    });

    it("parses single-quoted string", () => {
      const ast = parse("'hello'");
      expect(ast).toEqual({ kind: "literal", value: "hello" });
    });

    it("parses empty string", () => {
      const ast = parse("''");
      expect(ast).toEqual({ kind: "literal", value: "" });
    });

    it("parses string with escaped single quote", () => {
      const ast = parse("'it\\'s working'");
      expect(ast).toEqual({ kind: "literal", value: "it's working" });
    });
  });

  describe("identifiers", () => {
    it("parses simple identifier", () => {
      const ast = parse("panelKind");
      expect(ast).toEqual({ kind: "identifier", path: ["panelKind"] });
    });

    it("parses dotted identifier path", () => {
      const ast = parse("panel.kind");
      expect(ast).toEqual({ kind: "identifier", path: ["panel", "kind"] });
    });

    it("parses deep dotted path", () => {
      const ast = parse("a.b.c.d");
      expect(ast).toEqual({ kind: "identifier", path: ["a", "b", "c", "d"] });
    });

    it("parses identifier starting with 'true' prefix as identifier, not boolean", () => {
      const ast = parse("trueValue");
      expect(ast).toEqual({ kind: "identifier", path: ["trueValue"] });
    });

    it("parses identifier starting with 'false' prefix as identifier, not boolean", () => {
      const ast = parse("falseFlag");
      expect(ast).toEqual({ kind: "identifier", path: ["falseFlag"] });
    });

    it("parses dotted identifier where root starts with 'true'", () => {
      const ast = parse("true.foo");
      expect(ast).toEqual({ kind: "identifier", path: ["true", "foo"] });
    });
  });

  describe("equality", () => {
    it("parses == with string literal", () => {
      const ast = parse("panel.kind == 'terminal'");
      expect(ast).toEqual({
        kind: "binary",
        operator: "==",
        left: { kind: "identifier", path: ["panel", "kind"] },
        right: { kind: "literal", value: "terminal" },
      });
    });

    it("parses != with string literal", () => {
      const ast = parse("panel.kind != 'browser'");
      expect(ast).toEqual({
        kind: "binary",
        operator: "!=",
        left: { kind: "identifier", path: ["panel", "kind"] },
        right: { kind: "literal", value: "browser" },
      });
    });

    it("parses == with boolean", () => {
      const ast = parse("ready == true");
      expect(ast).toEqual({
        kind: "binary",
        operator: "==",
        left: { kind: "identifier", path: ["ready"] },
        right: { kind: "literal", value: true },
      });
    });
  });

  describe("boolean operators", () => {
    it("parses &&", () => {
      const ast = parse("a && b");
      expect(ast).toEqual({
        kind: "binary",
        operator: "&&",
        left: { kind: "identifier", path: ["a"] },
        right: { kind: "identifier", path: ["b"] },
      });
    });

    it("parses ||", () => {
      const ast = parse("a || b");
      expect(ast).toEqual({
        kind: "binary",
        operator: "||",
        left: { kind: "identifier", path: ["a"] },
        right: { kind: "identifier", path: ["b"] },
      });
    });

    it("parses ! (unary not)", () => {
      const ast = parse("!a");
      expect(ast).toEqual({
        kind: "unary",
        operator: "!",
        operand: { kind: "identifier", path: ["a"] },
      });
    });
  });

  describe("operator precedence", () => {
    it("&& binds tighter than || (left)", () => {
      const ast = parse("a || b && c");
      expect(ast).toEqual({
        kind: "binary",
        operator: "||",
        left: { kind: "identifier", path: ["a"] },
        right: {
          kind: "binary",
          operator: "&&",
          left: { kind: "identifier", path: ["b"] },
          right: { kind: "identifier", path: ["c"] },
        },
      });
    });

    it("&& binds tighter than || (right)", () => {
      const ast = parse("a && b || c");
      expect(ast).toEqual({
        kind: "binary",
        operator: "||",
        left: {
          kind: "binary",
          operator: "&&",
          left: { kind: "identifier", path: ["a"] },
          right: { kind: "identifier", path: ["b"] },
        },
        right: { kind: "identifier", path: ["c"] },
      });
    });

    it("equality binds tighter than &&", () => {
      const ast = parse("a == 'x' && b == 'y'");
      expect(ast).toEqual({
        kind: "binary",
        operator: "&&",
        left: {
          kind: "binary",
          operator: "==",
          left: { kind: "identifier", path: ["a"] },
          right: { kind: "literal", value: "x" },
        },
        right: {
          kind: "binary",
          operator: "==",
          left: { kind: "identifier", path: ["b"] },
          right: { kind: "literal", value: "y" },
        },
      });
    });

    it("! binds tightest", () => {
      const ast = parse("!a && b");
      expect(ast).toEqual({
        kind: "binary",
        operator: "&&",
        left: {
          kind: "unary",
          operator: "!",
          operand: { kind: "identifier", path: ["a"] },
        },
        right: { kind: "identifier", path: ["b"] },
      });
    });
  });

  describe("complex expressions", () => {
    it("parses chained equality with &&", () => {
      const ast = parse("panel.kind == 'terminal' && agentState == 'idle'");
      expect(ast.kind).toBe("binary");
      expect((ast as any).operator).toBe("&&");
    });

    it("parses negated equality (no parens in v1)", () => {
      const ast = parse("!panel.kind == 'terminal'");
      // parses as: (!panel.kind) == 'terminal'
      expect(ast).toEqual({
        kind: "binary",
        operator: "==",
        left: {
          kind: "unary",
          operator: "!",
          operand: { kind: "identifier", path: ["panel", "kind"] },
        },
        right: { kind: "literal", value: "terminal" },
      });
    });

    it("parses three-way ||", () => {
      const ast = parse("a || b || c");
      expect(ast).toEqual({
        kind: "binary",
        operator: "||",
        left: {
          kind: "binary",
          operator: "||",
          left: { kind: "identifier", path: ["a"] },
          right: { kind: "identifier", path: ["b"] },
        },
        right: { kind: "identifier", path: ["c"] },
      });
    });
  });

  describe("whitespace handling", () => {
    it("handles tab-separated tokens", () => {
      const ast = parse("a\t&&\tb");
      expect(ast).toEqual({
        kind: "binary",
        operator: "&&",
        left: { kind: "identifier", path: ["a"] },
        right: { kind: "identifier", path: ["b"] },
      });
    });

    it("handles newline-separated tokens", () => {
      const ast = parse("a\n&&\nb");
      expect(ast).toEqual({
        kind: "binary",
        operator: "&&",
        left: { kind: "identifier", path: ["a"] },
        right: { kind: "identifier", path: ["b"] },
      });
    });
  });

  describe("errors", () => {
    it("rejects empty input", () => {
      expect(() => parse("")).toThrow(ParseError);
      expect(() => parse("   ")).toThrow(ParseError);
    });

    it("rejects regex operator =~", () => {
      expect(() => parse("panel.kind =~ 'term'")).toThrow(ParseError);
    });

    it("rejects in operator", () => {
      expect(() => parse("panel.kind in 'terminal'")).toThrow(ParseError);
    });

    it("rejects numeric comparison <", () => {
      expect(() => parse("x < 5")).toThrow(ParseError);
    });

    it("rejects numeric comparison >", () => {
      expect(() => parse("x > 5")).toThrow(ParseError);
    });

    it("rejects parentheses", () => {
      expect(() => parse("(a == 'x')")).toThrow(ParseError);
    });

    it("rejects double-quoted strings", () => {
      expect(() => parse('a == "x"')).toThrow(ParseError);
    });

    it("rejects unterminated string", () => {
      expect(() => parse("a == 'unterminated")).toThrow(ParseError);
    });

    it("rejects unknown tokens", () => {
      expect(() => parse("a @ b")).toThrow(ParseError);
    });

    it("rejects dangling operator", () => {
      expect(() => parse("a &&")).toThrow(ParseError);
    });

    it("rejects trailing garbage", () => {
      expect(() => parse("a == 'x' b")).toThrow(ParseError);
    });
  });
});

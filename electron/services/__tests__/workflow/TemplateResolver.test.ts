import { describe, it, expect } from "vitest";
import {
  hasTemplateExpressions,
  resolveTemplateArgs,
  resolveTemplateString,
  resolveExpression,
} from "../../workflow/TemplateResolver.js";
import type { NodeState } from "../../../../shared/types/workflowRun.js";

const completedState = (result: Record<string, unknown>): NodeState => ({
  status: "completed",
  result,
});

describe("hasTemplateExpressions", () => {
  it("detects template in string", () => {
    expect(hasTemplateExpressions("{{ node1.result }}")).toBe(true);
    expect(hasTemplateExpressions("no template here")).toBe(false);
  });

  it("detects template in nested object", () => {
    expect(hasTemplateExpressions({ a: { b: "{{ x.y }}" } })).toBe(true);
    expect(hasTemplateExpressions({ a: { b: "plain" } })).toBe(false);
  });

  it("detects template in array", () => {
    expect(hasTemplateExpressions(["{{ a.b }}", "plain"])).toBe(true);
    expect(hasTemplateExpressions(["plain", "also plain"])).toBe(false);
  });

  it("returns false for non-string primitives", () => {
    expect(hasTemplateExpressions(42)).toBe(false);
    expect(hasTemplateExpressions(null)).toBe(false);
    expect(hasTemplateExpressions(true)).toBe(false);
  });

  it("handles repeated calls correctly (global regex lastIndex)", () => {
    expect(hasTemplateExpressions("{{ a.b }}")).toBe(true);
    expect(hasTemplateExpressions("{{ a.b }}")).toBe(true);
    expect(hasTemplateExpressions("no match")).toBe(false);
    expect(hasTemplateExpressions("{{ c.d }}")).toBe(true);
  });
});

describe("resolveExpression", () => {
  it("resolves a simple expression", () => {
    const states = { node1: completedState({ summary: "done" }) };
    expect(resolveExpression("node1.summary", states)).toBe("done");
  });

  it("throws on expression without dot", () => {
    expect(() => resolveExpression("nodonly", {})).toThrow("must be in format");
  });

  it("throws when node is missing", () => {
    expect(() => resolveExpression("missing.path", {})).toThrow("not found in workflow");
  });

  it("throws when node has not completed", () => {
    const states = { node1: { status: "running" as const } };
    expect(() => resolveExpression("node1.summary", states)).toThrow("has not completed");
  });
});

describe("resolveTemplateString", () => {
  it("returns raw typed value for pure placeholder", () => {
    const states = { n1: completedState({ data: { count: 42 } }) };
    expect(resolveTemplateString("{{ n1.data.count }}", states)).toBe(42);
  });

  it("stringifies non-string values in embedded placeholders", () => {
    const states = { n1: completedState({ data: { count: 42 } }) };
    expect(resolveTemplateString("Count is {{ n1.data.count }} items", states)).toBe(
      "Count is 42 items"
    );
  });

  it("returns plain string unchanged", () => {
    const states = {};
    expect(resolveTemplateString("no templates", states)).toBe("no templates");
  });
});

describe("resolveTemplateArgs", () => {
  it("resolves templates in args object", () => {
    const states = {
      step1: completedState({ summary: "build complete", data: { version: "2.0" } }),
    };
    const args = {
      message: "{{ step1.summary }}",
      version: "{{ step1.data.version }}",
      plain: "no-template",
    };
    const resolved = resolveTemplateArgs(args, states);
    expect(resolved.message).toBe("build complete");
    expect(resolved.version).toBe("2.0");
    expect(resolved.plain).toBe("no-template");
  });

  it("resolves nested objects and arrays", () => {
    const states = { n: completedState({ summary: "ok" }) };
    const args = {
      nested: { inner: "{{ n.summary }}" },
      list: ["{{ n.summary }}", "plain"],
    };
    const resolved = resolveTemplateArgs(args, states);
    expect((resolved.nested as Record<string, unknown>).inner).toBe("ok");
    expect(resolved.list).toEqual(["ok", "plain"]);
  });

  it("passes through non-string primitives", () => {
    const states = {};
    const args = { count: 5, flag: true };
    const resolved = resolveTemplateArgs(args as Record<string, unknown>, states);
    expect(resolved.count).toBe(5);
    expect(resolved.flag).toBe(true);
  });
});

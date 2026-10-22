import { afterEach, describe, expect, it, vi } from "vitest";

const { parseSpy } = vi.hoisted(() => ({ parseSpy: vi.fn() }));

vi.mock("../parser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parser.js")>();
  parseSpy.mockImplementation(actual.parse);
  return { ...actual, parse: parseSpy };
});

const { evaluateWhenClause, _resetWhenClauseCacheForTest } =
  await import("../evaluateWhenClause.js");

afterEach(() => {
  _resetWhenClauseCacheForTest();
  parseSpy.mockClear();
});

describe("evaluateWhenClause", () => {
  it("holds for a missing or empty clause without parsing", () => {
    expect(evaluateWhenClause(undefined, {})).toBe(true);
    expect(evaluateWhenClause("", {})).toBe(true);
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it("fails closed on a clause that does not parse, including whitespace", () => {
    expect(evaluateWhenClause("a &&", { a: true })).toBe(false);
    expect(evaluateWhenClause("   ", {})).toBe(false);
    expect(evaluateWhenClause("path =~ /x/", { path: "x" })).toBe(false);
  });

  it("hides on an unset key and keeps negation of one permissive", () => {
    expect(evaluateWhenClause("isGitBacked", {})).toBe(false);
    expect(evaluateWhenClause("!isGitBacked", {})).toBe(true);
  });

  it("re-evaluates a cached clause against each new context", () => {
    const clause = "activeSidebarView == 'worktrees' && acme.tools.ready";
    expect(evaluateWhenClause(clause, { activeSidebarView: "worktrees" })).toBe(false);
    expect(
      evaluateWhenClause(clause, {
        activeSidebarView: "worktrees",
        acme: { tools: { ready: true } },
      })
    ).toBe(true);
    expect(
      evaluateWhenClause(clause, {
        activeSidebarView: "acme.board",
        acme: { tools: { ready: true } },
      })
    ).toBe(false);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("parses a malformed clause once however often it is asked", () => {
    for (let i = 0; i < 5; i++) expect(evaluateWhenClause("(a", { a: true })).toBe(false);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest clause once the cache is full, and still answers it", () => {
    for (let i = 0; i < 300; i++) evaluateWhenClause(`k${i}`, {});
    parseSpy.mockClear();

    expect(evaluateWhenClause("k299", { k299: true })).toBe(true);
    expect(parseSpy).not.toHaveBeenCalled();

    expect(evaluateWhenClause("k0", { k0: true })).toBe(true);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });
});

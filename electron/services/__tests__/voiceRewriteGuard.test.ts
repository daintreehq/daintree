import { describe, expect, it } from "vitest";
import { validateRewrite } from "../voiceRewriteGuard.js";

describe("validateRewrite", () => {
  const selection =
    "um so basically can you fix @src/App.tsx so `npm test` passes with --watch, there are 3 failing tests";

  it("accepts a rewrite that rewords freely but keeps every protected span in order", () => {
    expect(
      validateRewrite(
        selection,
        "1. Fix @src/App.tsx.\n2. Make `npm test` pass with --watch (three tests fail)."
      )
    ).toEqual({ ok: true });
  });

  it("accepts a rewrite that shortens, renumbers and adds a negation", () => {
    expect(
      validateRewrite(
        selection,
        "Fix @src/App.tsx so `npm test` passes with --watch. Don't skip tests."
      )
    ).toEqual({ ok: true });
  });

  it("rejects a rewrite that drops, changes, reorders or invents a strict span", () => {
    const rejected = { ok: false, reason: "protected_span" };
    expect(validateRewrite(selection, "Fix the app so `npm test` passes with --watch.")).toEqual(
      rejected
    );
    expect(
      validateRewrite(selection, "Fix @src/app.tsx so `npm test` passes with --watch.")
    ).toEqual(rejected);
    expect(
      validateRewrite(selection, "With --watch, make `npm test` pass in @src/App.tsx.")
    ).toEqual(rejected);
    expect(
      validateRewrite(selection, "Fix @src/App.tsx so `npm test` passes with --watch --force.")
    ).toEqual(rejected);
  });

  it("rejects a rewrite that loses a path, but lets a new filename appear", () => {
    const withPath = "update docs/setup.md and mention the config";
    expect(validateRewrite(withPath, "Mention the config.")).toEqual({
      ok: false,
      reason: "protected_span",
    });
    expect(validateRewrite(withPath, "Update docs/setup.md to mention vite.config.ts.")).toEqual({
      ok: true,
    });
  });
});

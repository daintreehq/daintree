import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

function parse(promptTemplates: unknown, origin: PluginOrigin = "user") {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.templates",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes: { promptTemplates },
  });
}

const RECONCILE = {
  id: "reconcile",
  title: "Reconcile this month",
  description: "Match the month's ledger against the bank export.",
  body: "Reconcile {{month}} for {{ account }}.",
  args: [
    { name: "month", label: "Month", required: true },
    { name: "account", label: "Account" },
  ],
};

describe("contributes.promptTemplates schema (#13799)", () => {
  it("accepts a template and defaults the group and args to empty", () => {
    const result = parse([RECONCILE]);
    expect(result.success).toBe(true);

    const noArgs = parse([{ id: "plain", title: "Plain", description: "d", body: "Hello" }]);
    expect(noArgs.success && noArgs.data.contributes.promptTemplates[0]?.args).toEqual([]);

    const bare = getPluginManifestSchema("user").safeParse({ name: "acme.t", version: "1.0.0" });
    expect(bare.success && bare.data.contributes.promptTemplates).toEqual([]);
  });

  it("is available to a project plugin", () => {
    expect(parse([RECONCILE], "project").success).toBe(true);
  });

  it("rejects a duplicate template id and a duplicate argument name", () => {
    expect(parse([RECONCILE, RECONCILE]).success).toBe(false);
    const args = [RECONCILE.args[0], RECONCILE.args[0]];
    expect(parse([{ ...RECONCILE, args }]).success).toBe(false);
  });

  it("rejects a body reference with no declared argument", () => {
    const result = parse([{ ...RECONCILE, body: "Reconcile {{month}} and {{year}}." }]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("{{year}}"))).toBe(true);
    }
  });

  it("rejects a malformed reference and a malformed argument name", () => {
    expect(parse([{ ...RECONCILE, body: "Reconcile {{Month}}." }]).success).toBe(false);
    expect(parse([{ ...RECONCILE, body: "Reconcile {{}}." }]).success).toBe(false);
    const args = [{ name: "Month", label: "Month" }];
    expect(parse([{ ...RECONCILE, body: "x", args }]).success).toBe(false);
  });

  it("is strict and bounded", () => {
    expect(parse([{ ...RECONCILE, submit: true }]).success).toBe(false);
    expect(parse([{ ...RECONCILE, body: "" }]).success).toBe(false);
    expect(parse([{ ...RECONCILE, body: "x".repeat(8193), args: [] }]).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `a${i}`, label: "A" }));
    expect(parse([{ ...RECONCILE, body: "x", args: many }]).success).toBe(false);
  });
});

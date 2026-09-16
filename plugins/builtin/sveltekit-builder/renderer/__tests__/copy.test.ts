import { describe, expect, it } from "vitest";
import { z } from "zod";
import { middleTruncate, wireFailureMessage } from "../copy.js";

describe("wireFailureMessage", () => {
  /**
   * The rule, not the sentence: whatever we decide to say about a schema
   * mismatch, it must not be the validator's own payload. A `ZodError`'s
   * `.message` IS the raw issue array, and it was reaching the panel as the
   * user-facing explanation — eight lines of `invalid_union` / `discriminator`
   * / `"errors": []` wrapped in proportional type.
   */
  it("never surfaces a validator's payload as the explanation", () => {
    const schema = z.discriminatedUnion("status", [
      z.object({ status: z.literal("ready"), id: z.string() }),
      z.object({ status: z.literal("no-app") }),
    ]);
    let error: unknown;
    try {
      schema.parse({ status: "failed" });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeDefined();

    const message = wireFailureMessage(error, "Couldn't open the site source");

    for (const leak of ["invalid_union", "discriminator", "issues", "{", "[", '"code"']) {
      expect(message).not.toContain(leak);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message.split("\n")).toHaveLength(1);
  });

  /** Cross-realm: zod may be duplicated across the plugin and host bundles. */
  it("recognises a validator error that fails instanceof", () => {
    const foreign = Object.assign(new Error('[{"code":"invalid_union"}]'), {
      name: "ZodError",
      issues: [{ code: "invalid_union" }],
    });
    expect(wireFailureMessage(foreign, "fallback")).not.toContain("invalid_union");
  });

  /** A real runtime error says something the user can act on, and keeps it. */
  it("keeps a genuine runtime message", () => {
    const message = wireFailureMessage(
      new Error("EACCES: permission denied, open 'vite.config.ts'"),
      "Couldn't open the site source"
    );
    expect(message).toContain("EACCES");
  });
});

describe("middleTruncate", () => {
  /**
   * The rule: whatever gets dropped, the end survives. CSS `truncate` cuts the
   * right-hand side, which is where the filename and line number live — the
   * part the user came for.
   */
  it("keeps the filename and line when a path is too long", () => {
    const path = "src/routes/marketing/campaigns/spring/pricing/+page.svelte:126";
    const short = middleTruncate(path, 40);
    expect(short.length).toBeLessThanOrEqual(41);
    expect(short.endsWith("+page.svelte:126")).toBe(true);
    expect(short).toContain("…");
  });

  it("leaves a path that already fits completely alone", () => {
    const path = "src/routes/+page.svelte:6";
    expect(middleTruncate(path, 40)).toBe(path);
  });

  it("keeps the end even when the filename alone exceeds the budget", () => {
    const path = "src/AbsurdlyLongComponentNameThatGoesOnForever.svelte:12";
    const short = middleTruncate(path, 20);
    expect(short.endsWith("Forever.svelte:12")).toBe(true);
  });
});

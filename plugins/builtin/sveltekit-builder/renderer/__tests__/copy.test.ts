import { describe, expect, it } from "vitest";
import { z } from "zod";
import { wireFailureMessage } from "../copy.js";

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

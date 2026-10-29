import { describe, expect, it } from "vitest";
import { z } from "zod";
import { missingComponentSource, runtimeIssueMessage, wireFailureMessage } from "../copy.js";

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

describe("runtimeIssueMessage", () => {
  /**
   * What a request includes is the composer's Includes row's to say, and it
   * says when there is no screenshot. A verdict that listed the parts would
   * promise one the row then contradicts.
   */
  it.each(["not-dev-build", "metadata-unavailable", "extractor-failed"])(
    "does not list what a request carries for %s",
    (code) => {
      const message = runtimeIssueMessage(code, "svelte");
      expect(message).not.toBeNull();
      const said = `${message!.title} ${message!.body ?? ""}`;
      expect(said).not.toMatch(/screenshot|markup|styles|carries/i);
    }
  );

  it("still tells a production build's reader the way forward", () => {
    expect(runtimeIssueMessage("not-dev-build", undefined)?.body).toMatch(/dev server/);
  });
});

describe("missingComponentSource", () => {
  /** The identity's slot is the same sentence as the note under Send, which adds the name. */
  it("is one sentence, with the component named only where it can't be read from a header", () => {
    expect(missingComponentSource()).toBe("Couldn't find the source");
    expect(missingComponentSource("PricingCard")).toBe(
      `${missingComponentSource()} for PricingCard`
    );
  });
});

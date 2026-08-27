import { describe, expect, it } from "vitest";

import { normalizeToken, splitVariants } from "./classStrings.js";
import rule from "./no-raw-radius.js";
import { createRuleTester } from "./testHarness.mjs";

describe("splitVariants", () => {
  it("returns the whole token when there is no variant", () => {
    expect(splitVariants("rounded-md")).toEqual({ variants: "", base: "rounded-md" });
  });

  it("splits on the last variant separator", () => {
    expect(splitVariants("dark:hover:text-daintree-text")).toEqual({
      variants: "dark:hover",
      base: "text-daintree-text",
    });
  });

  it("ignores colons inside an arbitrary variant", () => {
    expect(splitVariants("data-[state=open]:bg-surface")).toEqual({
      variants: "data-[state=open]",
      base: "bg-surface",
    });
  });

  it("ignores colons inside an arbitrary value", () => {
    expect(splitVariants("text-[color:var(--x)]")).toEqual({
      variants: "",
      base: "text-[color:var(--x)]",
    });
  });

  it("separates a variant from a base that itself holds a colon", () => {
    expect(splitVariants("hover:text-[color:var(--x)]")).toEqual({
      variants: "hover",
      base: "text-[color:var(--x)]",
    });
  });
});

describe("normalizeToken", () => {
  it("strips the important marker from either end", () => {
    expect(normalizeToken("!rounded").base).toBe("rounded");
    expect(normalizeToken("rounded!").base).toBe("rounded");
    expect(normalizeToken("focus:!rounded").base).toBe("rounded");
  });
});

// The walker is exercised through a rule, because what matters is which class
// strings reach a predicate — not the shape of an intermediate array.
describe("class-string extraction", () => {
  const ruleTester = createRuleTester();

  ruleTester.run("extraction (via no-raw-radius)", rule, {
    valid: [
      {
        name: "a token split across an interpolation is not a token",
        code: "const a = `rounded${suffix} p-2`;",
      },
      {
        name: "class strings outside a className or class helper are out of scope",
        code: 'const doc = "write rounded, not rounded-lg";',
      },
      {
        name: "an interpolation-adjacent fragment is dropped from both sides",
        code: "const a = <div className={`p-1 rounded-${step} m-1`} />;",
      },
    ],
    invalid: [
      {
        name: "className string literal",
        code: 'const a = <div className="rounded p-2" />;',
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "nested cn() inside className is walked once, not twice",
        code: 'const a = <div className={cn("rounded", other)} />;',
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "cn() in a plain module with no JSX",
        code: 'export const ROW = cn("flex rounded");',
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "both arms of a ternary",
        code: 'const a = <div className={on ? "rounded" : "rounded-t"} />;',
        errors: [{ messageId: "unnamedStep" }, { messageId: "unnamedStep" }],
      },
      {
        name: "cva variant table values",
        code: 'const v = cva("base", { variants: { size: { sm: "rounded px-2" } } });',
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "clsx object keys",
        code: "const a = <div className={clsx({ rounded: on })} />;",
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "a complete token in a template literal quasi",
        code: "const a = <div className={`rounded ${extra}`} />;",
        errors: [{ messageId: "unnamedStep" }],
      },
    ],
  });
});

import { describe, expect, it } from "vitest";

import { normalizeToken, splitVariants } from "./classStrings.js";
import rule from "./no-raw-radius.js";
import { createRuleTester, createTsRuleTester } from "./testHarness.mjs";

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
        code: "const a = <div className={`rounded${suffix} p-2`} />;",
      },
      {
        name: "an interpolated literal that abuts text is a fragment, not a class",
        code: 'const a = <div className={`${"rounded"}-lg`} />;',
      },
      {
        name: "a cva option label is not a class",
        code: `const v = cva("", {
          variants: { shape: { rounded: "rounded-lg", square: "rounded-none" } },
          defaultVariants: { shape: "rounded" },
        });`,
      },
      {
        name: "a tv option label is not a class (its config is the first argument)",
        code: `const v = tv({ variants: { shape: { rounded: "rounded-lg" } } });`,
      },
      {
        name: "a cast does not smuggle a variant config past the structural read",
        code: `const v = cva("", { defaultVariants: { shape: "rounded" } });`,
      },
      {
        name: "a class-named lookup table's keys are labels, not classes",
        code: 'const editorStyles = { rounded: { borderRadius: "4px" } };',
      },
      {
        name: "a compound-variant selector is not a class",
        code: `const v = cva("", {
          variants: { shape: { rounded: "rounded-lg" } },
          compoundVariants: [{ shape: "rounded", class: "rounded-md" }],
        });`,
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
      {
        name: "an escaped newline separates tokens the way runtime whitespace does",
        code: "const a = <div className={`rounded\\np-2`} />;",
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "a class-string constant is a root of its own",
        code: 'const SECTION_HEADER_CLASS = "px-3 rounded";',
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "a plural camelCase class-string constant is a root",
        code: 'const rowClasses = "px-3 rounded";',
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "a conventionally named class prop is a root",
        code: 'const a = <Chip textClassName="rounded" />;',
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "a helper the root could not reach is still walked",
        code: 'const a = <div className={cn(items.map(() => cn("rounded")))} />;',
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "a quoted delimiter inside an arbitrary variant does not hide the utility",
        code: `const a = <div className="[&[data-x='(']]:rounded" />;`,
        errors: [{ messageId: "unnamedStep" }],
      },
    ],
  });
});

// The production parser is typescript-eslint; these shapes do not exist in Espree.
describe("class-string extraction under the TypeScript parser", () => {
  const ruleTester = createTsRuleTester();

  ruleTester.run("extraction (via no-raw-radius)", rule, {
    valid: [],
    invalid: [
      {
        name: "a cast does not hide the helper call",
        code: 'const a = <div className={cn("rounded") as string} />;',
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "a non-null assertion does not hide the class string",
        code: 'const a = <div className={cn("rounded"!)} />;',
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "a satisfies expression does not hide the class string",
        code: 'const a = <div className={cn("rounded" satisfies string)} />;',
        errors: [{ messageId: "unnamedStep" }],
      },
    ],
  });
});

import { describe } from "vitest";

import rule from "./no-raw-radius.js";
import { createRuleTester } from "./testHarness.mjs";

describe("no-raw-radius", () => {
  const ruleTester = createRuleTester();

  ruleTester.run("no-raw-radius", rule, {
    valid: [
      {
        name: "the named scale is the token scale",
        code: 'const a = <div className="rounded-sm rounded-md rounded-lg rounded-2xl" />;',
      },
      {
        name: "the same value spelled as an explicit token read",
        code: 'const a = <div className="rounded-[var(--radius-md)]" />;',
      },
      {
        name: "a custom property with a fallback",
        code: 'const a = <div className="rounded-[var(--toolbar-pill-radius,0.5rem)]" />;',
      },
      {
        name: "shape decisions rather than points on a scale",
        code: 'const a = <div className="rounded-full rounded-none" />;',
      },
      {
        name: "a side-scoped shape decision",
        code: 'const a = <div className="rounded-l-none rounded-r-full" />;',
      },
      {
        name: "a side-scoped named step",
        code: 'const a = <div className="rounded-t-lg rounded-b-[var(--radius-md)]" />;',
      },
      {
        name: "an unrelated utility that starts with the same word",
        code: 'const a = <div className="roundedish" />;',
      },
    ],
    invalid: [
      {
        name: "bare rounded leaves the step unnamed",
        code: 'const a = <div className="rounded p-2" />;',
        errors: [{ messageId: "unnamedStep", data: { token: "rounded" } }],
      },
      {
        name: "a bare side variant leaves it unnamed too",
        code: 'const a = <div className="rounded-t rounded-br" />;',
        errors: [
          { messageId: "unnamedStep", data: { token: "rounded-t" } },
          { messageId: "unnamedStep", data: { token: "rounded-br" } },
        ],
      },
      {
        name: "a hardcoded pixel radius",
        code: 'const a = <div className="rounded-[2px]" />;',
        errors: [{ messageId: "hardcoded", data: { token: "rounded-[2px]" } }],
      },
      {
        name: "a hardcoded fractional radius",
        code: 'const a = <div className="rounded-[1.5px]" />;',
        errors: [{ messageId: "hardcoded" }],
      },
      {
        name: "a hardcoded side radius",
        code: 'const a = <div className="rounded-l-[3px]" />;',
        errors: [{ messageId: "hardcoded", data: { token: "rounded-l-[3px]" } }],
      },
      {
        name: "a variant-prefixed bare radius",
        code: 'const a = <div className="hover:rounded" />;',
        errors: [{ messageId: "unnamedStep" }],
      },
    ],
  });
});

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
        name: "a logical-property side keeps its named step",
        code: 'const a = <div className="rounded-ss-lg rounded-ee-md" />;',
      },
      {
        name: "a logical-property side keeps its token read",
        code: 'const a = <div className="rounded-e-[var(--radius-md)]" />;',
      },
      {
        name: "a logical-property side keeps its shape decision",
        code: 'const a = <div className="rounded-es-none rounded-se-full" />;',
      },
      {
        name: "a scale step whose name starts with a side letter is not eaten",
        code: 'const a = <div className="rounded-sm rounded-es-sm" />;',
      },
      {
        name: "an arbitrary radius that reads a custom property",
        code: 'const a = <div className="rounded-[var(--radius-md)] rounded-[--pill-radius]" />;',
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
        name: "a bare logical-property side is still unnamed",
        code: 'const a = <div className="rounded-s rounded-ee" />;',
        errors: [
          { messageId: "unnamedStep", data: { token: "rounded-s" } },
          { messageId: "unnamedStep", data: { token: "rounded-ee" } },
        ],
      },
      {
        name: "an arbitrary variant does not hide the radius",
        code: 'const a = <div className="[&_svg]:rounded supports-[display:grid]:rounded" />;',
        errors: [{ messageId: "unnamedStep" }, { messageId: "unnamedStep" }],
      },
      {
        name: "the v4 trailing important marker is stripped before matching",
        code: 'const a = <div className="rounded!" />;',
        errors: [{ messageId: "unnamedStep" }],
      },
      {
        name: "a step the repo does not redefine is not on its scale",
        code: 'const a = <div className="rounded-4xl" />;',
        errors: [{ messageId: "hardcoded", data: { token: "rounded-4xl" } }],
      },
      {
        name: "a zero radius is still a literal",
        code: 'const a = <div className="rounded-[0]" />;',
        errors: [{ messageId: "hardcoded" }],
      },
      {
        name: "a computed radius is still a literal",
        code: 'const a = <div className="rounded-[calc(2px)]" />;',
        errors: [{ messageId: "hardcoded" }],
      },
      {
        name: "a multi-value radius is still a literal",
        code: 'const a = <div className="rounded-[2px_4px]" />;',
        errors: [{ messageId: "hardcoded" }],
      },
      {
        name: "a variant-prefixed bare radius",
        code: 'const a = <div className="hover:rounded" />;',
        errors: [{ messageId: "unnamedStep" }],
      },
    ],
  });
});

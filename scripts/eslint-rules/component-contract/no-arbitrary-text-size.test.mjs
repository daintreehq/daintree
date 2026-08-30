import { describe } from "vitest";

import rule from "./no-arbitrary-text-size.js";
import { createRuleTester } from "./testHarness.mjs";

describe("no-arbitrary-text-size", () => {
  const ruleTester = createRuleTester();

  ruleTester.run("no-arbitrary-text-size", rule, {
    valid: [
      {
        name: "a named step on the type scale",
        code: 'const a = <div className="text-xs text-2xl" />;',
      },
      {
        name: "an arbitrary hex colour shares the spelling but is not a size",
        code: 'const a = <div className="text-[#0b1220]" />;',
      },
      {
        name: "a bare colour keyword",
        code: 'const a = <div className="text-[red] text-[CanvasText]" />;',
      },
      {
        name: "a custom-property colour read",
        code: 'const a = <div className="text-[var(--color-state-active)]" />;',
      },
      {
        name: "an explicit colour hint",
        code: 'const a = <div className="text-[color:var(--x)] text-[color-mix(in_oklab,red,blue)]" />;',
      },
      {
        name: "the paren shorthand for a custom-property colour",
        code: 'const a = <div className="text-(--brand-fg)" />;',
      },
      {
        name: "a text-shadow utility is not a font size",
        code: 'const a = <div className="text-shadow-sm" />;',
      },
      {
        name: "a non-size text utility",
        code: 'const a = <div className="text-center text-balance" />;',
      },
    ],
    invalid: [
      {
        name: "an arbitrary pixel size",
        code: 'const a = <div className="text-[11px]" />;',
        errors: [{ messageId: "arbitrarySize", data: { token: "text-[11px]" } }],
      },
      {
        name: "an arbitrary rem size",
        code: 'const a = <div className="text-[0.65rem]" />;',
        errors: [{ messageId: "arbitrarySize" }],
      },
      {
        name: "an explicit length hint",
        code: 'const a = <div className="text-[length:var(--label-size)]" />;',
        errors: [{ messageId: "arbitrarySize" }],
      },
      {
        name: "the size half of a size / leading shorthand",
        code: 'const a = <div className="text-[10px]/3" />;',
        errors: [{ messageId: "arbitrarySize", data: { token: "text-[10px]/3" } }],
      },
      {
        name: "the paren shorthand with an explicit length hint",
        code: 'const a = <div className="text-(length:--label-size)" />;',
        errors: [{ messageId: "arbitrarySize", data: { token: "text-(length:--label-size)" } }],
      },
      {
        name: "an arbitrary size computed with calc",
        code: 'const a = <div className="text-[calc(1rem+1px)]" />;',
        errors: [{ messageId: "arbitrarySize", data: { token: "text-[calc(1rem+1px)]" } }],
      },
      {
        name: "an arbitrary size in container units",
        code: 'const a = <div className="text-[1cqi]" />;',
        errors: [{ messageId: "arbitrarySize" }],
      },
      {
        name: "an arbitrary size given as a CSS size keyword",
        code: 'const a = <div className="text-[small]" />;',
        errors: [{ messageId: "arbitrarySize" }],
      },
      {
        name: "a variant-prefixed arbitrary size",
        code: 'const a = <div className="md:text-[13px]" />;',
        errors: [{ messageId: "arbitrarySize", data: { token: "text-[13px]" } }],
      },
    ],
  });
});

import { describe } from "vitest";

import rule from "./no-text-color-slash-alpha.js";
import { createRuleTester } from "./testHarness.mjs";

describe("no-text-color-slash-alpha", () => {
  const ruleTester = createRuleTester();

  ruleTester.run("no-text-color-slash-alpha", rule, {
    valid: [
      {
        name: "a solid text token",
        code: 'const a = <div className="text-text-secondary" />;',
      },
      {
        name: "alpha on a surface, which composites against a known background",
        code: 'const a = <div className="bg-status-error/10 border-border-default/50" />;',
      },
      {
        name: "the font-size / line-height shorthand",
        code: 'const a = <div className="text-sm/6 text-2xl/tight" />;',
      },
      {
        name: "the shorthand with an arbitrary size",
        code: 'const a = <div className="text-[11px]/4" />;',
      },
      {
        name: "a text-shadow alpha is a shadow modifier, not the glyph colour",
        code: 'const a = <div className="text-shadow-sm/50" />;',
      },
      {
        name: "the shorthand with a calc size",
        code: 'const a = <div className="text-[calc(1rem+1px)]/4" />;',
      },
      {
        name: "the shorthand with an explicit length hint",
        code: 'const a = <div className="text-(length:--label-size)/4" />;',
      },
      {
        name: "the shorthand on a custom step the doc tells you to add",
        code: 'const a = <div className="text-2xs/4" />;',
      },
      {
        name: "a bare size utility with no slash",
        code: 'const a = <div className="text-xs text-center" />;',
      },
    ],
    invalid: [
      {
        name: "alpha on a semantic text token",
        code: 'const a = <div className="text-text-secondary/70" />;',
        errors: [{ messageId: "slashAlpha", data: { token: "text-text-secondary/70" } }],
      },
      {
        name: "alpha on a legacy alias",
        code: 'const a = <div className="text-daintree-text/60" />;',
        errors: [{ messageId: "slashAlpha" }],
      },
      {
        name: "alpha on a Tailwind palette colour",
        code: 'const a = <div className="text-red-500/50" />;',
        errors: [{ messageId: "slashAlpha" }],
      },
      {
        name: "a variant-prefixed fade still fades the label",
        code: 'const a = <div className="hover:text-status-error/80" />;',
        errors: [{ messageId: "slashAlpha", data: { token: "text-status-error/80" } }],
      },
      {
        name: "alpha on an arbitrary colour value",
        code: 'const a = <div className="text-[var(--color-state-active)]/70" />;',
        errors: [{ messageId: "slashAlpha" }],
      },
      {
        name: "alpha on the paren custom-property shorthand",
        code: 'const a = <div className="text-(--brand-fg)/50" />;',
        errors: [{ messageId: "slashAlpha", data: { token: "text-(--brand-fg)/50" } }],
      },
      {
        name: "an arbitrary alpha value",
        code: 'const a = <div className="text-text-muted/[0.35]" />;',
        errors: [{ messageId: "slashAlpha" }],
      },
    ],
  });
});

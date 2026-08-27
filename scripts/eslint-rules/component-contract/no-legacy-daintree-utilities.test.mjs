import { describe } from "vitest";

import rule from "./no-legacy-daintree-utilities.js";
import { createRuleTester } from "./testHarness.mjs";

describe("no-legacy-daintree-utilities", () => {
  const ruleTester = createRuleTester();

  ruleTester.run("no-legacy-daintree-utilities", rule, {
    valid: [
      {
        name: "the semantic token the alias stands for",
        code: 'const a = <div className="text-text-primary bg-surface-canvas" />;',
      },
      {
        name: "a custom-property read inside an arbitrary value",
        code: 'const a = <div className="bg-[color-mix(in_oklab,var(--color-daintree-text)_90%,transparent)]" />;',
      },
      {
        name: "an unrelated utility that merely contains the word",
        code: 'const a = <div className="daintree-panel" />;',
      },
    ],
    invalid: [
      {
        name: "names the mapped replacement, preserving the utility prefix",
        code: 'const a = <div className="text-daintree-text" />;',
        errors: [
          {
            messageId: "mapped",
            data: { token: "text-daintree-text", replacement: "text-text-primary" },
          },
        ],
      },
      {
        name: "a different prefix maps to the same token",
        code: 'const a = <div className="border-daintree-border" />;',
        errors: [
          {
            messageId: "mapped",
            data: { token: "border-daintree-border", replacement: "border-border-default" },
          },
        ],
      },
      {
        name: "a multi-segment prefix survives the rewrite",
        code: 'const a = <div className="inset-ring-daintree-accent" />;',
        errors: [
          {
            messageId: "mapped",
            data: { token: "inset-ring-daintree-accent", replacement: "inset-ring-accent-primary" },
          },
        ],
      },
      {
        name: "an alpha suffix is carried through to the replacement",
        code: 'const a = <div className="outline-daintree-accent/40" />;',
        errors: [
          {
            messageId: "mapped",
            data: {
              token: "outline-daintree-accent/40",
              replacement: "outline-accent-primary/40",
            },
          },
        ],
      },
      {
        name: "variants are stripped before matching",
        code: 'const a = <div className="hover:bg-daintree-sidebar" />;',
        errors: [
          {
            messageId: "mapped",
            data: { token: "bg-daintree-sidebar", replacement: "bg-surface-sidebar" },
          },
        ],
      },
      {
        name: "an alias with no mapping still reports",
        code: 'const a = <div className="text-daintree-assistant" />;',
        errors: [{ messageId: "unmapped", data: { token: "text-daintree-assistant" } }],
      },
    ],
  });
});

import { describe } from "vitest";

import rule from "./no-raw-shadow.js";
import { createRuleTester } from "./testHarness.mjs";

describe("no-raw-shadow", () => {
  const ruleTester = createRuleTester();

  ruleTester.run("no-raw-shadow", rule, {
    valid: [
      {
        name: "theme shadow tokens",
        code: 'const a = <div className="shadow-[var(--theme-shadow-floating)] hover:shadow-[var(--theme-shadow-dialog)]" />;',
      },
      {
        name: "the repo's named shadow stacks",
        code: 'const a = <div className="shadow-overlay shadow-modal shadow-floating shadow-ambient" />;',
      },
      {
        name: "the inset token under a variant",
        code: 'const a = <div className="active:shadow-[var(--shadow-inset)]" />;',
      },
      {
        name: "removing a shadow",
        code: 'const a = <div className="shadow-none inset-shadow-none" />;',
      },
      {
        name: "a shadow colour utility",
        code: 'const a = <div className="shadow-tint/10" />;',
      },
      {
        name: "arbitrary values are someone else's decision",
        code: 'const a = <div className="inset-shadow-[0_1px_0_rgba(255,255,255,0.15)] shadow-(--my-shadow)" />;',
      },
      {
        name: "a drop-shadow filter is not a box shadow",
        code: 'const a = <span className="drop-shadow-sm" />;',
      },
    ],
    invalid: [
      {
        name: "a stock step",
        code: 'const a = <div className="rounded-md shadow-sm" />;',
        errors: [{ messageId: "stock", data: { token: "shadow-sm" } }],
      },
      {
        name: "bare shadow",
        code: 'const a = <div className="shadow" />;',
        errors: [{ messageId: "stock", data: { token: "shadow" } }],
      },
      {
        name: "the large steps a side sheet reaches for",
        code: 'const a = <div className="shadow-2xl hover:shadow-xl" />;',
        errors: [
          { messageId: "stock", data: { token: "shadow-2xl" } },
          { messageId: "stock", data: { token: "shadow-xl" } },
        ],
      },
      {
        name: "shadow-inner under a variant",
        code: 'const a = <button className="active:shadow-inner" />;',
        errors: [{ messageId: "stock", data: { token: "shadow-inner" } }],
      },
      {
        name: "the inset scale",
        code: 'const a = <div className="inset-shadow-xs inset-shadow" />;',
        errors: [
          { messageId: "stock", data: { token: "inset-shadow-xs" } },
          { messageId: "stock", data: { token: "inset-shadow" } },
        ],
      },
      {
        name: "important modifier does not hide it",
        code: 'const a = <div className="!shadow-md" />;',
        errors: [{ messageId: "stock", data: { token: "shadow-md" } }],
      },
      {
        name: "an opacity modifier does not make it a token",
        code: 'const a = <div className="shadow-sm/20 inset-shadow-xs/25" />;',
        errors: [
          { messageId: "stock", data: { token: "shadow-sm" } },
          { messageId: "stock", data: { token: "inset-shadow-xs" } },
        ],
      },
      {
        name: "a class-string constant",
        code: 'const CARD_SURFACE_CLASS = "border shadow-md";',
        errors: [{ messageId: "stock", data: { token: "shadow-md" } }],
      },
      {
        name: "inside cn()",
        code: 'const a = cn("p-2", "shadow-lg");',
        errors: [{ messageId: "stock", data: { token: "shadow-lg" } }],
      },
    ],
  });
});

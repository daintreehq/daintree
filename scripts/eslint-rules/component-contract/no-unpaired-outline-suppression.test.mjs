import { describe } from "vitest";

import rule from "./no-unpaired-outline-suppression.js";
import { createRuleTester } from "./testHarness.mjs";

describe("no-unpaired-outline-suppression", () => {
  const ruleTester = createRuleTester();

  ruleTester.run("no-unpaired-outline-suppression", rule, {
    valid: [
      {
        name: "suppression paired with a focus-visible ring",
        code: 'const a = <button className="outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary" />;',
      },
      {
        name: "suppression paired with a focus border",
        code: 'const a = <input className="outline-hidden focus:border-accent-primary" />;',
      },
      {
        name: "focus-within on a wrapper that owns the indicator",
        code: 'const a = <label className="outline-hidden focus-within:ring-1" />;',
      },
      {
        name: "the codebase macro-focus mechanism counts",
        code: 'const a = <div className="outline-hidden data-[macro-focus=true]:ring-2" />;',
      },
      {
        name: "the fallback may live in a sibling cn() argument",
        code: 'const a = <div className={cn("outline-hidden", "focus-visible:outline-2")} />;',
      },
      {
        name: "the fallback may live in the other arm of a ternary",
        code: 'const a = <div className={cn("outline-hidden", on ? "focus:ring-1" : "p-2")} />;',
      },
      {
        name: "no suppression at all",
        code: 'const a = <div className="p-2 rounded-md" />;',
      },
    ],
    invalid: [
      {
        name: "bare suppression with nothing painted in its place",
        code: 'const a = <button className="outline-hidden px-2" />;',
        errors: [{ messageId: "unpaired", data: { token: "outline-hidden" } }],
      },
      {
        name: "a parent-state variant is not an element-owned indicator",
        code: 'const a = <div className="outline-hidden group-focus:ring-2" />;',
        errors: [{ messageId: "unpaired" }],
      },
      {
        name: "a sibling-state variant is not one either",
        code: 'const a = <div className="outline-hidden peer-focus-visible:ring-2" />;',
        errors: [{ messageId: "unpaired" }],
      },
      {
        name: "a focus variant that only suppresses again is not a fallback",
        code: 'const a = <div className="outline-hidden focus:outline-none" />;',
        errors: [{ messageId: "unpaired" }, { messageId: "unsafeOutlineNone" }],
      },
      {
        name: "focus:ring-0 removes rather than paints",
        code: 'const a = <div className="outline-hidden focus:ring-0" />;',
        errors: [{ messageId: "unpaired" }],
      },
      {
        name: "outline-none is unsafe in v4 even when paired",
        code: 'const a = <div className="outline-none focus-visible:ring-2" />;',
        errors: [{ messageId: "unsafeOutlineNone" }],
      },
      {
        name: "a variant-scoped suppression with no replacement",
        code: 'const a = <div className="focus:outline-hidden px-2" />;',
        errors: [{ messageId: "unpaired", data: { token: "focus:outline-hidden" } }],
      },
    ],
  });
});

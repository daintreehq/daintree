import { describe, it, expect } from "vitest";
import { assistantSkipsDaintreeConfirmations } from "../assistantDaintreeConfirmations.js";

describe("assistantSkipsDaintreeConfirmations (#12874)", () => {
  it("skips only while inheriting a global Skip permission prompts that is on", () => {
    expect(assistantSkipsDaintreeConfirmations("inherit", true)).toBe(true);
    expect(assistantSkipsDaintreeConfirmations(undefined, true)).toBe(true);
  });

  it("can only make it stricter", () => {
    expect(assistantSkipsDaintreeConfirmations("always-ask", true)).toBe(false);
    expect(assistantSkipsDaintreeConfirmations("inherit", false)).toBe(false);
    expect(assistantSkipsDaintreeConfirmations("inherit", undefined)).toBe(false);
    expect(assistantSkipsDaintreeConfirmations("always-ask", false)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  assistantSkipsDaintreeConfirmations,
  isHelpAssistantDaintreeConfirmations,
} from "../assistantDaintreeConfirmations.js";

describe("assistantSkipsDaintreeConfirmations (#12874, #12989)", () => {
  it("follows the global Skip permission prompts while inheriting", () => {
    expect(assistantSkipsDaintreeConfirmations("inherit", true)).toBe(true);
    expect(assistantSkipsDaintreeConfirmations(undefined, true)).toBe(true);
    expect(assistantSkipsDaintreeConfirmations("inherit", false)).toBe(false);
    expect(assistantSkipsDaintreeConfirmations("inherit", undefined)).toBe(false);
  });

  it("never skips under always-ask", () => {
    expect(assistantSkipsDaintreeConfirmations("always-ask", true)).toBe(false);
    expect(assistantSkipsDaintreeConfirmations("always-ask", false)).toBe(false);
  });

  it("always skips under never-ask, whatever the global says", () => {
    expect(assistantSkipsDaintreeConfirmations("never-ask", false)).toBe(true);
    expect(assistantSkipsDaintreeConfirmations("never-ask", undefined)).toBe(true);
    expect(assistantSkipsDaintreeConfirmations("never-ask", true)).toBe(true);
  });

  it("reads an unrecognised preference as inherit", () => {
    const unknown = "skip" as unknown as "inherit";
    expect(assistantSkipsDaintreeConfirmations(unknown, false)).toBe(false);
    expect(assistantSkipsDaintreeConfirmations(unknown, true)).toBe(true);
  });
});

describe("isHelpAssistantDaintreeConfirmations", () => {
  it("accepts exactly the three stored values", () => {
    expect(isHelpAssistantDaintreeConfirmations("inherit")).toBe(true);
    expect(isHelpAssistantDaintreeConfirmations("always-ask")).toBe(true);
    expect(isHelpAssistantDaintreeConfirmations("never-ask")).toBe(true);
    expect(isHelpAssistantDaintreeConfirmations("skip")).toBe(false);
    expect(isHelpAssistantDaintreeConfirmations(undefined)).toBe(false);
    expect(isHelpAssistantDaintreeConfirmations(true)).toBe(false);
  });
});

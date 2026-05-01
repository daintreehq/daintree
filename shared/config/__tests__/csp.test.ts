import { describe, expect, it } from "vitest";
import {
  TRUSTED_TYPES_POLICY_NAME,
  getDaintreeAppCSP,
  getDaintreeAppDevCSP,
  getDaintreeAppProdCSP,
} from "../csp.js";

describe("Daintree app CSP", () => {
  it("requires Trusted Types for script in production", () => {
    const csp = getDaintreeAppProdCSP();
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain(`trusted-types ${TRUSTED_TYPES_POLICY_NAME} 'allow-duplicates'`);
  });

  it("requires Trusted Types for script in development", () => {
    const csp = getDaintreeAppDevCSP();
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain(`trusted-types ${TRUSTED_TYPES_POLICY_NAME} 'allow-duplicates'`);
  });

  it("does not register a default Trusted Types policy", () => {
    expect(getDaintreeAppProdCSP()).not.toMatch(/trusted-types[^;]*\bdefault\b/);
    expect(getDaintreeAppDevCSP()).not.toMatch(/trusted-types[^;]*\bdefault\b/);
  });

  it("getDaintreeAppCSP routes to dev or prod based on flag", () => {
    expect(getDaintreeAppCSP(true)).toBe(getDaintreeAppDevCSP());
    expect(getDaintreeAppCSP(false)).toBe(getDaintreeAppProdCSP());
  });
});

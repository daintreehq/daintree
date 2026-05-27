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
    expect(csp).toContain(`trusted-types ${TRUSTED_TYPES_POLICY_NAME} default 'allow-duplicates'`);
  });

  it("requires Trusted Types for script in development", () => {
    const csp = getDaintreeAppDevCSP();
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain(`trusted-types ${TRUSTED_TYPES_POLICY_NAME} default 'allow-duplicates'`);
  });

  it("registers a default Trusted Types policy for React/Radix DOM sinks", () => {
    expect(getDaintreeAppProdCSP()).toMatch(/trusted-types[^;]*\bdefault\b/);
    expect(getDaintreeAppDevCSP()).toMatch(/trusted-types[^;]*\bdefault\b/);
  });

  it("getDaintreeAppCSP routes to dev or prod based on flag", () => {
    expect(getDaintreeAppCSP(true)).toBe(getDaintreeAppDevCSP());
    expect(getDaintreeAppCSP(false)).toBe(getDaintreeAppProdCSP());
  });

  it("allows the plugin: scheme in script/connect/img/style directives (prod and dev)", () => {
    for (const csp of [getDaintreeAppProdCSP(), getDaintreeAppDevCSP()]) {
      const directive = (name: string) =>
        csp
          .split(";")
          .map((d) => d.trim())
          .find((d) => d.startsWith(`${name} `)) ?? "";
      expect(directive("script-src")).toContain("plugin:");
      expect(directive("connect-src")).toContain("plugin:");
      expect(directive("img-src")).toContain("plugin:");
      expect(directive("style-src")).toContain("plugin:");
    }
  });
});

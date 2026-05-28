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

  describe("scriptSrcHashes option", () => {
    it("appends a single hash to script-src in production", () => {
      const csp = getDaintreeAppProdCSP({ scriptSrcHashes: ["'sha256-abc123'"] });
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-abc123'");
    });

    it("appends multiple hashes space-separated in production", () => {
      const csp = getDaintreeAppProdCSP({
        scriptSrcHashes: ["'sha256-aaa'", "'sha256-bbb'"],
      });
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-aaa' 'sha256-bbb'");
    });

    it("omits the hash list when scriptSrcHashes is empty", () => {
      const csp = getDaintreeAppProdCSP({ scriptSrcHashes: [] });
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
      expect(csp).not.toMatch(/'sha256-/);
    });

    it("omits the hash list when options is undefined", () => {
      expect(getDaintreeAppProdCSP()).toBe(getDaintreeAppProdCSP({ scriptSrcHashes: [] }));
    });

    it("does not modify the dev CSP even when hashes are provided", () => {
      const csp = getDaintreeAppCSP(true, { scriptSrcHashes: ["'sha256-abc'"] });
      expect(csp).toBe(getDaintreeAppDevCSP());
      expect(csp).not.toMatch(/'sha256-/);
    });

    it("threads scriptSrcHashes through getDaintreeAppCSP to the prod variant", () => {
      const csp = getDaintreeAppCSP(false, { scriptSrcHashes: ["'sha256-xyz'"] });
      expect(csp).toContain("'sha256-xyz'");
    });
  });
});

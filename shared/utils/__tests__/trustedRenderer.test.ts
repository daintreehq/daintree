import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRecoveryPageUrl, isTrustedRendererUrl, getTrustedOrigins } from "../trustedRenderer.js";

describe("trustedRenderer", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDevServerUrl = process.env.DAINTREE_DEV_SERVER_URL;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    delete process.env.DAINTREE_DEV_SERVER_URL;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalDevServerUrl === undefined) {
      delete process.env.DAINTREE_DEV_SERVER_URL;
    } else {
      process.env.DAINTREE_DEV_SERVER_URL = originalDevServerUrl;
    }
  });

  describe("isTrustedRendererUrl", () => {
    it("should allow production app:// origin", () => {
      expect(isTrustedRendererUrl("app://daintree")).toBe(true);
      expect(isTrustedRendererUrl("app://daintree/")).toBe(true);
      expect(isTrustedRendererUrl("app://daintree/path/to/page")).toBe(true);
    });

    it("should allow localhost:5173 dev origin", () => {
      expect(isTrustedRendererUrl("http://localhost:5173")).toBe(true);
      expect(isTrustedRendererUrl("http://localhost:5173/")).toBe(true);
      expect(isTrustedRendererUrl("http://localhost:5173/path")).toBe(true);
    });

    it("should allow 127.0.0.1:5173 dev origin", () => {
      expect(isTrustedRendererUrl("http://127.0.0.1:5173")).toBe(true);
      expect(isTrustedRendererUrl("http://127.0.0.1:5173/")).toBe(true);
      expect(isTrustedRendererUrl("http://127.0.0.1:5173/path")).toBe(true);
    });

    it("should reject untrusted origins", () => {
      expect(isTrustedRendererUrl("https://evil.com")).toBe(false);
      expect(isTrustedRendererUrl("http://localhost:3000")).toBe(false);
      expect(isTrustedRendererUrl("http://127.0.0.1:8080")).toBe(false);
      expect(isTrustedRendererUrl("file:///etc/passwd")).toBe(false);
      expect(isTrustedRendererUrl("app://different-app")).toBe(false);
    });

    it("should reject localhost with https protocol", () => {
      expect(isTrustedRendererUrl("https://localhost:5173")).toBe(false);
    });

    it("should reject localhost without port", () => {
      expect(isTrustedRendererUrl("http://localhost")).toBe(false);
      expect(isTrustedRendererUrl("http://127.0.0.1")).toBe(false);
    });

    it("should reject app protocol with non-standard port", () => {
      expect(isTrustedRendererUrl("app://daintree:1234")).toBe(false);
    });

    it("should reject userinfo tricks", () => {
      expect(isTrustedRendererUrl("http://localhost:5173@evil.com")).toBe(false);
      // Note: http://evil.com@localhost:5173 is correctly parsed as host=localhost with userinfo=evil.com
      // This is actually a valid localhost URL per URL spec, so we accept it
      expect(isTrustedRendererUrl("http://evil.com@localhost:5173")).toBe(true);
    });

    it("should allow query strings and hash fragments", () => {
      expect(isTrustedRendererUrl("http://localhost:5173/?foo=bar")).toBe(true);
      expect(isTrustedRendererUrl("http://localhost:5173/#/path")).toBe(true);
      expect(isTrustedRendererUrl("app://daintree/index.html?v=1")).toBe(true);
      expect(isTrustedRendererUrl("app://daintree/#/settings")).toBe(true);
    });

    it("should handle malformed URLs", () => {
      expect(isTrustedRendererUrl("")).toBe(false);
      expect(isTrustedRendererUrl("not-a-url")).toBe(false);
      expect(isTrustedRendererUrl("://broken")).toBe(false);
      expect(isTrustedRendererUrl("http://")).toBe(false);
    });

    it("should normalize protocol and hostname to lowercase per URL spec", () => {
      expect(isTrustedRendererUrl("HTTP://localhost:5173")).toBe(true);
      expect(isTrustedRendererUrl("http://LOCALHOST:5173")).toBe(true);
      expect(isTrustedRendererUrl("APP://daintree")).toBe(true);
    });

    it("should allow an env-configured dev origin", () => {
      process.env.DAINTREE_DEV_SERVER_URL = "http://127.0.0.1:6123";

      expect(isTrustedRendererUrl("http://127.0.0.1:6123")).toBe(true);
      expect(isTrustedRendererUrl("http://localhost:6123")).toBe(true);
      expect(isTrustedRendererUrl("http://localhost:5173")).toBe(false);
    });
  });

  describe("getTrustedOrigins", () => {
    it("should return all trusted origins including dev origins in development", () => {
      const origins = getTrustedOrigins();
      expect(origins).toContain("app://daintree");
      expect(origins).toContain("http://localhost:5173");
      expect(origins).toContain("http://127.0.0.1:5173");
    });
  });

  describe("isRecoveryPageUrl", () => {
    it("accepts production recovery URL", () => {
      expect(isRecoveryPageUrl("app://daintree/recovery.html")).toBe(true);
    });

    it("accepts dev recovery URLs on both localhost and 127.0.0.1", () => {
      expect(isRecoveryPageUrl("http://localhost:5173/recovery.html")).toBe(true);
      expect(isRecoveryPageUrl("http://127.0.0.1:5173/recovery.html")).toBe(true);
    });

    it("accepts recovery URL with query string", () => {
      expect(isRecoveryPageUrl("app://daintree/recovery.html?reason=crash&exitCode=-1")).toBe(true);
    });

    it("rejects main index page URL", () => {
      expect(isRecoveryPageUrl("app://daintree/index.html")).toBe(false);
      expect(isRecoveryPageUrl("http://localhost:5173/index.html")).toBe(false);
    });

    it("rejects recovery.html on untrusted origin", () => {
      expect(isRecoveryPageUrl("https://evil.com/recovery.html")).toBe(false);
      expect(isRecoveryPageUrl("http://localhost:3000/recovery.html")).toBe(false);
    });

    it("rejects malformed URLs", () => {
      expect(isRecoveryPageUrl("")).toBe(false);
      expect(isRecoveryPageUrl("not-a-url")).toBe(false);
    });

    it("rejects recovery-like paths that are not /recovery.html", () => {
      expect(isRecoveryPageUrl("app://daintree/recovery")).toBe(false);
      expect(isRecoveryPageUrl("app://daintree/recovery.html/evil")).toBe(false);
      expect(isRecoveryPageUrl("app://daintree/subdir/recovery.html")).toBe(false);
    });

    it("rejects localhost recovery URLs in production mode", () => {
      process.env.NODE_ENV = "production";
      expect(isRecoveryPageUrl("http://localhost:5173/recovery.html")).toBe(false);
      expect(isRecoveryPageUrl("http://127.0.0.1:5173/recovery.html")).toBe(false);
      expect(isRecoveryPageUrl("app://daintree/recovery.html")).toBe(true);
    });
  });
});

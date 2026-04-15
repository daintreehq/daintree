import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTrustedRendererUrl, getTrustedOrigins } from "../trustedRenderer.js";

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
      expect(isTrustedRendererUrl("app://canopy")).toBe(true);
      expect(isTrustedRendererUrl("app://canopy/")).toBe(true);
      expect(isTrustedRendererUrl("app://canopy/path/to/page")).toBe(true);
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
      expect(isTrustedRendererUrl("app://canopy:1234")).toBe(false);
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
      expect(isTrustedRendererUrl("app://canopy/index.html?v=1")).toBe(true);
      expect(isTrustedRendererUrl("app://canopy/#/settings")).toBe(true);
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
      expect(isTrustedRendererUrl("APP://canopy")).toBe(true);
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
      expect(origins).toContain("app://canopy");
      expect(origins).toContain("http://localhost:5173");
      expect(origins).toContain("http://127.0.0.1:5173");
    });
  });
});

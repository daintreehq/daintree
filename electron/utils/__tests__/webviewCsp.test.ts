import { describe, it, expect } from "vitest";
import {
  classifyPartition,
  getLocalhostDevCSP,
  mergeCspHeaders,
  isDevPreviewPartition,
} from "../webviewCsp.js";
import type { OnHeadersReceivedListenerDetails } from "electron";

describe("webviewCsp", () => {
  describe("isDevPreviewPartition", () => {
    it("identifies exact dev-preview partition", () => {
      expect(isDevPreviewPartition("persist:dev-preview")).toBe(true);
    });

    it("identifies dynamic dev-preview partitions", () => {
      expect(isDevPreviewPartition("persist:dev-preview-myproject-main-panel1")).toBe(true);
      expect(isDevPreviewPartition("persist:dev-preview-foo-bar-baz")).toBe(true);
    });

    it("rejects malformed dev-preview partitions", () => {
      expect(isDevPreviewPartition("persist:dev-previewevil")).toBe(false);
      expect(isDevPreviewPartition("persist:dev-preview")).toBe(true);
      expect(isDevPreviewPartition("persist:dev-preview-")).toBe(true);
    });

    it("returns false for other partitions", () => {
      expect(isDevPreviewPartition("persist:browser")).toBe(false);
      expect(isDevPreviewPartition("persist:sidecar")).toBe(false);
      expect(isDevPreviewPartition("persist:unknown")).toBe(false);
    });
  });

  describe("classifyPartition", () => {
    it("identifies browser partition", () => {
      expect(classifyPartition("persist:browser")).toBe("browser");
    });

    it("identifies sidecar partition", () => {
      expect(classifyPartition("persist:sidecar")).toBe("sidecar");
    });

    it("identifies dev-preview partition", () => {
      expect(classifyPartition("persist:dev-preview")).toBe("dev-preview");
    });

    it("identifies dynamic dev-preview partitions", () => {
      expect(classifyPartition("persist:dev-preview-myproject-main-panel1")).toBe("dev-preview");
      expect(classifyPartition("persist:dev-preview-foo-bar-baz")).toBe("dev-preview");
    });

    it("rejects malformed dev-preview partitions as unknown", () => {
      expect(classifyPartition("persist:dev-previewevil")).toBe("unknown");
    });

    it("returns unknown for unrecognized partitions", () => {
      expect(classifyPartition("persist:unknown")).toBe("unknown");
      expect(classifyPartition("some-random-partition")).toBe("unknown");
      expect(classifyPartition("")).toBe("unknown");
    });
  });

  describe("getLocalhostDevCSP", () => {
    it("returns a localhost-restricted CSP policy", () => {
      const csp = getLocalhostDevCSP();

      expect(csp).toContain("default-src 'self' http://localhost:* http://127.0.0.1:*");
      expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
      expect(csp).toContain("connect-src 'self' ws://localhost:* ws://127.0.0.1:*");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
    });

    it("includes secure localhost support (https and wss)", () => {
      const csp = getLocalhostDevCSP();

      expect(csp).toContain("https://localhost:*");
      expect(csp).toContain("https://127.0.0.1:*");
      expect(csp).toContain("wss://localhost:*");
      expect(csp).toContain("wss://127.0.0.1:*");
    });

    it("does not allow non-localhost external origins", () => {
      const csp = getLocalhostDevCSP();

      // Should have https://localhost but not https: wildcard
      expect(csp).toContain("https://localhost:*");
      expect(csp).not.toMatch(/https:\s/); // No bare "https:" wildcard
      expect(csp).not.toContain("http://example.com");
    });
  });

  describe("mergeCspHeaders", () => {
    it("adds CSP header when none exists", () => {
      const details = {
        responseHeaders: {
          "content-type": ["text/html"],
        },
      } as Partial<OnHeadersReceivedListenerDetails> as OnHeadersReceivedListenerDetails;

      const result = mergeCspHeaders(details, "default-src 'self'");

      expect(result["Content-Security-Policy"]).toEqual(["default-src 'self'"]);
      expect(result["content-type"]).toEqual(["text/html"]);
    });

    it("replaces existing CSP header (case-sensitive)", () => {
      const details = {
        responseHeaders: {
          "Content-Security-Policy": ["default-src 'none'"],
          "content-type": ["text/html"],
        },
      } as Partial<OnHeadersReceivedListenerDetails> as OnHeadersReceivedListenerDetails;

      const result = mergeCspHeaders(details, "default-src 'self'");

      expect(result["Content-Security-Policy"]).toEqual(["default-src 'self'"]);
      expect(result["content-type"]).toEqual(["text/html"]);
    });

    it("replaces existing CSP header (case-insensitive)", () => {
      const details = {
        responseHeaders: {
          "content-security-policy": ["default-src 'none'"],
          "content-type": ["text/html"],
        },
      } as Partial<OnHeadersReceivedListenerDetails> as OnHeadersReceivedListenerDetails;

      const result = mergeCspHeaders(details, "default-src 'self'");

      expect(result["Content-Security-Policy"]).toEqual(["default-src 'self'"]);
      expect(result["content-type"]).toEqual(["text/html"]);
      expect(result["content-security-policy"]).toBeUndefined();
    });

    it("removes multiple CSP headers if present", () => {
      const details = {
        responseHeaders: {
          "Content-Security-Policy": ["default-src 'none'"],
          "content-security-policy": ["script-src 'self'"],
          "content-type": ["text/html"],
        },
      } as Partial<OnHeadersReceivedListenerDetails> as OnHeadersReceivedListenerDetails;

      const result = mergeCspHeaders(details, "default-src 'self'");

      expect(result["Content-Security-Policy"]).toEqual(["default-src 'self'"]);
      expect(result["content-security-policy"]).toBeUndefined();
      expect(result["content-type"]).toEqual(["text/html"]);
    });

    it("preserves other headers", () => {
      const details = {
        responseHeaders: {
          "content-type": ["text/html"],
          "x-custom-header": ["value"],
          "cache-control": ["no-cache"],
        },
      } as Partial<OnHeadersReceivedListenerDetails> as OnHeadersReceivedListenerDetails;

      const result = mergeCspHeaders(details, "default-src 'self'");

      expect(result["content-type"]).toEqual(["text/html"]);
      expect(result["x-custom-header"]).toEqual(["value"]);
      expect(result["cache-control"]).toEqual(["no-cache"]);
      expect(result["Content-Security-Policy"]).toEqual(["default-src 'self'"]);
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  DEV_PREVIEW_PROXY_PORT,
  sanitizeSubdomainToken,
  buildDevPreviewSubdomain,
  buildDevPreviewProxyOrigin,
  parseDevPreviewProxyHost,
} from "../devPreviewProxy.js";

describe("devPreviewProxy", () => {
  describe("sanitizeSubdomainToken", () => {
    it("passes through DNS-safe tokens", () => {
      expect(sanitizeSubdomainToken("panel-1")).toBe("panel-1");
      expect(sanitizeSubdomainToken("abc123_DEF")).toBe("abc123_DEF");
    });

    it("replaces non-alphanumeric characters with hyphens", () => {
      expect(sanitizeSubdomainToken("a/b c.d")).toBe("a-b-c-d");
    });

    it("caps the token at 24 characters", () => {
      expect(sanitizeSubdomainToken("x".repeat(40))).toHaveLength(24);
    });

    it("falls back to 'x' for an empty result", () => {
      expect(sanitizeSubdomainToken("")).toBe("x");
    });
  });

  describe("buildDevPreviewSubdomain", () => {
    it("builds a dp-<projectToken>-<panelToken> label", () => {
      expect(buildDevPreviewSubdomain("project-1", "panel-1")).toBe("dp-project-1-panel-1");
    });

    it("is deterministic for the same inputs", () => {
      expect(buildDevPreviewSubdomain("p", "q")).toBe(buildDevPreviewSubdomain("p", "q"));
    });

    it("stays within the 63-char DNS label limit for long ids", () => {
      const label = buildDevPreviewSubdomain("P".repeat(50), "Q".repeat(50));
      expect(label.length).toBeLessThanOrEqual(63);
    });
  });

  describe("buildDevPreviewProxyOrigin", () => {
    it("builds the full http origin with the subdomain and port", () => {
      expect(buildDevPreviewProxyOrigin(43000, "project-1", "panel-1")).toBe(
        "http://dp-project-1-panel-1.localhost:43000"
      );
    });
  });

  describe("parseDevPreviewProxyHost", () => {
    it("extracts the subdomain label, stripping the port", () => {
      expect(parseDevPreviewProxyHost("dp-project-1-panel-1.localhost:43000")).toBe(
        "dp-project-1-panel-1"
      );
    });

    it("round-trips with buildDevPreviewProxyOrigin's host", () => {
      const subdomain = buildDevPreviewSubdomain("proj", "panel");
      const host = `${subdomain}.localhost:${DEV_PREVIEW_PROXY_PORT}`;
      expect(parseDevPreviewProxyHost(host)).toBe(subdomain);
    });

    it("returns null for non-localhost hosts", () => {
      expect(parseDevPreviewProxyHost("example.com:43000")).toBeNull();
      expect(parseDevPreviewProxyHost("127.0.0.1:3000")).toBeNull();
    });

    it("returns null for bare localhost (no subdomain label)", () => {
      expect(parseDevPreviewProxyHost("localhost:43000")).toBeNull();
    });

    it("returns null for a *.localhost subdomain without the dp- prefix", () => {
      expect(parseDevPreviewProxyHost("evil.localhost:43000")).toBeNull();
    });

    it("returns null for empty/undefined hosts", () => {
      expect(parseDevPreviewProxyHost(undefined)).toBeNull();
      expect(parseDevPreviewProxyHost("")).toBeNull();
    });

    it("is case-insensitive", () => {
      expect(parseDevPreviewProxyHost("DP-PROJ-PANEL.LOCALHOST:43000")).toBe("dp-proj-panel");
    });
  });
});

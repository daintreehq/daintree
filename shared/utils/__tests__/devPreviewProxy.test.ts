import { describe, it, expect } from "vitest";
import {
  DEV_PREVIEW_PROXY_PORT,
  DEV_PREVIEW_BOOTSTRAP_PATH,
  sanitizeSubdomainToken,
  buildDevPreviewSubdomain,
  buildDevPreviewProxyOrigin,
  parseDevPreviewProxyHost,
  normalizeBootstrapRedirectPath,
  buildBootstrapUrl,
} from "../devPreviewProxy.js";

describe("devPreviewProxy", () => {
  describe("sanitizeSubdomainToken", () => {
    it("passes through already DNS-safe lowercase tokens", () => {
      expect(sanitizeSubdomainToken("panel-1")).toBe("panel-1");
      expect(sanitizeSubdomainToken("abc123")).toBe("abc123");
    });

    it("lowercases uppercase characters (DNS hosts are case-insensitive)", () => {
      expect(sanitizeSubdomainToken("ProjABC")).toBe("projabc");
    });

    it("folds underscores and other non-[a-z0-9-] characters to hyphens", () => {
      expect(sanitizeSubdomainToken("abc123_DEF")).toBe("abc123-def");
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

    it("round-trips through parseDevPreviewProxyHost for uppercase ids (case-insensitive Host)", () => {
      // The browser lowercases the Host header, so the built subdomain must equal the parsed
      // one even when the ids contain uppercase — otherwise the proxy lookup misses.
      const subdomain = buildDevPreviewSubdomain("ProjABC", "PanelXYZ");
      const host = `${subdomain.toUpperCase()}.localhost:43000`;
      expect(parseDevPreviewProxyHost(host)).toBe(subdomain);
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

  describe("normalizeBootstrapRedirectPath", () => {
    it("passes through a valid same-origin absolute path", () => {
      expect(normalizeBootstrapRedirectPath("/dashboard")).toBe("/dashboard");
    });

    it("preserves the query string and fragment", () => {
      expect(normalizeBootstrapRedirectPath("/a/b?x=1&y=2#frag")).toBe("/a/b?x=1&y=2#frag");
    });

    it("defaults to / for empty or nullish input", () => {
      expect(normalizeBootstrapRedirectPath("")).toBe("/");
      expect(normalizeBootstrapRedirectPath(undefined)).toBe("/");
      expect(normalizeBootstrapRedirectPath(null)).toBe("/");
    });

    it("rejects paths without a leading slash", () => {
      expect(normalizeBootstrapRedirectPath("dashboard")).toBe("/");
      expect(normalizeBootstrapRedirectPath("http://evil.com")).toBe("/");
    });

    it("rejects scheme-relative open-redirect bypasses", () => {
      expect(normalizeBootstrapRedirectPath("//evil.com")).toBe("/");
      expect(normalizeBootstrapRedirectPath("//evil.com/path")).toBe("/");
      expect(normalizeBootstrapRedirectPath("/\\evil.com")).toBe("/");
    });

    it("collapses encoded dot-segments while staying on-origin", () => {
      // The URL constructor decodes `%2e%2e` to `..` and resolves it; the result
      // never escapes the origin, so the worst case is a harmless same-origin path.
      expect(normalizeBootstrapRedirectPath("/%2e%2e/admin")).toBe("/admin");
    });
  });

  describe("buildBootstrapUrl", () => {
    it("builds a bootstrap URL with percent-encoded token and rd params", () => {
      const url = buildBootstrapUrl("http://dp-a-b.localhost:43000", "tok.en", "/path?x=1");
      const parsed = new URL(url);
      expect(parsed.origin).toBe("http://dp-a-b.localhost:43000");
      expect(parsed.pathname).toBe(DEV_PREVIEW_BOOTSTRAP_PATH);
      expect(parsed.searchParams.get("token")).toBe("tok.en");
      expect(parsed.searchParams.get("rd")).toBe("/path?x=1");
    });
  });
});

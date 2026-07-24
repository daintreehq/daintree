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
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' plugin: 'sha256-abc123'");
    });

    it("appends multiple hashes space-separated in production", () => {
      const csp = getDaintreeAppProdCSP({
        scriptSrcHashes: ["'sha256-aaa'", "'sha256-bbb'"],
      });
      expect(csp).toContain(
        "script-src 'self' 'wasm-unsafe-eval' plugin: 'sha256-aaa' 'sha256-bbb'"
      );
    });

    it("omits the hash list when scriptSrcHashes is empty", () => {
      const csp = getDaintreeAppProdCSP({ scriptSrcHashes: [] });
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' plugin:;");
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

  describe("plugin: scheme allowance", () => {
    // `React.lazy(() => import("plugin://..."))` in
    // `src/components/Panel/PluginViewHost.tsx` is governed by `script-src`;
    // `connect-src` covers any `fetch("plugin://...")` plugin authors layer on
    // top. Both must include `plugin:` for non-PTY plugin panels to render in
    // production. Past lesson #3757 forbids `bypassCSP: true` — this narrow
    // directive expansion is the load-bearing alternative.
    it("allows plugin: in script-src in production for dynamic plugin imports", () => {
      const csp = getDaintreeAppProdCSP();
      const scriptSrcMatch = csp.match(/script-src ([^;]*);/);
      expect(scriptSrcMatch).not.toBeNull();
      expect(scriptSrcMatch?.[1]).toContain("plugin:");
    });

    it("allows plugin: in connect-src in production for plugin-served fetches", () => {
      const csp = getDaintreeAppProdCSP();
      const connectSrcMatch = csp.match(/connect-src ([^;]*);/);
      expect(connectSrcMatch).not.toBeNull();
      expect(connectSrcMatch?.[1]).toContain("plugin:");
    });

    it("allows plugin: in script-src in development", () => {
      const csp = getDaintreeAppDevCSP();
      const scriptSrcMatch = csp.match(/script-src ([^;]*);/);
      expect(scriptSrcMatch?.[1]).toContain("plugin:");
    });

    it("allows plugin: in connect-src in development", () => {
      const csp = getDaintreeAppDevCSP();
      const connectSrcMatch = csp.match(/connect-src ([^;]*);/);
      expect(connectSrcMatch?.[1]).toContain("plugin:");
    });
  });

  describe("daintree-html: preview scheme in frame-src (#11191)", () => {
    // The file panel mounts a `daintree-html://<token>/…` iframe to render HTML
    // files. Without the scheme in frame-src the iframe cannot navigate at all;
    // the framed document's own scripts/assets are governed by the per-document
    // CSP the protocol handler serves, never this one.
    it("allows daintree-html: in frame-src in production", () => {
      const frameSrc = getDaintreeAppProdCSP().match(/frame-src ([^;]*);/)?.[1];
      expect(frameSrc).toContain("daintree-html:");
    });

    it("allows daintree-html: in frame-src in development", () => {
      const frameSrc = getDaintreeAppDevCSP().match(/frame-src ([^;]*);/)?.[1];
      expect(frameSrc).toContain("daintree-html:");
    });

    it("does not add daintree-html: to script-src or connect-src", () => {
      // The scheme is frame-only; the sandboxed document is isolated, so the
      // trusted shell must never gain script/connect access to it.
      const csp = getDaintreeAppProdCSP();
      expect(csp.match(/script-src ([^;]*);/)?.[1]).not.toContain("daintree-html:");
      expect(csp.match(/connect-src ([^;]*);/)?.[1]).not.toContain("daintree-html:");
    });
  });

  describe("daintree-file: scheme in media-src (#11382)", () => {
    // The file viewer fetch()es video bytes from daintree-file:// and plays
    // them through a blob object URL (Chromium's custom-scheme media loader
    // can't consume follow-up range requests — electron#51442), so media-src
    // must allow blob:. daintree-file: stays for consumers that stream media
    // from the scheme without the blob detour. Without either entry the
    // element is silently blocked with only a devtools warning — every
    // protocol/MIME fix upstream still fails.
    it("allows daintree-file: in media-src in production", () => {
      const mediaSrc = getDaintreeAppProdCSP().match(/media-src ([^;]*);/)?.[1];
      expect(mediaSrc).toContain("daintree-file:");
    });

    it("allows daintree-file: in media-src in development", () => {
      const mediaSrc = getDaintreeAppDevCSP().match(/media-src ([^;]*);/)?.[1];
      expect(mediaSrc).toContain("daintree-file:");
    });

    it("allows blob: in media-src in production", () => {
      const mediaSrc = getDaintreeAppProdCSP().match(/media-src ([^;]*);/)?.[1];
      expect(mediaSrc).toContain("blob:");
    });

    it("allows blob: in media-src in development", () => {
      const mediaSrc = getDaintreeAppDevCSP().match(/media-src ([^;]*);/)?.[1];
      expect(mediaSrc).toContain("blob:");
    });
  });

  describe("daintree.org doc images in img-src (#9828)", () => {
    // The `help.displayImage` MCP tool surfaces documentation images served
    // from daintree.org. Chromium 148 does not match the apex against a
    // wildcard, so both forms must be present for apex and subdomain images.
    it("allows the daintree.org apex in img-src in production", () => {
      const imgSrc = getDaintreeAppProdCSP().match(/img-src ([^;]*);/)?.[1];
      expect(imgSrc).toContain("https://daintree.org");
    });

    it("allows daintree.org subdomains in img-src in production", () => {
      const imgSrc = getDaintreeAppProdCSP().match(/img-src ([^;]*);/)?.[1];
      expect(imgSrc).toContain("https://*.daintree.org");
    });

    it("allows the daintree.org apex in img-src in development", () => {
      const imgSrc = getDaintreeAppDevCSP().match(/img-src ([^;]*);/)?.[1];
      expect(imgSrc).toContain("https://daintree.org");
    });

    it("allows daintree.org subdomains in img-src in development", () => {
      const imgSrc = getDaintreeAppDevCSP().match(/img-src ([^;]*);/)?.[1];
      expect(imgSrc).toContain("https://*.daintree.org");
    });
  });
});

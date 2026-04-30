import { describe, it, expect } from "vitest";
import {
  classifyPartition,
  getDaintreeAppCSP,
  getLocalhostDevCSP,
  mergeCspHeaders,
  isDevPreviewPartition,
} from "../webviewCsp.js";
import type { OnHeadersReceivedListenerDetails } from "electron";

function parseDirectives(csp: string): Record<string, string> {
  return Object.fromEntries(
    csp.split("; ").map((d) => {
      const [name, ...rest] = d.split(" ");
      return [name, rest.join(" ")];
    })
  );
}

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
      expect(isDevPreviewPartition("persist:portal")).toBe(false);
      expect(isDevPreviewPartition("persist:unknown")).toBe(false);
    });
  });

  describe("classifyPartition", () => {
    it("identifies browser partition", () => {
      expect(classifyPartition("persist:browser")).toBe("browser");
    });

    it("identifies portal partition", () => {
      expect(classifyPartition("persist:portal")).toBe("portal");
    });

    it("identifies dev-preview partition", () => {
      expect(classifyPartition("persist:dev-preview")).toBe("dev-preview");
    });

    it("identifies dynamic dev-preview partitions", () => {
      expect(classifyPartition("persist:dev-preview-myproject-main-panel1")).toBe("dev-preview");
      expect(classifyPartition("persist:dev-preview-foo-bar-baz")).toBe("dev-preview");
    });

    it("identifies shared daintree-app partition as project", () => {
      expect(classifyPartition("persist:daintree")).toBe("project");
    });

    it("identifies legacy per-project partitions as project", () => {
      expect(classifyPartition("persist:project-abc123")).toBe("project");
      expect(classifyPartition("persist:project-some-uuid")).toBe("project");
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

  // Locks the contract that decides which partition types receive the
  // localhost-only CSP overlay in setupWebviewCSP.applyCSP. The browser
  // partition hosts arbitrary remote sites and must NOT receive the overlay
  // (regression guard for #6249).
  describe("CSP applicability by partition type", () => {
    const partitionsThatReceiveOverlay = ["dev-preview", "project"] as const;
    const partitionsThatSkipOverlay = ["browser", "portal", "unknown"] as const;

    it("dev-preview partitions are eligible for the localhost CSP overlay", () => {
      expect(classifyPartition("persist:dev-preview")).toBe("dev-preview");
      expect(classifyPartition("persist:dev-preview-myproject-main-panel1")).toBe("dev-preview");
      expect(partitionsThatReceiveOverlay).toContain("dev-preview");
    });

    it("project partitions are eligible for the localhost CSP overlay", () => {
      expect(classifyPartition("persist:daintree")).toBe("project");
      expect(classifyPartition("persist:project-abc123")).toBe("project");
      expect(partitionsThatReceiveOverlay).toContain("project");
    });

    it("browser partition is NOT eligible — hosts arbitrary remote sites", () => {
      expect(classifyPartition("persist:browser")).toBe("browser");
      expect(partitionsThatSkipOverlay).toContain("browser");
      expect(partitionsThatReceiveOverlay).not.toContain("browser" as never);
    });

    it("portal partition is NOT eligible", () => {
      expect(classifyPartition("persist:portal")).toBe("portal");
      expect(partitionsThatSkipOverlay).toContain("portal");
    });

    it("unknown partitions are NOT eligible", () => {
      expect(classifyPartition("persist:unknown")).toBe("unknown");
      expect(classifyPartition("")).toBe("unknown");
      expect(partitionsThatSkipOverlay).toContain("unknown");
    });
  });

  describe("getLocalhostDevCSP", () => {
    it("returns a localhost-restricted CSP policy", () => {
      const csp = getLocalhostDevCSP();

      expect(csp).toContain("default-src 'self' http://localhost:* http://127.0.0.1:*");
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).toContain("connect-src 'self' ws://localhost:* ws://127.0.0.1:*");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
    });

    it("includes unsafe-eval in script-src for framework compatibility", () => {
      const csp = getLocalhostDevCSP();
      const directives = Object.fromEntries(
        csp.split("; ").map((d) => {
          const [name, ...rest] = d.split(" ");
          return [name, rest.join(" ")];
        })
      );

      expect(directives["script-src"]).toContain("'unsafe-eval'");
    });

    it("includes secure localhost support (https and wss)", () => {
      const csp = getLocalhostDevCSP();

      expect(csp).toContain("https://localhost:*");
      expect(csp).toContain("https://127.0.0.1:*");
      expect(csp).toContain("wss://localhost:*");
      expect(csp).toContain("wss://127.0.0.1:*");
    });

    it("includes IPv6 localhost origins", () => {
      const csp = getLocalhostDevCSP();

      expect(csp).toContain("http://[::1]:*");
      expect(csp).toContain("https://[::1]:*");
      expect(csp).toContain("ws://[::1]:*");
      expect(csp).toContain("wss://[::1]:*");
    });

    it("does not allow external origins in script-src or default-src", () => {
      const csp = getLocalhostDevCSP();
      const directives = Object.fromEntries(
        csp.split("; ").map((d) => {
          const [name, ...rest] = d.split(" ");
          return [name, rest.join(" ")];
        })
      );

      expect(directives["default-src"]).not.toMatch(/(?:^|\s)https:(?:\s|$)/);
      expect(directives["script-src"]).not.toMatch(/(?:^|\s)https:(?:\s|$)/);
      expect(csp).not.toContain("http://example.com");
    });

    it("allows blob: frames for iframe-based previews", () => {
      const csp = getLocalhostDevCSP();

      expect(csp).toContain("frame-src");
      expect(csp).toMatch(/frame-src[^;]*blob:/);
      expect(csp).toMatch(/frame-src[^;]*http:\/\/localhost:\*/);
      expect(csp).toMatch(/frame-src[^;]*https:\/\/localhost:\*/);
    });

    it("allows external HTTPS images", () => {
      const csp = getLocalhostDevCSP();

      expect(csp).toMatch(/img-src[^;]*https:/);
    });

    it("includes form-action directive restricting form submissions to localhost", () => {
      const csp = getLocalhostDevCSP();
      const directives = Object.fromEntries(
        csp.split("; ").map((d) => {
          const [name, ...rest] = d.split(" ");
          return [name, rest.join(" ")];
        })
      );

      expect(directives["form-action"]).toBeDefined();
      expect(directives["form-action"]).toContain("'self'");
      expect(directives["form-action"]).toContain("http://localhost:*");
      expect(directives["form-action"]).toContain("http://127.0.0.1:*");
      expect(directives["form-action"]).toContain("https://localhost:*");
      expect(directives["form-action"]).toContain("https://127.0.0.1:*");
    });

    it("does not allow external origins in form-action", () => {
      const csp = getLocalhostDevCSP();
      const directives = Object.fromEntries(
        csp.split("; ").map((d) => {
          const [name, ...rest] = d.split(" ");
          return [name, rest.join(" ")];
        })
      );

      expect(directives["form-action"]).not.toMatch(/(?:^|\s)https:(?:\s|$)/);
      expect(directives["form-action"]).not.toMatch(/(?:^|\s)http:(?:\s|$)/);
      expect(directives["form-action"]).not.toMatch(/(?:^|\s)\*(?:\s|$)/);
      expect(directives["form-action"]).not.toContain("http://example.com");
    });
  });

  describe("getDaintreeAppCSP", () => {
    describe("production policy (isDev=false)", () => {
      const csp = getDaintreeAppCSP(false);
      const directives = parseDirectives(csp);

      it("includes all required directives", () => {
        expect(directives["default-src"]).toBeDefined();
        expect(directives["script-src"]).toBeDefined();
        expect(directives["style-src"]).toBeDefined();
        expect(directives["connect-src"]).toBeDefined();
        expect(directives["img-src"]).toBeDefined();
        expect(directives["font-src"]).toBeDefined();
        expect(directives["media-src"]).toBeDefined();
        expect(directives["worker-src"]).toBeDefined();
        expect(directives["frame-src"]).toBeDefined();
        expect(directives["object-src"]).toBeDefined();
        expect(directives["base-uri"]).toBeDefined();
        expect(directives["form-action"]).toBeDefined();
      });

      it("omits 'unsafe-eval' in script-src", () => {
        expect(directives["script-src"]).not.toContain("'unsafe-eval'");
      });

      it("omits 'unsafe-inline' in script-src", () => {
        expect(directives["script-src"]).not.toContain("'unsafe-inline'");
      });

      it("retains 'wasm-unsafe-eval' in script-src for WASM compilation", () => {
        expect(directives["script-src"]).toContain("'wasm-unsafe-eval'");
      });

      it("keeps 'unsafe-inline' in style-src for Vite inline style injection", () => {
        expect(directives["style-src"]).toContain("'unsafe-inline'");
      });

      it("denies plugins via object-src 'none'", () => {
        expect(directives["object-src"]).toBe("'none'");
      });

      it("locks base-uri to 'self'", () => {
        expect(directives["base-uri"]).toBe("'self'");
      });

      it("denies all form submissions via form-action 'none'", () => {
        expect(directives["form-action"]).toBe("'none'");
      });

      it("allows blob: workers", () => {
        expect(directives["worker-src"]).toContain("blob:");
      });

      it("allows daintree-file: in connect-src for Web Audio fetches", () => {
        expect(directives["connect-src"]).toContain("daintree-file:");
        expect(directives["connect-src"]).toContain("canopy-file:");
      });

      it("allows daintree-file: + GitHub avatar host + data:/blob: in img-src", () => {
        expect(directives["img-src"]).toContain("'self'");
        expect(directives["img-src"]).toContain("daintree-file:");
        expect(directives["img-src"]).toContain("canopy-file:");
        expect(directives["img-src"]).toContain("https://avatars.githubusercontent.com");
        expect(directives["img-src"]).toContain("data:");
        expect(directives["img-src"]).toContain("blob:");
      });

      it("allows data: fonts (Vite inlines small fonts)", () => {
        expect(directives["font-src"]).toContain("data:");
      });

      it("allows localhost frames so embedded <webview> guests can mount", () => {
        expect(directives["frame-src"]).toContain("'self'");
        expect(directives["frame-src"]).toContain("http://localhost:*");
        expect(directives["frame-src"]).toContain("http://127.0.0.1:*");
        expect(directives["frame-src"]).toContain("https://localhost:*");
        expect(directives["frame-src"]).toContain("https://127.0.0.1:*");
      });

      it("does not include any dev server origins", () => {
        expect(directives["default-src"]).not.toContain("http://localhost");
        expect(directives["default-src"]).not.toContain("http://127.0.0.1");
        expect(directives["script-src"]).not.toContain("http://localhost");
        expect(directives["script-src"]).not.toContain("http://127.0.0.1");
        expect(directives["script-src"]).not.toContain("ws:");
        expect(directives["connect-src"]).not.toContain("ws:");
      });

      it("does not allow external HTTP(S) wildcard origins in script-src", () => {
        expect(directives["script-src"]).not.toMatch(/(?:^|\s)https?:(?:\s|$)/);
        expect(directives["default-src"]).not.toMatch(/(?:^|\s)https?:(?:\s|$)/);
      });
    });

    describe("development policy (isDev=true)", () => {
      const csp = getDaintreeAppCSP(true);
      const directives = parseDirectives(csp);

      it("includes 'unsafe-eval' in script-src for Vite HMR", () => {
        expect(directives["script-src"]).toContain("'unsafe-eval'");
      });

      // Regression guard: @vitejs/plugin-react injects an inline
      // <script type="module"> React Refresh preamble at the top of <head>,
      // and the HTTP header CSP applies before parsing — so without
      // 'unsafe-inline' the preamble is blocked and React never bootstraps.
      it("includes 'unsafe-inline' in script-src for Vite's React Refresh preamble", () => {
        expect(directives["script-src"]).toContain("'unsafe-inline'");
      });

      it("adds the dev server HTTP origin to script-src", () => {
        expect(directives["script-src"]).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
        expect(directives["script-src"]).toMatch(/http:\/\/localhost:\d+/);
      });

      it("adds the dev server HTTP origin to connect-src", () => {
        expect(directives["connect-src"]).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
        expect(directives["connect-src"]).toMatch(/http:\/\/localhost:\d+/);
      });

      it("adds the WebSocket dev server origin to connect-src for HMR", () => {
        expect(directives["connect-src"]).toMatch(/ws:\/\/127\.0\.0\.1:\d+/);
        expect(directives["connect-src"]).toMatch(/ws:\/\/localhost:\d+/);
      });

      it("retains daintree-file: in connect-src and img-src", () => {
        expect(directives["connect-src"]).toContain("daintree-file:");
        expect(directives["img-src"]).toContain("daintree-file:");
      });

      it("adds the dev server HTTP origin to style-src, img-src, font-src", () => {
        expect(directives["style-src"]).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
        expect(directives["img-src"]).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
        expect(directives["font-src"]).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
      });

      it("retains the strict directives that don't depend on the dev server", () => {
        expect(directives["object-src"]).toBe("'none'");
        expect(directives["base-uri"]).toBe("'self'");
        expect(directives["form-action"]).toBe("'none'");
      });
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

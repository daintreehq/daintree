import { describe, it, expect } from "vitest";
import {
  extractLocalhostUrls,
  normalizeBrowserUrl,
  isLocalhostUrl,
  isSafeNavigationUrl,
  stripAnsiAndOscCodes,
  isImplicitlyAllowedHost,
} from "../urlUtils.js";

describe("urlUtils", () => {
  describe("extractLocalhostUrls", () => {
    it("extracts plain localhost URL", () => {
      const urls = extractLocalhostUrls("  ➜  Local:   http://localhost:5173/");
      expect(urls).toContain("http://localhost:5173/");
    });

    it("extracts URL from Vite output", () => {
      const output = `
  VITE v5.0.0  ready in 500 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
`;
      const urls = extractLocalhostUrls(output);
      expect(urls).toContain("http://localhost:5173/");
    });

    it("extracts URL from Next.js output", () => {
      const output = `ready - started server on 0.0.0.0:3000, url: http://localhost:3000`;
      const urls = extractLocalhostUrls(output);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.some((u) => u.includes("localhost:3000"))).toBe(true);
    });

    it("extracts URL from webpack-dev-server output", () => {
      const output = `<i> [webpack-dev-server] Project is running at http://localhost:8080/`;
      const urls = extractLocalhostUrls(output);
      expect(urls).toContain("http://localhost:8080/");
    });

    it("extracts URL wrapped in ANSI color codes", () => {
      const output = `  ➜  Local:   \x1b[32mhttp://localhost:5173/\x1b[0m`;
      const urls = extractLocalhostUrls(output);
      expect(urls).toContain("http://localhost:5173/");
    });

    it("extracts URL wrapped in OSC 8 hyperlink (BEL terminator)", () => {
      const output = `  ➜  Local:   \x1b]8;;http://localhost:5173/\x07http://localhost:5173/\x1b]8;;\x07`;
      const urls = extractLocalhostUrls(output);
      expect(urls).toContain("http://localhost:5173/");
    });

    it("extracts URL wrapped in OSC 8 hyperlink (ST terminator — xterm 6 style)", () => {
      const output = `  ➜  Local:   \x1b]8;;http://localhost:5173/\x1b\\http://localhost:5173/\x1b]8;;\x1b\\`;
      const urls = extractLocalhostUrls(output);
      expect(urls).toContain("http://localhost:5173/");
    });

    it("does not capture BEL control character as part of URL path", () => {
      // OSC hyperlink wrapping the URL — the BEL (\x07) must not be included in the URL
      const output = `\x1b]8;;http://localhost:5173/\x07http://localhost:5173/\x1b]8;;\x07`;
      const urls = extractLocalhostUrls(output);
      expect(urls).toEqual(["http://localhost:5173/"]);
      expect(urls[0]).not.toContain("%07");
    });

    it("normalizes 0.0.0.0 to localhost", () => {
      const output = `Server running at http://0.0.0.0:3000`;
      const urls = extractLocalhostUrls(output);
      expect(urls.some((u) => u.includes("localhost:3000"))).toBe(true);
    });

    it("extracts 127.0.0.1 URLs", () => {
      const output = `Listening on http://127.0.0.1:4000`;
      const urls = extractLocalhostUrls(output);
      expect(urls.some((u) => u.includes("127.0.0.1:4000"))).toBe(true);
    });

    it("returns empty array for non-localhost URLs", () => {
      const output = `Server running at http://example.com:3000`;
      const urls = extractLocalhostUrls(output);
      expect(urls).toEqual([]);
    });

    it("returns empty array for text without URLs", () => {
      const urls = extractLocalhostUrls("Installing dependencies...");
      expect(urls).toEqual([]);
    });

    it("returns empty array for non-localhost http URLs", () => {
      const urls = extractLocalhostUrls("Proxy available at https://example.com:8443");
      expect(urls).toEqual([]);
    });

    it("deduplicates URLs", () => {
      const output = `http://localhost:5173/ http://localhost:5173/`;
      const urls = extractLocalhostUrls(output);
      expect(urls.length).toBe(1);
    });

    it("extracts multiple different URLs", () => {
      const output = `Local: http://localhost:5173/  Network: http://localhost:5174/`;
      const urls = extractLocalhostUrls(output);
      expect(urls.length).toBe(2);
    });

    it("handles uppercase localhost hostnames", () => {
      const output = `Server ready at http://LOCALHOST:5173/`;
      const urls = extractLocalhostUrls(output);
      expect(urls).toContain("http://localhost:5173/");
    });

    it("extracts IPv6 [::1] URLs from terminal output", () => {
      const output = `Server running at http://[::1]:3000`;
      const urls = extractLocalhostUrls(output);
      expect(urls).toContain("http://[::1]:3000/");
    });

    it("extracts IPv6 [::1] URLs with paths", () => {
      const output = `Ready at http://[::1]:3000/api/health`;
      const urls = extractLocalhostUrls(output);
      expect(urls).toContain("http://[::1]:3000/api/health");
    });
  });

  describe("stripAnsiAndOscCodes", () => {
    it("strips SGR codes", () => {
      expect(stripAnsiAndOscCodes("\x1b[32mgreen\x1b[0m")).toBe("green");
    });

    it("strips OSC 8 hyperlinks with BEL terminator", () => {
      expect(stripAnsiAndOscCodes("\x1b]8;;http://example.com\x07text\x1b]8;;\x07")).toBe("text");
    });

    it("strips OSC 8 hyperlinks with ST terminator (xterm 6 style)", () => {
      expect(stripAnsiAndOscCodes("\x1b]8;;http://example.com\x1b\\text\x1b]8;;\x1b\\")).toBe(
        "text"
      );
    });

    it("strips other OSC sequences with BEL terminator", () => {
      expect(stripAnsiAndOscCodes("\x1b]0;window title\x07plain")).toBe("plain");
    });

    it("strips other OSC sequences with ST terminator", () => {
      expect(stripAnsiAndOscCodes("\x1b]2;window title\x1b\\plain")).toBe("plain");
    });

    it("strips CSI cursor movement sequences", () => {
      expect(stripAnsiAndOscCodes("\x1b[2J\x1b[H output")).toBe(" output");
    });

    it("returns plain text unchanged", () => {
      expect(stripAnsiAndOscCodes("hello world")).toBe("hello world");
    });
  });

  describe("normalizeBrowserUrl", () => {
    it("normalizes localhost URL", () => {
      const result = normalizeBrowserUrl("http://localhost:3000");
      expect(result.url).toBe("http://localhost:3000/");
    });

    it("replaces 0.0.0.0 with localhost", () => {
      const result = normalizeBrowserUrl("http://0.0.0.0:3000");
      expect(result.url).toContain("localhost");
    });

    it("rejects non-localhost URLs", () => {
      const result = normalizeBrowserUrl("http://example.com");
      expect(result.error).toBeDefined();
    });

    it("rejects empty input", () => {
      const result = normalizeBrowserUrl("");
      expect(result.error).toBeDefined();
    });

    it("normalizes IPv6 [::1] URL", () => {
      const result = normalizeBrowserUrl("http://[::1]:3000");
      expect(result.url).toBe("http://[::1]:3000/");
      expect(result.error).toBeUndefined();
    });
  });

  describe("isImplicitlyAllowedHost", () => {
    it("allows loopback hostnames", () => {
      expect(isImplicitlyAllowedHost("localhost")).toBe(true);
      expect(isImplicitlyAllowedHost("127.0.0.1")).toBe(true);
      expect(isImplicitlyAllowedHost("::1")).toBe(true);
    });

    it("allows RFC 6761 / 6762 reserved TLDs", () => {
      expect(isImplicitlyAllowedHost("web.localhost")).toBe(true);
      expect(isImplicitlyAllowedHost("api.test")).toBe(true);
      expect(isImplicitlyAllowedHost("printer.local")).toBe(true);
      expect(isImplicitlyAllowedHost("corp.internal")).toBe(true);
      expect(isImplicitlyAllowedHost("deep.nested.test")).toBe(true);
    });

    it("does not allow real gTLDs like .dev or .app", () => {
      expect(isImplicitlyAllowedHost("example.dev")).toBe(false);
      expect(isImplicitlyAllowedHost("example.app")).toBe(false);
      expect(isImplicitlyAllowedHost("example.com")).toBe(false);
    });

    it("allows RFC-1918 private IPv4", () => {
      expect(isImplicitlyAllowedHost("10.0.0.1")).toBe(true);
      expect(isImplicitlyAllowedHost("10.255.255.255")).toBe(true);
      expect(isImplicitlyAllowedHost("172.16.0.1")).toBe(true);
      expect(isImplicitlyAllowedHost("172.31.255.255")).toBe(true);
      expect(isImplicitlyAllowedHost("192.168.1.42")).toBe(true);
    });

    it("allows link-local IPv4 169.254/16", () => {
      expect(isImplicitlyAllowedHost("169.254.1.1")).toBe(true);
    });

    it("rejects IPv4 outside private ranges", () => {
      expect(isImplicitlyAllowedHost("8.8.8.8")).toBe(false);
      expect(isImplicitlyAllowedHost("172.15.0.1")).toBe(false);
      expect(isImplicitlyAllowedHost("172.32.0.1")).toBe(false);
      expect(isImplicitlyAllowedHost("193.168.1.1")).toBe(false);
    });

    it("allows IPv6 link-local (fe80::/10) and ULA (fc00::/7)", () => {
      expect(isImplicitlyAllowedHost("fe80::1")).toBe(true);
      expect(isImplicitlyAllowedHost("fc00::1")).toBe(true);
      expect(isImplicitlyAllowedHost("fd12:3456::1")).toBe(true);
    });

    it("rejects public IPv6 addresses", () => {
      expect(isImplicitlyAllowedHost("2001:4860:4860::8888")).toBe(false);
    });

    it("strips IPv6 brackets before classifying", () => {
      expect(isImplicitlyAllowedHost("[fe80::1]")).toBe(true);
    });

    it("returns false for empty input", () => {
      expect(isImplicitlyAllowedHost("")).toBe(false);
    });
  });

  describe("normalizeBrowserUrl with allowedHosts option", () => {
    it("implicitly allows local TLDs without prompting", () => {
      const result = normalizeBrowserUrl("http://api.test:3000", { allowedHosts: [] });
      expect(result.url).toBe("http://api.test:3000/");
      expect(result.requiresConfirmation).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it("implicitly allows RFC-1918 LAN IPs without prompting", () => {
      const result = normalizeBrowserUrl("http://192.168.1.42:3000", { allowedHosts: [] });
      expect(result.url).toBe("http://192.168.1.42:3000/");
      expect(result.requiresConfirmation).toBeUndefined();
    });

    it("flags unknown public hosts as requiring confirmation", () => {
      const result = normalizeBrowserUrl("https://tunnel.ngrok-free.app", { allowedHosts: [] });
      expect(result.url).toBe("https://tunnel.ngrok-free.app/");
      expect(result.requiresConfirmation).toBe(true);
      expect(result.hostname).toBe("tunnel.ngrok-free.app");
      expect(result.error).toBeUndefined();
    });

    it("skips confirmation when host is already approved", () => {
      const result = normalizeBrowserUrl("https://tunnel.ngrok-free.app", {
        allowedHosts: ["tunnel.ngrok-free.app"],
      });
      expect(result.url).toBe("https://tunnel.ngrok-free.app/");
      expect(result.requiresConfirmation).toBeUndefined();
    });

    it("matches approved hosts case-insensitively", () => {
      const result = normalizeBrowserUrl("https://Staging.Example.Com", {
        allowedHosts: ["staging.example.com"],
      });
      expect(result.url).toBe("https://staging.example.com/");
      expect(result.requiresConfirmation).toBeUndefined();
    });

    it("rejects non-http(s) protocols even with allowedHosts", () => {
      const result = normalizeBrowserUrl("file:///etc/passwd", { allowedHosts: [] });
      expect(result.error).toBeDefined();
    });

    it("keeps strict behavior when options are omitted", () => {
      const result = normalizeBrowserUrl("http://192.168.1.42:3000");
      expect(result.error).toBeDefined();
      expect(result.url).toBeUndefined();
    });
  });

  describe("isLocalhostUrl", () => {
    it("returns true for localhost URLs", () => {
      expect(isLocalhostUrl("http://localhost:3000")).toBe(true);
    });

    it("returns true for 127.0.0.1", () => {
      expect(isLocalhostUrl("http://127.0.0.1:3000")).toBe(true);
    });

    it("returns false for remote URLs", () => {
      expect(isLocalhostUrl("http://example.com")).toBe(false);
    });

    it("returns false for invalid input", () => {
      expect(isLocalhostUrl("not a url")).toBe(false);
    });

    it("returns true for IPv6 [::1] URL", () => {
      expect(isLocalhostUrl("http://[::1]:3000")).toBe(true);
    });

    it("returns true for IPv6 [::1] URL with path", () => {
      expect(isLocalhostUrl("http://[::1]:3000/page")).toBe(true);
    });

    it("returns true for https IPv6 [::1] URL", () => {
      expect(isLocalhostUrl("https://[::1]:3000")).toBe(true);
    });
  });

  describe("isSafeNavigationUrl", () => {
    it("returns true for http URL", () => {
      expect(isSafeNavigationUrl("http://example.com")).toBe(true);
    });

    it("returns true for https URL", () => {
      expect(isSafeNavigationUrl("https://example.com/path")).toBe(true);
    });

    it("returns false for javascript: URL", () => {
      expect(isSafeNavigationUrl("javascript:alert(1)")).toBe(false);
    });

    it("returns false for data: URL", () => {
      expect(isSafeNavigationUrl("data:text/html,<h1>Hi</h1>")).toBe(false);
    });

    it("returns false for file: URL", () => {
      expect(isSafeNavigationUrl("file:///etc/passwd")).toBe(false);
    });

    it("returns false for blob: URL", () => {
      expect(isSafeNavigationUrl("blob:https://example.com/uuid")).toBe(false);
    });

    it("returns false for about:blank", () => {
      expect(isSafeNavigationUrl("about:blank")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isSafeNavigationUrl("")).toBe(false);
    });

    it("returns false for invalid URL", () => {
      expect(isSafeNavigationUrl("not-a-url")).toBe(false);
    });

    it("trims whitespace before parsing", () => {
      expect(isSafeNavigationUrl("  https://example.com  ")).toBe(true);
    });
  });
});

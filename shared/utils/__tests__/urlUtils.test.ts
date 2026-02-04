import { describe, it, expect } from "vitest";
import {
  extractLocalhostUrls,
  normalizeBrowserUrl,
  isLocalhostUrl,
  stripAnsiAndOscCodes,
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

    it("extracts URL wrapped in OSC 8 hyperlink", () => {
      const output = `  ➜  Local:   \x1b]8;;http://localhost:5173/\x07http://localhost:5173/\x1b]8;;\x07`;
      const urls = extractLocalhostUrls(output);
      expect(urls).toContain("http://localhost:5173/");
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
  });

  describe("stripAnsiAndOscCodes", () => {
    it("strips SGR codes", () => {
      expect(stripAnsiAndOscCodes("\x1b[32mgreen\x1b[0m")).toBe("green");
    });

    it("strips OSC 8 hyperlinks", () => {
      expect(stripAnsiAndOscCodes("\x1b]8;;http://example.com\x07text\x1b]8;;\x07")).toBe("text");
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
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { UrlDetector } from "../UrlDetector.js";

describe("UrlDetector", () => {
  let detector: UrlDetector;

  beforeEach(() => {
    detector = new UrlDetector();
  });

  describe("scanOutput()", () => {
    describe("URL extraction", () => {
      it("detects localhost URLs from terminal output", () => {
        const result = detector.scanOutput("Server running at http://localhost:3000", "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("detects 127.0.0.1 URLs", () => {
        const result = detector.scanOutput("Listening on http://127.0.0.1:8080", "");
        expect(result.url).toBe("http://127.0.0.1:8080/");
      });

      it("detects 0.0.0.0 URLs and normalizes to localhost", () => {
        const result = detector.scanOutput("Server: http://0.0.0.0:5000", "");
        expect(result.url).toBe("http://localhost:5000/");
      });

      it("handles URLs with ANSI escape codes", () => {
        const withAnsi = "\x1b[32mhttp://localhost:3000\x1b[0m";
        const result = detector.scanOutput(withAnsi, "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("handles URLs with OSC hyperlinks via ANSI stripping", () => {
        const withOsc =
          "Server at \x1b]8;;http://localhost:3000\x07http://localhost:3000\x1b]8;;\x07";
        const result = detector.scanOutput(withOsc, "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("detects URLs split across chunks using buffer", () => {
        const result1 = detector.scanOutput("Server at http://local", "");
        const result2 = detector.scanOutput("host:3000", result1.buffer);
        expect(result2.url).toBe("http://localhost:3000/");
      });

      it("prefers localhost over 127.0.0.1 when multiple URLs found", () => {
        const result = detector.scanOutput("http://127.0.0.1:3000 and http://localhost:3000", "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("returns first URL if no localhost variant exists", () => {
        const result = detector.scanOutput("http://127.0.0.1:3000 and http://127.0.0.1:4000", "");
        expect(result.url).toBe("http://127.0.0.1:3000/");
      });

      it("maintains 4096 character buffer for split URL detection", () => {
        const longPrefix = "x".repeat(4000);
        const result1 = detector.scanOutput(longPrefix + "http://local", "");
        expect(result1.buffer.length).toBeLessThanOrEqual(4096);

        const result2 = detector.scanOutput("host:3000", result1.buffer);
        expect(result2.url).toBe("http://localhost:3000/");
      });

      it("handles npm output format", () => {
        const result = detector.scanOutput("  > Local:    http://localhost:5173/", "");
        expect(result.url).toBe("http://localhost:5173/");
      });

      it("handles yarn output format", () => {
        const result = detector.scanOutput(
          "webpack 5.0.0 compiled with 1 warning in 1234ms\n✔ Compiled successfully!\nYou can now view app in the browser.\n  Local:            http://localhost:3000",
          ""
        );
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("handles pnpm output format", () => {
        const result = detector.scanOutput("  ➜  Local:   http://localhost:5173/", "");
        expect(result.url).toBe("http://localhost:5173/");
      });

      it("handles bun output format", () => {
        const result = detector.scanOutput("[0.23s] http://localhost:3000", "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("extracts latest URL from buffer when port changes", () => {
        const result1 = detector.scanOutput("Server at http://localhost:3000\n", "");
        const result2 = detector.scanOutput(
          "Port changed, now at http://localhost:3001\n",
          result1.buffer
        );
        expect(result2.url).toBe("http://localhost:3001/");
      });

      it("returns null when no URL is present", () => {
        const result = detector.scanOutput("Compiling TypeScript files...", "");
        expect(result.url).toBeNull();
      });

      it("returns null for empty data", () => {
        const result = detector.scanOutput("", "");
        expect(result.url).toBeNull();
      });

      it("detects URLs with paths", () => {
        const result = detector.scanOutput("App at http://localhost:3000/app/dashboard", "");
        expect(result.url).toBe("http://localhost:3000/app/dashboard");
      });

      it("detects HTTPS localhost URLs", () => {
        const result = detector.scanOutput("Secure server: https://localhost:8443", "");
        expect(result.url).toBe("https://localhost:8443/");
      });

      it("handles URLs with query strings", () => {
        const result = detector.scanOutput("Preview at http://localhost:3000/?token=abc123", "");
        expect(result.url).toBe("http://localhost:3000/?token=abc123");
      });

      it("handles URLs without port numbers", () => {
        const result = detector.scanOutput("Server: http://localhost", "");
        expect(result.url).toBe("http://localhost/");
      });

      it("prefers first localhost URL when multiple in same chunk", () => {
        const result = detector.scanOutput(
          "Old: http://localhost:3000 New: http://localhost:4000",
          ""
        );
        // TODO: Should prefer latest (4000) but currently returns first (3000)
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("does not detect IPv6 bracket notation URLs", () => {
        const result = detector.scanOutput("Server: http://[::1]:3000", "");
        // TODO: IPv6 bracket format not currently supported by regex
        expect(result.url).toBeNull();
      });
    });

    describe("error detection", () => {
      it("detects port conflict errors", () => {
        const result = detector.scanOutput(
          "Error: listen EADDRINUSE: address already in use :::3000",
          ""
        );
        expect(result.error?.type).toBe("port-conflict");
        expect(result.error?.port).toBe("3000");
      });

      it("detects missing dependency errors", () => {
        const result = detector.scanOutput("Error: Cannot find module 'react'", "");
        expect(result.error?.type).toBe("missing-dependencies");
        expect(result.error?.module).toBe("react");
      });

      it("detects permission errors", () => {
        const result = detector.scanOutput("Error: EACCES: permission denied", "");
        expect(result.error?.type).toBe("permission");
      });

      it("does not detect errors when auto-retry message is present", () => {
        const result = detector.scanOutput("port 3000 in use, trying another port", "");
        expect(result.error).toBeNull();
      });

      it("uses buffer for error detection across chunks", () => {
        const result1 = detector.scanOutput("Error: Cannot find ", "");
        const result2 = detector.scanOutput("module 'express'", result1.buffer);
        expect(result2.error?.type).toBe("missing-dependencies");
      });

      it("detects 'Something is already running on port' format", () => {
        const result = detector.scanOutput("Something is already running on port 3000", "");
        expect(result.error?.type).toBe("port-conflict");
        expect(result.error?.port).toBe("3000");
      });

      it("detects EPERM permission errors", () => {
        const result = detector.scanOutput("Error: EPERM: operation not permitted", "");
        expect(result.error?.type).toBe("permission");
      });

      it("detects MODULE_NOT_FOUND errors", () => {
        const result = detector.scanOutput("Error [ERR_MODULE_NOT_FOUND]", "");
        expect(result.error?.type).toBe("missing-dependencies");
      });

      it("returns null error for normal output", () => {
        const result = detector.scanOutput("Compiling 42 files...", "");
        expect(result.error).toBeNull();
      });

      it("can detect both URL and error in same output", () => {
        const result = detector.scanOutput(
          "http://localhost:3000\nError: EACCES: permission denied",
          ""
        );
        expect(result.url).toBe("http://localhost:3000/");
        expect(result.error?.type).toBe("permission");
      });
    });

    describe("buffer management", () => {
      it("returns updated buffer after scan", () => {
        const result = detector.scanOutput("test output", "");
        expect(result.buffer).toBe("test output");
      });

      it("appends new data to existing buffer", () => {
        const result1 = detector.scanOutput("line 1\n", "");
        const result2 = detector.scanOutput("line 2\n", result1.buffer);
        expect(result2.buffer).toBe("line 1\nline 2\n");
      });

      it("maintains buffer size limit of 4096 characters", () => {
        const longData = "x".repeat(5000);
        const result = detector.scanOutput(longData, "");
        expect(result.buffer).toHaveLength(4096);
        expect(result.buffer).toBe(longData.slice(-4096));
      });

      it("trims old data when buffer exceeds limit", () => {
        const result1 = detector.scanOutput("a".repeat(3000), "");
        const result2 = detector.scanOutput("b".repeat(2000), result1.buffer);
        expect(result2.buffer).toHaveLength(4096);
        expect(result2.buffer.startsWith("a")).toBe(true);
        expect(result2.buffer.endsWith("b")).toBe(true);
      });

      it("returns empty buffer for empty input", () => {
        const result = detector.scanOutput("", "");
        expect(result.buffer).toBe("");
      });
    });

    describe("stateless design", () => {
      it("produces identical results with fresh instances", () => {
        const detector1 = new UrlDetector();
        const detector2 = new UrlDetector();

        const data = "Server at http://localhost:3000";
        const result1 = detector1.scanOutput(data, "");
        const result2 = detector2.scanOutput(data, "");

        expect(result1).toEqual(result2);
      });

      it("does not leak state between scanOutput calls", () => {
        const result1 = detector.scanOutput("Error: EACCES: permission denied", "");
        expect(result1.error?.type).toBe("permission");

        const result2 = detector.scanOutput("All good, no errors here", "");
        expect(result2.error).toBeNull();
        expect(result2.url).toBeNull();
      });
    });
  });
});

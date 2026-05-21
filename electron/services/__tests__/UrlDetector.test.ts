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

      it("handles URLs with OSC 8 hyperlinks (BEL terminator)", () => {
        const withOsc =
          "Server at \x1b]8;;http://localhost:3000\x07http://localhost:3000\x1b]8;;\x07";
        const result = detector.scanOutput(withOsc, "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("handles URLs with OSC 8 hyperlinks (ST terminator — xterm 6 style)", () => {
        const withOsc =
          "Server at \x1b]8;;http://localhost:3000\x1b\\http://localhost:3000\x1b]8;;\x1b\\";
        const result = detector.scanOutput(withOsc, "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("does not capture BEL control character as part of detected URL", () => {
        const withOsc = "\x1b]8;;http://localhost:5173/\x07http://localhost:5173/\x1b]8;;\x07";
        const result = detector.scanOutput(withOsc, "");
        expect(result.url).toBe("http://localhost:5173/");
        expect(result.url).not.toContain("%07");
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

      it("prefers localhost even when it appears before a later non-localhost URL", () => {
        const result = detector.scanOutput("http://localhost:3000 and http://127.0.0.1:4000", "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("returns last URL if no localhost variant exists", () => {
        const result = detector.scanOutput("http://127.0.0.1:3000 and http://127.0.0.1:4000", "");
        expect(result.url).toBe("http://127.0.0.1:4000/");
      });

      it("maintains 8192 character buffer for split URL detection", () => {
        const longPrefix = "x".repeat(8000);
        const result1 = detector.scanOutput(longPrefix + "http://local", "");
        expect(result1.buffer.length).toBeLessThanOrEqual(8192);

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

      it("prefers last localhost URL when multiple in same chunk", () => {
        const result = detector.scanOutput(
          "Old: http://localhost:3000 New: http://localhost:4000",
          ""
        );
        expect(result.url).toBe("http://localhost:4000/");
      });

      it("detects IPv6 bracket notation URLs", () => {
        const result = detector.scanOutput("Server: http://[::1]:3000", "");
        expect(result.url).toBe("http://[::1]:3000/");
      });

      it("detects URLs wrapped in OSC 8 with non-empty params (BEL terminator)", () => {
        const withOsc =
          "Server at \x1b]8;id=vte-123;http://localhost:3000\x07http://localhost:3000\x1b]8;;\x07";
        const result = detector.scanOutput(withOsc, "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("detects URLs wrapped in OSC 8 with non-empty params (ST terminator)", () => {
        const withOsc =
          "Server at \x1b]8;id=gcc-456;http://localhost:3000\x1b\\http://localhost:3000\x1b]8;;\x1b\\";
        const result = detector.scanOutput(withOsc, "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("does not extract URLs from DCS payloads containing localhost substring", () => {
        // DCS payload with base64-like content containing "localhost" as substring
        const withDcs = "Before \x1bP@k=30;bG9jYWxob3N0\x1b\\ after";
        const result = detector.scanOutput(withDcs, "");
        expect(result.url).toBeNull();
      });

      it("extracts only real URL when APC payload precedes a localhost URL", () => {
        // Kitty-like APC followed by a real URL
        const withApc =
          "Data \x1b_Gi=1,aW1hZ2U6Ly9sb2NhbGhvc3Q6OTk5OQ==\x1b\\ then http://localhost:3000";
        const result = detector.scanOutput(withApc, "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("detects URL with trailing dot from sentence punctuation", () => {
        const result = detector.scanOutput("Server running at http://localhost:3000.", "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("detects URL with trailing semicolon from list punctuation", () => {
        const result = detector.scanOutput("URL: http://localhost:3000;", "");
        expect(result.url).toBe("http://localhost:3000/");
      });

      it("detects URL with trailing comma from prose punctuation", () => {
        const result = detector.scanOutput("Check http://localhost:3000, and more", "");
        expect(result.url).toBe("http://localhost:3000/");
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

      it("maintains buffer size limit of 8192 characters", () => {
        const longData = "x".repeat(9000);
        const result = detector.scanOutput(longData, "");
        expect(result.buffer).toHaveLength(8192);
        expect(result.buffer).toBe(longData.slice(-8192));
      });

      it("trims old data when buffer exceeds limit", () => {
        const result1 = detector.scanOutput("a".repeat(5000), "");
        const result2 = detector.scanOutput("b".repeat(5000), result1.buffer);
        expect(result2.buffer).toHaveLength(8192);
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

    describe("readiness markers", () => {
      it("detects the Vite ready line", () => {
        const result = detector.scanOutput("  VITE v5.4.0  ready in 312 ms", "");
        expect(result.readyMarker).toBe(true);
      });

      it("detects the Vite ready line for Vite 8", () => {
        const result = detector.scanOutput("  VITE v8.0.1  ready in 87 ms", "");
        expect(result.readyMarker).toBe(true);
      });

      it("detects the Vite ready line wrapped in ANSI colour codes", () => {
        const withAnsi = "\x1b[36m  VITE v6.3.1\x1b[39m  \x1b[32mready in 456 ms\x1b[0m";
        const result = detector.scanOutput(withAnsi, "");
        expect(result.readyMarker).toBe(true);
      });

      it("detects the Next.js checkmark ready line", () => {
        const result = detector.scanOutput("\x1b[32m✓\x1b[0m Ready in 1843ms", "");
        expect(result.readyMarker).toBe(true);
      });

      it("detects the Next.js legacy 'started server on' line", () => {
        const result = detector.scanOutput(
          "ready - started server on 0.0.0.0:3000, url: http://localhost:3000",
          ""
        );
        expect(result.readyMarker).toBe(true);
      });

      it("detects the webpack compiled-successfully line", () => {
        const result = detector.scanOutput("webpack compiled successfully", "");
        expect(result.readyMarker).toBe(true);
      });

      it("detects the webpack-dev-middleware compiled line", () => {
        const result = detector.scanOutput(
          "[webpack-dev-middleware] Compiled successfully in 1203 ms",
          ""
        );
        expect(result.readyMarker).toBe(true);
      });

      it("returns false for unrelated output", () => {
        const result = detector.scanOutput("Compiling routes and warming the cache...", "");
        expect(result.readyMarker).toBe(false);
      });

      it("returns false on a URL-only line (no regression)", () => {
        const result = detector.scanOutput("Server at http://localhost:3000", "");
        expect(result.readyMarker).toBe(false);
        expect(result.url).toBe("http://localhost:3000/");
      });
    });
  });
});

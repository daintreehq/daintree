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
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        detector.scanOutput("Server running at http://localhost:3000", "");

        expect(urls).toEqual(["http://localhost:3000/"]);
      });

      it("detects 127.0.0.1 URLs", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        detector.scanOutput("Listening on http://127.0.0.1:8080", "");

        expect(urls).toEqual(["http://127.0.0.1:8080/"]);
      });

      it("detects 0.0.0.0 URLs and normalizes to localhost", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        detector.scanOutput("Server: http://0.0.0.0:5000", "");

        expect(urls).toEqual(["http://localhost:5000/"]);
      });

      it("handles URLs with ANSI escape codes", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        const withAnsi = "\x1b[32mhttp://localhost:3000\x1b[0m";
        detector.scanOutput(withAnsi, "");

        expect(urls).toEqual(["http://localhost:3000/"]);
      });

      it("handles URLs with OSC hyperlinks via ANSI stripping", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        const withOsc =
          "Server at \x1b]8;;http://localhost:3000\x07http://localhost:3000\x1b]8;;\x07";
        detector.scanOutput(withOsc, "");

        expect(urls).toEqual(["http://localhost:3000/"]);
      });

      it("detects URLs split across chunks using buffer", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        const result1 = detector.scanOutput("Server at http://local", "");
        detector.scanOutput("host:3000", result1.buffer);

        expect(urls).toEqual(["http://localhost:3000/"]);
      });

      it("prefers localhost over 127.0.0.1 when multiple URLs found", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        detector.scanOutput("http://127.0.0.1:3000 and http://localhost:3000", "");

        expect(urls).toEqual(["http://localhost:3000/"]);
      });

      it("returns first URL if no localhost variant exists", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        detector.scanOutput("http://127.0.0.1:3000 and http://127.0.0.1:4000", "");

        expect(urls).toEqual(["http://127.0.0.1:3000/"]);
      });

      it("maintains 4096 character buffer for split URL detection", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        const longPrefix = "x".repeat(4000);
        const result1 = detector.scanOutput(longPrefix + "http://local", "");

        expect(result1.buffer.length).toBeLessThanOrEqual(4096);

        detector.scanOutput("host:3000", result1.buffer);
        expect(urls).toEqual(["http://localhost:3000/"]);
      });

      it("does not emit duplicate URLs for the same output", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        detector.scanOutput("http://localhost:3000 http://localhost:3000", "");

        expect(urls).toEqual(["http://localhost:3000/"]);
      });

      it("handles npm output format", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        detector.scanOutput("  > Local:    http://localhost:5173/", "");

        expect(urls).toEqual(["http://localhost:5173/"]);
      });

      it("handles yarn output format", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        detector.scanOutput(
          "webpack 5.0.0 compiled with 1 warning in 1234ms\n✔ Compiled successfully!\nYou can now view app in the browser.\n  Local:            http://localhost:3000",
          ""
        );

        expect(urls).toEqual(["http://localhost:3000/"]);
      });

      it("handles pnpm output format", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        detector.scanOutput("  ➜  Local:   http://localhost:5173/", "");

        expect(urls).toEqual(["http://localhost:5173/"]);
      });

      it("handles bun output format", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        detector.scanOutput("[0.23s] http://localhost:3000", "");

        expect(urls).toEqual(["http://localhost:3000/"]);
      });

      it("extracts latest URL from buffer when port changes", () => {
        const urls: string[] = [];
        detector.on("url-detected", (url) => urls.push(url));

        const result1 = detector.scanOutput("Server at http://localhost:3000\n", "");
        detector.scanOutput("Port changed, now at http://localhost:3001\n", result1.buffer);

        expect(urls[urls.length - 1]).toBe("http://localhost:3001/");
      });
    });

    describe("error detection", () => {
      it("detects port conflict errors", () => {
        const errors: any[] = [];
        detector.on("error-detected", (error) => errors.push(error));

        detector.scanOutput("Error: listen EADDRINUSE: address already in use :::3000", "");

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe("port-conflict");
        expect(errors[0].port).toBe("3000");
      });

      it("detects missing dependency errors", () => {
        const errors: any[] = [];
        detector.on("error-detected", (error) => errors.push(error));

        detector.scanOutput("Error: Cannot find module 'react'", "");

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe("missing-dependencies");
        expect(errors[0].module).toBe("react");
      });

      it("detects permission errors", () => {
        const errors: any[] = [];
        detector.on("error-detected", (error) => errors.push(error));

        detector.scanOutput("Error: EACCES: permission denied", "");

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe("permission");
      });

      it("does not detect errors when auto-retry message is present", () => {
        const errors: any[] = [];
        detector.on("error-detected", (error) => errors.push(error));

        detector.scanOutput("port 3000 in use, trying another port", "");

        expect(errors).toHaveLength(0);
      });

      it("uses buffer for error detection across chunks", () => {
        const errors: any[] = [];
        detector.on("error-detected", (error) => errors.push(error));

        const result1 = detector.scanOutput("Error: Cannot find ", "");
        detector.scanOutput("module 'express'", result1.buffer);

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe("missing-dependencies");
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
    });

    describe("event emission", () => {
      it("does not emit events when no URLs or errors found", () => {
        const urls: string[] = [];
        const errors: any[] = [];
        detector.on("url-detected", (url) => urls.push(url));
        detector.on("error-detected", (error) => errors.push(error));

        detector.scanOutput("normal terminal output", "");

        expect(urls).toHaveLength(0);
        expect(errors).toHaveLength(0);
      });

      it("emits both URL and error events if both detected", () => {
        const urls: string[] = [];
        const errors: any[] = [];
        detector.on("url-detected", (url) => urls.push(url));
        detector.on("error-detected", (error) => errors.push(error));

        detector.scanOutput(
          "Server at http://localhost:3000\nError: Cannot find module 'react'",
          ""
        );

        expect(urls).toHaveLength(1);
        expect(errors).toHaveLength(1);
      });

      it("allows multiple listeners for the same event", () => {
        const urls1: string[] = [];
        const urls2: string[] = [];
        detector.on("url-detected", (url) => urls1.push(url));
        detector.on("url-detected", (url) => urls2.push(url));

        detector.scanOutput("http://localhost:3000", "");

        expect(urls1).toEqual(["http://localhost:3000/"]);
        expect(urls2).toEqual(["http://localhost:3000/"]);
      });
    });
  });
});

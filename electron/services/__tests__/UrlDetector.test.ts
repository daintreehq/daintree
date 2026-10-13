import { describe, it, expect, beforeEach } from "vitest";
import { UrlDetector, type ScanResult } from "../UrlDetector.js";
import { extractLocalhostUrls, stripAnsiAndOscCodes } from "../../../shared/utils/urlUtils.js";
import {
  DEV_SERVER_ERROR_PATTERNS,
  DEV_SERVER_ERROR_TRIGGERS,
  detectDevServerError,
} from "../../../shared/utils/devServerErrors.js";

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

      it("detects URL with trailing dot from sentence punctuation", () => {
        const result = detector.scanOutput("Server running at http://localhost:3000.", "");
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

    describe("compile markers", () => {
      it("detects webpack 'compiling...' line", () => {
        const result = detector.scanOutput("compiling...", "");
        expect(result.compileMarker).toBe(true);
        expect(result.readyMarker).toBe(false);
      });

      it("detects Vite hmr update", () => {
        const result = detector.scanOutput("[vite] hmr update /src/App.tsx", "");
        expect(result.compileMarker).toBe(true);
      });

      it("detects Vite page reload", () => {
        const result = detector.scanOutput("[vite] page reload src/main.tsx", "");
        expect(result.compileMarker).toBe(true);
      });

      it("detects Next.js 'Compiling /route'", () => {
        const result = detector.scanOutput("Compiling /dashboard", "");
        expect(result.compileMarker).toBe(true);
      });

      it("does not match 'Compiled' (completion, not compile-start)", () => {
        const result = detector.scanOutput("Compiled successfully in 234ms", "");
        expect(result.compileMarker).toBe(false);
      });

      it("does not match unrelated output", () => {
        const result = detector.scanOutput("Watching for file changes...", "");
        expect(result.compileMarker).toBe(false);
        expect(result.readyMarker).toBe(false);
      });

      it("handles ANSI-coloured compile markers", () => {
        const withAnsi = "\x1b[36mcompiling...\x1b[0m";
        const result = detector.scanOutput(withAnsi, "");
        expect(result.compileMarker).toBe(true);
      });
    });

    // #12299: PTY transport splits output at arbitrary offsets, so a marker
    // line regularly arrives in two pieces. Matching only the current chunk
    // dropped those markers permanently.
    describe("markers split across chunk boundaries", () => {
      const READY_LINE = "  VITE v8.0.1  ready in 87 ms";
      const COMPILE_LINE = "[vite] hmr update /src/App.tsx";

      function feed(chunks: string[]): Array<{ readyMarker: boolean; compileMarker: boolean }> {
        let buffer = "";
        return chunks.map((chunk) => {
          const result = detector.scanOutput(chunk, buffer);
          buffer = result.buffer;
          return { readyMarker: result.readyMarker, compileMarker: result.compileMarker };
        });
      }

      it("detects a ready marker at every split position", () => {
        for (let split = 1; split < READY_LINE.length; split++) {
          detector = new UrlDetector();
          const results = feed([READY_LINE.slice(0, split), READY_LINE.slice(split)]);
          expect(
            results.some((r) => r.readyMarker),
            `split at ${split}`
          ).toBe(true);
        }
      });

      it("detects a compile marker at every split position", () => {
        for (let split = 1; split < COMPILE_LINE.length; split++) {
          detector = new UrlDetector();
          const results = feed([COMPILE_LINE.slice(0, split), COMPILE_LINE.slice(split)]);
          expect(
            results.some((r) => r.compileMarker),
            `split at ${split}`
          ).toBe(true);
        }
      });

      it("detects a ready marker split across three chunks", () => {
        const results = feed(["  VITE v8.0", ".1  ready", " in 87 ms"]);
        expect(results.some((r) => r.readyMarker)).toBe(true);
      });

      it("reports a split marker exactly once", () => {
        const results = feed(["  VITE v8.0.1  rea", "dy in 87 ms", "\nwatching for changes"]);
        expect(results.filter((r) => r.readyMarker)).toHaveLength(1);
      });

      it("does not re-report a completed marker on later unrelated chunks", () => {
        const results = feed([READY_LINE, "\n", "  ➜  press h + enter to show help", ""]);
        expect(results.filter((r) => r.readyMarker)).toHaveLength(1);
      });

      it("reports a second genuine marker later in the stream", () => {
        const results = feed([COMPILE_LINE, "\nsome unrelated output\n", COMPILE_LINE]);
        expect(results.filter((r) => r.compileMarker)).toHaveLength(2);
      });

      it("detects a marker whose ANSI colour codes are split across chunks", () => {
        const results = feed(["\x1b[36m  VITE v6.3.1\x1b[39m  \x1b[32mready", " in 456 ms\x1b[0m"]);
        expect(results.some((r) => r.readyMarker)).toBe(true);
      });

      // The escape SEQUENCE itself straddles the boundary, so neither half
      // contains a complete one. Stripping the halves independently leaves
      // "\x1b[0m" embedded between the glyph and "Ready", and the marker is
      // lost for good.
      it("detects a marker when an escape sequence straddles the boundary", () => {
        const results = feed(["\x1b[32m✓\x1b[0", "m Ready in 87ms"]);
        expect(results.some((r) => r.readyMarker)).toBe(true);
      });

      it("detects a compile marker when an escape straddles the boundary", () => {
        const results = feed(["\x1b[36mcompil\x1b[3", "6ming..."]);
        expect(results.some((r) => r.compileMarker)).toBe(true);
      });

      it("does not report a marker that lies wholly in the carried tail", () => {
        const first = detector.scanOutput(READY_LINE, "");
        expect(first.readyMarker).toBe(true);
        const second = detector.scanOutput("still nothing to see", first.buffer);
        expect(second.readyMarker).toBe(false);
      });

      it("keeps markers out of an unrelated session's buffer", () => {
        // scanOutput is stateless — the caller's buffer is the only carry.
        const other = detector.scanOutput("plain output", "");
        expect(other.readyMarker).toBe(false);
        const fresh = detector.scanOutput("dy in 87 ms", "");
        expect(fresh.readyMarker).toBe(false);
      });
    });
  });
});

// UrlDetector skips re-scanning its whole buffer for URLs and errors once their
// literals have scrolled out of it. That is only an optimisation if every scan
// answers exactly as the full re-scan did, so this replays recorded dev-server
// logs through both and compares every result.

function referenceScan(
  data: string,
  buffer: string
): Omit<ScanResult, "readyMarker" | "compileMarker"> {
  const newBuffer =
    data.length < 8192
      ? buffer.slice(Math.max(0, buffer.length - 8192 + data.length)) + data
      : data.slice(-8192);
  let urls = extractLocalhostUrls(data);
  if (urls.length === 0) {
    const bufferUrls = extractLocalhostUrls(newBuffer);
    if (bufferUrls.length > 0) urls = [bufferUrls[bufferUrls.length - 1]];
  }
  let url: string | null = null;
  if (urls.length === 1) url = urls[0];
  else if (urls.length > 1) {
    const local = urls.filter((candidate) => /localhost/i.test(candidate));
    url = local.length > 0 ? local[local.length - 1] : urls[urls.length - 1];
  }
  return { url, error: detectDevServerError(newBuffer), buffer: newBuffer };
}

// Frozen copies of the marker lists, so a change to them shows up here too.
const READY = [
  /VITE\s+v\d+[^\n]*ready\s+in\s+\d+/gi,
  /[✓✔]\s+Ready\s+in/gu,
  /ready\s+-\s+started\s+server\s+on/gi,
  /webpack\s+compiled\s+successfully/gi,
  /\[webpack-dev-middleware\]\s+compiled\s+successfully/gi,
];
const COMPILE = [
  /compiling\.\.\./gi,
  /\[vite\]\s+hmr\s+update/gi,
  /\[vite\]\s+page\s+reload/gi,
  /\bcompiling\s+\//gi,
];

function referenceMarkers(data: string, buffer: string): { ready: boolean; compile: boolean } {
  const carry = buffer.slice(-512);
  const window = stripAnsiAndOscCodes(carry + data);
  const chunk = stripAnsiAndOscCodes(data);
  const strippedCarry = stripAnsiAndOscCodes(carry);
  const boundary =
    strippedCarry.length + chunk.length === window.length
      ? strippedCarry.length
      : Math.max(0, window.length - chunk.length);
  const endsPast = (patterns: RegExp[]): boolean => {
    if (window.length <= boundary) return false;
    for (const pattern of patterns) {
      for (const match of window.matchAll(pattern)) {
        if (match.index + match[0].length > boundary) return true;
      }
    }
    return false;
  };
  return { ready: endsPast(READY), compile: endsPast(COMPILE) };
}

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const VITE_START =
  "\r\n  \x1b[32m\x1b[1mVITE\x1b[22m v6.3.1\x1b[39m  \x1b[2mready in \x1b[0m\x1b[1m312\x1b[22m\x1b[2m\x1b[0m ms\x1b[22m\r\n\r\n" +
  "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n" +
  "  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m: \x1b[2muse \x1b[22m\x1b[1m--host\x1b[22m\x1b[2m to expose\x1b[22m\r\n";

const NEXT_START =
  "   \x1b[1m\x1b[38;2;173;127;168m▲ Next.js 15.3.2\x1b[39m\x1b[22m (Turbopack)\r\n" +
  "   - Local:        \x1b]8;;http://localhost:3000\x1b\\http://localhost:3000\x1b]8;;\x1b\\\r\n" +
  "   - Network:      http://192.168.1.20:3000\r\n\r\n" +
  " \x1b[32m\x1b[1m✓\x1b[22m\x1b[39m Ready in 1234ms\r\n";

function viteHmr(r: () => number, lines: number): string {
  let out = "";
  for (let i = 0; i < lines; i++) {
    out += `\x1b[2m12:0${i % 10}:${10 + (i % 50)} PM\x1b[22m \x1b[36m\x1b[1m[vite]\x1b[22m\x1b[39m \x1b[32m${
      r() < 0.8 ? "hmr update" : "page reload"
    } \x1b[39m\x1b[2m/src/Widget${i % 13}.tsx\x1b[22m\r\n`;
  }
  return out;
}

function nextRequests(r: () => number, lines: number): string {
  let out = "";
  for (let i = 0; i < lines; i++) {
    out +=
      r() < 0.85
        ? ` GET /api/items?page=${i} \x1b[32m200\x1b[39m in ${Math.floor(r() * 300)}ms\r\n`
        : ` \x1b[33m○\x1b[39m Compiling /dashboard ...\r\n \x1b[32m✓\x1b[39m Compiled /dashboard in ${i}ms\r\n`;
  }
  return out;
}

const r = rng(42);

const LOGS: Record<string, string> = {
  "vite: start, long HMR run, compile error, recovery, restart on a new port":
    VITE_START +
    viteHmr(r, 400) +
    "\x1b[31m[vite] Internal server error: Transform failed with 1 error:\x1b[39m\r\n" +
    '/src/App.tsx:12:4: ERROR: Could not resolve "./missing"\r\n' +
    viteHmr(r, 30) +
    "\x1b[31merror TS2304: Cannot find name 'foo'.\x1b[39m\r\n" +
    viteHmr(r, 300) +
    "Port 5173 is in use, trying another one...\r\n" +
    VITE_START.replace("5173", "5174") +
    viteHmr(r, 250),
  "next: start, request log, missing module, EACCES, recovery":
    NEXT_START +
    nextRequests(r, 350) +
    "Error: Cannot find module 'left-pad'\r\nRequire stack:\r\n- /app/page.js\r\n" +
    nextRequests(r, 40) +
    "Error: EACCES: permission denied, open '/app/.next/cache'\r\n" +
    nextRequests(r, 400) +
    "   - Local:        http://127.0.0.1:3001\r\n" +
    nextRequests(r, 200),
  "port conflict whose auto-retry notice scrolls out before the EADDRINUSE line":
    "Port 3000 is in use, trying another one...\r\n" +
    nextRequests(r, 200) +
    "Error: listen EADDRINUSE: address already in use :::3000\r\n" +
    nextRequests(r, 300) +
    "Error: listen EADDRINUSE: address already in use :::4000\r\n" +
    "Port 4000 is in use, trying another one...\r\n" +
    nextRequests(r, 300),
  "URLs straddling chunk boundaries, bare ::1 and 0.0.0.0 hosts":
    viteHmr(r, 50) +
    "Listening on http://[::1]:8080/ and http://0.0.0.0:9000/app\r\n" +
    viteHmr(r, 200) +
    "server ready at \x1b[1mhttp://local\x1b[22mhost:4321/\r\n" +
    viteHmr(r, 200),
};

function chunkings(log: string, seed: number): string[][] {
  const pick = rng(seed);
  const plans: string[][] = [];
  const sized = (min: number, max: number): string[] => {
    const chunks: string[] = [];
    for (let pos = 0; pos < log.length;) {
      const len = min + Math.floor(pick() * (max - min + 1));
      chunks.push(log.slice(pos, pos + len));
      pos += len;
    }
    return chunks;
  };
  plans.push(sized(200, 4096));
  plans.push(sized(1, 40));
  plans.push(sized(1, 12_000));
  plans.push(log.split(/(?<=\n)/));
  return plans;
}

function replay(chunks: readonly string[], detector = new UrlDetector()): void {
  let buffer = "";
  for (const [index, chunk] of chunks.entries()) {
    const actual = detector.scanOutput(chunk, buffer);
    const expected = referenceScan(chunk, buffer);
    const markers = referenceMarkers(chunk, buffer);
    const where = `chunk ${index}`;
    expect(actual.url, where).toBe(expected.url);
    expect(actual.error, where).toEqual(expected.error);
    expect(actual.buffer, where).toBe(expected.buffer);
    expect(actual.readyMarker, where).toBe(markers.ready);
    expect(actual.compileMarker, where).toBe(markers.compile);
    buffer = actual.buffer;
  }
}

describe("UrlDetector parity with a full-buffer re-scan", () => {
  for (const [name, log] of Object.entries(LOGS)) {
    it(name, () => {
      for (const chunks of chunkings(log, name.length)) replay(chunks);
    });
  }

  it("reports the events the full re-scan would, in the same order", () => {
    const log = LOGS["vite: start, long HMR run, compile error, recovery, restart on a new port"];
    const detector = new UrlDetector();
    const events: string[] = [];
    let buffer = "";
    let lastUrl: string | null = null;
    let lastError: string | null = null;
    for (const chunk of chunkings(log, 3)[0]) {
      const result = detector.scanOutput(chunk, buffer);
      buffer = result.buffer;
      if (result.url && result.url !== lastUrl) events.push(`url ${(lastUrl = result.url)}`);
      const key = result.error ? `${result.error.type}:${result.error.message}` : null;
      if (key && key !== lastError) events.push(`error ${(lastError = key)}`);
    }
    expect(events).toEqual([
      "url http://localhost:5173/",
      "error compile-error:Compilation failed. Check the terminal output for details.",
      "url http://localhost:5174/",
    ]);
  });

  it("stays exact when more sessions interleave than it keeps facts for", () => {
    const detector = new UrlDetector();
    const streams = Object.values(LOGS).flatMap((log, i) => [
      chunkings(log, i)[0],
      chunkings(log, i + 10)[1].slice(0, 3000),
    ]);
    const buffers = streams.map(() => "");
    const cursors = streams.map(() => 0);
    const pick = rng(9);
    for (let step = 0; step < 6000; step++) {
      const s = Math.floor(pick() * streams.length);
      const chunk = streams[s][cursors[s]++ % streams[s].length];
      const actual = detector.scanOutput(chunk, buffers[s]);
      const expected = referenceScan(chunk, buffers[s]);
      expect(actual.url, `step ${step}`).toBe(expected.url);
      expect(actual.error, `step ${step}`).toEqual(expected.error);
      buffers[s] = actual.buffer;
    }
  });

  it("stays exact at the edges of the fast path", () => {
    const filler = (n: number): string => "x".repeat(n);
    const cases: string[][] = [
      // A trigger and a hint literal straddling the chunk boundary.
      [filler(100), "Error: Cannot find ", "module 'left-pad'\r\n", filler(50)],
      [filler(100), "listening on 0.0.0", ".0 port 80\r\n", "[::", "1] up\r\n"],
      // Bare hints with no URL, then scrolling out one character at a time.
      ["bound to ::1\r\n", ...Array.from({ length: 40 }, () => filler(205))],
      ["EACCES\r\n", filler(8184), "y", "z", filler(10)],
      // Chunks at and past the buffer size, and empty chunks.
      [filler(20), "Error: EPERM\r\n" + filler(8178), "", "http://localhost:1/" + filler(8173)],
      [filler(8191), "Failed to compile", "", filler(8192), "Port 9 is in use"],
    ];
    for (const chunks of cases) replay(chunks);
  });

  it("stays exact on a buffer longer than it ever returns", () => {
    const detector = new UrlDetector();
    const buffer = "Could not resolve x\r\n" + "y".repeat(9000);
    const expected = referenceScan("tick\r\n", buffer);
    const actual = detector.scanOutput("tick\r\n", buffer);
    expect(actual.error).toEqual(expected.error);
    expect(actual.buffer).toBe(expected.buffer);
  });

  it("has a trigger literal inside every error pattern", () => {
    // Skipping the full error scan is only exact if no pattern can match text
    // that holds none of the triggers — a new pattern needs its own literal.
    const uncovered = DEV_SERVER_ERROR_PATTERNS.filter((pattern) => {
      const literalText = pattern.source.replace(/\\(.)/g, "$1").toLowerCase();
      return !DEV_SERVER_ERROR_TRIGGERS.some((trigger) => literalText.includes(trigger));
    });
    expect(uncovered).toEqual([]);
  });

  it("accepts a buffer it did not produce", () => {
    const detector = new UrlDetector();
    const seeded = "Local: http://localhost:5173/\r\nError: Cannot find module 'x'\r\n";
    const result = detector.scanOutput("hmr update\r\n", seeded);
    expect(result.url).toBe("http://localhost:5173/");
    expect(result.error?.type).toBe("missing-dependencies");
  });
});

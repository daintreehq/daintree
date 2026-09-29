import { describe, expect, it } from "vitest";
import { UrlDetector, type ScanResult } from "../UrlDetector.js";
import { extractLocalhostUrls, stripAnsiAndOscCodes } from "../../../shared/utils/urlUtils.js";
import {
  DEV_SERVER_ERROR_PATTERNS,
  DEV_SERVER_ERROR_TRIGGERS,
  detectDevServerError,
} from "../../../shared/utils/devServerErrors.js";

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

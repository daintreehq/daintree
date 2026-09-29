import { bench, describe } from "vitest";
import { UrlDetector } from "../UrlDetector.js";

// UrlDetector.scanOutput runs on the main thread for every chunk of dev-server
// output (the data-mirror listener stays attached for the whole session). This
// replays a 10k-chunk log from a long-running server — startup banner, then the
// HMR updates and request lines that make up nearly all of its output — split
// into 200 B–4 KB chunks the way the PTY transport delivers them.
//
//   npx vitest bench --run electron/services/__bench__/urlDetector.bench.ts

const CHUNKS = 10_000;

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const VITE_BANNER =
  "\r\n  \x1b[32m\x1b[1mVITE\x1b[22m v6.3.1\x1b[39m  \x1b[2mready in \x1b[0m\x1b[1m312\x1b[22m\x1b[2m\x1b[0m ms\x1b[22m\r\n\r\n" +
  "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n" +
  "  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m: \x1b[2muse \x1b[22m\x1b[1m--host\x1b[22m\x1b[2m to expose\x1b[22m\r\n";

const NEXT_BANNER =
  "   \x1b[1m\x1b[38;2;173;127;168m▲ Next.js 15.3.2\x1b[39m\x1b[22m (Turbopack)\r\n" +
  "   - Local:        http://localhost:3000\r\n   - Network:      http://192.168.1.20:3000\r\n\r\n" +
  " \x1b[32m\x1b[1m✓\x1b[22m\x1b[39m Starting...\r\n \x1b[32m\x1b[1m✓\x1b[22m\x1b[39m Ready in 1234ms\r\n";

function viteLine(r: () => number, i: number): string {
  const file = `/src/components/Feature${Math.floor(r() * 40)}/Widget${i % 17}.tsx`;
  return r() < 0.7
    ? `\x1b[2m12:0${i % 10}:${10 + (i % 50)} PM\x1b[22m \x1b[36m\x1b[1m[vite]\x1b[22m\x1b[39m \x1b[32mhmr update \x1b[39m\x1b[2m${file}\x1b[22m\r\n`
    : `\x1b[2m12:0${i % 10}:${10 + (i % 50)} PM\x1b[22m \x1b[36m\x1b[1m[vite]\x1b[22m\x1b[39m \x1b[32mpage reload \x1b[39m\x1b[2m${file}\x1b[22m\r\n`;
}

function nextLine(r: () => number, i: number): string {
  const route = ["/", "/api/users", "/dashboard", "/api/session", "/_next/data/build/index.json"][
    Math.floor(r() * 5)
  ];
  return r() < 0.9
    ? ` GET ${route}?page=${i % 30} \x1b[32m200\x1b[39m in ${Math.floor(r() * 400)}ms\r\n`
    : ` \x1b[32m\x1b[1m✓\x1b[22m\x1b[39m Compiled ${route} in ${Math.floor(r() * 900)}ms (${800 + (i % 300)} modules)\r\n`;
}

function buildLog(
  banner: string,
  line: (r: () => number, i: number) => string,
  seed: number
): string[] {
  const r = rng(seed);
  let stream = banner;
  let i = 0;
  // ~2.2 KB average chunk × 10k chunks.
  while (stream.length < CHUNKS * 2300) stream += line(r, i++);
  const chunks: string[] = [];
  let pos = 0;
  while (chunks.length < CHUNKS) {
    const len = 200 + Math.floor(r() * 3900);
    chunks.push(stream.slice(pos, pos + len));
    pos += len;
  }
  return chunks;
}

function erroringLine(r: () => number, i: number): string {
  return r() < 0.3 ? `\x1b[31merror TS2304: Cannot find name 'x${i}'.\x1b[39m\r\n` : viteLine(r, i);
}

const viteChunks = buildLog(VITE_BANNER, viteLine, 7);
const nextChunks = buildLog(NEXT_BANNER, nextLine, 11);
// Worst case for the detector's per-buffer bookkeeping: more interleaved
// sessions than it keeps facts for, every buffer full of error lines.
const erroringSessions = [1, 2, 3, 4, 5].map((seed) =>
  buildLog(VITE_BANNER, erroringLine, seed).slice(0, CHUNKS / 5)
);

function replay(chunks: readonly string[]): number {
  const detector = new UrlDetector();
  let buffer = "";
  let seen = 0;
  for (const chunk of chunks) {
    const result = detector.scanOutput(chunk, buffer);
    buffer = result.buffer;
    if (result.url || result.error || result.readyMarker || result.compileMarker) seen += 1;
  }
  return seen;
}

function replayInterleaved(sessions: readonly (readonly string[])[]): number {
  const detector = new UrlDetector();
  const buffers = sessions.map(() => "");
  let seen = 0;
  for (let i = 0; i < sessions[0].length; i++) {
    for (let s = 0; s < sessions.length; s++) {
      const result = detector.scanOutput(sessions[s][i], buffers[s]);
      buffers[s] = result.buffer;
      if (result.error) seen += 1;
    }
  }
  return seen;
}

describe("UrlDetector.scanOutput — 10k-chunk dev-server log", () => {
  bench("vite (HMR)", () => {
    replay(viteChunks);
  });
  bench("next (request log)", () => {
    replay(nextChunks);
  });
  bench("5 interleaved sessions, recurring errors", () => {
    replayInterleaved(erroringSessions);
  });
});

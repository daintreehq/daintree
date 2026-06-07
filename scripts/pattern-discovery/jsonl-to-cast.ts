/**
 * Convert a pattern-discovery JSONL corpus into an asciinema v2 `.cast` file
 * suitable for the ActivityMonitor replay harness
 * (`electron/services/__tests__/replay/castReplayHarness.ts`), plus a stub
 * `.expected.json` that fails the replay test until a developer calibrates it.
 *
 * Every chunk is passed through `scrubReportText` before serialization, so the
 * output is safe to commit by construction — redaction happens at the write
 * boundary, never at the capture layer (lesson #9427).
 *
 * Usage:
 *   npm run pattern-discovery:jsonl-to-cast -- \
 *     --corpus scripts/pattern-discovery/corpus/aider_sample.jsonl \
 *     --out electron/services/__tests__/fixtures/activity-monitor/aider-working-to-idle
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scrubReportText } from "../../shared/utils/reportScrubbers.js";
import { readCorpus } from "./corpus-replay.js";
import type { CorpusEntry } from "./types.js";

export interface ConvertOptions {
  width: number;
  height: number;
  title: string;
  /**
   * Prepend `\r\n` to every event after the first so each corpus chunk lands
   * on its own terminal row. Synthetic sample corpora store bare strings with
   * no control characters — replaying them verbatim concatenates everything
   * onto one row, which breaks cursor-line prompt detection. Raw PTY
   * recordings already embed their own line discipline and must NOT be
   * line-structured. When undefined, auto-detects: line events are enabled
   * only if no chunk contains `\r`, `\n`, or `ESC`.
   */
  lineEvents?: boolean;
}

const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 30;

export function corpusLooksSynthetic(entries: CorpusEntry[]): boolean {
  // eslint-disable-next-line no-control-regex -- ESC is the signal being detected
  return entries.every((e) => !/[\r\n\u001b]/.test(e.chunk));
}

export function corpusEntriesToCast(entries: CorpusEntry[], opts: ConvertOptions): string {
  if (entries.length === 0) {
    throw new Error("Corpus is empty — nothing to convert.");
  }
  const lineEvents = opts.lineEvents ?? corpusLooksSynthetic(entries);
  const header = JSON.stringify({
    version: 2,
    width: opts.width,
    height: opts.height,
    // The CLI derives the title from the fixture basename, but programmatic
    // callers may pass arbitrary text — scrub it like every other payload.
    title: scrubReportText(opts.title),
  });
  const lines = [header];
  for (let i = 0; i < entries.length; i++) {
    const chunk = scrubReportText(entries[i].chunk);
    const data = lineEvents && i > 0 ? `\r\n${chunk}` : chunk;
    lines.push(JSON.stringify([entries[i].time, "o", data]));
  }
  return lines.join("\n") + "\n";
}

export function buildStubExpected(agentId: string | undefined): string {
  const stub = {
    agentId,
    settleMs: 8000,
    _stub:
      "Calibrate before committing: run the replay test, read the recorded transitions " +
      "from the failure output, author the real transitions, then delete this field. " +
      "See docs/architecture/agent-activity-monitoring.md § Adding replay fixtures.",
    transitions: [{ atMs: 0, state: "busy", trigger: "STUB_REPLACE_ME" }],
  };
  return JSON.stringify(stub, null, 2) + "\n";
}

export interface WriteFixtureResult {
  castPath: string;
  expectedPath: string;
  wroteExpected: boolean;
}

/**
 * Write `<base>.cast` (always overwritten) and `<base>.expected.json` (only
 * when absent — calibrated expectations are never clobbered).
 */
export function writeCastFixture(
  outBase: string,
  castText: string,
  stubExpectedText: string
): WriteFixtureResult {
  const base = outBase.endsWith(".cast") ? outBase.slice(0, -".cast".length) : outBase;
  const castPath = `${base}.cast`;
  const expectedPath = `${base}.expected.json`;
  fs.mkdirSync(path.dirname(castPath), { recursive: true });
  fs.writeFileSync(castPath, castText, "utf8");
  const wroteExpected = !fs.existsSync(expectedPath);
  if (wroteExpected) {
    fs.writeFileSync(expectedPath, stubExpectedText, "utf8");
  }
  return { castPath, expectedPath, wroteExpected };
}

interface CliOptions {
  corpusPath: string;
  outBase: string;
  width: number;
  height: number;
  agentId?: string;
  lineEvents?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  let lineEvents: boolean | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--line-events") {
      lineEvents = true;
      continue;
    }
    if (token === "--raw") {
      lineEvents = false;
      continue;
    }
    if (!token.startsWith("--")) continue;
    const key = token.replace(/^--/, "");
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) {
      args.set(key, value);
      i++;
    }
  }

  const corpusPath = args.get("corpus");
  const outBase = args.get("out");
  if (!corpusPath || !outBase) {
    throw new Error(
      "Usage: jsonl-to-cast --corpus <corpus.jsonl> --out <fixture-base> " +
        "[--width 80] [--height 30] [--agent <id>] [--line-events|--raw]"
    );
  }

  return {
    corpusPath,
    outBase,
    width: Number(args.get("width") ?? DEFAULT_WIDTH),
    height: Number(args.get("height") ?? DEFAULT_HEIGHT),
    agentId: args.get("agent"),
    lineEvents,
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const entries = readCorpus(options.corpusPath);
  const title = path.basename(options.outBase, ".cast");
  const castText = corpusEntriesToCast(entries, {
    width: options.width,
    height: options.height,
    title,
    lineEvents: options.lineEvents,
  });
  const agentId = options.agentId ?? entries[0]?.agentId;
  const result = writeCastFixture(options.outBase, castText, buildStubExpected(agentId));

  const mode = (options.lineEvents ?? corpusLooksSynthetic(entries))
    ? "line-structured"
    : "raw chunks";
  console.log(`[jsonl-to-cast] Wrote ${result.castPath} (${entries.length} events, ${mode})`);
  if (result.wroteExpected) {
    console.log(`[jsonl-to-cast] Wrote stub ${result.expectedPath} — calibrate before committing`);
  } else {
    console.log(`[jsonl-to-cast] Kept existing ${result.expectedPath} (not overwritten)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

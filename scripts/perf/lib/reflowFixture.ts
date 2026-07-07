import { RESIZE_FLUSH_SYNC_BUDGET_BYTES } from "../../../src/services/terminal/resizeFlushBudget";
import { createHeadlessTerminal, createRng } from "./workloads";

type HeadlessTerminal = import("@xterm/headless").Terminal;

/**
 * Fixture helpers for the resize/reflow scenarios (PERF-110..112).
 *
 * Everything here is lazy: importing this module must never construct a
 * terminal or generate backlog content (same rule gitPipelineFixture
 * documents, required by the scenario-matrix test). Reflow cost is dominated
 * by the wrapped-line ratio, so the seeded generator emits a realistic
 * agent-output mix instead of uniform short lines: ~30% lines longer than
 * the column width (tool results, file paths, diffs — multi-row wrapped
 * lines whose re-wrap is the expensive part), ~10% ANSI-SGR-heavy lines,
 * remainder short status lines. Seeds are fixed so byte content is identical
 * across runs and machines; checksums keep it honest.
 */

const LONG_LINE_FILL =
  "const value = await pipeline.transform(input, options); // 0123456789abcdef ";
const SGR_COLORS = [31, 32, 33, 34, 35, 36] as const;

let constructedReflowTerminals = 0;

/** Guard hook for the scenario-matrix test: importing modules must not build terminals. */
export function getConstructedReflowTerminalCount(): number {
  return constructedReflowTerminals;
}

async function createCountedTerminal(config: {
  cols: number;
  rows: number;
  scrollback: number;
}): Promise<HeadlessTerminal> {
  constructedReflowTerminals += 1;
  return createHeadlessTerminal(config);
}

/** Seeded agent-output generator with a running FNV-1a checksum. */
export class AgentOutputStream {
  private readonly rng: () => number;
  private lineIndex = 0;
  private checksumState = 0x811c9dc5;

  constructor(seed: number) {
    this.rng = createRng(seed);
  }

  get checksum(): number {
    return this.checksumState >>> 0;
  }

  nextChunk(lineCount: number): string {
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i += 1) {
      lines.push(this.nextLine());
    }
    const chunk = `${lines.join("\n")}\n`;
    this.fold(chunk);
    return chunk;
  }

  private nextLine(): string {
    const draw = this.rng();
    const index = this.lineIndex;
    this.lineIndex += 1;
    if (draw < 0.3) return this.longLine(index);
    if (draw < 0.4) return this.sgrLine(index);
    return this.shortLine(index);
  }

  private longLine(index: number): string {
    const target = 150 + Math.floor(this.rng() * 210);
    let text = `src/generated/module${index % 97}.ts:${index % 400}: `;
    while (text.length < target) text += LONG_LINE_FILL;
    return text.slice(0, target);
  }

  private sgrLine(index: number): string {
    const segments = 6 + Math.floor(this.rng() * 5);
    let text = "";
    for (let segment = 0; segment < segments; segment += 1) {
      const color = SGR_COLORS[Math.floor(this.rng() * SGR_COLORS.length)] ?? 37;
      text += `\x1b[1;${color}m block${(index + segment) % 50} \x1b[0m`;
    }
    return text;
  }

  private shortLine(index: number): string {
    const target = 20 + Math.floor(this.rng() * 61);
    let text = `[worker ${index % 8}] step ${index} ok `;
    while (text.length < target) text += "· ok ";
    return text.slice(0, target);
  }

  private fold(text: string): void {
    let hash = this.checksumState;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    this.checksumState = hash;
  }
}

const FILL_CHUNK_LINES = 500;

function writeAndWait(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    terminal.write(data, () => resolve());
  });
}

/**
 * Writes seeded content until the buffer retains `targetBufferLines` rows
 * (wrapped rows count — reflow cost scales with buffer rows, not logical
 * lines). Bails if the buffer stops growing (scrollback cap reached) so a
 * mis-sized target can never hang the harness.
 */
export async function fillToBufferLines(
  terminal: HeadlessTerminal,
  stream: AgentOutputStream,
  targetBufferLines: number
): Promise<void> {
  let previousLength = -1;
  while (terminal.buffer.active.length < targetBufferLines) {
    if (terminal.buffer.active.length === previousLength) break;
    previousLength = terminal.buffer.active.length;
    await writeAndWait(terminal, stream.nextChunk(FILL_CHUNK_LINES));
  }
}

export const HISTORY_COLS = 120;
export const HISTORY_ROWS = 30;
const HISTORY_SCROLLBACK = 100_000;
export const HISTORY_CHECKPOINTS = [
  { label: "10k", lines: 10_000 },
  { label: "50k", lines: 50_000 },
  { label: "100k", lines: 100_000 },
] as const;

export interface HistoryCheckpoint {
  label: (typeof HISTORY_CHECKPOINTS)[number]["label"];
  lines: number;
  terminal: HeadlessTerminal;
  contentChecksum: number;
}

let historyFixturePromise: Promise<HistoryCheckpoint[]> | null = null;

/**
 * One persistent terminal per retention checkpoint. Iterations alternate a
 * ±1-column resize on each, so buffer state never drifts across iterations
 * beyond the scrollback-cap churn at the 100k checkpoint.
 */
export function getHistoryReflowFixture(): Promise<HistoryCheckpoint[]> {
  historyFixturePromise ??= buildHistoryFixture();
  return historyFixturePromise;
}

async function buildHistoryFixture(): Promise<HistoryCheckpoint[]> {
  const checkpoints: HistoryCheckpoint[] = [];
  for (const { label, lines } of HISTORY_CHECKPOINTS) {
    const terminal = await createCountedTerminal({
      cols: HISTORY_COLS,
      rows: HISTORY_ROWS,
      scrollback: HISTORY_SCROLLBACK,
    });
    const stream = new AgentOutputStream(911_000 + lines);
    await fillToBufferLines(terminal, stream, lines);
    checkpoints.push({ label, lines, terminal, contentChecksum: stream.checksum });
  }
  return checkpoints;
}

export const STORM_TERMINAL_COUNT = 8;
export const STORM_ROWS = 30;
export const STORM_MAX_COLS = 120;
export const STORM_MIN_COLS = 90;
const STORM_RETAINED_LINES = 20_000;
const STORM_SCROLLBACK = 20_000;

export interface StormFixture {
  terminals: HeadlessTerminal[];
  colsNow: number;
}

let stormFixturePromise: Promise<StormFixture> | null = null;

/**
 * Eight persistent terminals, each retaining 20k buffer rows — a realistic
 * mid-session agent grid. Iterations ramp the whole grid between
 * STORM_MAX_COLS and STORM_MIN_COLS, alternating direction so buffer state
 * stays at steady state across iterations.
 */
export function getStormFixture(): Promise<StormFixture> {
  stormFixturePromise ??= buildStormFixture();
  return stormFixturePromise;
}

async function buildStormFixture(): Promise<StormFixture> {
  const terminals: HeadlessTerminal[] = [];
  for (let i = 0; i < STORM_TERMINAL_COUNT; i += 1) {
    const terminal = await createCountedTerminal({
      cols: STORM_MAX_COLS,
      rows: STORM_ROWS,
      scrollback: STORM_SCROLLBACK,
    });
    await fillToBufferLines(terminal, new AgentOutputStream(911_100 + i), STORM_RETAINED_LINES);
    terminals.push(terminal);
  }
  return { terminals, colsNow: STORM_MAX_COLS };
}

export const REVEAL_COLS = 120;
export const REVEAL_ROWS = 30;
const REVEAL_RETAINED_LINES = 5_000;
const REVEAL_SCROLLBACK = 5_000;
export const SMALL_BACKLOG_TARGET_BYTES = Math.floor(RESIZE_FLUSH_SYNC_BUDGET_BYTES * 0.75);
export const LARGE_BACKLOG_TARGET_BYTES = RESIZE_FLUSH_SYNC_BUDGET_BYTES * 4;
/** Mirrors COALESCE_BATCH_CAP_BYTES in TerminalOutputIngestService (#4853). */
export const REVEAL_DRAIN_CHUNK_BYTES = 256 * 1024;

export interface RevealBacklog {
  text: string;
  checksum: number;
}

let revealBacklogs: { small: RevealBacklog; large: RevealBacklog } | null = null;

export function getRevealBacklogs(): { small: RevealBacklog; large: RevealBacklog } {
  revealBacklogs ??= {
    small: buildBacklog(911_200, SMALL_BACKLOG_TARGET_BYTES),
    large: buildBacklog(911_201, LARGE_BACKLOG_TARGET_BYTES),
  };
  return revealBacklogs;
}

function buildBacklog(seed: number, targetBytes: number): RevealBacklog {
  const stream = new AgentOutputStream(seed);
  const parts: string[] = [];
  let bytes = 0;
  while (bytes < targetBytes) {
    const chunk = stream.nextChunk(200);
    parts.push(chunk);
    bytes += chunk.length;
  }
  return { text: parts.join(""), checksum: stream.checksum };
}

async function drainBacklog(
  terminal: HeadlessTerminal,
  text: string,
  chunkBytes: number
): Promise<void> {
  let offset = 0;
  while (offset < text.length) {
    const chunk = text.slice(offset, offset + chunkBytes);
    offset += chunkBytes;
    await writeAndWait(terminal, chunk);
  }
}

export interface RevealArmResult {
  revealBlockingMs: number;
  drainMs: number;
  parsedLines: number;
}

/**
 * Reconstructs one arm of the 2026-07-06 reveal-resize incident at the xterm
 * level: a hidden terminal accumulated `backlog` while throttled, then the
 * reveal sweep resizes it to fresh geometry. Replays the decision
 * `flushHeldBytesBeforeResize` makes against the REAL budget constant:
 * within budget the backlog is flushed into xterm's write buffer and
 * `resize()`'s flushSync parses it synchronously (reveal-blocking); over
 * budget the resize runs on an empty write buffer and the backlog drains
 * afterwards in watermarked chunks at the new grid. If a refactor bypasses
 * or loosens RESIZE_FLUSH_SYNC_BUDGET_BYTES, the over-budget arm collapses
 * into the synchronous-parse path and its blocking bracket jumps by orders
 * of magnitude.
 */
export async function runRevealArm(backlog: RevealBacklog, seed: number): Promise<RevealArmResult> {
  const terminal = await createCountedTerminal({
    cols: REVEAL_COLS,
    rows: REVEAL_ROWS,
    scrollback: REVEAL_SCROLLBACK,
  });
  try {
    await fillToBufferLines(terminal, new AgentOutputStream(seed), REVEAL_RETAINED_LINES);

    let revealBlockingMs: number;
    let drainMs = 0;
    if (backlog.text.length <= RESIZE_FLUSH_SYNC_BUDGET_BYTES) {
      const start = performance.now();
      terminal.write(backlog.text);
      terminal.resize(REVEAL_COLS - 1, REVEAL_ROWS);
      revealBlockingMs = performance.now() - start;
    } else {
      const start = performance.now();
      terminal.resize(REVEAL_COLS - 1, REVEAL_ROWS);
      revealBlockingMs = performance.now() - start;
      const drainStart = performance.now();
      await drainBacklog(terminal, backlog.text, REVEAL_DRAIN_CHUNK_BYTES);
      drainMs = performance.now() - drainStart;
    }

    return { revealBlockingMs, drainMs, parsedLines: terminal.buffer.active.length };
  } finally {
    terminal.dispose();
  }
}

import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;

import {
  ActivityMonitor,
  type ActivityStateMetadata,
  type ProcessStateValidator,
} from "../../ActivityMonitor.js";
import { buildActivityMonitorOptions } from "../../pty/terminalActivityPatterns.js";

export interface RecordedTransition {
  replayMs: number;
  state: "busy" | "idle" | "completed";
  trigger?: ActivityStateMetadata["trigger"];
  waitingReason?: ActivityStateMetadata["waitingReason"];
  patternConfidence?: number;
  sessionCost?: number;
  sessionTokens?: number;
}

export interface FragmentationOpts {
  seed: number;
  maxSplits?: number;
}

export interface ReplayCastOpts {
  agentId?: string;
  fragmentation?: FragmentationOpts;
  processStateValidator?: ProcessStateValidator;
  settleMs?: number;
  pollingIntervalMs?: number;
  pollingMaxBootMs?: number;
  maxWorkingSilenceMs?: number;
  idleDebounceMs?: number;
  promptFastPathMinQuietMs?: number;
}

export interface ExpectedTransition {
  atMs: number;
  state: "busy" | "idle" | "completed";
  trigger?: ActivityStateMetadata["trigger"];
  waitingReason?: ActivityStateMetadata["waitingReason"];
  sessionCost?: number;
  sessionTokens?: number;
}

export interface ExpectedFile {
  agentId?: string;
  pollingMaxBootMs?: number;
  settleMs?: number;
  maxWorkingSilenceMs?: number;
  idleDebounceMs?: number;
  promptFastPathMinQuietMs?: number;
  toleranceMs?: number;
  /**
   * Default false (strict). When true, recorded transitions that are not in the
   * expected list are tolerated. Used by fragmented replay variants where
   * intentional chunk-boundary noise can introduce extra busy/completed pulses
   * that don't change the load-bearing state-sequence invariant.
   */
  allowExtraTransitions?: boolean;
  transitions: ExpectedTransition[];
}

interface CastEvent {
  absoluteMs: number;
  kind: "o" | "i" | "r" | "m" | "x";
  data: string;
}

interface ParsedCast {
  cols: number;
  rows: number;
  version: 2 | 3;
  events: CastEvent[];
}

const DEFAULT_POLLING_INTERVAL_MS = 50;
const DEFAULT_SETTLE_MS = 6000;
const DEFAULT_FRAGMENT_MAX_SPLITS = 4;

const NULL_PROCESS_STATE_VALIDATOR: ProcessStateValidator = {
  hasActiveChildren: () => false,
  getDescendantsCpuUsage: () => 0,
};

export function parseCast(filePath: string): ParsedCast {
  const raw = readFileSync(filePath, "utf8");
  const rawLines = raw.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    lines.push(line);
  }
  if (lines.length === 0) {
    throw new Error(`Cast file is empty: ${filePath}`);
  }

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`Cast header is not valid JSON in ${filePath}`, { cause: error });
  }

  const version = header.version;
  if (version !== 2 && version !== 3) {
    throw new Error(`Unsupported cast version ${String(version)} in ${filePath}`);
  }

  let cols: number;
  let rows: number;
  if (version === 3) {
    const term = header.term as { cols?: number; rows?: number } | undefined;
    cols = Number(term?.cols ?? 80);
    rows = Number(term?.rows ?? 24);
  } else {
    cols = Number(header.width ?? 80);
    rows = Number(header.height ?? 24);
  }

  const events: CastEvent[] = [];
  let accumulated = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`Malformed event row at ${filePath}:${i + 1}`, { cause: error });
    }
    if (!Array.isArray(row) || row.length < 3) {
      throw new Error(`Event row must be a 3-tuple at ${filePath}:${i + 1}`);
    }
    const time = Number(row[0]);
    const kind = String(row[1]) as CastEvent["kind"];
    const data = String(row[2]);
    if (!Number.isFinite(time)) {
      throw new Error(`Event time must be a number at ${filePath}:${i + 1}`);
    }
    if (version === 3 && time < 0) {
      throw new Error(`v3 event delta must be non-negative at ${filePath}:${i + 1} (got ${time})`);
    }
    let absoluteSeconds: number;
    if (version === 3) {
      accumulated += time;
      absoluteSeconds = accumulated;
    } else {
      absoluteSeconds = time;
    }
    events.push({ absoluteMs: Math.round(absoluteSeconds * 1000), kind, data });
  }

  return { cols, rows, version, events };
}

function mulberry32(seed: number): () => number {
  let t = (seed >>> 0) + 0x6d2b79f5;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Split a UTF-8 byte buffer at random byte offsets — including offsets that
 * land mid-codepoint and mid-ANSI-sequence. The fragments are returned as raw
 * `Uint8Array` slices so that xterm's parser can stitch multi-byte sequences
 * across `parse()` calls (which it does in production when node-pty delivers
 * partial chunks). Decoding fragments to strings here would inject U+FFFD
 * replacement characters before xterm sees the bytes, defeating the test.
 */
function fragmentBytes(bytes: Uint8Array, rng: () => number, maxSplits: number): Uint8Array[] {
  if (bytes.length <= 1 || maxSplits <= 0) {
    return [bytes];
  }
  const splitCount = 1 + Math.floor(rng() * Math.max(1, maxSplits));
  const offsets = new Set<number>();
  for (let i = 0; i < splitCount; i++) {
    const offset = 1 + Math.floor(rng() * (bytes.length - 1));
    offsets.add(offset);
  }
  const sorted = [...offsets].sort((a, b) => a - b);
  const fragments: Uint8Array[] = [];
  let prev = 0;
  for (const offset of sorted) {
    fragments.push(bytes.subarray(prev, offset));
    prev = offset;
  }
  fragments.push(bytes.subarray(prev));
  return fragments;
}

function createHeadlessTerminal(cols: number, rows: number): HeadlessTerminalType {
  return new HeadlessTerminal({
    cols: Math.max(1, cols),
    rows: Math.max(1, rows),
    scrollback: 1000,
    allowProposedApi: true,
  });
}

function makeGetVisibleLines(term: HeadlessTerminalType): (n: number) => string[] {
  return (n: number) => {
    const buffer = term.buffer.active;
    if (!buffer) return [];
    // Bottom-N rows of the active viewport — matches TerminalProcess.getLastNLines().
    // For short fixtures whose cursor doesn't reach the bottom, the trailing rows
    // will be empty. Fixture authors should size `height` so meaningful content
    // lands within the bottom `promptScanLineCount` rows (default 6).
    const viewportBottom = buffer.baseY + term.rows;
    const start = Math.max(buffer.baseY, viewportBottom - n);
    const lines: string[] = [];
    for (let i = start; i < viewportBottom; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines;
  };
}

function makeGetCursorLine(term: HeadlessTerminalType): () => string | null {
  return () => {
    const buffer = term.buffer.active;
    if (!buffer || typeof buffer.getLine !== "function") return null;
    const cursorY = buffer.cursorY ?? 0;
    const line = buffer.getLine(buffer.baseY + cursorY);
    return line ? line.translateToString(true) : null;
  };
}

interface InputHandlerLike {
  parse(data: string | Uint8Array, promiseResult?: boolean): void | Promise<boolean>;
}

interface CoreLike {
  _inputHandler: InputHandlerLike;
}

interface InternalTerminal extends HeadlessTerminalType {
  _core: CoreLike;
}

/**
 * Write bytes to the headless terminal synchronously via xterm's internal
 * input handler. The public `term.write(data, callback)` API batches via
 * `setTimeout` internally, which deadlocks under `vi.useFakeTimers()` because
 * the WriteBuffer's deferred flush never fires. Driving the parser directly
 * bypasses the WriteBuffer entirely so the buffer reflects the new bytes
 * before the next polling cycle reads from it.
 *
 * This relies on xterm's private `_core._inputHandler.parse()` surface — the
 * tradeoff is acceptable since (a) the API has been stable across xterm 5–6,
 * (b) this is test-only code with no production impact, and (c) any breakage
 * here surfaces as a single test-suite failure with a descriptive error
 * rather than a runtime bug. `parse()` returns Promise<boolean> if any async
 * DCS handler is installed; we install none, so the void return is safe.
 */
function writeBytesToTerminal(term: HeadlessTerminalType, bytes: Uint8Array): void {
  const internal = term as InternalTerminal;
  const inputHandler = internal._core?._inputHandler;
  if (!inputHandler || typeof inputHandler.parse !== "function") {
    throw new Error(
      "Headless terminal does not expose _core._inputHandler.parse — xterm internals may have changed."
    );
  }
  inputHandler.parse(bytes, false);
}

export async function replayCast(
  castPath: string,
  opts: ReplayCastOpts = {}
): Promise<RecordedTransition[]> {
  const cast = parseCast(castPath);
  const term = createHeadlessTerminal(cast.cols, cast.rows);
  const getVisibleLines = makeGetVisibleLines(term);
  const getCursorLine = makeGetCursorLine(term);

  const baseOptions = buildActivityMonitorOptions(opts.agentId, {
    getVisibleLines,
    getCursorLine,
  });

  const pollingIntervalMs = opts.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
  const recorded: RecordedTransition[] = [];
  const startedAt = Date.now();

  const monitor = new ActivityMonitor(
    "replay-terminal",
    startedAt,
    (_id, _spawnedAt, state, metadata) => {
      const replayMs = Date.now() - startedAt;
      recorded.push({
        replayMs,
        state,
        trigger: metadata?.trigger,
        waitingReason: metadata?.waitingReason,
        patternConfidence: metadata?.patternConfidence,
        sessionCost: metadata?.sessionCost,
        sessionTokens: metadata?.sessionTokens,
      });
    },
    {
      ...baseOptions,
      processStateValidator: opts.processStateValidator ?? NULL_PROCESS_STATE_VALIDATOR,
      pollingIntervalMs,
      pollingMaxBootMs: opts.pollingMaxBootMs ?? baseOptions.pollingMaxBootMs,
      maxWorkingSilenceMs: opts.maxWorkingSilenceMs ?? baseOptions.maxWorkingSilenceMs,
      idleDebounceMs: opts.idleDebounceMs ?? baseOptions.idleDebounceMs,
      promptFastPathMinQuietMs:
        opts.promptFastPathMinQuietMs ?? baseOptions.promptFastPathMinQuietMs,
    }
  );

  // Boot phase clock starts here. Tests must call vi.setSystemTime(startedAt)
  // before invoking replayCast so the boot deadline is anchored to a known origin.
  monitor.startPolling();

  const rng = opts.fragmentation ? mulberry32(opts.fragmentation.seed) : null;
  const maxSplits = opts.fragmentation?.maxSplits ?? DEFAULT_FRAGMENT_MAX_SPLITS;

  let currentMs = 0;
  for (const event of cast.events) {
    const delta = Math.max(0, event.absoluteMs - currentMs);
    if (delta > 0) {
      // Polling ordering: timers advance to the event timestamp BEFORE the event
      // is written/dispatched. A polling tick scheduled exactly at `currentMs+N`
      // therefore observes pre-event state — the new bytes land immediately
      // afterward and the next tick sees them. Deterministic and matches how
      // production polling is interleaved with PTY data callbacks.
      vi.advanceTimersByTime(delta);
      currentMs = event.absoluteMs;
    }

    if (event.kind === "o") {
      const bytes = Buffer.from(event.data, "utf8");
      const fragments = rng ? fragmentBytes(bytes, rng, maxSplits) : [bytes];
      for (const fragment of fragments) {
        if (fragment.length === 0) continue;
        writeBytesToTerminal(term, fragment);
      }
      // Production calls `monitor.onData(chunk)` with the fully-decoded string
      // from node-pty (which buffers partial UTF-8). Replay mirrors that
      // contract: the monitor sees the whole event as one string, not the
      // fragmented byte chunks. Fragmentation stresses xterm's parser only.
      monitor.onData(event.data);
    } else if (event.kind === "i") {
      monitor.onInput(event.data);
    } else if (event.kind === "r") {
      const match = /^(\d+)x(\d+)$/.exec(event.data);
      if (match) {
        const newCols = Number(match[1]);
        const newRows = Number(match[2]);
        try {
          term.resize(Math.max(1, newCols), Math.max(1, newRows));
        } catch {
          // Some xterm builds throw if dims unchanged — ignore.
        }
        monitor.notifyResize();
      }
    }
    // Ignore "m" (markers) and "x" (exit) for now — they don't drive state.
  }

  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  if (settleMs > 0) {
    vi.advanceTimersByTime(settleMs);
  }

  monitor.dispose();
  term.dispose();
  return recorded;
}

export function loadExpected(expectedPath: string): ExpectedFile {
  const raw = readFileSync(expectedPath, "utf8");
  const parsed = JSON.parse(raw) as ExpectedFile;
  if (!Array.isArray(parsed.transitions)) {
    throw new Error(`Expected file missing 'transitions' array: ${expectedPath}`);
  }
  return parsed;
}

export interface MatchOpts {
  toleranceMs?: number;
  /**
   * When true, recorded transitions that don't map to an expected entry are
   * tolerated. Default is strict — any unmatched recorded transition fails.
   */
  allowExtraTransitions?: boolean;
}

export interface MatchFailure {
  kind:
    | "missing"
    | "extra"
    | "trigger-mismatch"
    | "waiting-reason-mismatch"
    | "metadata-mismatch"
    | "timing";
  index: number;
  expected?: ExpectedTransition;
  actual?: RecordedTransition;
  detail?: string;
}

/**
 * Strict in-order match. Each expected entry must match a recorded transition
 * within `toleranceMs` of `atMs`. State is required; `trigger`,
 * `waitingReason`, `sessionCost`, `sessionTokens` are asserted only when the
 * expected entry names them. Recorded transitions that don't map to an
 * expected entry produce `extra` failures unless `allowExtraTransitions` is
 * true (used by fragmented variants where chunk-boundary noise can introduce
 * benign duplicate `completed` pulses).
 */
export function matchTransitions(
  recorded: RecordedTransition[],
  expected: ExpectedTransition[],
  opts: MatchOpts = {}
): MatchFailure[] {
  const tolerance = opts.toleranceMs ?? 200;
  const failures: MatchFailure[] = [];
  const matched = new Set<number>();
  let cursor = 0;

  for (let i = 0; i < expected.length; i++) {
    const want = expected[i];
    let foundIndex = -1;
    for (let j = cursor; j < recorded.length; j++) {
      const got = recorded[j];
      if (matched.has(j)) continue;
      if (got.state !== want.state) continue;
      if (Math.abs(got.replayMs - want.atMs) > tolerance) continue;
      if (want.trigger && got.trigger !== want.trigger) continue;
      if (want.waitingReason && got.waitingReason !== want.waitingReason) continue;
      if (want.sessionCost !== undefined && got.sessionCost !== want.sessionCost) continue;
      if (want.sessionTokens !== undefined && got.sessionTokens !== want.sessionTokens) continue;
      foundIndex = j;
      break;
    }
    if (foundIndex === -1) {
      failures.push({ kind: "missing", index: i, expected: want });
      continue;
    }
    matched.add(foundIndex);
    cursor = foundIndex + 1;
  }

  if (!opts.allowExtraTransitions) {
    for (let j = 0; j < recorded.length; j++) {
      if (matched.has(j)) continue;
      failures.push({
        kind: "extra",
        index: j,
        actual: recorded[j],
        detail: `unmatched recorded transition: ${recorded[j].state}/${recorded[j].trigger ?? "-"} at ${recorded[j].replayMs}ms`,
      });
    }
  }

  return failures;
}

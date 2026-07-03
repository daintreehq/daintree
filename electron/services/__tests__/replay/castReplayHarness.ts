import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { IBufferCell, Terminal as HeadlessTerminalType } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import unicode11 from "@xterm/addon-unicode11";
const { Unicode11Addon } = unicode11;

import {
  ActivityMonitor,
  type ActivityStateMetadata,
  type ProcessStateValidator,
} from "../../ActivityMonitor.js";
import { buildActivityMonitorOptions } from "../../pty/terminalActivityPatterns.js";
import { Osc94Parser } from "../../pty/Osc94Parser.js";
import {
  createVisibleCellContentSnapshot,
  type VisibleContentCell,
  type VisibleContentSnapshot,
} from "../../pty/SustainedChangeTracker.js";
import { AgentStateService } from "../../pty/AgentStateService.js";
import { SemanticBufferManager } from "../../pty/SemanticBufferManager.js";
import { events } from "../../events.js";
import type { TerminalInfo } from "../../pty/types.js";
import type { AgentState, WaitingReason } from "../../../../shared/types/agent.js";
import type { TerminalCheckResult } from "../../../../shared/types/checkResult.js";

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
  simpleOutputState?: boolean;
  /**
   * Route OSC 9;4 progress sequences from cast "o" events into the monitor's
   * `onOscProgressWorking`/`onOscProgressIdle` callbacks (production wiring).
   * Defaults to true. Set false to suppress the routing — used by the OSC
   * coverage test to show that the viewport-independent heartbeat genuinely
   * shifts the idle deadline (without it, the monitor idles off stale visible
   * content instead).
   */
  routeOsc94?: boolean;
  /**
   * Internal hooks used by `replayCastThroughFsm` to mirror the production
   * TerminalProcess wiring on top of the activity replay. Fired synchronously
   * at the event's virtual timestamp (timers already advanced).
   */
  onActivityObservation?: (
    state: "busy" | "idle" | "completed",
    metadata?: ActivityStateMetadata
  ) => void;
  onOutputChunk?: (data: string) => void;
  onExitEvent?: (code: number) => void;
}

export interface ExpectedTransition {
  atMs: number;
  state: "busy" | "idle" | "completed";
  trigger?: ActivityStateMetadata["trigger"];
  waitingReason?: ActivityStateMetadata["waitingReason"];
  sessionCost?: number;
  sessionTokens?: number;
}

export interface ExpectedFsmTransition {
  atMs: number;
  state: AgentState;
  trigger?: string;
  waitingReason?: WaitingReason;
  sessionCost?: number;
  sessionTokens?: number;
  exitCode?: number | null;
}

export interface ExpectedCheckResult {
  passed: boolean;
  /** Substring the parsed `command` must contain (null command fails the match). */
  commandIncludes?: string;
  /** Substring the `failureSummary` must contain (null summary fails the match). */
  failureSummaryIncludes?: string;
}

export interface ExpectedFsm {
  /** Canonical agent-state timeline (idle/working/waiting/completed/exited). */
  transitions: ExpectedFsmTransition[];
  toleranceMs?: number;
  allowExtraTransitions?: boolean;
  /**
   * Terminal `lastCheckResult` after the replay settles. `null` asserts that
   * NO check result was extracted; omit to skip the assertion.
   */
  checkResult?: ExpectedCheckResult | null;
  /** Waiting reason the terminal must settle on (asserted post-replay). */
  finalWaitingReason?: WaitingReason;
}

/**
 * Negative expectation: a transition that must NOT appear in the recording,
 * optionally bounded to a replay-time window. Checked even when
 * `allowExtraTransitions` is set — that flag tolerates benign noise, while a
 * forbidden entry pins a specific false positive (e.g. "resize noise must not
 * enter working").
 */
export interface ExpectedForbidden {
  /** Which recording to scan. Default "activity". */
  scope?: "activity" | "fsm";
  state: string;
  trigger?: string;
  /** Inclusive [fromMs, toMs] replay-time window. Omit to scan the whole replay. */
  betweenMs?: [number, number];
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
  /** Canonical-FSM expectations; fixtures with this block replay through `replayCastThroughFsm`. */
  fsm?: ExpectedFsm;
  forbidden?: ExpectedForbidden[];
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
  const term = new HeadlessTerminal({
    cols: Math.max(1, cols),
    rows: Math.max(1, rows),
    scrollback: 1000,
    allowProposedApi: true,
  });
  // Match production (TerminalProcess): Unicode 11 widths must be active before
  // any data is written so emoji/CJK glyphs in agent spinner output measure at
  // their true cell width — otherwise cell-based snapshots desync from what the
  // real terminal renders (#7403). Order matters: load the addon, then select
  // the version.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  return term;
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

interface SnapshotBufferLine {
  getCell?: (index: number, cell?: IBufferCell) => IBufferCell | undefined;
}

interface SnapshotBuffer {
  baseY: number;
  getNullCell?: () => IBufferCell;
  getLine: (index: number) => SnapshotBufferLine | undefined;
}

function cellToVisibleContentCell(cell: IBufferCell): VisibleContentCell {
  const attributes =
    (cell.isBold() ? 1 : 0) |
    (cell.isItalic() ? 1 << 1 : 0) |
    (cell.isDim() ? 1 << 2 : 0) |
    (cell.isUnderline() ? 1 << 3 : 0) |
    (cell.isBlink() ? 1 << 4 : 0) |
    (cell.isInverse() ? 1 << 5 : 0) |
    (cell.isInvisible() ? 1 << 6 : 0) |
    (cell.isStrikethrough() ? 1 << 7 : 0) |
    (cell.isOverline() ? 1 << 8 : 0);

  return {
    chars: cell.getChars(),
    code: cell.getCode(),
    width: cell.getWidth(),
    fgColorMode: cell.getFgColorMode(),
    fgColor: cell.getFgColor(),
    attributes,
  };
}

/**
 * Cell-based visible-content snapshot, mirroring
 * `TerminalProcess.getVisibleActivitySnapshot`. Production always wires this so
 * the `AgentActivityTemperature` cell-snapshot path is exercised; the harness
 * previously passed only `getVisibleLines`/`getCursorLine`, leaving the cell
 * path on its text-only fallback. The `n` parameter clamps the scan to the
 * bottom-N rows, matching production's `getVisibleActivityCells(n)` behaviour.
 * Returns `undefined` when the cell API is unavailable so `ActivityMonitor`
 * falls back to the text snapshot.
 */
function makeGetVisibleContentSnapshot(
  term: HeadlessTerminalType
): (n: number) => VisibleContentSnapshot | undefined {
  return (n: number) => {
    const buffer = term.buffer.active as unknown as SnapshotBuffer;
    if (
      !buffer ||
      typeof buffer.getLine !== "function" ||
      typeof buffer.getNullCell !== "function"
    ) {
      return undefined;
    }
    const reusableCell = buffer.getNullCell();
    const end = buffer.baseY + term.rows;
    const start = Math.max(buffer.baseY, end - n);
    const rows: VisibleContentCell[][] = [];
    for (let y = start; y < end; y++) {
      const line = buffer.getLine(y);
      if (!line || typeof line.getCell !== "function") continue;
      const row: VisibleContentCell[] = [];
      for (let x = 0; x < term.cols; x++) {
        const cell = line.getCell(x, reusableCell);
        if (cell) row.push(cellToVisibleContentCell(cell));
      }
      rows.push(row);
    }
    return createVisibleCellContentSnapshot(rows);
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
  const getVisibleContentSnapshot = makeGetVisibleContentSnapshot(term);

  const baseOptions = buildActivityMonitorOptions(opts.agentId, {
    getVisibleLines,
    getCursorLine,
    getVisibleContentSnapshot,
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
      opts.onActivityObservation?.(state, metadata);
    },
    {
      ...baseOptions,
      processStateValidator: opts.processStateValidator ?? NULL_PROCESS_STATE_VALIDATOR,
      pollingIntervalMs,
      pollingMaxBootMs: opts.pollingMaxBootMs ?? baseOptions.pollingMaxBootMs,
      maxWorkingSilenceMs: opts.maxWorkingSilenceMs ?? baseOptions.maxWorkingSilenceMs,
      // Start from the production options that `buildActivityMonitorOptions`
      // returns (simpleOutputState, the 8000ms debounce floor, the cell
      // snapshot path) so the harness exercises the same detection branch
      // production agents run. A fixture may still override these via its
      // `.expected.json` (e.g. aider/goose pin a 6000ms debounce) — those flow
      // through `opts` and win only when explicitly set.
      idleDebounceMs: opts.idleDebounceMs ?? baseOptions.idleDebounceMs,
      promptFastPathMinQuietMs:
        opts.promptFastPathMinQuietMs ?? baseOptions.promptFastPathMinQuietMs,
      simpleOutputState: opts.simpleOutputState ?? baseOptions.simpleOutputState,
    }
  );

  // OSC 9;4 taskbar-progress routing (#8701, deferred from #10301). Production
  // (`TerminalProcess.handlePtyData`) feeds every raw PTY chunk to an
  // `Osc94Parser` upstream of `activityMonitor.onData()`; the parser routes
  // working/idle progress states into the monitor's progress callbacks. The
  // harness mirrors that wiring so Claude-style OSC 9;4 heartbeats — which keep
  // an agent "busy" even when the visible viewport is quiet — are exercised.
  // For fixtures with no OSC 9;4 sequences, `feed()` is a no-op pass-through.
  const routeOsc94 = opts.routeOsc94 ?? true;
  const osc94Parser = new Osc94Parser({
    onWorking: (now) => monitor.onOscProgressWorking(now),
    onIdle: (now) => monitor.onOscProgressIdle(now),
  });

  // Boot phase clock starts here. Tests must call vi.setSystemTime(startedAt)
  // before invoking replayCast so the boot deadline is anchored to a known origin.
  monitor.startPolling();

  const rng = opts.fragmentation ? mulberry32(opts.fragmentation.seed) : null;
  const maxSplits = opts.fragmentation?.maxSplits ?? DEFAULT_FRAGMENT_MAX_SPLITS;

  try {
    let currentMs = 0;
    for (const event of cast.events) {
      const delta = Math.max(0, event.absoluteMs - currentMs);
      if (delta > 0) {
        // Polling ordering: timers advance to the event timestamp BEFORE the
        // event is written/dispatched. A polling tick scheduled exactly at
        // `currentMs+N` therefore observes pre-event state — the new bytes land
        // immediately afterward and the next tick sees them. Deterministic and
        // matches how production polling is interleaved with PTY data callbacks.
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
        // OSC 9;4 is fed first (matching production's feed-before-onData order);
        // `Date.now()` reflects the replay clock since timers were already
        // advanced to this event's timestamp above.
        if (routeOsc94) {
          osc94Parser.feed(event.data, Date.now());
        }
        monitor.onData(event.data);
        opts.onOutputChunk?.(event.data);
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
      } else if (event.kind === "x") {
        // Exit event (asciinema v3 shape): data is the process exit code.
        const code = Number(event.data);
        opts.onExitEvent?.(Number.isFinite(code) ? code : 0);
      }
      // Ignore "m" (markers) — they don't drive state.
    }

    const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
    if (settleMs > 0) {
      vi.advanceTimersByTime(settleMs);
    }
  } finally {
    // Always tear down so a throw mid-replay can't leak the polling interval or
    // debounce timers into the next test under shared fake timers.
    monitor.dispose();
    term.dispose();
  }
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

// === Canonical-FSM replay ===
//
// `replayCast` stops at the ActivityMonitor observation layer ("busy"/"idle"/
// "completed"). `replayCastThroughFsm` mirrors the production TerminalProcess
// wiring on top of it: observations feed the real `AgentStateService`
// (hysteresis, schema validation, waiting reasons, cost/tokens, check-result
// extraction on settle), raw output feeds the real `SemanticBufferManager`,
// and cast "x" events drive the exit path. What comes out is the canonical
// `agent:state-changed` timeline — the same events `terminal.getStatus` and
// `waitUntilIdle` consume.

export interface RecordedFsmTransition {
  replayMs: number;
  state: AgentState;
  previousState: AgentState;
  trigger: string;
  confidence: number;
  waitingReason?: WaitingReason;
  sessionCost?: number;
  sessionTokens?: number;
  exitCode?: number | null;
  exitSignal?: number;
  checkResult?: TerminalCheckResult;
}

export interface FsmReplayResult {
  activity: RecordedTransition[];
  fsm: RecordedFsmTransition[];
  finalState: AgentState;
  finalWaitingReason?: WaitingReason;
  finalCheckResult?: TerminalCheckResult;
}

let fsmReplaySeq = 0;

export async function replayCastThroughFsm(
  castPath: string,
  opts: ReplayCastOpts = {}
): Promise<FsmReplayResult> {
  const startedAt = Date.now();
  // Unique per replay: the recording listens on the GLOBAL events bus, so a
  // shared id would cross-record if two replays ever ran in one worker.
  const terminalId = `replay-terminal-${++fsmReplaySeq}`;
  // Minimal TerminalInfo — only the fields AgentStateService touches. The
  // launch hint doubles as the routing agent id (`getLiveAgentId` falls back
  // to it), so unregistered agent ids exercise the universal fallback while
  // still carrying a stable identity on emitted events.
  const terminal = {
    id: terminalId,
    cwd: "/replay",
    shell: "/bin/zsh",
    spawnedAt: startedAt,
    analysisEnabled: true,
    lastInputTime: 0,
    lastOutputTime: 0,
    lastCheckTime: 0,
    restartCount: 0,
    ...(opts.agentId ? { launchAgentId: opts.agentId } : {}),
    agentState: "idle",
    ptyProcess: {} as never,
    outputBuffer: "",
    semanticBuffer: [],
  } as unknown as TerminalInfo;

  const service = new AgentStateService();
  const semanticBuffer = new SemanticBufferManager(terminal);
  const fsm: RecordedFsmTransition[] = [];

  const onStateChanged = (payload: {
    terminalId?: string;
    state: AgentState;
    previousState: AgentState;
    trigger: string;
    confidence: number;
    waitingReason?: WaitingReason;
    sessionCost?: number;
    sessionTokens?: number;
    exitCode?: number | null;
    exitSignal?: number;
    lastCheckResult?: TerminalCheckResult;
  }): void => {
    if (payload.terminalId !== terminalId) return;
    fsm.push({
      replayMs: Date.now() - startedAt,
      state: payload.state,
      previousState: payload.previousState,
      trigger: payload.trigger,
      confidence: payload.confidence,
      waitingReason: payload.waitingReason,
      sessionCost: payload.sessionCost,
      sessionTokens: payload.sessionTokens,
      exitCode: payload.exitCode,
      exitSignal: payload.exitSignal,
      checkResult: payload.lastCheckResult,
    });
  };
  events.on("agent:state-changed", onStateChanged);

  try {
    const activity = await replayCast(castPath, {
      ...opts,
      onOutputChunk: (data) => semanticBuffer.onData(data),
      onActivityObservation: (state, metadata) => {
        service.handleActivityState(terminal, state, metadata);
      },
      onExitEvent: (code) => {
        // Flush pending semantic lines first so the settle-time check-result
        // scan sees the tail of the output (production flushes on teardown).
        semanticBuffer.flush();
        service.updateAgentState(terminal, { type: "exit", code });
      },
    });
    return {
      activity,
      fsm,
      finalState: terminal.agentState ?? "idle",
      finalWaitingReason: terminal.waitingReason,
      finalCheckResult: terminal.lastCheckResult,
    };
  } finally {
    events.off("agent:state-changed", onStateChanged);
    semanticBuffer.dispose();
  }
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
    | "timing"
    | "forbidden"
    | "check-result"
    | "final-waiting-reason";
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

/**
 * Strict in-order match over the canonical-FSM recording. Same semantics as
 * `matchTransitions`: state + time window required; trigger, waitingReason,
 * cost/tokens, exitCode asserted only when the expected entry names them.
 */
export function matchFsmTransitions(
  recorded: RecordedFsmTransition[],
  expected: ExpectedFsmTransition[],
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
      if (want.exitCode !== undefined && got.exitCode !== want.exitCode) continue;
      foundIndex = j;
      break;
    }
    if (foundIndex === -1) {
      failures.push({
        kind: "missing",
        index: i,
        detail: `expected fsm ${want.state}${want.waitingReason ? `/${want.waitingReason}` : ""} near ${want.atMs}ms`,
      });
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
        detail: `unmatched fsm transition: ${recorded[j].previousState} → ${recorded[j].state}/${recorded[j].trigger} at ${recorded[j].replayMs}ms`,
      });
    }
  }

  return failures;
}

/**
 * Scan both recordings for forbidden transitions. Runs regardless of
 * `allowExtraTransitions` — a forbidden entry pins a specific false positive.
 */
export function checkForbidden(
  forbidden: ExpectedForbidden[] | undefined,
  activity: RecordedTransition[],
  fsm: RecordedFsmTransition[] = []
): MatchFailure[] {
  if (!forbidden || forbidden.length === 0) return [];
  const failures: MatchFailure[] = [];
  for (let i = 0; i < forbidden.length; i++) {
    const rule = forbidden[i];
    const scope = rule.scope ?? "activity";
    const pool: Array<{ replayMs: number; state: string; trigger?: string }> =
      scope === "fsm" ? fsm : activity;
    for (const got of pool) {
      if (got.state !== rule.state) continue;
      if (rule.trigger && got.trigger !== rule.trigger) continue;
      if (
        rule.betweenMs &&
        (got.replayMs < rule.betweenMs[0] || got.replayMs > rule.betweenMs[1])
      ) {
        continue;
      }
      failures.push({
        kind: "forbidden",
        index: i,
        detail: `forbidden ${scope} transition ${got.state}/${got.trigger ?? "-"} recorded at ${got.replayMs}ms`,
      });
    }
  }
  return failures;
}

/** Assert the settled check result against the fixture's expectation. */
export function matchCheckResult(
  expected: ExpectedCheckResult | null | undefined,
  actual: TerminalCheckResult | undefined
): MatchFailure[] {
  if (expected === undefined) return [];
  if (expected === null) {
    return actual === undefined
      ? []
      : [
          {
            kind: "check-result",
            index: 0,
            detail: `expected no check result, got passed=${actual.passed} command=${actual.command ?? "-"}`,
          },
        ];
  }
  if (!actual) {
    return [{ kind: "check-result", index: 0, detail: "expected a check result, none extracted" }];
  }
  const failures: MatchFailure[] = [];
  if (actual.passed !== expected.passed) {
    failures.push({
      kind: "check-result",
      index: 0,
      detail: `check result passed=${actual.passed}, expected ${expected.passed}`,
    });
  }
  if (
    expected.commandIncludes !== undefined &&
    !(actual.command ?? "").includes(expected.commandIncludes)
  ) {
    failures.push({
      kind: "check-result",
      index: 0,
      detail: `check result command "${actual.command ?? ""}" missing "${expected.commandIncludes}"`,
    });
  }
  if (
    expected.failureSummaryIncludes !== undefined &&
    !(actual.failureSummary ?? "").includes(expected.failureSummaryIncludes)
  ) {
    failures.push({
      kind: "check-result",
      index: 0,
      detail: `check result failureSummary missing "${expected.failureSummaryIncludes}"`,
    });
  }
  return failures;
}

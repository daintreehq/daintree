import type * as pty from "node-pty";
import { PtyDataPipeline } from "../../../electron/services/pty/PtyDataPipeline";
import { TerminalForensicsBuffer } from "../../../electron/services/pty/TerminalForensicsBuffer";
import { SemanticBufferManager } from "../../../electron/services/pty/SemanticBufferManager";
import {
  IdentityWatcher,
  SHELL_IDENTITY_FALLBACK_SCAN_LINES,
} from "../../../electron/services/pty/IdentityWatcher";
import {
  OUTPUT_BUFFER_SIZE,
  SEMANTIC_BUFFER_MAX_LINES,
  SEMANTIC_BUFFER_MAX_LINE_LENGTH,
  type TerminalInfo,
} from "../../../electron/services/pty/types";
import type { AnalysisBackend } from "../../../electron/services/pty/analysis/AnalysisBackend";
import type { SessionSnapshotter } from "../../../electron/services/pty/SessionSnapshotter";
import type { ProcessDetector } from "../../../electron/services/ProcessDetector";

/**
 * Fixture for the terminal-output scenarios (PERF-030/031/032).
 *
 * THE SUBJECT is `PtyDataPipeline` — the per-chunk fan-out every byte a
 * terminal produces goes through in the PTY host — driven through its public
 * `handlePtyData` entry point with the real retention machinery attached:
 *
 *  - `handleOscColorQueries`, the OSC 10/11 responder that answers on the
 *    agent's behalf and strips the query from the renderer-bound copy,
 *  - `TerminalForensicsBuffer`, the 4,000-char crash-forensics ring,
 *  - `SemanticBufferManager`, the 50-line semantic ring with its 1,000-char
 *    per-line truncation,
 *  - the inline agent output ring (`OUTPUT_BUFFER_SIZE`, 2,000 chars) and
 *    `getLiveAgentId`,
 *  - `IdentityWatcher.observeOutput`, the prompt-return demotion scan.
 *
 * These three scenarios previously called `simulateTerminalOutputPass`, a
 * `push()`/`shift()` loop over a `string[]` written by the harness. It measured
 * V8's array-shift cost. Nothing in `electron/` or `src/` was imported, and the
 * "scrollback cap" it enforced was the harness's own number.
 *
 * WHAT IS STUBBED, and why. Two of the six pipeline stages are counted rather
 * than run:
 *
 *  - `AnalysisBackend.feedChunk` fans out to the OSC 9;4 tap, the activity
 *    monitor and a headless xterm mirror. Real xterm parse cost is already
 *    measured, properly and in isolation, by PERF-033/034 and PERF-193..196;
 *    running it here would make this scenario a worse copy of those.
 *  - `SessionSnapshotter.schedule()` debounces a serialize-and-write to disk.
 *    Its work is IO on a timer, not per-chunk work, and PERF-195 prices the
 *    serialize.
 *
 * Both are still counted, so a pipeline that stopped calling them is a miss
 * rather than a speedup.
 *
 * FIDELITY GAP. `IdentityWatcherDelegate.getLastNLines`/`getCursorLine` read
 * the viewport of a headless xterm in production; here they read the tail of
 * the real forensics buffer. The prompt matching, the command-failure scan and
 * the demotion call are production's; the source of the "visible" lines is an
 * approximation, and a regression in viewport extraction is invisible here.
 */

const TERMINAL_ID = "perf-terminal";

/** One chunk plus what the pipeline must make of it. */
export interface PipelineFrame {
  text: string;
  /** Carries an OSC 10/11 query: must be answered and stripped from the forward. */
  expectsOscResponse?: boolean;
  /**
   * Carries an OSC sequence that is NOT a colour query. It reaches
   * `handleOscColorQueries` (the `\x1b]1` fast-path gate lets it through) and
   * must come back untouched: no PTY write, nothing stripped.
   */
  oscDecoy?: string;
  /** A returned shell prompt: must demote the committed agent identity. */
  expectsPromptReturn?: boolean;
  /**
   * A returned shell prompt preceded by a command failure. `zsh: command not
   * found` means the shell rejected the command, so the prompt is not evidence
   * the agent finished — the product must NOT demote here.
   */
  promptDecoy?: boolean;
}

export interface PipelinePlan {
  frames: PipelineFrame[];
  /** Concatenation of every frame, kept for the ring oracles. */
  stream: string;
  expectedOscResponses: number;
  expectedOscDecoys: number;
  expectedPromptReturns: number;
  expectedPromptDecoys: number;
  /** Last 4,000 chars of the stream — what the forensics ring must hold. */
  expectedForensicTail: string;
  /** Last 2,000 chars of the stream — what the agent output ring must hold. */
  expectedOutputTail: string;
  /** The final non-empty line, which the semantic ring must end on. */
  expectedLastSemanticLine: string;
  totalChars: number;
}

/**
 * Deterministic agent-terminal output. SGR-dense because real agent output is,
 * and colour is most of what the retention rings actually store.
 *
 * Every line is checked against the shell-prompt patterns the identity watcher
 * uses: no `@`, no trailing `$`/`>`/`%`/`#`, no `➜`, and none of the
 * command-failure phrases (`not found`, `no such file`, `permission denied`),
 * so an ordinary line can never be mistaken for a planted prompt.
 */
const OUTPUT_LINES = [
  "\x1b[2m[14:22:07]\x1b[0m \x1b[36mRunning\x1b[0m tests in packages/core",
  "\x1b[32m  PASS\x1b[0m src/services/terminal/WriteQueue.test.ts",
  "\x1b[33m  warn\x1b[0m deprecated option 'legacyWatch' ignored",
  "  \x1b[1mSummary\x1b[0m 412 assertions, 0 failures, 3 skipped",
  "\x1b[34m  info\x1b[0m rebuilt 18 modules in 214ms",
  "  \x1b[90m…\x1b[0m applying patch to src/store/slices/panelRegistry.ts",
  "\x1b[35m  diff\x1b[0m +42 -17 across 6 files",
  "  \x1b[2mtrace\x1b[0m worker pool drained, 4 idle threads",
] as const;

const OSC_11_QUERY = "\x1b]11;?\x07";
/** OSC 12 (cursor colour) — passes the `\x1b]1` gate, is not a colour query. */
const OSC_12_DECOY = "\x1b]12;?\x07";

class PipelinePlanBuilder {
  private readonly frames: PipelineFrame[] = [];
  private parts: string[] = [];
  private oscResponses = 0;
  private oscDecoys = 0;
  private promptReturns = 0;
  private promptDecoys = 0;
  private chars = 0;

  push(frame: PipelineFrame): this {
    this.frames.push(frame);
    this.parts.push(frame.text);
    this.chars += frame.text.length;
    if (frame.expectsOscResponse) this.oscResponses += 1;
    if (frame.oscDecoy !== undefined) this.oscDecoys += 1;
    if (frame.expectsPromptReturn) this.promptReturns += 1;
    if (frame.promptDecoy) this.promptDecoys += 1;
    return this;
  }

  build(): PipelinePlan {
    const stream = this.parts.join("");
    const lines = stream.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    let lastLine = "";
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (line.length > 0) {
        lastLine =
          line.length > SEMANTIC_BUFFER_MAX_LINE_LENGTH
            ? `${line.substring(0, SEMANTIC_BUFFER_MAX_LINE_LENGTH)}... [truncated]`
            : line;
        break;
      }
    }
    return {
      frames: this.frames,
      stream,
      expectedOscResponses: this.oscResponses,
      expectedOscDecoys: this.oscDecoys,
      expectedPromptReturns: this.promptReturns,
      expectedPromptDecoys: this.promptDecoys,
      expectedForensicTail: stream.slice(-4000),
      expectedOutputTail: stream.slice(-OUTPUT_BUFFER_SIZE),
      expectedLastSemanticLine: lastLine,
      totalChars: this.chars,
    };
  }
}

/**
 * A terminal-output stream of `chunks` chunks, each `linesPerChunk` lines.
 *
 * Planted, at a fixed cadence rather than randomly, so the two-sided halves are
 * the same size on every iteration:
 *
 *  - an OSC 11 colour query every `oscEvery` chunks (answer + strip),
 *  - an OSC 12 decoy right after it (no answer, no strip),
 *  - a `command not found` + prompt pair every `promptEvery` chunks (must NOT
 *    demote), followed four chunks later — past the identity watcher's 4-line
 *    scan window — by a clean prompt that MUST demote.
 *
 * The stream ends on an over-long line so the semantic ring's 1,000-char
 * truncation is exercised where the oracle can still see it, and then on a
 * known sentinel line.
 */
export function buildPipelinePlan(options: {
  chunks: number;
  linesPerChunk: number;
  oscEvery: number;
  promptEvery: number;
  seed: number;
}): PipelinePlan {
  const builder = new PipelinePlanBuilder();
  let lineIndex = options.seed;

  const outputChunk = (): string => {
    const lines: string[] = [];
    for (let i = 0; i < options.linesPerChunk; i += 1) {
      lineIndex += 1;
      lines.push(`${OUTPUT_LINES[lineIndex % OUTPUT_LINES.length]!} #${lineIndex}`);
    }
    return `${lines.join("\r\n")}\r\n`;
  };

  for (let chunk = 0; chunk < options.chunks; chunk += 1) {
    if (options.oscEvery > 0 && chunk % options.oscEvery === 0 && chunk > 0) {
      builder.push({ text: `${OSC_11_QUERY}${outputChunk()}`, expectsOscResponse: true });
      builder.push({ text: `${OSC_12_DECOY}${outputChunk()}`, oscDecoy: OSC_12_DECOY });
      continue;
    }
    if (options.promptEvery > 0 && chunk % options.promptEvery === 0 && chunk > 0) {
      builder.push({
        text: "zsh: command not found: buildd\r\nuser@studio:~/daintree$ ",
        promptDecoy: true,
      });
      // Four ordinary chunks push the failure line out of the watcher's
      // SHELL_IDENTITY_FALLBACK_SCAN_LINES window, so the clean prompt below is
      // graded on the prompt alone.
      for (let i = 0; i < SHELL_IDENTITY_FALLBACK_SCAN_LINES; i += 1) {
        builder.push({ text: outputChunk() });
      }
      builder.push({
        text: "user@studio:~/daintree$ ",
        expectsPromptReturn: true,
      });
      continue;
    }
    builder.push({ text: outputChunk() });
  }

  // An over-long line, then the sentinel the semantic ring must end on.
  builder.push({ text: `\x1b[2m${"x".repeat(SEMANTIC_BUFFER_MAX_LINE_LENGTH + 400)}\x1b[0m\r\n` });
  builder.push({ text: "final line of terminal output\r\n" });
  return builder.build();
}

export interface PipelineObservation {
  emitCalls: number;
  emittedChars: number;
  analysisFeeds: number;
  snapshotSchedules: number;
  agentQueueCalls: number;
  oscResponses: number;
  /** Forwarded payloads that still carried a query the product answered. */
  oscStripLeaks: number;
  /** Forwarded payloads where a NON-query OSC sequence was stripped anyway. */
  oscOverStrips: number;
  promptReturns: number;
  /** Planted prompts that failed to demote a committed agent identity. */
  promptReturnsMissed: number;
  /** Demotions on a chunk that had no clean prompt — the decoy half. */
  promptReturnsSpurious: number;
  forensicTail: string;
  outputTail: string;
  semanticLines: string[];
  chunksFed: number;
}

export interface PipelineHarness {
  feed(frame: PipelineFrame): void;
  /** Flush the semantic buffer's pending data, as teardown does in production. */
  finish(): PipelineObservation;
  dispose(): void;
}

/**
 * Build one real `PtyDataPipeline` over a real terminal record.
 *
 * `TerminalInfo` carries ~60 fields belonging to spawn, lifecycle and IPC
 * state that this pipeline never reads, so only the fields `runPipeline`
 * actually touches are populated. The cast is the fixture admitting that, not
 * papering over a missing dependency.
 */
export function createPipelineHarness(terminalId = TERMINAL_ID): PipelineHarness {
  let emitCalls = 0;
  let emittedChars = 0;
  let analysisFeeds = 0;
  let snapshotSchedules = 0;
  let agentQueueCalls = 0;
  let oscResponses = 0;
  let promptReturns = 0;
  let chunksFed = 0;
  let lastEmitted = "";

  const fakePty = {
    write: (): void => {
      oscResponses += 1;
    },
  } as unknown as pty.IPty;

  const terminalInfo = {
    id: terminalId,
    ptyProcess: fakePty,
    outputBuffer: "",
    semanticBuffer: [] as string[],
    detectedAgentId: "claude",
    launchAgentId: "claude",
    agentState: "working",
    lastOutputTime: Date.now(),
    contentEpoch: 0,
  } as unknown as TerminalInfo;

  const forensicsBuffer = new TerminalForensicsBuffer();
  const semanticBufferManager = new SemanticBufferManager(terminalInfo);

  const tailLines = (count: number): string[] =>
    forensicsBuffer
      .getRecentOutput()
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .slice(-count);

  const identityWatcher = new IdentityWatcher({
    terminalId,
    isExited: false,
    wasKilled: false,
    detectedAgentId: "claude",
    lastOutputTime: Date.now(),
    spawnedAt: Date.now(),
    lastDetectedProcessIconId: undefined,
    processDetector: {
      clearShellCommandEvidence: (): void => {
        promptReturns += 1;
      },
      injectShellCommandEvidence: (): void => {},
    } as unknown as ProcessDetector,
    getLastNLines: (n: number): string[] => tailLines(n),
    getCursorLine: (): string | null => {
      const lines = tailLines(2);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!;
        if (line.trim().length > 0) return line;
      }
      return null;
    },
    getRecentOutput: (): string => forensicsBuffer.getRecentOutput(),
    getLastCommand: (): string | undefined => semanticBufferManager.getLastCommand(),
    getPtyDescendantCount: (): number | undefined => 0,
    readForegroundProcessGroupSnapshot: (): null => null,
    handleAgentDetection: (): void => {},
  });

  const pipeline = new PtyDataPipeline({
    terminalInfo,
    analysis: {
      feedChunk: (data: string): void => {
        analysisFeeds += 1;
        void data;
      },
    } as unknown as AnalysisBackend,
    sessionSnapshotter: {
      schedule: (): void => {
        snapshotSchedules += 1;
      },
    } as unknown as SessionSnapshotter,
    forensicsBuffer,
    identityWatcher,
    semanticBufferManager,
    isAgentLive: true,
    shouldHandleOscColorQueries: true,
    emitData: (data: string | Uint8Array): void => {
      emitCalls += 1;
      lastEmitted = typeof data === "string" ? data : "";
      emittedChars += lastEmitted.length;
    },
    queueAgentOutput: (): void => {
      agentQueueCalls += 1;
    },
  });

  let oscStripLeaks = 0;
  let oscOverStrips = 0;
  let promptReturnsMissed = 0;
  let promptReturnsSpurious = 0;

  return {
    feed(frame: PipelineFrame): void {
      const responsesBefore = oscResponses;
      const promptsBefore = promptReturns;
      pipeline.handlePtyData(fakePty, frame.text);
      chunksFed += 1;
      // Attributed per frame rather than compared as two totals: a missed
      // plant and a spurious demotion cancel in an aggregate, and those are
      // the two failures this half of the corpus exists to tell apart.
      if (frame.expectsPromptReturn && promptReturns === promptsBefore) {
        promptReturnsMissed += 1;
      }
      if (!frame.expectsPromptReturn && promptReturns > promptsBefore) {
        promptReturnsSpurious += 1;
      }
      // Strip-on-success is the whole contract: a query the backend answered
      // must not reach the renderer (xterm.js would answer it a second time),
      // and a sequence it did NOT answer must survive untouched.
      if (frame.expectsOscResponse && oscResponses > responsesBefore) {
        if (lastEmitted.includes(OSC_11_QUERY)) oscStripLeaks += 1;
      }
      if (frame.oscDecoy !== undefined && !lastEmitted.includes(frame.oscDecoy)) {
        oscOverStrips += 1;
      }
    },
    finish(): PipelineObservation {
      // Production flushes the semantic buffer on teardown; the 100ms debounce
      // timer cannot fire during a synchronous feed loop, so without this the
      // ring would never be written and its oracle would grade nothing.
      semanticBufferManager.flush();
      return {
        emitCalls,
        emittedChars,
        analysisFeeds,
        snapshotSchedules,
        agentQueueCalls,
        oscResponses,
        oscStripLeaks,
        oscOverStrips,
        promptReturns,
        promptReturnsMissed,
        promptReturnsSpurious,
        forensicTail: forensicsBuffer.getRecentOutput(),
        outputTail: terminalInfo.outputBuffer,
        semanticLines: terminalInfo.semanticBuffer,
        chunksFed,
      };
    },
    dispose(): void {
      semanticBufferManager.dispose();
      identityWatcher.dispose();
    },
  };
}

export function runPipelinePlan(plan: PipelinePlan, terminalId?: string): PipelineObservation {
  const harness = createPipelineHarness(terminalId);
  try {
    for (const frame of plan.frames) harness.feed(frame);
    return harness.finish();
  } finally {
    harness.dispose();
  }
}

/**
 * Drive several terminals' streams a chunk at a time, round-robin.
 *
 * That is how they arrive: one PTY host serves every terminal in the window on
 * one thread, so N chatty panes interleave at chunk granularity rather than
 * running to completion one after another. Running them sequentially would
 * measure N independent single-terminal passes and miss whatever a shared
 * process does badly at N.
 */
export function runInterleavedPipelinePlans(plans: readonly PipelinePlan[]): PipelineObservation[] {
  const harnesses = plans.map((_, index) => createPipelineHarness(`${TERMINAL_ID}-${index}`));
  try {
    const longest = plans.reduce((max, plan) => Math.max(max, plan.frames.length), 0);
    for (let cursor = 0; cursor < longest; cursor += 1) {
      for (let i = 0; i < plans.length; i += 1) {
        const frame = plans[i]!.frames[cursor];
        if (frame !== undefined) harnesses[i]!.feed(frame);
      }
    }
    return harnesses.map((harness) => harness.finish());
  } finally {
    harnesses.forEach((harness) => harness.dispose());
  }
}

export interface PipelineMissCounts {
  /** Signed. Chunks the pipeline failed to forward to the renderer. */
  forwardMisses: number;
  /** Signed. Chunks the pipeline failed to hand to the analysis backend. */
  analysisFeedMisses: number;
  /** Signed. Chunks that did not schedule a session snapshot. */
  snapshotScheduleMisses: number;
  /** Signed. Chunks that did not reach the agent output queue. */
  agentQueueMisses: number;
  /** Signed. OSC colour queries the backend failed to answer. */
  oscResponseMisses: number;
  /** Two-sided: answered queries that leaked, plus non-queries stripped anyway. */
  oscStripMisses: number;
  /** Two-sided: prompts that failed to demote, plus demotions after a failure. */
  promptReturnMisses: number;
  /** The 4,000-char forensics ring does not hold the stream's tail. */
  forensicRingMisses: number;
  /** The 2,000-char agent output ring does not hold the stream's tail. */
  outputRingMisses: number;
  /** Line cap, tail line, or the 1,000-char truncation is wrong. */
  semanticRingMisses: number;
}

/**
 * Grade one pass.
 *
 * One accumulator per pipeline stage, deliberately. `runPipeline` does six
 * things per chunk and an aggregate would let five of them be deleted for the
 * price of one; the ring oracles in particular are the reason this scenario
 * exists, and they are the only terms that get slower as the stream gets
 * longer.
 *
 * The ring expectations are arithmetic over the corpus the fixture itself
 * built — `stream.slice(-4000)` and `stream.slice(-2000)` — not a second read
 * of the rings. A ring that never trimmed and a ring that dropped a chunk both
 * fail, in opposite directions, against the same string.
 */
export function pipelinePassMisses(
  plan: PipelinePlan,
  observed: PipelineObservation
): PipelineMissCounts {
  const chunks = plan.frames.length;

  let semanticRingMisses = 0;
  if (observed.semanticLines.length > SEMANTIC_BUFFER_MAX_LINES) semanticRingMisses += 1;
  if (observed.semanticLines.length === 0) semanticRingMisses += 1;
  const lastSemantic = observed.semanticLines[observed.semanticLines.length - 1];
  if (lastSemantic !== plan.expectedLastSemanticLine) semanticRingMisses += 1;
  if (!observed.semanticLines.some((line) => line.endsWith("... [truncated]"))) {
    semanticRingMisses += 1;
  }

  return {
    forwardMisses: chunks - observed.emitCalls,
    analysisFeedMisses: chunks - observed.analysisFeeds,
    snapshotScheduleMisses: chunks - observed.snapshotSchedules,
    agentQueueMisses: chunks - observed.agentQueueCalls,
    oscResponseMisses: plan.expectedOscResponses - observed.oscResponses,
    oscStripMisses: observed.oscStripLeaks + observed.oscOverStrips,
    promptReturnMisses: observed.promptReturnsMissed + observed.promptReturnsSpurious,
    forensicRingMisses: observed.forensicTail === plan.expectedForensicTail ? 0 : 1,
    outputRingMisses: observed.outputTail === plan.expectedOutputTail ? 0 : 1,
    semanticRingMisses,
  };
}

export function emptyPipelineMisses(): PipelineMissCounts {
  return {
    forwardMisses: 0,
    analysisFeedMisses: 0,
    snapshotScheduleMisses: 0,
    agentQueueMisses: 0,
    oscResponseMisses: 0,
    oscStripMisses: 0,
    promptReturnMisses: 0,
    forensicRingMisses: 0,
    outputRingMisses: 0,
    semanticRingMisses: 0,
  };
}

export function addPipelineMisses(
  into: PipelineMissCounts,
  from: PipelineMissCounts
): PipelineMissCounts {
  into.forwardMisses += from.forwardMisses;
  into.analysisFeedMisses += from.analysisFeedMisses;
  into.snapshotScheduleMisses += from.snapshotScheduleMisses;
  into.agentQueueMisses += from.agentQueueMisses;
  into.oscResponseMisses += from.oscResponseMisses;
  into.oscStripMisses += from.oscStripMisses;
  into.promptReturnMisses += from.promptReturnMisses;
  into.forensicRingMisses += from.forensicRingMisses;
  into.outputRingMisses += from.outputRingMisses;
  into.semanticRingMisses += from.semanticRingMisses;
  return into;
}

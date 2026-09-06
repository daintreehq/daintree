import {
  processDevPreviewOutput,
  classifyDevPreviewExit,
  type OutputProcessorSession,
  type OutputProcessorSessionUpdate,
} from "../../../electron/services/DevPreviewOutputProcessor";
import { UrlDetector } from "../../../electron/services/UrlDetector";
import {
  recordDevPreviewDiagnostic,
  type DevPreviewDiagnosticsRingMap,
} from "../../../electron/services/DevPreviewDiagnosticsRing";
import type { DevServerErrorType } from "../../../shared/utils/devServerErrors";

/**
 * Fixture for the dev-preview scenarios (PERF-020..024).
 *
 * WHAT IS REAL. The subject is `processDevPreviewOutput` — the exact function
 * `DevPreviewSessionService.handleData` calls for every chunk a dev server
 * writes — driven with the real `UrlDetector`, which is what actually finds the
 * URL: `extractLocalhostUrls` → `normalizeBrowserUrl` (ipaddr.js loopback
 * classification), the ANSI/OSC strip pass, the rolling 8 KiB carry-over
 * buffer, `selectPreferredUrl`, the real `READY_MARKERS`/`COMPILE_MARKERS`
 * tables, `detectDevServerError`, and the real bounded diagnostics ring.
 * PERF-024 additionally drives the real `classifyDevPreviewExit`.
 *
 * These scenarios previously ran a `/https?:\/\/localhost:\d{2,5}/` regex the
 * harness itself owned, against log lines the harness itself invented, and
 * imported nothing from `electron/`. They measured the harness.
 *
 * WHAT IS NOT REAL, and why. `OutputProcessorDeps` is the product's own
 * injection seam, and exactly one dep is replaced rather than supplied:
 * `pollServerReadiness`. In production that fires `waitForServerReady`, which
 * opens real HTTP and WebSocket connections to whatever port the detector just
 * reported. Running it here would put arbitrary localhost sockets — possibly
 * belonging to a dev server the developer actually has running — inside a
 * timed bracket, and its latency would swamp the parse cost being measured.
 * The stub records the URL the product asked it to poll, which is also the
 * cleanest read of "the detector found this": it is the product's call site,
 * not a re-invocation of the detector by the oracle.
 *
 * No process is started, no port is bound and no PTY exists, so none of these
 * numbers include dev-server startup. They are per-chunk parse cost, and the
 * counts are the readings that travel.
 *
 * The diagnostics ring is real product code inside the measured bracket, so it
 * is graded rather than merely counted: `diagnosticRingMisses` reads the ring
 * back and compares its contents, in order, with what the corpus planted.
 * `diagnosticEvents` alone was informational and appeared in no predicate,
 * which made `recordSessionDiagnostic` a free deletion.
 */

export type DevPreviewSessionState = OutputProcessorSession & {
  phaseLabel?: "Compiling";
  predictedUrl: string | null;
};

/** One chunk of dev-server output plus what the real detector must make of it. */
export interface DevPreviewFrame {
  text: string;
  /**
   * The URL the product must hand to `pollServerReadiness` on this frame.
   * Composed by the plan builder from the host and port it planted, never read
   * back out of `UrlDetector`.
   */
  expectsUrl?: string;
  /** Carries a near-miss the detector must NOT report. */
  isDecoy?: boolean;
  /** A framework readiness line that must accelerate the in-flight poll. */
  expectsReadyAcceleration?: boolean;
  /** An HMR/compile-start line that must arm the compile debounce. */
  expectsCompileArm?: boolean;
  /** A readiness line arriving mid-compile, which must clear the debounce. */
  expectsCompileClear?: boolean;
  /** A failure line the real `detectDevServerError` must classify. */
  expectsErrorType?: DevServerErrorType;
}

/**
 * One entry the real diagnostics ring must hold after the pass, in order.
 *
 * Composed where the frame is planted, from the same host/port/error the frame
 * carries, so a corpus that stopped planting a bind also stops expecting its
 * event. `detail` is the URL for a bind and the error type for a fault — the
 * one field of the event that says WHICH plant it came from, so a ring that
 * recorded the right number of the wrong events still scores.
 */
export interface DevPreviewDiagnosticExpectation {
  type: "url-detected" | "output-error";
  detail: string;
}

export interface DevPreviewStreamPlan {
  frames: DevPreviewFrame[];
  /** Distinct port bindings planted, in order. */
  expectedUrls: string[];
  /**
   * The full `pollServerReadiness` call sequence the product must produce.
   *
   * A bind produces TWO calls, not one: the URL branch starts a poll, and the
   * framework's readiness line then aborts that poll and re-probes immediately
   * with the same URL. Expecting one call per bind would have graded the
   * readiness acceleration as a spurious detection — the counter would have
   * been permanently non-zero on a healthy run, which is the failure mode the
   * predicate rules call out by name.
   */
  expectedPolls: string[];
  expectedReadyAccelerations: number;
  expectedCompileArms: number;
  expectedCompileClears: number;
  expectedErrorTypes: DevServerErrorType[];
  /**
   * The diagnostics-ring writes the pass must leave behind, in order.
   *
   * Only the two the per-chunk handler makes synchronously: `url-detected` on
   * a new bind and `output-error` on a newly-classified fault. The compile
   * events are written from `setTimeout` callbacks (COMPILE_ARM_MS /
   * COMPILE_CLEAR_MS) that cannot fire inside a synchronous feed loop, so
   * expecting them would grade a healthy pass as broken.
   */
  expectedDiagnostics: DevPreviewDiagnosticExpectation[];
  decoyFrames: number;
  totalChars: number;
}

/**
 * Plan-building tally. Every count is incremented where the frame is pushed, so
 * a plan that stopped planting something also stops expecting it — there is no
 * literal anywhere that could disagree with the corpus.
 */
class PlanBuilder {
  private readonly frames: DevPreviewFrame[] = [];
  private readonly expectedUrls: string[] = [];
  private readonly expectedPolls: string[] = [];
  private pendingUrl: string | null = null;
  private readonly expectedErrorTypes: DevServerErrorType[] = [];
  private readonly expectedDiagnostics: DevPreviewDiagnosticExpectation[] = [];
  private readyAccelerations = 0;
  private compileArms = 0;
  private compileClears = 0;
  private decoys = 0;
  private chars = 0;

  push(frame: DevPreviewFrame): this {
    this.frames.push(frame);
    this.chars += frame.text.length;
    if (frame.expectsUrl !== undefined) {
      this.expectedUrls.push(frame.expectsUrl);
      this.expectedPolls.push(frame.expectsUrl);
      this.pendingUrl = frame.expectsUrl;
      this.expectedDiagnostics.push({ type: "url-detected", detail: frame.expectsUrl });
    }
    if (frame.isDecoy) this.decoys += 1;
    if (frame.expectsReadyAcceleration) {
      this.readyAccelerations += 1;
      if (this.pendingUrl !== null) this.expectedPolls.push(this.pendingUrl);
    }
    if (frame.expectsCompileArm) this.compileArms += 1;
    if (frame.expectsCompileClear) this.compileClears += 1;
    if (frame.expectsErrorType !== undefined) {
      this.expectedErrorTypes.push(frame.expectsErrorType);
      this.expectedDiagnostics.push({ type: "output-error", detail: frame.expectsErrorType });
    }
    return this;
  }

  build(): DevPreviewStreamPlan {
    return {
      frames: this.frames,
      expectedUrls: this.expectedUrls,
      expectedPolls: this.expectedPolls,
      expectedReadyAccelerations: this.readyAccelerations,
      expectedCompileArms: this.compileArms,
      expectedCompileClears: this.compileClears,
      expectedErrorTypes: this.expectedErrorTypes,
      expectedDiagnostics: this.expectedDiagnostics,
      decoyFrames: this.decoys,
      totalChars: this.chars,
    };
  }
}

const NOISE_LINES = [
  "  transforming (128) src/components/App.tsx",
  "  watching for file changes",
  "  bundle chunk index-a91f2.js 128.44 kB gzip 41.02 kB",
  "  optimized dependencies changed, reloading",
  "  [plugin:vite:react-babel] transform pass complete",
  "  pre-bundling 42 dependencies in 380ms",
  "  hmr client connected",
  "  sourcemap written for src/main.tsx",
] as const;

/**
 * Near-misses the real detector rejects. Each was confirmed against
 * `UrlDetector.scanOutput` before being planted here:
 *
 *  - a bare port number has no scheme and no host,
 *  - `localhost:PORT` without a scheme is not a URL,
 *  - `example.com` is not a loopback host (`normalizeBrowserUrl` rejects it),
 *  - a LAN address is not loopback either,
 *  - `ftp:` is outside `ALLOWED_PROTOCOLS`.
 *
 * Decoy ports live in a 9xxx band that no planted URL uses, so a detector that
 * reported one could never be mistaken for a hit on a real plant.
 */
const DECOY_LINES = [
  "  Server listening on port 9101",
  "  waiting on localhost:9102 for the client bundle",
  "  proxy target http://example.com:9103/api",
  "  lan address http://192.168.1.42:9104/",
  "  ftp mirror ftp://localhost:9105/pub",
] as const;

/** A readiness line the real `READY_MARKERS` table must match. */
function readyLine(index: number): string {
  return index % 2 === 0 ? `  VITE v6.3.1  ready in ${300 + index} ms` : `  ✓ Ready in ${index}ms`;
}

/** An HMR line the real `COMPILE_MARKERS` table must match. */
function compileLine(index: number): string {
  return index % 2 === 0 ? `  [vite] hmr update /src/App.tsx?t=${index}` : "  compiling...";
}

/**
 * A planted URL plus the string the product must report for it.
 *
 * The expectation is the fixture's own arithmetic over the host and port it
 * chose, not a read-back of the detector. The wildcard variant makes that
 * non-trivial on purpose: `0.0.0.0` is a loopback wildcard and the product
 * rewrites it to `localhost`, so the expected string is not the string that
 * was planted.
 */
function urlPlant(variant: number, port: number): { text: string; expected: string } {
  switch (variant % 3) {
    case 0:
      return {
        text: `  ➜  Local:   http://localhost:${port}/`,
        expected: `http://localhost:${port}/`,
      };
    case 1:
      return {
        text: `  bound wildcard http://0.0.0.0:${port}/`,
        expected: `http://localhost:${port}/`,
      };
    default:
      return {
        text: `  ➜  Local:   https://localhost:${port}/app`,
        expected: `https://localhost:${port}/app`,
      };
  }
}

/**
 * A dev-server startup stream: noise, decoys, and `segments` port bindings each
 * followed by a readiness marker, an HMR compile burst, and the readiness line
 * that clears it.
 *
 * Every planted URL is loopback-normalised to `localhost`, deliberately.
 * `selectPreferredUrl` prefers the last `localhost` URL in the rolling buffer
 * over a later `127.0.0.1` one, so mixing hosts inside a single stream makes
 * the expected poll sequence depend on buffer eviction rather than on the
 * plants. The 127.0.0.1 and `[::1]` forms are exercised by
 * `buildSingleBindStreamPlan`, where they are the only URL in the buffer.
 */
export function buildStartupStreamPlan(options: {
  segments: number;
  firstPort: number;
  noisePerSegment: number;
  seed: number;
}): DevPreviewStreamPlan {
  const builder = new PlanBuilder();
  let noiseIndex = options.seed;
  const noise = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      noiseIndex += 1;
      builder.push({ text: `${NOISE_LINES[noiseIndex % NOISE_LINES.length]!} #${noiseIndex}\n` });
    }
  };

  for (let segment = 0; segment < options.segments; segment += 1) {
    noise(options.noisePerSegment);
    for (const decoy of DECOY_LINES) {
      builder.push({ text: `${decoy}\n`, isDecoy: true });
    }
    noise(options.noisePerSegment);

    const plant = urlPlant(segment, options.firstPort + segment);
    builder.push({ text: `${plant.text}\n`, expectsUrl: plant.expected });
    noise(options.noisePerSegment);
    // A readiness marker after a URL is pending: the product must abort the
    // sleeping poll and re-probe now. Only the first one per bind does that —
    // `markerSeen` latches until the next URL resets it.
    builder.push({ text: `${readyLine(segment)}\n`, expectsReadyAcceleration: true });
    noise(options.noisePerSegment);
    builder.push({ text: `${compileLine(segment)}\n`, expectsCompileArm: true });
    noise(options.noisePerSegment);
    // A second readiness line, with the compile debounce armed: clears it, and
    // does NOT accelerate again (`markerSeen` is already latched).
    builder.push({ text: `${readyLine(segment + 1)}\n`, expectsCompileClear: true });
  }

  return builder.build();
}

/**
 * A single bind on a non-`localhost` loopback form, with decoys either side.
 * Used where exactly one URL is ever in the rolling buffer, so
 * `selectPreferredUrl`'s localhost preference cannot reorder the expectation.
 */
export function buildSingleBindStreamPlan(options: {
  port: number;
  host: "127.0.0.1" | "[::1]";
  noise: number;
  seed: number;
}): DevPreviewStreamPlan {
  const builder = new PlanBuilder();
  let noiseIndex = options.seed;
  const noise = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      noiseIndex += 1;
      builder.push({ text: `${NOISE_LINES[noiseIndex % NOISE_LINES.length]!} #${noiseIndex}\n` });
    }
  };

  noise(options.noise);
  for (const decoy of DECOY_LINES) {
    builder.push({ text: `${decoy}\n`, isDecoy: true });
  }
  const expected = `http://${options.host}:${options.port}/`;
  builder.push({
    text: `  ➜  Network: http://${options.host}:${options.port}/\n`,
    expectsUrl: expected,
  });
  noise(options.noise);
  builder.push({ text: `${readyLine(0)}\n`, expectsReadyAcceleration: true });
  noise(options.noise);

  return builder.build();
}

/**
 * The URL line is split across two chunks INSIDE the hostname, so neither half
 * is a URL on its own and the answer exists only in `scanOutput`'s rolling
 * carry-over buffer.
 *
 * `deliverTail: false` is the superseded case: a worktree switch drops the
 * session before the rest of the line arrives, and the product must report
 * nothing. It is the half of the oracle that a detector matching too eagerly
 * fails — `http://loc` must not become a URL.
 */
export function buildSplitBindStreamPlan(options: {
  port: number;
  noise: number;
  deliverTail: boolean;
  seed: number;
}): DevPreviewStreamPlan {
  const builder = new PlanBuilder();
  let noiseIndex = options.seed;
  const noise = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      noiseIndex += 1;
      builder.push({ text: `${NOISE_LINES[noiseIndex % NOISE_LINES.length]!} #${noiseIndex}\n` });
    }
  };

  noise(options.noise);
  builder.push({ text: `${DECOY_LINES[0]!}\n`, isDecoy: true });
  builder.push({ text: "  ➜  Local:   http://loc" });
  if (options.deliverTail) {
    builder.push({
      text: `alhost:${options.port}/\n`,
      expectsUrl: `http://localhost:${options.port}/`,
    });
    noise(options.noise);
    builder.push({ text: `${readyLine(0)}\n`, expectsReadyAcceleration: true });
  } else {
    noise(options.noise);
  }

  return builder.build();
}

/**
 * The ANSI colour-split bind, as its own stream.
 *
 * Vite prints the port inside its own SGR run, so the raw regex can only reach
 * `http://localhost:` — the port exists solely on `extractLocalhostUrls`'s
 * strip-and-rescan pass. A detector that lost that pass still returns a URL,
 * just a portless one, which is why this is graded as an exact string.
 *
 * It is deliberately the ONLY bind in its stream. `extractLocalhostUrls`
 * appends strip-pass matches after raw-pass matches, so once an ANSI-split URL
 * is in the rolling buffer it sorts last for the rest of the session and the
 * buffer-fallback branch keeps re-reporting it as the newest bind even after a
 * later plain-text bind supersedes it. Mixing it into a multi-bind stream made
 * the expected poll sequence depend on that ordering quirk rather than on the
 * plants.
 */
export function buildAnsiBindStreamPlan(options: {
  port: number;
  noise: number;
  seed: number;
}): DevPreviewStreamPlan {
  const builder = new PlanBuilder();
  let noiseIndex = options.seed;
  const noise = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      noiseIndex += 1;
      builder.push({ text: `${NOISE_LINES[noiseIndex % NOISE_LINES.length]!} #${noiseIndex}\n` });
    }
  };

  noise(options.noise);
  for (const decoy of DECOY_LINES) {
    builder.push({ text: `${decoy}\n`, isDecoy: true });
  }
  builder.push({
    text: `  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m${options.port}\x1b[22m/\x1b[39m\n`,
    expectsUrl: `http://localhost:${options.port}/`,
  });
  noise(options.noise);
  builder.push({ text: `${readyLine(0)}\n`, expectsReadyAcceleration: true });
  noise(options.noise);
  return builder.build();
}

/**
 * The output-classified failure path, ONE failure per stream.
 *
 * They cannot share a stream. `scanOutput` keeps an 8 KiB rolling buffer and
 * `detectDevServerError` runs over the whole of it, so the first failure keeps
 * matching for every later chunk and `lastErrorKey` dedups the repeat — the
 * second planted failure is never reached. That is correct product behaviour
 * (one server, one fault), but it means a multi-failure stream would grade
 * three of its four plants as misses against a perfectly healthy detector.
 *
 * Each row is graded on the type AND the status it routes to:
 * `missing-dependencies` is the one recoverable type and leaves the session in
 * a running state, every other type stops it with `error`. A classifier that
 * answered `unknown` for everything would still be "detecting" and still fails
 * here.
 */
export function buildFailureStreamPlans(seed: number): DevPreviewStreamPlan[] {
  const failures: Array<{ text: string; type: DevServerErrorType }> = [
    { text: "  Error: listen EADDRINUSE: address already in use :::5199", type: "port-conflict" },
    { text: "  Error: Cannot find module 'vite-plugin-inspect'", type: "missing-dependencies" },
    { text: "  ✘ [ERROR] Failed to compile src/routes/index.tsx", type: "compile-error" },
    { text: "  EACCES: permission denied, open '/usr/local/lib/cache'", type: "permission" },
  ];

  return failures.map((failure, index) => {
    const builder = new PlanBuilder();
    let noiseIndex = seed + index * 17;
    const noise = (count: number): void => {
      for (let i = 0; i < count; i += 1) {
        noiseIndex += 1;
        builder.push({ text: `${NOISE_LINES[noiseIndex % NOISE_LINES.length]!} #${noiseIndex}\n` });
      }
    };
    // Enough preamble to saturate scanOutput's 8 KiB rolling buffer before the
    // fault lands. `detectDevServerError` sweeps the WHOLE buffer on every
    // chunk, so a stream that never fills it prices that sweep at a fraction of
    // what a real dev server pays.
    noise(90);
    builder.push({ text: `${failure.text}\n`, expectsErrorType: failure.type });
    // Chunks after the fault: the error scan still runs over the buffer on
    // every one of them, and the product must NOT re-report the same fault.
    noise(30);
    return builder.build();
  });
}

/** Fresh session state, matching what `spawnSessionTerminal` leaves behind. */
export function createDevPreviewSession(
  panelId: string,
  projectId: string
): DevPreviewSessionState {
  return {
    panelId,
    projectId,
    status: "starting",
    url: null,
    pendingUrl: null,
    predictedUrl: null,
    buffer: "",
    readinessAbort: null,
    markerSeen: false,
    sawOutput: false,
    generation: 1,
    isRunningInstall: false,
    needsInstall: false,
    lastErrorKey: null,
    compiling: false,
    compilingTimer: null,
    compilingClearTimer: null,
  };
}

/** Clear the compile debounce timers a run may have left armed. */
export function disposeDevPreviewSession(session: DevPreviewSessionState): void {
  if (session.compilingTimer !== null) {
    clearTimeout(session.compilingTimer);
    session.compilingTimer = null;
  }
  if (session.compilingClearTimer !== null) {
    clearTimeout(session.compilingClearTimer);
    session.compilingClearTimer = null;
  }
  session.compiling = false;
  session.readinessAbort?.abort();
  session.readinessAbort = null;
}

export interface DevPreviewPassResult {
  /** URLs the product handed to `pollServerReadiness`, in call order. */
  polledUrls: string[];
  readyAccelerations: number;
  compileArms: number;
  compileClears: number;
  errorUpdates: Array<{ type: DevServerErrorType; status: string }>;
  chunksProcessed: number;
  /** `recordSessionDiagnostic` invocations, counted at the dep we supplied. */
  diagnosticEvents: number;
  /** The ring key the product's writes landed under, for the read-back oracle. */
  ringKey: string;
  /** Frame index of the first poll, or -1. Reported as a detection depth. */
  firstPolledFrameIndex: number;
}

export interface SharedDevPreviewDeps {
  /**
   * Narrowed to the one method the product's own `OutputProcessorDeps` asks
   * for, so a test can substitute a deliberately broken detector and check the
   * predicate notices.
   */
  detector: Pick<UrlDetector, "scanOutput">;
  textDecoder: TextDecoder;
  rings: DevPreviewDiagnosticsRingMap;
}

/**
 * One session's pass over one plan, steppable a chunk at a time so concurrent
 * sessions can be interleaved on the single main-process thread they actually
 * share.
 *
 * Every observation below is taken at the call site — either the product
 * invoking a dep we supplied, or a field on the session object the product just
 * mutated. Nothing here calls `UrlDetector` a second time to check the first
 * call's answer.
 */
export class DevPreviewPassDriver {
  private readonly polledUrls: string[] = [];
  private readonly errorUpdates: Array<{ type: DevServerErrorType; status: string }> = [];
  private readyAccelerations = 0;
  private compileArms = 0;
  private compileClears = 0;
  private diagnosticEvents = 0;
  private chunksProcessed = 0;
  private firstPolledFrameIndex = -1;
  private cursor = 0;
  private readonly ringKey: string;
  private readonly deps: Parameters<typeof processDevPreviewOutput<DevPreviewSessionState>>[3];

  constructor(
    private readonly plan: DevPreviewStreamPlan,
    private readonly session: DevPreviewSessionState,
    shared: SharedDevPreviewDeps,
    private readonly terminalId = "dev-preview-terminal"
  ) {
    const key = `${session.projectId}::${session.panelId}`;
    this.ringKey = key;
    this.deps = {
      detector: shared.detector,
      textDecoder: shared.textDecoder,
      recordSessionDiagnostic: (target, input): void => {
        this.diagnosticEvents += 1;
        recordDevPreviewDiagnostic(shared.rings, key, target.generation, input);
      },
      updateSession: (target, updates: OutputProcessorSessionUpdate): void => {
        if (updates.status !== undefined) target.status = updates.status;
        if (updates.url !== undefined) target.url = updates.url;
        if (updates.predictedUrl !== undefined) target.predictedUrl = updates.predictedUrl;
        if (updates.phaseLabel !== undefined) target.phaseLabel = updates.phaseLabel;
        if (updates.error) {
          this.errorUpdates.push({ type: updates.error.type, status: target.status });
        }
      },
      emitStateChanged: (): void => {},
      clearCompiling: (target): void => {
        if (target.compilingTimer !== null) {
          clearTimeout(target.compilingTimer);
          target.compilingTimer = null;
        }
        if (target.compilingClearTimer !== null) {
          clearTimeout(target.compilingClearTimer);
          target.compilingClearTimer = null;
        }
        target.compiling = false;
        if (target.phaseLabel === "Compiling") target.phaseLabel = undefined;
      },
      pollServerReadiness: (_target, url): void => {
        this.polledUrls.push(url);
        if (this.firstPolledFrameIndex < 0) this.firstPolledFrameIndex = this.chunksProcessed;
      },
    };
  }

  get done(): boolean {
    return this.cursor >= this.plan.frames.length;
  }

  /** Feed the next chunk. Returns false once the stream is exhausted. */
  step(): boolean {
    const frame = this.plan.frames[this.cursor];
    if (frame === undefined) return false;
    this.cursor += 1;

    const markerSeenBefore = this.session.markerSeen;
    const compileArmedBefore = this.session.compilingTimer !== null || this.session.compiling;

    processDevPreviewOutput(this.session, this.terminalId, frame.text, this.deps);
    this.chunksProcessed += 1;

    const compileArmedAfter = this.session.compilingTimer !== null || this.session.compiling;
    // `markerSeen` is set only on the ready-marker branch, and every other
    // branch that touches it (a new URL, an output error) resets it to false.
    // A false→true transition is therefore exactly one accelerated re-probe.
    if (!markerSeenBefore && this.session.markerSeen) this.readyAccelerations += 1;
    if (!compileArmedBefore && compileArmedAfter) this.compileArms += 1;
    if (compileArmedBefore && !compileArmedAfter) this.compileClears += 1;
    return true;
  }

  result(): DevPreviewPassResult {
    return {
      polledUrls: this.polledUrls,
      readyAccelerations: this.readyAccelerations,
      compileArms: this.compileArms,
      compileClears: this.compileClears,
      errorUpdates: this.errorUpdates,
      chunksProcessed: this.chunksProcessed,
      diagnosticEvents: this.diagnosticEvents,
      ringKey: this.ringKey,
      firstPolledFrameIndex: this.firstPolledFrameIndex,
    };
  }
}

/** Feed one whole plan through the real per-chunk handler. */
export function runDevPreviewOutputPass(
  plan: DevPreviewStreamPlan,
  session: DevPreviewSessionState,
  shared: SharedDevPreviewDeps,
  terminalId = "dev-preview-terminal"
): DevPreviewPassResult {
  const driver = new DevPreviewPassDriver(plan, session, shared, terminalId);
  while (driver.step());
  return driver.result();
}

/**
 * Round-robin several sessions' streams a chunk at a time, which is how they
 * actually arrive: every dev server in a window writes into the same main
 * process, and `handleData` is one shared code path routing by terminal id.
 */
export function runInterleavedDevPreviewPasses(
  drivers: readonly DevPreviewPassDriver[]
): DevPreviewPassResult[] {
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const driver of drivers) {
      if (driver.step()) progressed = true;
    }
  }
  return drivers.map((driver) => driver.result());
}

export interface DevPreviewMissCounts {
  /** Planted URLs the product failed to poll, matched in order. */
  urlMisses: number;
  /** Polled URLs that were never planted — a decoy or noise line matched. */
  decoyHits: number;
  /** Signed: negative means the product accelerated more often than planted. */
  readyMarkerMisses: number;
  compileArmMisses: number;
  compileClearMisses: number;
  /** Signed, over the classified failure types in order. */
  errorClassMisses: number;
  /**
   * The real bounded diagnostics ring, read back after the pass.
   *
   * `diagnosticEvents` counts the calls the product made into the dep we
   * supplied, which is not the same claim: the ring write itself is real
   * product code inside the measured bracket, and deleting it left every
   * predicate at zero while the pass got faster. This grades what
   * `recordDevPreviewDiagnostic` actually stored.
   */
  diagnosticRingMisses: number;
}

/**
 * Grade one pass, in both directions.
 *
 * `urlMisses` catches a detector that reports nothing; `decoyHits` catches one
 * that reports everything. Neither alone is an oracle here — the cheap wrong
 * answers in URL detection are "always null" and "always match", and each of
 * them scores zero against the other's counter.
 *
 * The marker and error counters are separate accumulators rather than one
 * total, because they are separate operations inside the bracket: the
 * `READY_MARKERS` scan, the `COMPILE_MARKERS` scan, and the
 * `detectDevServerError` sweep over the rolling buffer all run on every chunk,
 * and a single aggregate would let one of them be deleted for free.
 */
/** A session that has not been stopped by the failure it just reported. */
const RECOVERABLE_STATUSES: ReadonlySet<string> = new Set(["starting", "installing", "running"]);

export function devPreviewPassMisses(
  plan: DevPreviewStreamPlan,
  result: DevPreviewPassResult,
  rings: DevPreviewDiagnosticsRingMap
): DevPreviewMissCounts {
  const planted = new Set(plan.expectedUrls);
  // Positional against the planned call sequence: a detector that reported the
  // right set in the wrong order, or that skipped one bind and shifted the
  // rest, is not healthy.
  let urlMisses = 0;
  for (let i = 0; i < plan.expectedPolls.length; i += 1) {
    if (result.polledUrls[i] !== plan.expectedPolls[i]) urlMisses += 1;
  }

  // The other direction. A URL never planted is a decoy or a noise line that
  // matched; an extra poll of a URL that WAS planted is a dedup failure
  // (`pendingUrl` should have absorbed it) and counts here too, so
  // "report everything" cannot pass by covering the planted set.
  let decoyHits = 0;
  for (const polled of result.polledUrls) {
    if (!planted.has(polled)) decoyHits += 1;
  }
  decoyHits += Math.max(0, result.polledUrls.length - plan.expectedPolls.length - decoyHits);

  let errorClassMisses = plan.expectedErrorTypes.length - result.errorUpdates.length;
  for (let i = 0; i < plan.expectedErrorTypes.length; i += 1) {
    const expectedType = plan.expectedErrorTypes[i]!;
    const actual = result.errorUpdates[i];
    if (!actual || actual.type !== expectedType) {
      errorClassMisses += 1;
      continue;
    }
    // `missing-dependencies` is the one recoverable type: it arms the install
    // and leaves the session running, because `installing` now means an install
    // actually started rather than one that output merely predicted (#12295).
    // Every other type must stop the session. Still two-sided: routing the
    // recoverable type to `error`, or a terminal type anywhere else, both miss.
    const statusOk =
      expectedType === "missing-dependencies"
        ? RECOVERABLE_STATUSES.has(actual.status)
        : actual.status === "error";
    if (!statusOk) errorClassMisses += 1;
  }

  return {
    urlMisses,
    decoyHits,
    readyMarkerMisses: plan.expectedReadyAccelerations - result.readyAccelerations,
    compileArmMisses: plan.expectedCompileArms - result.compileArms,
    compileClearMisses: plan.expectedCompileClears - result.compileClears,
    errorClassMisses,
    diagnosticRingMisses: diagnosticRingMisses(plan, rings, result.ringKey),
  };
}

/**
 * Read the session's ring back and compare it, in order, with what the corpus
 * planted.
 *
 * Two-sided over one operation. A ring that stopped recording holds fewer
 * events than were planted; a ring that stopped bounding or stopped coalescing
 * holds more; a ring that recorded the wrong thing fails the per-index detail.
 * The expectations are the fixture's own — the URL it composed from the host
 * and port it chose, and the error type it planted — never a second read of
 * `UrlDetector` or `detectDevServerError`.
 *
 * The session key is the product's own (`projectId::panelId`), taken from the
 * driver that supplied the dep, so a write filed under the wrong key reads here
 * as a ring that recorded nothing.
 *
 * TWO BOUNDS THIS DOES NOT REACH, so nobody reads more into it than is there.
 * No corpus plants more than `DIAGNOSTIC_RING_MAX` (100) events on one session,
 * so the per-session trim is never exercised; and the heaviest scenario opens
 * 30 sessions against a `DIAGNOSTIC_SESSIONS_MAX` of 50, so the key LRU never
 * evicts. A corpus that grew past either would start reporting misses on a
 * healthy run — `diagnosticRingCount` is emitted beside these for that reason.
 */
function diagnosticRingMisses(
  plan: DevPreviewStreamPlan,
  rings: DevPreviewDiagnosticsRingMap,
  ringKey: string
): number {
  const events = rings.get(ringKey)?.events ?? [];
  let misses = Math.abs(plan.expectedDiagnostics.length - events.length);

  const paired = Math.min(plan.expectedDiagnostics.length, events.length);
  for (let i = 0; i < paired; i += 1) {
    const expected = plan.expectedDiagnostics[i]!;
    const event = events[i]!;
    if (event.type !== expected.type) {
      misses += 1;
      continue;
    }
    if (event.type === "url-detected" && event.url !== expected.detail) misses += 1;
    if (event.type === "output-error" && event.errorType !== expected.detail) misses += 1;
  }

  return misses;
}

export function emptyMissCounts(): DevPreviewMissCounts {
  return {
    urlMisses: 0,
    decoyHits: 0,
    readyMarkerMisses: 0,
    compileArmMisses: 0,
    compileClearMisses: 0,
    errorClassMisses: 0,
    diagnosticRingMisses: 0,
  };
}

export function addMissCounts(
  into: DevPreviewMissCounts,
  from: DevPreviewMissCounts
): DevPreviewMissCounts {
  into.urlMisses += from.urlMisses;
  into.decoyHits += from.decoyHits;
  into.readyMarkerMisses += from.readyMarkerMisses;
  into.compileArmMisses += from.compileArmMisses;
  into.compileClearMisses += from.compileClearMisses;
  into.errorClassMisses += from.errorClassMisses;
  into.diagnosticRingMisses += from.diagnosticRingMisses;
  return into;
}

export function createSharedDevPreviewDeps(): SharedDevPreviewDeps {
  return {
    detector: new UrlDetector(),
    textDecoder: new TextDecoder(),
    rings: new Map(),
  };
}

/**
 * The exit-classification spec table PERF-024 grades against.
 *
 * Every row states the answer the product must produce, and the table is
 * two-sided by construction: seven rows must classify to `null` (a clean exit
 * or an expected termination signal) and the rest to a named type. A
 * classifier that reported a crash for everything fails the null rows; one
 * that reported nothing fails the rest.
 *
 * Three rows are the ones an exit-code-only or signal-only classifier gets
 * wrong. SIGKILL (9) is in `CRASH_SIGNALS` but deliberately falls THROUGH to
 * the output and exit-code tiers, so `(0, 9)` is a clean exit and `(1, 9)` is
 * `unknown` — not `process-crash`. And SIGABRT with heap-OOM text in the output
 * is `oom`, not `process-crash`, because Node's own heap OOM aborts rather than
 * being killed.
 */
export interface ExitCase {
  exitCode: number;
  signal?: number;
  output: string;
  expected: DevServerErrorType | null;
}

export const EXIT_SPEC_TABLE: readonly ExitCase[] = [
  { exitCode: 0, output: "  server closed", expected: null },
  { exitCode: 0, signal: 15, output: "", expected: null },
  { exitCode: 0, signal: 2, output: "^C", expected: null },
  { exitCode: 0, signal: 1, output: "", expected: null },
  { exitCode: 0, signal: 13, output: "", expected: null },
  { exitCode: 0, signal: 9, output: "  shutting down", expected: null },
  { exitCode: 143, signal: 15, output: "  received SIGTERM", expected: null },
  { exitCode: 1, output: "  server stopped", expected: "unknown" },
  { exitCode: 1, signal: 9, output: "  server stopped", expected: "unknown" },
  { exitCode: 1, signal: 11, output: "  segmentation violation", expected: "process-crash" },
  { exitCode: 1, signal: 4, output: "", expected: "process-crash" },
  { exitCode: 1, signal: 7, output: "", expected: "process-crash" },
  { exitCode: 1, signal: 8, output: "", expected: "process-crash" },
  { exitCode: 1, signal: 6, output: "  aborted", expected: "process-crash" },
  {
    exitCode: 1,
    signal: 6,
    output: "FATAL ERROR: JavaScript heap out of memory",
    expected: "oom",
  },
  { exitCode: 137, signal: 9, output: "Cannot allocate memory", expected: "oom" },
  {
    exitCode: 1,
    output: "Error: listen EADDRINUSE: address already in use :::5199",
    expected: "port-conflict",
  },
  { exitCode: 1, output: "Error: Cannot find module 'vite'", expected: "missing-dependencies" },
  { exitCode: 1, output: "EACCES: permission denied, open '/tmp/x'", expected: "permission" },
  { exitCode: 1, output: "Failed to compile src/App.tsx", expected: "compile-error" },
];

export interface ExitClassificationResult {
  classifications: number;
  /** Signed against the table: rows the product answered differently. */
  exitClassMisses: number;
  nullRowsGraded: number;
  errorRowsGraded: number;
}

/** Drive the real `classifyDevPreviewExit` across the whole spec table. */
export function runExitClassificationPass(
  table: readonly ExitCase[] = EXIT_SPEC_TABLE
): ExitClassificationResult {
  let classifications = 0;
  let exitClassMisses = 0;
  let nullRowsGraded = 0;
  let errorRowsGraded = 0;

  for (const row of table) {
    const actual = classifyDevPreviewExit(row.exitCode, row.signal, row.output);
    classifications += 1;
    if (row.expected === null) {
      nullRowsGraded += 1;
      if (actual !== null) exitClassMisses += 1;
    } else {
      errorRowsGraded += 1;
      if (actual === null || actual.type !== row.expected) exitClassMisses += 1;
    }
  }

  return { classifications, exitClassMisses, nullRowsGraded, errorRowsGraded };
}

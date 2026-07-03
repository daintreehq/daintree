import {
  AgentPatternDetector,
  stripAnsi,
  type PatternDetectionConfig,
  type PatternDetectionResult,
} from "./pty/AgentPatternDetector.js";
import { PatternBuffer } from "./pty/PatternBuffer.js";
import { InputTracker } from "./pty/InputTracker.js";
import { OutputVolumeDetector, type OutputVolumeConfig } from "./pty/OutputVolumeDetector.js";
import { HighOutputDetector } from "./pty/HighOutputDetector.js";
import { WorkingSignalDebouncer } from "./pty/WorkingSignalDebouncer.js";
import { LineRewriteDetector, isStatusLineRewrite } from "./pty/LineRewriteDetector.js";
import { stripIdleTerminalSequences } from "./pty/IdleSequenceFilter.js";
import {
  SynchronizedFrameAnalyzer,
  type FrameSnapshot,
  type StructuralSignal,
} from "./pty/SynchronizedFrameAnalyzer.js";
import {
  createVisibleContentSnapshot,
  type VisibleContentSnapshot,
} from "./pty/SustainedChangeTracker.js";
import {
  AGENT_OUTPUT_ACTIVITY_LINE_COUNT,
  AgentActivityTemperature,
  type AgentActivityObservationResult,
  type AgentActivitySignalKind,
} from "./pty/AgentActivityTemperature.js";
import {
  detectPrompt,
  detectPromptLexeme,
  DEFAULT_PROMPT_PATTERNS,
  type PromptDetectorConfig,
} from "./pty/PromptDetector.js";
import { detectCompletion } from "./pty/CompletionDetector.js";
import { CompletionTimer } from "./pty/CompletionTimer.js";
import { BootDetector } from "./pty/BootDetector.js";
import { classifyWaitingReason } from "./pty/WaitingReasonClassifier.js";
import { CpuHighStateTracker } from "./pty/CpuHighStateTracker.js";
import { WaitingWatchdog } from "./pty/WaitingWatchdog.js";
import type { WaitingReason } from "../../shared/types/agent.js";

const PROMPT_DEBOUNCE_MS = 500;
const PROMPT_QUIET_MS = 200;
const PROMPT_HISTORY_FALLBACK_MS = 3000;
const WORKING_HOLD_MS = 1500;
const SPINNER_ACTIVE_MS = 1500;
const COMPLETION_HOLD_MS = 500;
// Minimum output quiet before the simple-output polling cycle scans for
// completion patterns — the non-simple path gets the same protection from its
// working-signal gates (recent output suppresses completion detection), so a
// cost summary printed mid-stream doesn't read as a finished session (#9873).
const SIMPLE_COMPLETION_MIN_QUIET_MS = 1500;
// Quiet window before captureSimpleOutputSnapshot starts reusing its cached
// snapshot — long enough for xterm's async parse of the last chunk (and any
// resize/focus-triggered redraw) to land before a frame is latched.
const SIMPLE_SNAPSHOT_SETTLE_MS = 1000;
// Idle-agent polling backoff (#10906). Once a simple-output agent has settled
// into idle and stayed silent this long, drop the polling cadence to
// FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS so a prompt sitting idle for an hour
// stops doing per-tick strip+diff temperature work at the active 50ms rate. Any
// onData (or busy transition) cancels the backoff and restores the visibility
// tier's interval instantly, so detection latency is preserved — state
// transitions are always preceded by output.
export const FSM_IDLE_BACKOFF_SETTLE_MS = 3000;
export const FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS = 2000;
const WORKING_INDICATOR_TTL_MS = 5000;
const CPU_HIGH_THRESHOLD = 10;
const CPU_LOW_THRESHOLD = 3;
// Full-buffer strip+detect cadence cap. The rolling pattern buffer keeps
// accumulating per chunk; only the stripAnsi + pattern-bank scan is
// throttled, with a trailing-edge run so the final chunk before quiet is
// still scanned. Downstream consumers debounce at 100ms+ scales.
const PATTERN_SCAN_THROTTLE_MS = 30;

export interface ProcessStateValidator {
  hasActiveChildren(): boolean;
  getDescendantsCpuUsage?(): number;
}

export interface PatternDetector {
  detect(output: string): PatternDetectionResult;
}

export interface ActivityMonitorOptions {
  ignoredInputSequences?: string[];
  processStateValidator?: ProcessStateValidator;
  outputActivityDetection?: {
    enabled?: boolean;
    leakRatePerMs?: number;
    activationThreshold?: number;
    maxBytesPerFrame?: number;
  };
  highOutputThreshold?: {
    enabled?: boolean;
    windowMs?: number;
    bytesPerSecond?: number;
    recoveryEnabled?: boolean;
    recoveryDelayMs?: number;
  };
  agentId?: string;
  patternConfig?: PatternDetectionConfig;
  bootCompletePatterns?: RegExp[];
  patternBufferSize?: number;
  getVisibleLines?: (n: number) => string[];
  getVisibleContentSnapshot?: (n: number) => VisibleContentSnapshot | undefined;
  getCursorLine?: () => string | null;
  initialState?: "busy" | "idle";
  skipInitialStateEmit?: boolean;
  promptPatterns?: RegExp[];
  promptHintPatterns?: RegExp[];
  completionPatterns?: RegExp[];
  completionConfidence?: number;
  promptScanLineCount?: number;
  promptConfidence?: number;
  idleDebounceMs?: number;
  promptFastPathMinQuietMs?: number;
  inputConfirmMs?: number;
  maxNoPromptIdleMs?: number;
  lineRewriteDetection?: {
    enabled?: boolean;
    windowMs?: number;
    minRewrites?: number;
  };
  pollingIntervalMs?: number;
  workingRecoveryDelayMs?: number;
  // Background polling tier override — applied automatically by setPollingInterval()
  // when intervalMs > 50. When unset, fall back to the active value so behavior
  // matches today's defaults until the call site opts in.
  backgroundWorkingRecoveryDelayMs?: number;
  pollingMaxBootMs?: number;
  maxWorkingSilenceMs?: number;
  maxCpuHighEscapeMs?: number;
  maxWaitingSilenceMs?: number;
  simpleOutputState?: boolean;
  // Leaky-bucket byte-volume detector for the simpleOutputState early-return
  // path (#10664). Agent terminals short-circuit before the non-simple
  // first-output-byte recovery guard, so a sustained stream of appended output
  // (e.g. a long investigation result) never drove waiting→working. This
  // dedicated detector — kept separate from `outputActivityDetection` so it
  // can't perturb the polling cycle's `hasRecentOutputActivity` signal —
  // recovers idle→busy once enough stripped output accumulates.
  simpleOutputVolumeRecovery?: OutputVolumeConfig;
  // Consecutive watchdog ticks that must all observe a dead-looking probe
  // result before onWaitingTimeout fires. Defaults to 3 (≈15s of sustained
  // consensus at the 5s watchdog cadence) to ride through transient false
  // negatives during LLM API waits. Clamped to >= 1 to keep the fire path
  // reachable.
  waitingWatchdogFailThreshold?: number;
  onWaitingTimeout?: (id: string, spawnedAt: number) => void;
  /**
   * Fires once per boot cycle the first time `BootDetector.check()` returns
   * true (or `markExited()` is invoked indirectly). The timestamp is the
   * wall-clock `Date.now()` at the moment boot completion is observed. Used
   * by `TerminalProcess` to record `bootCompleteAt` and emit the
   * `[AgentStartup]` structured log entry.
   */
  onBootComplete?: (bootCompleteAt: number) => void;
}

export interface ActivityStateMetadata {
  trigger: "input" | "output" | "pattern" | "timeout" | "dispose";
  patternConfidence?: number;
  waitingReason?: WaitingReason;
  sessionCost?: number;
  sessionTokens?: number;
}

export class ActivityMonitor {
  private state: "busy" | "idle" = "idle";
  private isDisposed = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly IDLE_DEBOUNCE_MS: number;
  private readonly PROMPT_FAST_PATH_MIN_QUIET_MS: number;
  private readonly MAX_WORKING_SILENCE_MS: number;
  private readonly MAX_WAITING_SILENCE_MS: number;
  private idleSince = 0;
  private lastPatternResultAt = 0;
  private workingHoldUntil = 0;
  private lastPatternScanAt = 0;
  private patternScanTimer: NodeJS.Timeout | null = null;

  // Subsystem instances
  private readonly inputTracker: InputTracker;
  private readonly patternBuf: PatternBuffer;
  private readonly outputVolumeDetector: OutputVolumeDetector;
  // Volume-based idle→busy recovery for the simpleOutputState path (#10664).
  // Undefined unless `simpleOutputVolumeRecovery` is configured.
  private readonly simpleOutputVolumeDetector?: OutputVolumeDetector;
  // Wall-clock of the last sustained-volume bucket fire (#10664). Defers both
  // simpleOutputState waiting-demotion gates (the polling idle gate and the
  // temperature `stateHint: idle` gate) for the quiet floor after heavy
  // streaming, since appended output leaves the visible-content diff flat.
  // Stays 0 — and thus inert — for any monitor whose volume detector never
  // fires, so non-agent and unconfigured paths are unaffected.
  private lastSimpleOutputVolumeAt = 0;
  private readonly highOutputDetector: HighOutputDetector;
  private readonly workingSignalDebouncer: WorkingSignalDebouncer;
  // Dedicated debouncer for the idle-state cosmetic-redraw recovery path
  // (#6641). Cannot share workingSignalDebouncer because runPollingCycle's
  // "no working signal" branch resets sustainedSince every poll, which would
  // erase accumulated spinner-tick signal between sparse cosmetic frames.
  private readonly cosmeticRecoveryDebouncer: WorkingSignalDebouncer;
  // Structural tier (#6668) cannot share workingSignalDebouncer because
  // runPollingCycle's "no working signal this tick" branch calls
  // shouldTriggerRecovery(now, false), which would zero the structural
  // sustainedSince between sparse frame-close events (one every 80-100ms is
  // typical, vs. the polling cycle's 50ms cadence).
  private readonly structuralRecoveryDebouncer: WorkingSignalDebouncer;
  private readonly lineRewriteDetector: LineRewriteDetector;
  private readonly completionTimer: CompletionTimer;
  private readonly bootDetector: BootDetector;
  // Structural-signal tier (#6668). Sits above the regex-based pattern tier:
  // classifies DEC mode 2026 frame snapshots as cosmetic-only, spinner, or
  // time-counter. Driven by SynchronizedFrameDetector in TerminalProcess via
  // onSynchronizedFrame().
  private readonly synchronizedFrameAnalyzer: SynchronizedFrameAnalyzer;
  private readonly cpuTracker: CpuHighStateTracker;
  private readonly waitingWatchdog: WaitingWatchdog;

  // Resize suppression
  private resizeSuppressUntil = 0;

  // Focus suppression (#8865). xterm emits CSI I / CSI O on focus changes when
  // the TUI has enabled DEC mode ?1004; the agent's repaint can arrive after
  // the 1s echo window closes, so a dedicated longer window is required to
  // suppress the idle→busy promotion that the repaint would otherwise cause.
  private focusSuppressUntil = 0;

  private readonly onWaitingTimeout?: (id: string, spawnedAt: number) => void;
  private readonly onBootComplete?: (bootCompleteAt: number) => void;
  private bootCompleteCallbackFired = false;
  private readonly processStateValidator?: ProcessStateValidator;
  private lastActivityTimestamp = Date.now();
  private lastDataTimestamp = Date.now();
  private lastOutputActivityAt = 0;
  // Latched when simple-output data matches isStatusLineRewrite — lets the
  // polling cycle classify visible-content changes as indicator-driven (#9874).
  private lastStatusRewriteAt = 0;
  private lastWorkingIndicatorTimestamp = 0;
  private promptStableSince = 0;

  // Pattern-based detection
  private patternDetector?: AgentPatternDetector;
  private lastPatternResult?: PatternDetectionResult;
  private readonly getVisibleLines?: (n: number) => string[];
  private readonly getVisibleContentSnapshot?: (n: number) => VisibleContentSnapshot | undefined;
  private readonly getCursorLine?: () => string | null;
  private pollingInterval?: ReturnType<typeof setInterval>;
  private watchdogInterval?: ReturnType<typeof setInterval>;

  // Polling config
  private readonly POLLING_MAX_BOOT_MS: number;

  // Prompt/completion config
  private readonly promptDetectorConfig: PromptDetectorConfig;
  private readonly completionPatterns: RegExp[];
  private readonly completionConfidence: number;

  // State preservation for project switch
  private readonly skipInitialStateEmit: boolean;
  private readonly simpleOutputState: boolean;
  private readonly simpleOutputTemperature = new AgentActivityTemperature();
  // Memoized captureSimpleOutputSnapshot result, valid only while the quiet
  // clock it was keyed on (`simpleSnapshotCacheKey`) is unchanged.
  private simpleSnapshotCache?: VisibleContentSnapshot;
  private simpleSnapshotCacheKey = 0;
  private simpleSnapshotSettleFrom = 0;

  // Polling interval configuration.
  // POLLING_INTERVAL_MS is the *currently applied* interval driving setInterval.
  // requestedPollingIntervalMs is the visibility tier's desired cadence (50/500);
  // while idle-backoff owns the live interval they diverge, and the wake path
  // restores POLLING_INTERVAL_MS to requestedPollingIntervalMs (#10906).
  private POLLING_INTERVAL_MS: number;
  private requestedPollingIntervalMs: number;
  private fsmIdleBackoffTimer?: ReturnType<typeof setTimeout>;
  private fsmIdleBackoffActive = false;

  // Tier-aware recovery thresholds (#6641). The output volume detector is now
  // sample-cadence invariant (#6666), so only the working-signal debouncer
  // needs tier-specific tuning. Active values must match the pre-fix hardcoded
  // behavior so the 50ms tier is unchanged. Background shortens the debouncer
  // delay so backgrounded agents can escape "waiting" when output resumes.
  private _tier: "active" | "background" = "active";
  private readonly activeWorkingRecoveryDelayMs: number;
  private readonly backgroundWorkingRecoveryDelayMs: number;

  constructor(
    private terminalId: string,
    private spawnedAt: number,
    private onStateChange: (
      id: string,
      spawnedAt: number,
      state: "busy" | "idle" | "completed",
      metadata?: ActivityStateMetadata
    ) => void,
    options?: ActivityMonitorOptions
  ) {
    const simpleOutputState = options?.simpleOutputState ?? options?.agentId !== undefined;
    this.IDLE_DEBOUNCE_MS = options?.idleDebounceMs ?? (simpleOutputState ? 8000 : 4000);
    this.PROMPT_FAST_PATH_MIN_QUIET_MS = options?.promptFastPathMinQuietMs ?? 3000;
    this.POLLING_MAX_BOOT_MS = options?.pollingMaxBootMs ?? 15000;
    this.MAX_WORKING_SILENCE_MS = options?.maxWorkingSilenceMs ?? 180000;
    const maxCpuHighEscapeMs = options?.maxCpuHighEscapeMs ?? 60000;
    this.MAX_WAITING_SILENCE_MS = options?.maxWaitingSilenceMs ?? 600000;
    const rawThreshold = options?.waitingWatchdogFailThreshold ?? 3;
    const watchdogFailThreshold = Number.isFinite(rawThreshold) ? Math.max(1, rawThreshold) : 3;

    this.idleSince = Date.now();

    this.processStateValidator = options?.processStateValidator;
    this.onWaitingTimeout = options?.onWaitingTimeout;
    this.onBootComplete = options?.onBootComplete;

    // Initialize subsystems
    this.inputTracker = new InputTracker({
      ignoredInputSequences: options?.ignoredInputSequences,
      inputConfirmMs: options?.inputConfirmMs,
    });

    this.patternBuf = new PatternBuffer(options?.patternBufferSize ?? 10000);

    this.outputVolumeDetector = new OutputVolumeDetector(options?.outputActivityDetection);
    this.simpleOutputVolumeDetector = options?.simpleOutputVolumeRecovery
      ? new OutputVolumeDetector(options.simpleOutputVolumeRecovery)
      : undefined;

    this.highOutputDetector = new HighOutputDetector(options?.highOutputThreshold);

    this.workingSignalDebouncer = new WorkingSignalDebouncer(
      options?.workingRecoveryDelayMs ?? 1500
    );
    this.cosmeticRecoveryDebouncer = new WorkingSignalDebouncer(
      options?.workingRecoveryDelayMs ?? 1500
    );
    this.structuralRecoveryDebouncer = new WorkingSignalDebouncer(
      options?.workingRecoveryDelayMs ?? 1500
    );

    // Snapshot tier-aware recovery thresholds. Active value defaults to the
    // debouncer-instantiation value so the active-tier path is identical to
    // pre-fix behavior. Background defaults to the active value when the
    // caller doesn't opt in, preserving compatibility for non-agent terminals.
    this.activeWorkingRecoveryDelayMs = this.workingSignalDebouncer.delayMs;
    this.backgroundWorkingRecoveryDelayMs =
      options?.backgroundWorkingRecoveryDelayMs ?? this.activeWorkingRecoveryDelayMs;

    this.lineRewriteDetector = new LineRewriteDetector(options?.lineRewriteDetection);

    this.synchronizedFrameAnalyzer = new SynchronizedFrameAnalyzer();

    this.completionTimer = new CompletionTimer();

    this.bootDetector = new BootDetector(options?.bootCompletePatterns);

    // Pattern detector
    if (options?.patternConfig || options?.agentId) {
      this.patternDetector = new AgentPatternDetector(options.agentId, options.patternConfig);
    }
    this.getVisibleLines = options?.getVisibleLines;
    this.getVisibleContentSnapshot = options?.getVisibleContentSnapshot;
    this.getCursorLine = options?.getCursorLine;

    // Prompt config
    const promptPatterns =
      options?.promptPatterns?.length && options.promptPatterns.length > 0
        ? options.promptPatterns
        : DEFAULT_PROMPT_PATTERNS;
    this.promptDetectorConfig = {
      promptPatterns,
      promptHintPatterns: options?.promptHintPatterns ?? [],
      promptScanLineCount: options?.promptScanLineCount ?? 6,
      promptConfidence: options?.promptConfidence ?? 0.85,
    };

    // Completion config
    this.completionPatterns = options?.completionPatterns ?? [];
    this.completionConfidence = options?.completionConfidence ?? 0.9;

    // State preservation
    this.state = options?.initialState ?? "idle";
    this.skipInitialStateEmit = options?.skipInitialStateEmit ?? false;
    this.simpleOutputState = simpleOutputState;

    // Polling interval
    this.POLLING_INTERVAL_MS = options?.pollingIntervalMs ?? 50;
    this.requestedPollingIntervalMs = this.POLLING_INTERVAL_MS;

    this.cpuTracker = new CpuHighStateTracker(this.processStateValidator, {
      cpuHighThreshold: CPU_HIGH_THRESHOLD,
      cpuLowThreshold: CPU_LOW_THRESHOLD,
      maxCpuHighEscapeMs,
    });

    this.waitingWatchdog = new WaitingWatchdog({
      failThreshold: watchdogFailThreshold,
      maxWaitingSilenceMs: this.MAX_WAITING_SILENCE_MS,
      workingIndicatorTtlMs: WORKING_INDICATOR_TTL_MS,
      cpuTracker: this.cpuTracker,
      processStateValidator: this.processStateValidator,
      onFire: (id, spawnedAt) => {
        this.onWaitingTimeout?.(id, spawnedAt);
      },
    });

    // Apply initial tier so a monitor constructed with a background polling
    // interval (e.g. project starts hidden) gets the right thresholds before
    // any output arrives.
    this.applyTier(this.tierForInterval(this.POLLING_INTERVAL_MS));

    // Lightweight watchdog interval: runs the waiting watchdog check periodically
    // even when there's no output/activity. 5s keeps overhead negligible while
    // ensuring hung waiting states are caught within a reasonable window.
    this.watchdogInterval = setInterval(() => this.runWaitingWatchdogCheck(Date.now()), 5000);
    this.watchdogInterval.unref();
  }

  private tierForInterval(intervalMs: number): "active" | "background" {
    return intervalMs <= 50 ? "active" : "background";
  }

  private applyTier(tier: "active" | "background"): void {
    if (this._tier === tier) return;
    this._tier = tier;
    const delay =
      tier === "background"
        ? this.backgroundWorkingRecoveryDelayMs
        : this.activeWorkingRecoveryDelayMs;
    this.workingSignalDebouncer.setDelay(delay);
    this.cosmeticRecoveryDebouncer.setDelay(delay);
    this.structuralRecoveryDebouncer.setDelay(delay);
  }

  /**
   * Fires the configured `onBootComplete` callback at most once per boot
   * cycle. Reset by `startPolling()` when boot detection re-enters from
   * `hasExitedBootState=false`. Both `BootDetector.check()` call sites (data
   * path and polling cycle) must funnel through this guard.
   */
  private fireBootComplete(timestamp: number): void {
    if (this.bootCompleteCallbackFired) return;
    this.bootCompleteCallbackFired = true;
    if (!this.onBootComplete) return;
    try {
      this.onBootComplete(timestamp);
    } catch {
      // Callback failure must not destabilize the activity monitor.
    }
  }

  /**
   * @param lowerInput Pre-lowercased, ANSI-stripped text. Callers must lowercase
   *   before calling — this avoids re-allocating a lowercased copy of the rolling
   *   buffer on the per-chunk hot path. Both call sites already pass lowercased text.
   */
  private isEscInterruptFallback(lowerInput: string): boolean {
    return lowerInput.includes("esc to interrupt") || lowerInput.includes("esc to cancel");
  }

  // Raw-stream compiled-pattern tier, shared by the simple and non-simple
  // `onData` paths (#9873): feeds the rolling pattern buffer, checks
  // boot-complete patterns across chunk boundaries, and promotes/refreshes
  // busy on working-pattern matches.
  private detectPatternsFromData(data: string, now: number): void {
    this.patternBuf.update(data);

    const elapsed = now - this.lastPatternScanAt;
    if (elapsed < PATTERN_SCAN_THROTTLE_MS) {
      if (!this.patternScanTimer) {
        this.patternScanTimer = setTimeout(() => {
          this.patternScanTimer = null;
          if (this.isDisposed) return;
          this.scanPatternBuffer(Date.now());
        }, PATTERN_SCAN_THROTTLE_MS - elapsed);
      }
      return;
    }
    this.scanPatternBuffer(now);
  }

  private scanPatternBuffer(now: number): void {
    this.lastPatternScanAt = now;
    const bufferText = stripAnsi(this.patternBuf.getText());

    // Check for boot-complete patterns in the rolling buffer
    if (!this.bootDetector.hasExitedBootState) {
      if (this.bootDetector.check(bufferText, false, 0, Infinity)) {
        // Boot detected via pattern in rolling buffer
        this.fireBootComplete(now);
      }
    }

    // Check for working patterns in the rolling buffer
    const patternResult = this.patternDetector
      ? this.patternDetector.detect(bufferText, { alreadyStripped: true })
      : undefined;
    if (patternResult) {
      this.lastPatternResult = patternResult;
      this.lastPatternResultAt = now;
    }
    const isWorking = patternResult
      ? patternResult.isWorking
      : this.isEscInterruptFallback(bufferText.toLowerCase());

    if (
      isWorking &&
      !this.isResizeSuppressed(now) &&
      !this.isFocusSuppressed(now) &&
      (this.state === "busy" ||
        this.inputTracker.pendingInputUntil > 0 ||
        !this.inputTracker.isRecentUserInput(now))
    ) {
      if (this.state === "busy" || this.inputTracker.pendingInputUntil > 0) {
        this.becomeBusy({
          trigger: "pattern",
          patternConfidence: patternResult?.confidence ?? 0.9,
        });
      } else {
        if (this.workingSignalDebouncer.shouldTriggerRecovery(now, true)) {
          this.becomeBusy({
            trigger: "pattern",
            patternConfidence: patternResult?.confidence ?? 0.9,
          });
        }
      }
    }
  }

  onInput(data: string): void {
    if (this.isDisposed) return;
    const now = Date.now();
    const result = this.inputTracker.process(data, now);

    if (result.kind === "ignored" || result.kind === "no-enter") {
      return;
    }

    // result.kind === "enter"
    if (!this.getVisibleLines) {
      this.becomeBusy({ trigger: "input" });
      return;
    }

    if (result.hadText) {
      this.becomeBusy({ trigger: "input" }, now);
      return;
    }

    // Empty input: use confirmation window
    this.inputTracker.pendingInputWasNonEmpty = false;
    this.inputTracker.pendingInputUntil = now + this.inputTracker.INPUT_CONFIRM_MS;
  }

  onData(data?: string): void {
    if (this.isDisposed) return;
    const now = Date.now();

    if (this.simpleOutputState) {
      if (!data) {
        return;
      }
      this.lastDataTimestamp = now;
      // Wake-on-data: any output means the agent is live again — restore the
      // full polling cadence before the settle timer fires or while backed off.
      this.cancelFsmIdleBackoff(true);
      // Boot detection runs in the simple-output path too so onBootComplete
      // (#7616) fires for real agent terminals — `simpleOutputState` is true
      // for every agent monitor built via `buildActivityMonitorOptions`.
      if (!this.bootDetector.hasExitedBootState) {
        if (this.bootDetector.check(stripAnsi(data), false, 0, Infinity)) {
          this.fireBootComplete(now);
        }
      }
      // Semantic status-line rewrites (spinner, retry countdown, elapsed-time
      // counter) are strong liveness evidence even at 1Hz cadence (#9874).
      const isIndicatorRewrite = isStatusLineRewrite(data);
      if (isIndicatorRewrite) {
        this.lastStatusRewriteAt = now;
      }
      // Compiled-pattern tier (#9873): feed the rolling buffer and act on
      // working patterns with the same echo/cosmetic guards the non-simple
      // path uses. Completion and waiting-reason detection run in the
      // polling cycle's idle paths.
      if (!this.inputTracker.isLikelyUserEcho(data, now) && !isIndicatorRewrite) {
        this.detectPatternsFromData(data, now);
      }
      if (!this.getVisibleLines) {
        this.noteSimpleOutputSnapshot(
          createVisibleContentSnapshot(stripAnsi(data)),
          now,
          isIndicatorRewrite ? "indicator" : "content"
        );
      }
      // Byte-volume liveness floor (#10664). The visible-content temperature
      // model reports changedChars: 0 for appended/scrolled output, so a long
      // stream of investigation text never recovers waiting→working and, once
      // recovered, the simpleOutputState idle gate (which keys off
      // `lastActivityTimestamp`, only moved by visible-snapshot changes) would
      // bounce it straight back to waiting. Count the stripped bytes into a
      // dedicated leaky bucket; when it fires under the same suppression guards
      // the non-simple first-output-byte path uses (#6388 strip-then-count,
      // #8867 focus gate), treat that as activity: refresh the activity clock
      // so heavy streaming keeps the agent working, and recover idle→busy.
      if (this.simpleOutputVolumeDetector) {
        const filteredLength = Buffer.byteLength(stripIdleTerminalSequences(data), "utf8");
        if (
          filteredLength > 0 &&
          this.simpleOutputVolumeDetector.update(filteredLength, now) &&
          !this.isResizeSuppressed(now) &&
          !this.isFocusSuppressed(now) &&
          !this.inputTracker.isRecentUserInput(now) &&
          this.bootDetector.hasExitedBootState
        ) {
          this.lastSimpleOutputVolumeAt = now;
          if (this.state === "idle") {
            this.becomeBusy({ trigger: "output" }, now);
          }
        }
      }
      // Re-arm the idle-backoff settle timer on every idle byte so it debounces
      // on the *last* output: a still-idle agent that emits an occasional
      // cosmetic byte then falls silent still backs off (#10906). armFsmIdle-
      // Backoff no-ops when the byte promoted the agent to busy (state !== idle).
      this.armFsmIdleBackoff();
      return;
    }

    const isLikelyUserEcho = data ? this.inputTracker.isLikelyUserEcho(data, now) : false;
    const isCosmeticRedraw = data ? isStatusLineRewrite(data) : false;

    this.lastDataTimestamp = now;

    if (data && !isLikelyUserEcho && isCosmeticRedraw) {
      // Spinner/status-line rewrite — latch lastSpinnerDetectedAt for polling's isSpinnerActive()
      // check, but do not call becomeBusy() here. Entry into working state requires pattern
      // detection or sustained output, not cosmetic line rewrites alone.
      this.lineRewriteDetector.update(data, now);
    }

    // For polling-enabled terminals: check raw stream for patterns FIRST
    if (data && this.getVisibleLines && !isLikelyUserEcho && !isCosmeticRedraw) {
      this.detectPatternsFromData(data, now);
    }

    if (!data || isLikelyUserEcho) {
      return;
    }

    // Filter idle-only protocol sequences (DECSET toggles, OSC metadata, CPR
    // responses, DSR queries, bracketed-paste markers) before byte-volume gates
    // see them — these carry no work-progress information and would otherwise
    // spuriously escalate idle→busy at low minBytes thresholds. Computed up
    // front because the debounce-reset path also gates on it: pure protocol
    // noise must not keep a busy monitor alive forever.
    const filteredLength = Buffer.byteLength(stripIdleTerminalSequences(data), "utf8");
    const hasOutputActivity = isCosmeticRedraw || filteredLength > 0;

    if (hasOutputActivity) {
      this.lastActivityTimestamp = now;
    }

    // Agent terminals should recover from waiting on the first visible PTY
    // output byte. Pattern, volume, and structural detectors can still refine
    // prompts/completion, but they must not make `waiting` sticky while output
    // is arriving.
    if (
      this.getVisibleLines &&
      this.state === "idle" &&
      hasOutputActivity &&
      !this.isResizeSuppressed(now) &&
      !this.isFocusSuppressed(now) &&
      !this.inputTracker.isRecentUserInput(now) &&
      this.bootDetector.hasExitedBootState
    ) {
      this.becomeBusy({ trigger: "output" }, now);
      return;
    }

    // Spinner frames and other cosmetic redraws ARE evidence the agent is alive —
    // long-running model thinking can emit only spinner ticks for tens of seconds.
    // Reset the debounce timer before short-circuiting on cosmetic redraws so
    // already-busy agents don't flip to idle mid-thought (issue #6365). Pure
    // idle-protocol noise (filteredLength === 0 and not a spinner frame) is
    // NOT liveness evidence and is excluded from this guard.
    if (this.state === "busy" && (isCosmeticRedraw || filteredLength > 0)) {
      this.resetDebounceTimer();
    }

    if (isCosmeticRedraw) {
      if (this.getVisibleLines && !this.isResizeSuppressed(now)) {
        this.lastActivityTimestamp = now;
      }

      // Recovery path for idle (waiting) agent terminals (#6641): if a sustained
      // spinner reappears after the agent went quiet, transition back to busy
      // through a dedicated debouncer. Gated on getVisibleLines so this only
      // applies to agent terminals, and on isResizeSuppressed so window-resize
      // redraws don't false-positive recovery.
      if (
        this.getVisibleLines &&
        this.state === "idle" &&
        !this.isResizeSuppressed(now) &&
        !this.isFocusSuppressed(now) &&
        !this.inputTracker.isRecentUserInput(now) &&
        this.bootDetector.hasExitedBootState
      ) {
        if (this.cosmeticRecoveryDebouncer.shouldTriggerRecovery(now, true)) {
          this.cosmeticRecoveryDebouncer.reset();
          this.becomeBusy({ trigger: "output" }, now);
        }
      }
      return;
    }

    // Update pattern buffer and check for working patterns (non-polling terminals only)
    if (!this.getVisibleLines && this.patternDetector) {
      this.patternBuf.update(data);
      const patternResult = this.patternDetector.detect(this.patternBuf.getText());
      this.lastPatternResult = patternResult;
      this.lastPatternResultAt = now;

      if (patternResult.isWorking) {
        this.lastWorkingIndicatorTimestamp = now;
      }

      if (
        patternResult.isWorking &&
        !this.isResizeSuppressed(now) &&
        !this.isFocusSuppressed(now)
      ) {
        this.becomeBusyFromPattern(patternResult.confidence, now);
      }
    }

    if (this.isResizeSuppressed(now) || this.isFocusSuppressed(now)) {
      return;
    }

    if (filteredLength === 0) {
      return;
    }

    // Track high output activity
    this.highOutputDetector.update(filteredLength, now);

    // High output recovery
    if (this.state === "idle" && this.highOutputDetector.shouldTriggerRecovery(now)) {
      this.becomeBusy({ trigger: "output" }, now);
      return;
    }

    // Volume-based output detection
    if (!this.outputVolumeDetector.enabled) {
      return;
    }

    if (this.outputVolumeDetector.update(filteredLength, now)) {
      this.becomeBusyFromOutput(now);
    }
  }

  // Structural-signal tier entry point (#6668). Called by
  // SynchronizedFrameDetector once per DEC mode 2026 frame-close. Runs three
  // classifiers (cosmetic-only, time-counter, spinner) over the snapshot and
  // applies the result:
  //
  //   * cosmetic-only → low-confidence visible-output signal
  //   * spinner / time-counter → higher-confidence visible-output signal
  //
  // Frames are dropped when resize-suppressed, before boot-complete, or when
  // there's no visible-lines accessor (non-agent terminals).
  onSynchronizedFrame(snapshot: FrameSnapshot): void {
    if (this.isDisposed) return;
    if (!this.getVisibleLines) return;

    const now = Date.now();
    if (this.simpleOutputState) {
      // Simple output mode uses the full visible-line fingerprint from the
      // polling cycle. Mixing per-frame bottom-row hashes with full-screen
      // hashes makes unchanged frames look like changes.
      return;
    }
    if (this.isResizeSuppressed(now)) return;
    if (this.isFocusSuppressed(now)) return;
    // Pre-boot frames are part of the agent's startup chrome — let the boot
    // detector handle them via the regular onData path.
    if (!this.bootDetector.hasExitedBootState) return;

    const result = this.synchronizedFrameAnalyzer.classify(snapshot);
    this.applyStructuralSignal(result.signal, result.confidence, now);
  }

  private applyStructuralSignal(signal: StructuralSignal, confidence: number, now: number): void {
    if (signal === "cosmetic-only") {
      // A cosmetic-only 2026 frame is still visible output. The regression we
      // are fixing here was caused by treating this signal as a veto, which let
      // agents visibly redraw forever while remaining in `waiting`.
      this.noteStructuralWorkingSignal(now, Math.max(confidence, 0.7));
      return;
    }

    if (signal === "spinner" || signal === "time-counter") {
      this.noteStructuralWorkingSignal(now, confidence);
    }
  }

  private noteStructuralWorkingSignal(now: number, confidence: number): void {
    this.lastActivityTimestamp = now;
    if (this.isFocusSuppressed(now)) {
      // Focus-triggered repaint is not a structural working signal (#8865).
      // Reset the debouncer so a single post-focus blip can't accumulate.
      this.structuralRecoveryDebouncer.reset();
      return;
    }
    if (this.inputTracker.isRecentUserInput(now)) {
      // The user just typed; require sustained signal across user input
      // before recovering (matches the regex tier's behavior).
      this.structuralRecoveryDebouncer.shouldTriggerRecovery(now, false);
      return;
    }

    // For an already-busy monitor, structural confirmation is a heartbeat:
    // refresh workingHoldUntil so the idle debounce timer doesn't fire mid-
    // thought (#6365 lesson).
    if (this.state === "busy") {
      this.recordWorkingSignal(now);
      this.resetDebounceTimer();
      return;
    }

    // Idle → busy recovery: a single blip is not enough; signal must persist
    // across the structural-tier debounce window.
    if (this.structuralRecoveryDebouncer.shouldTriggerRecovery(now, true)) {
      this.structuralRecoveryDebouncer.reset();
      this.becomeBusy({ trigger: "pattern", patternConfidence: confidence }, now);
    }
  }

  private captureSimpleOutputSnapshot(): VisibleContentSnapshot | undefined {
    // Reuse the previous snapshot once the terminal has been quiet past the
    // settle window — extracting and hashing the full viewport 20x/sec for an
    // idle terminal is pure waste. New data moves `lastDataTimestamp`; resize,
    // focus, agent swap, and external promotion invalidate explicitly.
    const quietSince = Math.max(this.lastDataTimestamp, this.simpleSnapshotSettleFrom);
    const settled = Date.now() - quietSince >= SIMPLE_SNAPSHOT_SETTLE_MS;
    if (
      settled &&
      this.simpleSnapshotCache !== undefined &&
      this.simpleSnapshotCacheKey === quietSince
    ) {
      return this.simpleSnapshotCache;
    }

    const snapshot = this.computeSimpleOutputSnapshot();
    if (settled && snapshot !== undefined) {
      this.simpleSnapshotCache = snapshot;
      this.simpleSnapshotCacheKey = quietSince;
    } else {
      this.simpleSnapshotCache = undefined;
    }
    return snapshot;
  }

  private computeSimpleOutputSnapshot(): VisibleContentSnapshot | undefined {
    const cellSnapshot = this.getVisibleContentSnapshot?.(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);
    if (cellSnapshot !== undefined) {
      return cellSnapshot;
    }

    if (!this.getVisibleLines) {
      return undefined;
    }
    return createVisibleContentSnapshot(this.getVisibleLines(AGENT_OUTPUT_ACTIVITY_LINE_COUNT));
  }

  // The viewport can keep mutating after these signals without new PTY data
  // (async reflow/redraw), so restart the settle clock rather than just
  // dropping the cached frame.
  private invalidateSimpleSnapshotCache(): void {
    this.simpleSnapshotCache = undefined;
    this.simpleSnapshotSettleFrom = Date.now();
  }

  private noteSimpleOutputSnapshot(
    snapshot: VisibleContentSnapshot,
    now: number,
    signalKind?: AgentActivitySignalKind
  ): void {
    this.applySimpleOutputTemperature(
      this.simpleOutputTemperature.observeSnapshot(now, snapshot, { signalKind }),
      now
    );
  }

  private applySimpleOutputTemperature(result: AgentActivityObservationResult, now: number): void {
    if (result.suppressed || result.seeded) {
      return;
    }

    if (result.changed) {
      this.lastActivityTimestamp = now;
      this.lastDataTimestamp = now;
    }

    if (this.state === "busy" && result.changed) {
      this.resetDebounceTimer();
      return;
    }

    // Focus-triggered TUI redraw during a suppression window is not new work
    // (#8865), and a redraw driven by recent user input — e.g. mouse-report
    // bytes emitted while scrolling a mouse-reporting TUI — is likewise not the
    // agent working (#10925). Both stamp state that other promotion paths in
    // this file already consult; skip idle→busy promotion until the windows
    // expire. lastActivity is still refreshed above so the idle timer doesn't
    // drift.
    if (
      this.state !== "busy" &&
      result.stateHint === "busy" &&
      !this.isFocusSuppressed(now) &&
      !this.inputTracker.isRecentUserInput(now)
    ) {
      this.becomeBusy({ trigger: "output" }, now);
      return;
    }

    if (
      this.state === "busy" &&
      result.stateHint === "idle" &&
      now >= this.workingHoldUntil &&
      // Heavy appended streaming leaves the visible-content diff flat, so the
      // temperature reports "idle" even while output pours in. Defer demotion
      // while the byte-volume floor has fired within the quiet window (#10664).
      !this.hasRecentSimpleOutputVolume(now)
    ) {
      this.transitionSimpleToIdle(now);
    }
  }

  isHighOutputActivity(now: number = Date.now()): boolean {
    return this.highOutputDetector.isHighOutput(now);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    // Emit final idle transition if still busy — ensures renderer never stays stuck in "working"
    if (this.state === "busy") {
      this.state = "idle";
      try {
        this.onStateChange(this.terminalId, this.spawnedAt, "idle", { trigger: "dispose" });
      } catch {
        // Callback failure must not prevent cleanup
      }
    }
    this.waitingWatchdog.reset();
    this.idleSince = 0;
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = undefined;
    }
    this.stopPolling();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.patternScanTimer) {
      clearTimeout(this.patternScanTimer);
      this.patternScanTimer = null;
    }
    this.lastPatternScanAt = 0;
    this.completionTimer.dispose();
    this.inputTracker.reset();
    this.outputVolumeDetector.reset();
    this.simpleOutputVolumeDetector?.reset();
    this.highOutputDetector.reset();
    this.workingSignalDebouncer.reset();
    this.cosmeticRecoveryDebouncer.reset();
    this.structuralRecoveryDebouncer.reset();
    this.simpleOutputTemperature.reset();
    this.simpleSnapshotCache = undefined;
    this.simpleSnapshotCacheKey = 0;
    this.simpleSnapshotSettleFrom = 0;
    this.lineRewriteDetector.reset();
    this.synchronizedFrameAnalyzer.reset();
    this.patternBuf.reset();
    this.bootDetector.reset();
    this.resizeSuppressUntil = 0;
    this.focusSuppressUntil = 0;
    this.lastPatternResult = undefined;
    this.lastPatternResultAt = 0;
    this.cpuTracker.reset();
    this.workingHoldUntil = 0;
    this.lastDataTimestamp = 0;
    this.lastSimpleOutputVolumeAt = 0;
    this.lastOutputActivityAt = 0;
    this.lastStatusRewriteAt = 0;
    this.lastWorkingIndicatorTimestamp = 0;
    this.promptStableSince = 0;
  }

  getLastPatternResult(): PatternDetectionResult | undefined {
    return this.lastPatternResult;
  }

  reconfigure(agentId?: string, patternConfig?: PatternDetectionConfig): void {
    if (this.isDisposed) return;

    this.patternDetector =
      agentId || patternConfig ? new AgentPatternDetector(agentId, patternConfig) : undefined;

    // Old buffer contents and TTL-gated pattern results belong to the previous
    // detector — leaving any of them would let stale matches hold working state
    // through the debounce callback's WORKING_INDICATOR_TTL_MS window. Timing
    // fields (lastActivityTimestamp, promptStableSince, workingHoldUntil,
    // debounceTimer) are preserved so busy/idle classification stays coherent
    // across the swap.
    this.patternBuf.reset();
    this.lastPatternResult = undefined;
    this.lastPatternResultAt = 0;
    this.lastWorkingIndicatorTimestamp = 0;
    // Structural tier holds per-cell ring-buffer history that is implicitly
    // tied to the current agent's rendering. Swapping detectors is a strong
    // signal that the agent identity changed — discard accumulated state.
    this.synchronizedFrameAnalyzer.reset();
    this.simpleOutputTemperature.reset();
    this.invalidateSimpleSnapshotCache();
  }

  notifySubmission(): void {
    if (this.isDisposed) return;
    this.becomeBusy({ trigger: "input" });
  }

  // Viewport-independent working signal (#8701). Called by `TerminalProcess`
  // when its OSC 9;4 parser observes state=1 (normal/determinate) or state=3
  // (indeterminate) — both mean the agent is actively working. Refreshes
  // `lastActivityTimestamp` and `lastDataTimestamp` so the simpleOutputState
  // polling cycle's idle gate (`now - lastActivityTimestamp >= IDLE_DEBOUNCE_MS`)
  // doesn't fire from a stale timestamp when the visible-line snapshot is too
  // small (small grid tiles starve the viewport-bound detector).
  //
  // Acts like the data-path's cosmetic-redraw branch (line 538-540 in `onData`):
  // refresh the working hold and reset the debounce timer so an already-busy
  // monitor stays busy. The existing `MAX_WORKING_SILENCE_MS` safety net is
  // untouched — this is a heartbeat, not a permanent hold (lesson #4974).
  onOscProgressWorking(now: number = Date.now()): void {
    if (this.isDisposed) return;
    this.lastActivityTimestamp = now;
    this.lastDataTimestamp = now;
    if (this.state !== "busy") {
      // Skip idle→busy on OSC progress while focus suppression is active —
      // a focus-triggered repaint that also emits OSC 9;4 must not bypass
      // the suppression window (#8865).
      if (this.isFocusSuppressed(now)) return;
      this.becomeBusy({ trigger: "output" }, now);
      return;
    }
    this.recordWorkingSignal(now);
    this.resetDebounceTimer();
  }

  // OSC 9;4 state=0 (#8701). Intentionally advisory — a no-op by design.
  // Claude Code emits state=0 between every tool call, not just on completion,
  // so it cannot be an authoritative idle trigger: forcing idle here would
  // flicker working→idle→working on every tool boundary. We deliberately do
  // not act on it (and in particular do not mutate `workingHoldUntil`, which
  // would risk clobbering holds set by other signal paths). Real idle is left
  // to the `lastActivityTimestamp`-driven gate in the simpleOutputState polling
  // cycle: once working signals (OSC state=1/3 or output) stop refreshing the
  // timestamp, the 8s IDLE_DEBOUNCE_MS gate fires via natural decay. The method
  // is kept as the documented sink for `Osc94Parser`'s onIdle callback.
  onOscProgressIdle(_now: number = Date.now()): void {
    if (this.isDisposed) return;
  }

  // Called by `TerminalProcess.noteAgentOutputActivity` immediately after it
  // promotes the agent FSM to working via its direct
  // `agentStateService.handleActivityState("busy")` path (#9875). That path
  // bypasses this monitor entirely, leaving the private `state` at "idle" —
  // and every idle path that can transition the FSM working→waiting gates on
  // `state === "busy"`, so the FSM would otherwise strand in working with the
  // watchdog (which only fires from waiting) never arming. Mirrors
  // `becomeBusy`'s bookkeeping but deliberately skips `onStateChange`: the FSM
  // transition already happened at the call site, and re-emitting "busy" here
  // would double-fire the transition.
  notifyExternalPromotion(now: number = Date.now()): void {
    if (this.isDisposed) return;
    // Defense-in-depth: the call site already gates on focus suppression, but
    // keep the guard so any future caller inherits it (#8865).
    if (this.isFocusSuppressed(now)) return;
    // Direct busy promotion bypasses becomeBusy(), so cancel idle-backoff here.
    this.cancelFsmIdleBackoff(true);
    this.lastActivityTimestamp = now;
    this.lastDataTimestamp = now;
    this.recordWorkingSignal(now);
    this.resetDebounceTimer();
    this.waitingWatchdog.reset();
    this.cosmeticRecoveryDebouncer.reset();
    this.structuralRecoveryDebouncer.reset();
    this.completionTimer.reset();
    // Discard the temperature snapshot so its quiet clock restarts from the
    // promotion (same rationale as `notifyFocus`). A stale `quietStartedAt`
    // from the pre-promotion lull would otherwise hint "idle" at the first
    // poll after the 1.5s working hold and bounce the FSM straight back.
    this.simpleOutputTemperature.reset();
    this.invalidateSimpleSnapshotCache();
    if (this.state !== "busy") {
      this.state = "busy";
      this.idleSince = now;
    }
  }

  // True while the simpleOutputState byte-volume floor (#10664) has fired
  // within the waiting-quiet window. Used to defer waiting-demotion during
  // heavy appended streaming, which leaves the visible-content diff flat. The
  // `> 0` guard keeps a never-fired clock (0) from blocking demotion at small
  // synthetic timestamps, so monitors without a volume detector are inert here.
  private hasRecentSimpleOutputVolume(now: number): boolean {
    return (
      this.lastSimpleOutputVolumeAt > 0 &&
      now - this.lastSimpleOutputVolumeAt < this.IDLE_DEBOUNCE_MS
    );
  }

  notifyResize(suppressionMs = 500): void {
    this.resizeSuppressUntil = Date.now() + suppressionMs;
    this.highOutputDetector.resetWindow();
    this.workingSignalDebouncer.reset();
    this.cosmeticRecoveryDebouncer.reset();
    this.structuralRecoveryDebouncer.reset();
    // Structural tier keys cell ring buffers by viewport-bottom-relative
    // (rowOffset, col); a resize invalidates that mapping. Reset so the
    // first post-resize frame doesn't compare against pre-resize cells.
    this.synchronizedFrameAnalyzer.reset();
    this.simpleOutputTemperature.noteResize(Date.now(), suppressionMs);
    this.invalidateSimpleSnapshotCache();
  }

  private isResizeSuppressed(now: number): boolean {
    return this.resizeSuppressUntil > 0 && now < this.resizeSuppressUntil;
  }

  // Called by `TerminalProcess.write`/`tryWrite` when the renderer forwards a
  // focus-in or focus-out report to the PTY. Opens a 2s window during which
  // output cannot promote idle→busy: agent TUIs respond to focus changes by
  // repainting their prompt, and that repaint frequently arrives after the
  // 1s INPUT_ECHO_WINDOW_MS expires. Window is bounded — same lesson as
  // PR #4974: never let a suppression mechanism stick indefinitely.
  notifyFocus(suppressionMs = 2000): void {
    this.focusSuppressUntil = Date.now() + suppressionMs;
    this.workingSignalDebouncer.reset();
    this.cosmeticRecoveryDebouncer.reset();
    this.structuralRecoveryDebouncer.reset();
    // Discard accumulated temperature snapshot so the post-focus redraw gets a
    // fresh baseline. Unlike resize, focus does not invalidate cell ring-buffer
    // history or the high-output window — those stay intact.
    this.simpleOutputTemperature.reset();
    this.invalidateSimpleSnapshotCache();
  }

  isFocusSuppressed(now: number = Date.now()): boolean {
    return this.focusSuppressUntil > 0 && now < this.focusSuppressUntil;
  }

  // Public mirror of the private inputTracker check so the parallel
  // agentOutputTemperature promotion paths (TerminalProcess/AnalysisSession)
  // can gate on recent user input the same way this monitor's own paths do
  // (#10925). Mouse-report bytes from scrolling a TUI stamp lastUserInputAt.
  isRecentUserInput(now: number = Date.now()): boolean {
    return this.inputTracker.isRecentUserInput(now);
  }

  getState(): "busy" | "idle" {
    return this.state;
  }

  startPolling(): void {
    if (this.isDisposed) return;
    if (!this.getVisibleLines || this.pollingInterval) return;

    this.bootDetector.pollingStartTime = Date.now();
    // Session restore / agent relaunch may have rewritten the viewport
    // without data flowing through onData.
    this.invalidateSimpleSnapshotCache();

    if (this.skipInitialStateEmit) {
      this.bootDetector.hasExitedBootState = this.state === "idle";
      if (this.state === "busy") {
        this.recordWorkingSignal(this.bootDetector.pollingStartTime);
      }
    } else {
      this.bootDetector.hasExitedBootState = false;
      // Re-arm the one-shot boot-complete callback for restart paths so the
      // next observed boot completion fires telemetry again.
      this.bootCompleteCallbackFired = false;

      this.state = "busy";
      this.onStateChange(this.terminalId, this.spawnedAt, "busy", { trigger: "pattern" });
      this.recordWorkingSignal(this.bootDetector.pollingStartTime);
    }

    if (this.simpleOutputState) {
      const snapshot = this.captureSimpleOutputSnapshot();
      if (snapshot !== undefined) {
        this.simpleOutputTemperature.seedSnapshot(snapshot, this.bootDetector.pollingStartTime);
      }
      if (this.state === "busy") {
        this.resetDebounceTimer();
      }
    }

    this.pollingInterval = setInterval(() => this.runPollingCycle(), this.POLLING_INTERVAL_MS);
    this.pollingInterval.unref();

    // A restored/relaunched agent may start already idle (skipInitialStateEmit
    // with a settled screen) — arm the backoff so it doesn't poll at full rate.
    if (this.simpleOutputState && this.state === "idle") {
      this.armFsmIdleBackoff();
    }
  }

  private runPollingCycle(): void {
    if (this.isDisposed) return;
    if (!this.getVisibleLines) return;

    const now = Date.now();

    if (this.simpleOutputState) {
      // Boot detection in the simple-output polling path so the timeout
      // fallback (`timeSinceBoot >= POLLING_MAX_BOOT_MS`) still fires
      // onBootComplete (#7616) when agents emit no recognizable boot pattern.
      if (!this.bootDetector.hasExitedBootState && this.getVisibleLines) {
        const lines = this.getVisibleLines(50);
        const strippedText = stripAnsi(lines.join(" "));
        const timeSinceBoot = now - this.bootDetector.pollingStartTime;
        // A visible prompt exits boot early — parity with the non-simple boot
        // check, and what lets restart-resumed sessions (boot re-entered with
        // an already-settled screen) go idle without waiting out the boot
        // timeout (#9873). History scan unlocks after the same 3s the
        // non-simple prompt path uses.
        const promptResult = detectPrompt(
          lines,
          this.promptDetectorConfig,
          this.getCursorLine?.() ?? null,
          { allowHistoryScan: timeSinceBoot >= PROMPT_HISTORY_FALLBACK_MS }
        );
        if (
          this.bootDetector.check(
            strippedText,
            promptResult.isPrompt,
            timeSinceBoot,
            this.POLLING_MAX_BOOT_MS
          )
        ) {
          this.fireBootComplete(now);
        } else {
          return; // Still booting, stay busy — parity with the non-simple guard (#9873)
        }
      }

      const snapshot = this.captureSimpleOutputSnapshot();
      if (snapshot !== undefined) {
        // Classify the polled change as indicator-driven when status-line
        // rewrite data arrived recently — the data path can't feed the
        // temperature directly here (it gates on !getVisibleLines), so the
        // latched timestamp is the correlation signal (#9874).
        const indicatorActive =
          this.lastStatusRewriteAt > 0 && now - this.lastStatusRewriteAt <= SPINNER_ACTIVE_MS;
        this.noteSimpleOutputSnapshot(snapshot, now, indicatorActive ? "indicator" : "content");
      }

      // Completion detection runs every cycle while busy — mirrors the
      // non-simple path so simple-output agents reach `completed` (with
      // extracted cost/tokens) before any idle path fires (#9873).
      if (this.trySimpleCompletion(now)) {
        return;
      }

      if (
        this.state === "busy" &&
        !this.completionTimer.emitted &&
        now - this.lastActivityTimestamp >= this.IDLE_DEBOUNCE_MS &&
        !this.hasRecentSimpleOutputVolume(now) &&
        now >= this.workingHoldUntil
      ) {
        this.transitionSimpleToIdle(now);
      }
      return;
    }

    const scanCount = !this.bootDetector.hasExitedBootState
      ? Math.max(this.promptDetectorConfig.promptScanLineCount, 50)
      : Math.max(this.promptDetectorConfig.promptScanLineCount, 15);
    const lines = this.getVisibleLines!(scanCount);
    const cursorLine = this.getCursorLine?.() ?? null;
    const strippedText = stripAnsi(lines.join(" "));
    const quietForMs = now - this.lastActivityTimestamp;
    const isQuietForIdle = quietForMs >= this.IDLE_DEBOUNCE_MS;

    const patternResult = this.patternDetector
      ? this.patternDetector.detectFromLines(lines)
      : undefined;
    if (patternResult) {
      this.lastPatternResult = patternResult;
      this.lastPatternResultAt = now;
    }

    const isWorkingPattern = patternResult
      ? patternResult.isWorking
      : this.skipInitialStateEmit
        ? false
        : this.isEscInterruptFallback(strippedText.toLowerCase());

    const allowHistoryScan = quietForMs >= PROMPT_HISTORY_FALLBACK_MS;
    const promptResult = detectPrompt(lines, this.promptDetectorConfig, cursorLine, {
      allowHistoryScan,
    });
    const isPrompt = promptResult.isPrompt;
    if (isPrompt) {
      if (this.promptStableSince === 0) {
        this.promptStableSince = now;
      }
    } else {
      this.promptStableSince = 0;
    }

    const suppressWorkingPatternForPromptTyping =
      isPrompt &&
      this.inputTracker.pendingInputUntil === 0 &&
      this.inputTracker.isRecentUserInput(now);
    const effectiveWorkingPattern = suppressWorkingPatternForPromptTyping
      ? false
      : isWorkingPattern;

    // Check for boot completion
    if (!this.bootDetector.hasExitedBootState) {
      const timeSinceBoot = now - this.bootDetector.pollingStartTime;
      if (
        this.bootDetector.check(strippedText, isPrompt, timeSinceBoot, this.POLLING_MAX_BOOT_MS)
      ) {
        // Boot complete, continue to normal detection
        this.fireBootComplete(now);
      } else {
        return; // Still booting, stay busy
      }
    }

    this.cpuTracker.update(now);

    // Safety timeout: if no PTY output for MAX_WORKING_SILENCE_MS, force idle
    if (this.isWorkingSilenceTimeout(now)) {
      this.state = "idle";
      this.idleSince = now;
      this.patternBuf.clear();
      this.onStateChange(this.terminalId, this.spawnedAt, "idle", { trigger: "timeout" });
      return;
    }

    // Waiting watchdog runs solely on the dedicated 5s interval (set in the
    // constructor). Calling it from the polling cycle too would collapse
    // WATCHDOG_FAIL_THRESHOLD's confirmation window to one polling cadence
    // (~150ms at the 50ms default) for agent terminals, defeating the
    // consensus protection.

    const hasRecentOutputActivity =
      this.lastOutputActivityAt > 0 &&
      now - this.lastOutputActivityAt <= this.outputVolumeDetector.recencyWindowMs;
    const isSpinnerActive = this.lineRewriteDetector.isSpinnerActive(now, SPINNER_ACTIVE_MS);
    const isOutputQuiet = quietForMs >= PROMPT_QUIET_MS;
    const promptStableForMs = this.promptStableSince === 0 ? 0 : now - this.promptStableSince;

    const hasHighOutputActivity = this.highOutputDetector.isHighOutput(now);

    const shouldAllowPromptStability =
      isPrompt &&
      isOutputQuiet &&
      !isSpinnerActive &&
      !hasRecentOutputActivity &&
      !hasHighOutputActivity;
    const shouldPreferPrompt =
      shouldAllowPromptStability && promptStableForMs >= PROMPT_DEBOUNCE_MS;

    if (effectiveWorkingPattern && !shouldAllowPromptStability && !isQuietForIdle) {
      this.recordWorkingSignal(now);
    }

    const isWorkingSignal =
      isSpinnerActive ||
      hasRecentOutputActivity ||
      hasHighOutputActivity ||
      (effectiveWorkingPattern &&
        !shouldPreferPrompt &&
        !shouldAllowPromptStability &&
        !isQuietForIdle);
    if (isWorkingSignal) {
      this.promptStableSince = 0;
    }

    if (this.inputTracker.pendingInputUntil > 0) {
      if (isWorkingSignal && this.inputTracker.pendingInputWasNonEmpty) {
        this.inputTracker.pendingInputUntil = 0;
        this.inputTracker.pendingInputWasNonEmpty = false;
        const metadata = effectiveWorkingPattern
          ? { trigger: "pattern" as const, patternConfidence: patternResult?.confidence ?? 0.9 }
          : { trigger: "output" as const };
        this.becomeBusy(metadata, now);
        return;
      } else if (isPrompt && !this.inputTracker.pendingInputWasNonEmpty) {
        this.inputTracker.pendingInputUntil = 0;
        this.inputTracker.pendingInputWasNonEmpty = false;
      } else if (now >= this.inputTracker.pendingInputUntil) {
        this.inputTracker.pendingInputUntil = 0;
        this.inputTracker.pendingInputWasNonEmpty = false;
        this.becomeBusy({ trigger: "input" }, now);
        return;
      }
    }

    const resizeSuppressed = this.isResizeSuppressed(now);

    if (
      !resizeSuppressed &&
      this.state === "idle" &&
      this.highOutputDetector.shouldTriggerRecovery(now)
    ) {
      this.becomeBusy({ trigger: "output" }, now);
      return;
    }

    if (isWorkingSignal && !resizeSuppressed) {
      if (
        this.state !== "busy" &&
        this.inputTracker.pendingInputUntil === 0 &&
        this.inputTracker.isRecentUserInput(now)
      ) {
        this.workingSignalDebouncer.shouldTriggerRecovery(now, false);
        return;
      }
      if (this.state !== "busy") {
        if (
          this.bootDetector.hasExitedBootState &&
          this.workingSignalDebouncer.shouldTriggerRecovery(now, true)
        ) {
          const metadata = effectiveWorkingPattern
            ? { trigger: "pattern" as const, patternConfidence: patternResult?.confidence ?? 0.9 }
            : { trigger: "output" as const };
          this.becomeBusy(metadata, now);
        } else if (!this.bootDetector.hasExitedBootState) {
          const metadata = effectiveWorkingPattern
            ? { trigger: "pattern" as const, patternConfidence: patternResult?.confidence ?? 0.9 }
            : { trigger: "output" as const };
          this.becomeBusy(metadata, now);
        }
      }
      return;
    } else {
      this.workingSignalDebouncer.shouldTriggerRecovery(now, false);
    }

    // Completion detection
    if (
      this.state === "busy" &&
      !this.completionTimer.emitted &&
      this.completionPatterns.length > 0
    ) {
      const completionResult = detectCompletion(
        lines,
        this.completionPatterns,
        this.completionConfidence,
        this.promptDetectorConfig.promptScanLineCount
      );
      if (completionResult.isCompletion) {
        this.transitionToCompleted(
          completionResult.confidence,
          completionResult.extractedCost,
          completionResult.extractedTokens
        );
        return;
      }
    }

    // Prompt fast-path: when the prompt is stable and no working signals are active,
    // exit busy immediately rather than waiting the full IDLE_DEBOUNCE_MS. This keeps
    // the idle transition snappy after the prompt appears, even when IDLE_DEBOUNCE_MS
    // has been raised to cover LLM API call silence gaps.
    // The quiet requirement guards against premature idle during inter-tool-call
    // gaps (Claude bursts with 1-3s pauses, Codex has 3-5s gaps — Issue #3606).
    // buildActivityMonitorOptions floors promptFastPathMinQuietMs to the effective
    // idle debounce (>= 8s), so sub-floor per-agent values are not honored.
    if (
      this.state === "busy" &&
      !this.completionTimer.emitted &&
      shouldPreferPrompt &&
      quietForMs >= this.PROMPT_FAST_PATH_MIN_QUIET_MS &&
      now >= this.workingHoldUntil &&
      !this.cpuTracker.isHighAndNotDeadlined(now) &&
      !(this.inputTracker.pendingInputUntil > 0 && now < this.inputTracker.pendingInputUntil)
    ) {
      this.state = "idle";
      this.idleSince = now;
      this.patternBuf.clear();
      const waitingReason = classifyWaitingReason(lines, true);
      this.onStateChange(this.terminalId, this.spawnedAt, "idle", {
        trigger: "pattern",
        waitingReason,
      });
      return;
    }

    // Prompt lexeme fallback: when output has stalled and the last visible line
    // contains a prompt lexeme (?, [y/N], keyword+colon, "press enter"), detect
    // as a prompt with medium confidence. This catches interactive prompts that
    // don't match any configured promptPattern or promptHintPattern.
    const LEXEME_STALL_MIN_QUIET_MS = Math.max(3000, this.IDLE_DEBOUNCE_MS);
    if (
      this.state === "busy" &&
      !this.completionTimer.emitted &&
      !isPrompt &&
      !effectiveWorkingPattern &&
      !isSpinnerActive &&
      !hasRecentOutputActivity &&
      !hasHighOutputActivity &&
      quietForMs >= LEXEME_STALL_MIN_QUIET_MS &&
      now >= this.workingHoldUntil &&
      !this.cpuTracker.isHighAndNotDeadlined(now) &&
      !(this.inputTracker.pendingInputUntil > 0 && now < this.inputTracker.pendingInputUntil)
    ) {
      const candidateLine =
        cursorLine && stripAnsi(cursorLine).trim().length > 0
          ? cursorLine
          : lines.length > 0
            ? lines[lines.length - 1]
            : "";
      const lexemeResult = detectPromptLexeme(candidateLine);
      if (lexemeResult.isPrompt) {
        this.state = "idle";
        this.idleSince = now;
        this.patternBuf.clear();
        this.onStateChange(this.terminalId, this.spawnedAt, "idle", {
          trigger: "pattern",
          patternConfidence: 0.7,
        });
        return;
      }
    }

    if (
      this.state === "busy" &&
      !this.completionTimer.emitted &&
      isQuietForIdle &&
      now >= this.workingHoldUntil &&
      !hasHighOutputActivity &&
      !this.cpuTracker.isHighAndNotDeadlined(now) &&
      !(this.inputTracker.pendingInputUntil > 0 && now < this.inputTracker.pendingInputUntil)
    ) {
      this.state = "idle";
      this.idleSince = now;
      this.patternBuf.clear();
      const waitingReason = classifyWaitingReason(lines, isPrompt);
      this.onStateChange(this.terminalId, this.spawnedAt, "idle", {
        trigger: "timeout",
        waitingReason,
      });
    }
  }

  stopPolling(): void {
    // Reset idle-backoff first so POLLING_INTERVAL_MS returns to the requested
    // cadence — a later startPolling() reads it to seed the new interval.
    this.cancelFsmIdleBackoff(false);
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
    this.workingSignalDebouncer.reset();
  }

  setPollingInterval(intervalMs: number): void {
    if (this.isDisposed) return;
    // Guard on the *requested* cadence, not the applied one: while idle-backoff
    // owns the live interval they differ, and a same-request no-op must not be
    // read from the backoff value (#10906, #8998).
    if (this.requestedPollingIntervalMs === intervalMs) {
      return;
    }
    this.requestedPollingIntervalMs = intervalMs;

    // The working-signal debouncer needs to track polling cadence, otherwise
    // the 1500ms delay becomes impossible to satisfy at 500ms polling (#6641).
    // The output volume detector is sample-cadence invariant (#6666) and
    // needs no tier handling here. Tier always tracks the visibility cadence,
    // never the transient backoff interval (a 2000ms backoff must not classify
    // as "background").
    this.applyTier(this.tierForInterval(intervalMs));

    // While backed off, only record the request; the wake path
    // (onData/becomeBusy) restores this cadence when activity resumes.
    if (!this.fsmIdleBackoffActive) {
      this.applyPollingInterval(intervalMs);
    }
  }

  // Swaps the live polling interval. Keeps POLLING_INTERVAL_MS (the applied
  // cadence) in sync even when no interval is currently running so a later
  // startPolling() picks up the right value.
  private applyPollingInterval(intervalMs: number): void {
    this.POLLING_INTERVAL_MS = intervalMs;
    if (this.pollingInterval !== undefined) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = setInterval(() => this.runPollingCycle(), intervalMs);
      this.pollingInterval.unref();
    }
  }

  // Arms the idle-backoff settle timer for a settled simple-output agent. After
  // FSM_IDLE_BACKOFF_SETTLE_MS of continued silence the polling cadence drops to
  // FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS. Any onData/busy transition cancels it.
  private armFsmIdleBackoff(): void {
    if (this.isDisposed) return;
    // Only agents (simpleOutputState) do the per-tick temperature work this
    // backoff exists to throttle; non-agent monitors are left untouched.
    if (!this.simpleOutputState) return;
    if (this.state !== "idle") return;
    if (this.pollingInterval === undefined) return;
    if (this.fsmIdleBackoffActive) return;
    if (this.fsmIdleBackoffTimer !== undefined) return;

    const armedAtData = this.lastDataTimestamp;
    this.fsmIdleBackoffTimer = setTimeout(() => {
      this.fsmIdleBackoffTimer = undefined;
      if (this.isDisposed) return;
      if (this.state !== "idle") return;
      if (this.pollingInterval === undefined) return;
      // Belt-and-suspenders: data during the settle window cancels the timer
      // outright via cancelFsmIdleBackoff, but re-check in case a wake path
      // moved the clock without clearing the timer.
      if (this.lastDataTimestamp !== armedAtData) return;
      this.fsmIdleBackoffActive = true;
      this.applyPollingInterval(FSM_IDLE_BACKOFF_POLLING_INTERVAL_MS);
    }, FSM_IDLE_BACKOFF_SETTLE_MS);
    this.fsmIdleBackoffTimer.unref();
  }

  // Cancels the settle timer and, if backoff was live, leaves it. When
  // restorePolling is true the live interval is swapped back to the visibility
  // cadence; when false (stop/dispose) the applied-interval field is still reset
  // to the requested cadence so a later startPolling() never restarts at the
  // stale backoff value.
  private cancelFsmIdleBackoff(restorePolling: boolean): void {
    if (this.fsmIdleBackoffTimer !== undefined) {
      clearTimeout(this.fsmIdleBackoffTimer);
      this.fsmIdleBackoffTimer = undefined;
    }
    if (!this.fsmIdleBackoffActive) return;
    this.fsmIdleBackoffActive = false;
    if (restorePolling && !this.isDisposed) {
      this.applyPollingInterval(this.requestedPollingIntervalMs);
    } else {
      this.POLLING_INTERVAL_MS = this.requestedPollingIntervalMs;
    }
  }

  private recordWorkingSignal(now: number): void {
    this.workingHoldUntil = Math.max(this.workingHoldUntil, now + WORKING_HOLD_MS);
  }

  private transitionToCompleted(
    confidence: number,
    sessionCost?: number,
    sessionTokens?: number
  ): void {
    this.completionTimer.emit(() => {
      if (this.isDisposed) return;
      // Guard: ignore stale timer if a new busy cycle started or completion was reset
      if (!this.completionTimer.emitted || this.state !== "busy") {
        return;
      }
      this.completionTimer.emitted = false;
      this.state = "idle";
      this.idleSince = Date.now();
      this.patternBuf.clear();
      this.onStateChange(this.terminalId, this.spawnedAt, "idle", {
        trigger: "pattern",
        patternConfidence: 0.85,
      });
      this.armFsmIdleBackoff();
    }, COMPLETION_HOLD_MS);

    this.onStateChange(this.terminalId, this.spawnedAt, "completed", {
      trigger: "pattern",
      patternConfidence: confidence,
      sessionCost,
      sessionTokens,
    });
  }

  // Completion-pattern scan for simple-output monitors (#9873). Returns true
  // when a completion was detected and the completed transition was emitted.
  // Gated on output quiet so a cost line scrolling past mid-stream doesn't
  // end the session early.
  private trySimpleCompletion(now: number): boolean {
    if (
      this.state !== "busy" ||
      this.completionTimer.emitted ||
      this.completionPatterns.length === 0 ||
      !this.getVisibleLines ||
      // Quiet on both clocks: lastActivityTimestamp only moves on visible
      // snapshot changes, so raw PTY bytes streaming past a static viewport
      // must also block the scan via lastDataTimestamp.
      now - Math.max(this.lastActivityTimestamp, this.lastDataTimestamp) <
        SIMPLE_COMPLETION_MIN_QUIET_MS ||
      now < this.workingHoldUntil
    ) {
      return false;
    }
    const completionResult = detectCompletion(
      this.getVisibleLines(this.promptDetectorConfig.promptScanLineCount),
      this.completionPatterns,
      this.completionConfidence,
      this.promptDetectorConfig.promptScanLineCount
    );
    if (!completionResult.isCompletion) {
      return false;
    }
    this.transitionToCompleted(
      completionResult.confidence,
      completionResult.extractedCost,
      completionResult.extractedTokens
    );
    return true;
  }

  // Simple-output busy→idle transition shared by the polling idle gate, the
  // activity-temperature idle hint, and the debounce-timer backstop (#9873).
  // Runs completion detection first so agents with completionPatterns reach
  // `completed` (with extracted cost/tokens) instead of plain idle, and
  // attaches a waiting reason to the idle emission. While a completion hold
  // is pending, the idle emission is left to the completion timer.
  private transitionSimpleToIdle(now: number): void {
    if (this.completionTimer.emitted) return;
    if (this.trySimpleCompletion(now)) return;
    this.state = "idle";
    this.idleSince = now;
    this.patternBuf.clear();
    let waitingReason: WaitingReason | undefined;
    if (this.getVisibleLines) {
      const lines = this.getVisibleLines(this.promptDetectorConfig.promptScanLineCount);
      const promptResult = detectPrompt(
        lines,
        this.promptDetectorConfig,
        this.getCursorLine?.() ?? null,
        { allowHistoryScan: true }
      );
      waitingReason = classifyWaitingReason(lines, promptResult.isPrompt);
    }
    this.onStateChange(this.terminalId, this.spawnedAt, "idle", {
      trigger: "timeout",
      waitingReason,
    });
    this.armFsmIdleBackoff();
  }

  private becomeBusyFromPattern(confidence: number, now: number): void {
    this.becomeBusy({ trigger: "pattern", patternConfidence: confidence }, now);
  }

  private becomeBusy(metadata: ActivityStateMetadata, now: number = Date.now()): void {
    if (this.isDisposed) return;
    this.cancelFsmIdleBackoff(true);
    this.inputTracker.clearPendingInput();
    if (metadata.trigger === "input") {
      this.lastActivityTimestamp = now;
    }
    this.lastDataTimestamp = now;
    this.recordWorkingSignal(now);
    this.resetDebounceTimer();
    this.waitingWatchdog.reset();
    // Clear any in-flight cosmetic-redraw accumulator so the next idle cycle
    // starts fresh — otherwise a single spinner tick after busy→idle would
    // immediately re-trigger recovery without sustained signal.
    this.cosmeticRecoveryDebouncer.reset();
    this.structuralRecoveryDebouncer.reset();

    // Reset completion state for the new work cycle
    this.completionTimer.reset();

    if (this.state !== "busy") {
      this.state = "busy";
      this.idleSince = now;
      this.onStateChange(this.terminalId, this.spawnedAt, "busy", metadata);
    }
  }

  private becomeBusyFromOutput(now: number): void {
    if (
      this.state !== "busy" &&
      this.inputTracker.pendingInputUntil === 0 &&
      this.inputTracker.isRecentUserInput(now)
    ) {
      return;
    }

    this.lastOutputActivityAt = now;
    this.becomeBusy({ trigger: "output" }, now);
  }

  private resetDebounceTimer(): void {
    if (this.isDisposed) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    if (this.simpleOutputState) {
      this.debounceTimer = setTimeout(() => {
        if (this.isDisposed) {
          this.debounceTimer = null;
          return;
        }

        // During the polling boot window, idle is owned by the polling
        // cycle's boot guard — stay busy and re-arm (#9873). Monitors
        // without polling have no boot lifecycle and skip this.
        if (this.pollingInterval && !this.bootDetector.hasExitedBootState) {
          this.debounceTimer = null;
          this.resetDebounceTimer();
          return;
        }

        const now = Date.now();
        if (
          this.state === "busy" &&
          now - this.lastActivityTimestamp >= this.IDLE_DEBOUNCE_MS &&
          !this.hasRecentSimpleOutputVolume(now) &&
          now >= this.workingHoldUntil
        ) {
          this.transitionSimpleToIdle(now);
        }
        this.debounceTimer = null;
      }, this.IDLE_DEBOUNCE_MS);
      return;
    }

    this.debounceTimer = setTimeout(() => {
      if (this.isDisposed) {
        this.debounceTimer = null;
        return;
      }

      if (this.getVisibleLines) {
        this.debounceTimer = null;
        return;
      }

      // Safety timeout: if no PTY output for MAX_WORKING_SILENCE_MS, force idle
      if (this.isWorkingSilenceTimeout(Date.now())) {
        this.state = "idle";
        this.idleSince = Date.now();
        this.patternBuf.clear();
        this.onStateChange(this.terminalId, this.spawnedAt, "idle", { trigger: "timeout" });
        this.debounceTimer = null;
        return;
      }

      const now = Date.now();

      // Stale pattern results are expired via the same TTL as working indicators
      if (
        this.lastPatternResult?.isWorking &&
        now - this.lastPatternResultAt < WORKING_INDICATOR_TTL_MS
      ) {
        this.resetDebounceTimer();
        return;
      }

      if (
        this.lastWorkingIndicatorTimestamp > 0 &&
        Date.now() - this.lastWorkingIndicatorTimestamp < WORKING_INDICATOR_TTL_MS
      ) {
        this.resetDebounceTimer();
        return;
      }

      if (this.isHighOutputActivity()) {
        this.resetDebounceTimer();
        return;
      }

      if (this.cpuTracker.isHighAndNotDeadlined(now)) {
        this.resetDebounceTimer();
        return;
      }

      this.state = "idle";
      this.idleSince = Date.now();
      this.patternBuf.clear();
      this.onStateChange(this.terminalId, this.spawnedAt, "idle");
      this.debounceTimer = null;
    }, this.IDLE_DEBOUNCE_MS);
  }

  private isWorkingSilenceTimeout(now: number): boolean {
    if (this.state !== "busy") return false;
    if (now - this.lastDataTimestamp < this.MAX_WORKING_SILENCE_MS) return false;
    // Non-polling terminals have no boot phase; polling terminals must exit boot first
    if (this.getVisibleLines && !this.bootDetector.hasExitedBootState) return false;
    // High CPU prevents premature silence timeout, but only up to the escape deadline.
    if (this.cpuTracker.isHighAndNotDeadlined(now)) return false;
    return true;
  }

  private runWaitingWatchdogCheck(now: number): void {
    if (!this.onWaitingTimeout) return;
    this.waitingWatchdog.check(now, {
      state: this.state,
      idleSince: this.idleSince,
      isSpinnerActive: this.lineRewriteDetector.isSpinnerActive(now, SPINNER_ACTIVE_MS),
      lastPatternResult: this.lastPatternResult,
      lastPatternResultAt: this.lastPatternResultAt,
      lastDataTimestamp: this.lastDataTimestamp,
      terminalId: this.terminalId,
      spawnedAt: this.spawnedAt,
    });
  }
}

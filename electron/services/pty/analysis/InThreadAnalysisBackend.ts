import type { Terminal as HeadlessTerminalType, IMarker } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import serialize, { type SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
const { SerializeAddon } = serialize;
import unicode11 from "@xterm/addon-unicode11";
const { Unicode11Addon } = unicode11;
import { applyXtermReflowFastpath } from "../../../../shared/utils/xtermReflowFastpath.js";
import { PartialEscapeTracker } from "../../../../shared/utils/terminalPartialEscapeTail.js";
import { ActivityMonitor, type ActivityStateMetadata } from "../../ActivityMonitor.js";
import type { ProcessTreeCache } from "../../ProcessTreeCache.js";
import type { PatternDetectionConfig } from "../AgentPatternDetector.js";
import type { TerminalInfo } from "../types.js";
import { installHeadlessResponder } from "../headlessResponder.js";
import { headlessMirrorScheduler } from "../HeadlessMirrorScheduler.js";
import { Osc94Parser } from "../Osc94Parser.js";
import { SynchronizedFrameDetector } from "../SynchronizedFrameDetector.js";
import {
  mirrorNeedsResize,
  mirrorReplayInFlight,
  resizeMirror,
  restoreSessionFromFile,
} from "../terminalSessionPersistence.js";
import {
  createProcessStateValidator,
  buildActivityMonitorOptions,
} from "../terminalActivityPatterns.js";
import {
  serializeTerminal,
  serializeTerminalAsync,
  serializeTerminalTail,
  serializeForPersistence,
} from "../terminalSerialization.js";
import { OUTPUT_PROGRESS_SAMPLE_MS } from "../OutputProgressTracker.js";
import {
  measureVisibleContentDelta,
  type VisibleContentSnapshot,
} from "../SustainedChangeTracker.js";
import {
  AGENT_OUTPUT_ACTIVITY_LINE_COUNT,
  AgentActivityTemperature,
} from "../AgentActivityTemperature.js";
import {
  readCursorLine,
  readLastNLines,
  readViewportNonEmptyLines,
  readVisibleActivityLines,
  ViewportSnapshotCache,
} from "./headlessViewport.js";
import type {
  AnalysisBackend,
  AnalysisFinalCapture,
  MonitorStartOptions,
} from "./AnalysisBackend.js";
import type { AnalysisChunkFlags } from "../analysisWorkerProtocol.js";
import type {
  SerializeReadOptions,
  SerializedTerminalSnapshot,
} from "../../../../shared/types/terminal.js";

// Floor between agent-output content comparisons (noteAgentOutputActivity).
// Each comparison costs two full viewport extractions from the headless mirror
// plus a char diff, and it runs exactly while an agent is waiting/idle — i.e.
// while the user may be wheel-scrolling a mouse-reporting TUI whose every
// redraw chunk lands here. The temperature model needs a sustained-activity
// signal, not per-chunk granularity, so redraw-rate extraction is pure waste.
// A trailing timer preserves the final comparison of a burst; the persistent
// `agentOutputContentSnapshot` baseline makes the skipped chunks' delta
// accumulate into it rather than being lost.
const AGENT_OUTPUT_NOTE_MIN_INTERVAL_MS = 50;

/**
 * What the in-thread stack needs from its terminal. `terminalInfo` is the
 * compatibility record: the mirror is published on it (`headlessTerminal`,
 * `serializeAddon`, `pendingHeadlessWrites`) because serialization, preserved
 * capture and the wake path read it there. Everything that leaves the stack —
 * agent-state publication, PTY replies, viewport digests — goes through an
 * explicit callback.
 */
export interface InThreadAnalysisDeps {
  terminalId: string;
  terminalInfo: TerminalInfo;
  cols: number;
  rows: number;
  scrollback: number;
  /** Replay the persisted session buffer into the fresh mirror. */
  restore: boolean;
  processTreeCache: ProcessTreeCache | null;
  isAgentLive(): boolean;
  onActivityState(
    spawnedAt: number,
    state: "busy" | "idle" | "completed",
    metadata?: ActivityStateMetadata
  ): void;
  onWaitingTimeout(spawnedAt: number): void;
  onBootComplete(timestamp: number): void;
  /** Device-attribute reply from the headless responder (plain terminals). */
  onPtyResponse(data: string): void;
  /** The mirror's non-empty viewport lines, one trailing read per burst. */
  onViewport(lines: string[]): void;
  /** Agent-output temperature crossed into busy for a settled agent. */
  onOutputPromotion(): void;
}

/**
 * The single-threaded analysis path: headless xterm mirror + addons,
 * synchronized-frame detector, ActivityMonitor, OSC 9;4 tap, viewport cache
 * and agent-output temperature, all owned here. Selected when analysis workers
 * are disabled (DAINTREE_DISABLE_ANALYSIS_WORKERS=1) or the worker pool can't
 * provide a slot; worker mode never constructs one, so no local mirror exists.
 */
export class InThreadAnalysisBackend implements AnalysisBackend {
  readonly kind = "in-thread" as const;

  // Stamped once the mirror is built and any session restore has replayed,
  // so observation starts where the mirror actually begins reading.
  private readonly createdAt: number;
  private readonly id: string;
  private readonly terminalInfo: TerminalInfo;

  private activityMonitor: ActivityMonitor | null = null;
  // Streaming OSC 9;4 parser (#8701), fed every PTY chunk upstream of
  // `activityMonitor.onData()`. Callbacks route to the current
  // `activityMonitor` if one exists — the parser stays inert before an
  // activity monitor is attached (plain terminals pre-promotion) and resumes
  // seamlessly after promotion. Because the OSC 9;4 stripping in
  // `IdleSequenceFilter` still runs downstream, byte-volume detectors remain
  // unaffected; this is a read-only tap.
  private readonly osc94Parser: Osc94Parser = new Osc94Parser({
    onWorking: (now) => this.activityMonitor?.onOscProgressWorking(now),
    onIdle: (now) => this.activityMonitor?.onOscProgressIdle(now),
  });
  private headlessResponderDisposable: { dispose: () => void } | null = null;
  private synchronizedFrameDetector: SynchronizedFrameDetector | null = null;
  private readonly agentOutputTemperature = new AgentActivityTemperature();
  private agentOutputContentSnapshot: VisibleContentSnapshot | undefined;
  // Shared by the monitor's polling cycle and noteAgentOutputActivity so the
  // full-viewport extract+hash runs once per parse, not once per consumer per
  // tick (PERF-035).
  private readonly viewportSnapshotCache = new ViewportSnapshotCache();
  // -Infinity so the first comparison is never throttled regardless of where
  // the clock starts (fake test clocks sit at 0).
  private lastAgentOutputNoteAt = Number.NEGATIVE_INFINITY;
  private agentOutputNoteTimer: NodeJS.Timeout | null = null;
  private outputProgressTimer: NodeJS.Timeout | null = null;
  private _restoreBannerStart: IMarker | null = null;
  private _restoreBannerEnd: IMarker | null = null;
  private readonly parserTail = new PartialEscapeTracker();

  constructor(private readonly deps: InThreadAnalysisDeps) {
    this.id = deps.terminalId;
    this.terminalInfo = deps.terminalInfo;

    const headlessTerminal: HeadlessTerminalType = new HeadlessTerminal({
      cols: deps.cols,
      rows: deps.rows,
      scrollback: deps.scrollback,
      allowProposedApi: true,
    });
    applyXtermReflowFastpath(headlessTerminal);
    // SynchronizedFrameAnalyzer reads cell.width from this buffer; without
    // Unicode 11 widths, emoji and CJK rows would mis-report column counts.
    headlessTerminal.loadAddon(new Unicode11Addon());
    headlessTerminal.unicode.activeVersion = "11";
    const serializeAddon: SerializeAddonType = new SerializeAddon();
    headlessTerminal.loadAddon(serializeAddon);

    // Structural-signal tier (#6668): hook the headless parser for DEC mode
    // 2026 brackets so frame snapshots can drive the analyzer. Lifetime ties
    // to the headless terminal — disposed alongside it in release().
    // The callback resolves activityMonitor lazily so frame events fire even
    // for plain terminals that are promoted to agents post-spawn.
    this.synchronizedFrameDetector = new SynchronizedFrameDetector(headlessTerminal, (snapshot) => {
      this.activityMonitor?.onSynchronizedFrame(snapshot);
    });

    this.terminalInfo.headlessTerminal = headlessTerminal;
    this.terminalInfo.serializeAddon = serializeAddon;
    this.viewportSnapshotCache.attach(headlessTerminal);
    this.restoreSessionIfPresent(headlessTerminal);
    this.createdAt = Date.now();
  }

  private restoreSessionIfPresent(headlessTerminal: HeadlessTerminalType): void {
    // Terminals launched to run an agent re-inject their command on restart
    // rather than replaying a serialized buffer — session replay would show
    // stale agent output from the previous run. The owner folds that, the
    // persistence kill switch and an explicit `restore: false` into `restore`.
    if (!this.deps.restore) return;

    const result = restoreSessionFromFile(headlessTerminal, this.id);
    if (result.restored) {
      this._restoreBannerStart = result.bannerStartMarker;
      this._restoreBannerEnd = result.bannerEndMarker;
    }
  }

  get hasRestoreBannerMarkers(): boolean {
    return !!(this._restoreBannerStart || this._restoreBannerEnd);
  }

  feedChunk(data: string, _flags: AnalysisChunkFlags): void {
    const terminal = this.terminalInfo;

    // Tap OSC 9;4 progress sequences upstream of the rest of the analysis so
    // the agent-state signal is viewport-independent (#8701). The parser is
    // a read-only side channel; `IdleSequenceFilter.stripIdleTerminalSequences`
    // still removes the sequence from the ActivityMonitor byte-volume /
    // activity-gate path, so those detectors stay clean (the renderer keeps
    // the raw bytes — see TerminalProcess.osc.test.ts). This runs per-chunk for
    // backgrounded terminals too so the heartbeat never lags (#8753, #10744).
    this.osc94Parser.feed(data, Date.now());

    if (this.activityMonitor) {
      this.activityMonitor.onData(data);
    }

    // The headless responder answers device-attribute queries (CSI 6n, 5n)
    // for plain terminals so zsh et al. don't block waiting. When an agent
    // is live the renderer's xterm.js is the sole responder (installing
    // both would double-respond and corrupt TUI parsers), so skip.
    if (!this.deps.isAgentLive() && (data.includes("\x1b[6n") || data.includes("\x1b[5n"))) {
      this.ensureHeadlessResponder();
    }

    if (terminal.headlessTerminal) {
      // Outstanding-parse counter: the wake path only trusts a serialized
      // snapshot to cover the current contentEpoch when no headless writes
      // are still queued (scheduler hold + xterm's async parser both count —
      // the callback fires only after the chunk has actually parsed).
      terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 0) + 1;
      headlessMirrorScheduler.enqueue(this.id, terminal.headlessTerminal, data, () => {
        this.parserTail.feed(data);
        terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 1) - 1;
        // Invalidate before noteAgentOutputActivity reads the viewport: xterm
        // fires per-write callbacks before the onWriteParsed event the cache
        // subscribes to, and a stale hit here would diff a pre-parse snapshot.
        this.viewportSnapshotCache.invalidate();
        this.noteAgentOutputActivity();
        this.scheduleOutputProgressSample();
      });
    } else {
      this.noteAgentOutputActivity();
    }
  }

  feedPrelude(prelude: string): void {
    const terminal = this.terminalInfo;
    if (terminal.headlessTerminal) {
      terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 0) + 1;
      headlessMirrorScheduler.enqueue(this.id, terminal.headlessTerminal, prelude, () => {
        this.parserTail.feed(prelude);
        terminal.pendingHeadlessWrites = (terminal.pendingHeadlessWrites ?? 1) - 1;
        this.scheduleOutputProgressSample();
      });
    }
  }

  resize(cols: number, rows: number): void {
    const terminal = this.terminalInfo;
    if (terminal.headlessTerminal) {
      this.applyMirrorResize(terminal.headlessTerminal, cols, rows);
      // Reflow rewraps the buffer — invalidate any wake no-change skip.
      terminal.contentEpoch++;
    }
    // Notify activity monitor so reflow bytes are suppressed. Issue #2364.
    if (this.activityMonitor) {
      this.activityMonitor.notifyResize();
    }
    this.agentOutputTemperature.noteResize(Date.now());
    this.agentOutputContentSnapshot = undefined;
    // Baseline the reflowed frame inside the quiet window — the counterpart of
    // the digest the worker's session schedules on resize.
    this.scheduleOutputProgressSample();
  }

  /**
   * Re-assert the mirror's grid WITHOUT the side effects of a real resize
   * (#11719).
   *
   * Driven from `resize()`'s "unchanged" branch, where the PTY is already at
   * the requested size but the mirror may not be. It must stay side-effect
   * free: `notifyResize()` opens a 500ms activity-suppression window and resets
   * four detectors, and geometry gets re-asserted routinely, so firing that
   * here would repeatedly blind agent detection. No PTY resize happened, so
   * there are no reflow bytes to suppress either.
   */
  resyncGeometry(cols: number, rows: number): void {
    const mirror = this.terminalInfo.headlessTerminal;
    if (!mirror || !mirrorNeedsResize(mirror, cols, rows)) return;
    console.warn(
      `[TerminalProcess] Mirror grid diverged for ${this.id}: mirror ${mirror.cols}x${mirror.rows} ` +
        `vs pty ${cols}x${rows}; re-asserting`
    );
    this.applyMirrorResize(mirror, cols, rows);
    this.terminalInfo.contentEpoch++;
  }

  /**
   * Move the in-thread mirror to `cols`x`rows`, keeping the scheduler's held
   * output on the correct side of the reflow (#11719).
   *
   * A resize that a replay window will only PARK changes no geometry now, so
   * there is no ordering boundary to put the backlog behind — and draining for
   * it would push the scheduler's aggregate in-flight ledger over its cap with
   * no `flushSync` to repay it, stalling every other mirror until the backlog
   * parsed on its own. Park it directly instead.
   */
  private applyMirrorResize(mirror: HeadlessTerminalType, cols: number, rows: number): void {
    if (mirrorReplayInFlight(mirror)) {
      resizeMirror(mirror, cols, rows);
      return;
    }
    // Slices the scheduler still holds were emitted at the OLD grid. Handing
    // them over first lets xterm's own pre-resize flushSync parse them at that
    // grid; feeding them afterwards lays old-width output out at the new width.
    headlessMirrorScheduler.drainThenResize(this.id, mirror, () => {
      // Parked, not applied, while a session replay owns the grid — the replay
      // reflows to this geometry instead of to the one it opened on (#11552).
      resizeMirror(mirror, cols, rows);
    });
  }

  notifyInput(data: string): void {
    this.activityMonitor?.onInput(data);
  }

  notifyFocus(): void {
    this.activityMonitor?.notifyFocus();
    this.agentOutputTemperature.reset();
    this.agentOutputContentSnapshot = undefined;
  }

  notifySubmission(): void {
    this.activityMonitor?.notifySubmission();
  }

  startMonitor(opts: MonitorStartOptions): void {
    if (this.activityMonitor) return;
    const processStateValidator = createProcessStateValidator(
      this.terminalInfo.ptyProcess.pid,
      this.deps.processTreeCache
    );
    this.activityMonitor = new ActivityMonitor(
      this.id,
      this.terminalInfo.spawnedAt,
      (_termId, cbSpawnedAt, state, metadata) => {
        this.deps.onActivityState(cbSpawnedAt, state, metadata);
      },
      {
        ...buildActivityMonitorOptions(opts.agentId, {
          getVisibleLines: (n) => this.getVisibleActivityLines(n),
          getLastTextLines: (n) => this.getViewportLines(n),
          getVisibleContentSnapshot: (n) => this.getVisibleActivitySnapshot(n),
          getCursorLine: () => this.getCursorLine(),
        }),
        processStateValidator,
        initialState: opts.initialState,
        skipInitialStateEmit: opts.skipInitialStateEmit,
        // Structurally the in-thread monitor can't outlive its session
        // (stopMonitor disposes it synchronously and spawnedAt is immutable per
        // terminal), but the owner applies the same spawnedAt guard the worker
        // delegate uses.
        onWaitingTimeout: (_id, cbSpawnedAt) => this.deps.onWaitingTimeout(cbSpawnedAt),
        onBootComplete: (timestamp) => this.deps.onBootComplete(timestamp),
      }
    );
    this.activityMonitor.startPolling();
  }

  stopMonitor(): void {
    if (this.activityMonitor) {
      this.activityMonitor.dispose();
      this.activityMonitor = null;
    }
    // Clear any in-flight OSC 9;4 fragment so a sequence split across the
    // teardown boundary can't trigger a callback against a stale monitor.
    this.osc94Parser.reset();
  }

  reconfigureMonitor(agentId: string, patternConfig?: PatternDetectionConfig): void {
    this.activityMonitor?.reconfigure(agentId, patternConfig);
  }

  setPollingInterval(intervalMs: number): void {
    this.activityMonitor?.setPollingInterval(intervalMs);
  }

  hasMonitor(): boolean {
    return this.activityMonitor !== null;
  }

  setScrollback(lines: number): boolean {
    if (!this.terminalInfo.headlessTerminal) return false;
    this.terminalInfo.headlessTerminal.options.scrollback = lines;
    // A scrollback shrink can trim the buffer; viewport-relative reads
    // should not trust a snapshot taken before the trim.
    this.viewportSnapshotCache.invalidate();
    return true;
  }

  getViewportLines(n: number): string[] {
    return readLastNLines(this.terminalInfo.headlessTerminal, n);
  }

  getCursorLine(): string | null {
    return readCursorLine(this.terminalInfo.headlessTerminal);
  }

  isBracketedPasteMode(): boolean {
    return this.terminalInfo.headlessTerminal?.modes.bracketedPasteMode ?? false;
  }

  getVisibleActivityLines(n: number): string[] {
    return readVisibleActivityLines(this.terminalInfo.headlessTerminal, n);
  }

  getVisibleActivitySnapshot(n: number): VisibleContentSnapshot | undefined {
    return this.viewportSnapshotCache.read(this.terminalInfo.headlessTerminal, n);
  }

  /**
   * Drain the scheduler and serialize inside the drain callback, so the screen
   * and the parser tail describe the same parsed prefix. The yielding
   * serializer is skipped on purpose: its deferred serialize would run after
   * later chunks had parsed, and the snapshot would cover bytes past the
   * offset it is stamped with.
   */
  serialize(options?: SerializeReadOptions): Promise<SerializedTerminalSnapshot | null> {
    const terminal = this.terminalInfo;
    const headless = terminal.headlessTerminal;
    if (terminal.preservedSnapshot !== undefined || !headless || !terminal.serializeAddon) {
      return serializeTerminalAsync(this.id, terminal);
    }
    const tailRows = options?.tailRows;
    return new Promise((resolve) => {
      headlessMirrorScheduler.flush(this.id, headless, () => {
        if (terminal.headlessTerminal !== headless) {
          resolve(serializeTerminal(this.id, terminal));
          return;
        }
        // A capped read carries no continuation, matching the worker's.
        if (tailRows !== undefined) {
          resolve(serializeTerminalTail(this.id, terminal, tailRows));
          return;
        }
        const snapshot = serializeTerminal(this.id, terminal);
        resolve(
          snapshot && { ...snapshot, continuation: { pendingEscapeTail: this.parserTail.tail } }
        );
      });
    });
  }

  /** Banner-stripped serialize, synchronously, for the persistence paths. */
  serializeForPersistenceSync(): SerializedTerminalSnapshot | null {
    return serializeForPersistence(
      this.terminalInfo,
      this._restoreBannerStart,
      this._restoreBannerEnd
    );
  }

  serializeForPersistence(): Promise<SerializedTerminalSnapshot | null> {
    return Promise.resolve(this.serializeForPersistenceSync());
  }

  async captureFinalSnapshot(): Promise<AnalysisFinalCapture> {
    const snapshot = await serializeTerminalAsync(this.id, this.terminalInfo);
    return { snapshot, persistence: this.serializeForPersistenceSync() };
  }

  observedSince(): number | null {
    return this.createdAt;
  }

  /** Settle a pending output-progress read against the mirror now. */
  flushOutputProgressSample(): void {
    if (!this.outputProgressTimer) return;
    clearTimeout(this.outputProgressTimer);
    this.outputProgressTimer = null;
    this.sampleOutputProgress();
  }

  /** Drop a trailing agent-output comparison still waiting on its throttle. */
  cancelAgentOutputNote(): void {
    if (this.agentOutputNoteTimer) {
      clearTimeout(this.agentOutputNoteTimer);
      this.agentOutputNoteTimer = null;
    }
  }

  release(): void {
    const terminal = this.terminalInfo;
    this.agentOutputTemperature.reset();
    this.agentOutputContentSnapshot = undefined;
    this.viewportSnapshotCache.detach();
    if (!terminal.headlessTerminal) {
      return;
    }
    // Drop any feeds still held for this mirror — queued-slice callbacks are
    // discarded (matching disposed-xterm write callbacks never firing) and the
    // scheduler's aggregate in-flight accounting is released.
    headlessMirrorScheduler.clear(this.id);
    if (this.headlessResponderDisposable) {
      try {
        this.headlessResponderDisposable.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.headlessResponderDisposable = null;
    }
    if (this.synchronizedFrameDetector) {
      try {
        this.synchronizedFrameDetector.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.synchronizedFrameDetector = null;
    }
    try {
      terminal.headlessTerminal.dispose();
    } catch {
      // Ignore disposal errors
    }
    terminal.headlessTerminal = undefined;
    terminal.serializeAddon = undefined;
  }

  private ensureHeadlessTerminal(): void {
    const terminal = this.terminalInfo;

    if (terminal.wasKilled) {
      throw new Error("Terminal was killed");
    }

    if (terminal.headlessTerminal && terminal.serializeAddon) {
      return;
    }

    throw new Error("Headless terminal unavailable (unexpected)");
  }

  private ensureHeadlessResponder(): void {
    this.ensureHeadlessTerminal();
    const terminal = this.terminalInfo;

    if (terminal.wasKilled) {
      return;
    }

    if (this.headlessResponderDisposable || !terminal.headlessTerminal) {
      return;
    }

    this.headlessResponderDisposable = installHeadlessResponder(terminal.headlessTerminal, (data) =>
      this.deps.onPtyResponse(data)
    );
  }

  private getAgentOutputContentSnapshot(): VisibleContentSnapshot | undefined {
    if (!this.terminalInfo.headlessTerminal) {
      return undefined;
    }
    return this.getVisibleActivitySnapshot(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);
  }

  private noteAgentOutputActivity(): void {
    if (!this.deps.isAgentLive()) {
      this.agentOutputTemperature.reset();
      this.agentOutputContentSnapshot = undefined;
      return;
    }

    const state = this.terminalInfo.agentState;
    if (state !== "waiting" && state !== "idle" && state !== "completed") {
      return;
    }

    // Throttle: viewport extraction + diff at most once per interval. Skipped
    // chunks aren't lost — the diff runs against the stored baseline from the
    // last accepted comparison, so it covers everything since then. (A per-chunk
    // "before" viewport walk used to seed a fresher baseline; it was dropped —
    // a second full rows×cols extraction per note, running precisely in the
    // settled-agent states where the user scrolls a full-screen TUI, bought
    // only a marginally tighter diff window.)
    const now = Date.now();
    const sinceLastNote = now - this.lastAgentOutputNoteAt;
    if (sinceLastNote < AGENT_OUTPUT_NOTE_MIN_INTERVAL_MS) {
      if (!this.agentOutputNoteTimer) {
        this.agentOutputNoteTimer = setTimeout(() => {
          this.agentOutputNoteTimer = null;
          this.noteAgentOutputActivity();
        }, AGENT_OUTPUT_NOTE_MIN_INTERVAL_MS - sinceLastNote);
      }
      return;
    }
    this.lastAgentOutputNoteAt = now;

    const afterSnapshot = this.getAgentOutputContentSnapshot();
    if (afterSnapshot === undefined) {
      return;
    }

    const delta = measureVisibleContentDelta(this.agentOutputContentSnapshot, afterSnapshot);
    const hadFallbackBaseline = this.agentOutputContentSnapshot !== undefined;
    this.agentOutputContentSnapshot = afterSnapshot;
    if (!hadFallbackBaseline) {
      this.agentOutputTemperature.observeDelta(Date.now(), { changedChars: 0 });
      return;
    }

    const result = this.agentOutputTemperature.observeDelta(Date.now(), {
      changedChars: delta.changedChars,
    });
    // ActivityMonitor suppresses its own idle→busy paths on focus repaints
    // (#8865) and on recent user input (#10925), but this direct promotion is
    // a parallel path into agentStateService; gate it on both windows so
    // neither a focus-triggered TUI repaint nor a mouse-report-driven redraw
    // from scrolling a mouse-reporting TUI can flip a settled agent to busy.
    if (this.activityMonitor?.isFocusSuppressed() || this.activityMonitor?.isRecentUserInput()) {
      return;
    }
    if (result.stateHint === "busy" && this.terminalInfo.agentState === state) {
      this.deps.onOutputPromotion();
      // Arm the monitor's private busy state so its idle paths can transition
      // the FSM back to waiting — without this the direct promotion above
      // strands the FSM in working (#9875).
      this.activityMonitor?.notifyExternalPromotion();
    }
  }

  // In-thread counterpart of the worker's viewport digest: one trailing read
  // per burst, so the last frame before the output stops is always observed.
  private scheduleOutputProgressSample(): void {
    if (this.outputProgressTimer || !this.terminalInfo.headlessTerminal) return;
    this.outputProgressTimer = setTimeout(() => {
      this.outputProgressTimer = null;
      this.sampleOutputProgress();
    }, OUTPUT_PROGRESS_SAMPLE_MS);
    this.outputProgressTimer.unref?.();
  }

  private sampleOutputProgress(): void {
    const mirror = this.terminalInfo.headlessTerminal;
    // No mirror is no reading, not an empty screen.
    if (!mirror) return;
    this.deps.onViewport(readViewportNonEmptyLines(mirror));
  }
}

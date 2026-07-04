import type { Terminal as HeadlessTerminalType, IMarker } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import serialize, { type SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
const { SerializeAddon } = serialize;
import unicode11 from "@xterm/addon-unicode11";
const { Unicode11Addon } = unicode11;

import { getEffectiveAgentConfig } from "../../../../shared/config/agentRegistry.js";
import type { AgentState } from "../../../../shared/types/agent.js";
import { ActivityMonitor, type ProcessStateValidator } from "../../ActivityMonitor.js";
import { buildActivityMonitorOptions, buildPatternConfig } from "../terminalActivityPatterns.js";
import { installHeadlessResponder } from "../headlessResponder.js";
import { Osc94Parser } from "../Osc94Parser.js";
import { SynchronizedFrameDetector } from "../SynchronizedFrameDetector.js";
import { restoreSessionFromFile } from "../terminalSessionPersistence.js";
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
  readVisibleActivityLines,
  readVisibleActivitySnapshot,
  readViewportNonEmptyLines,
} from "./headlessViewport.js";
import type {
  AnalysisCreateSpec,
  AnalysisFinalSnapshot,
  AnalysisMonitorStartSpec,
  WorkerToHostMessage,
} from "../analysisWorkerProtocol.js";

// Mirrors AGENT_OUTPUT_NOTE_MIN_INTERVAL_MS in TerminalProcess: floor between
// agent-output content comparisons.
const AGENT_OUTPUT_NOTE_MIN_INTERVAL_MS = 50;
// Trailing-edge throttle on the viewport digest pushed to the host (serves
// IdentityWatcher's sync reads; its own poll cadence is 200ms).
const VIEWPORT_DIGEST_THROTTLE_MS = 200;
// Flow-control ack batching: a `data-ack` is emitted once this much data-
// message payload has parsed, or on a trailing timer so a quiet tail still
// drains the host's outstanding counter. Exported for tests.
export const ANALYSIS_ACK_FLUSH_BYTES = 256 * 1024;
export const ANALYSIS_ACK_FLUSH_INTERVAL_MS = 100;

type Emit = (msg: WorkerToHostMessage) => void;

/**
 * Worker-side per-terminal analysis stack: headless xterm mirror, serialize
 * addon, ActivityMonitor, OSC 9;4 tap, synchronized-frame detector, and the
 * agent-output temperature tracker. One instance per terminal slot; assembled
 * from the same modules the in-thread path uses so behavior stays aligned.
 */
export class AnalysisSession {
  private readonly terminalId: string;
  private readonly spawnedAt: number;
  // Slot generation this session belongs to; stamped onto every data-ack so
  // the host can discard acks from a superseded generation.
  private epoch: number;
  private readonly emit: Emit;

  private headlessTerminal: HeadlessTerminalType | null;
  private serializeAddon: SerializeAddonType | null;
  private frameDetector: SynchronizedFrameDetector | null;
  private responderDisposable: { dispose: () => void } | null = null;
  private restoreBannerStart: IMarker | null = null;
  private restoreBannerEnd: IMarker | null = null;

  private monitor: ActivityMonitor | null = null;
  private readonly osc94Parser: Osc94Parser;

  // Host-pushed mirrors (refreshed per data chunk + on out-of-band pushes).
  private agentLive = false;
  private agentState: AgentState | undefined;
  private processState = { hasActiveChildren: true, cpuUsage: 0 };

  // Agent-output temperature tracker (mirrors TerminalProcess's
  // noteAgentOutputActivity machinery).
  private readonly agentOutputTemperature = new AgentActivityTemperature();
  private agentOutputContentSnapshot: VisibleContentSnapshot | undefined;
  private lastAgentOutputNoteAt = Number.NEGATIVE_INFINITY;
  private agentOutputNoteTimer: NodeJS.Timeout | null = null;

  private digestTimer: NodeJS.Timeout | null = null;
  private pendingAckBytes = 0;
  private ackTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(spec: AnalysisCreateSpec, emit: Emit) {
    this.terminalId = spec.terminalId;
    this.spawnedAt = spec.spawnedAt;
    this.epoch = spec.epoch;
    this.emit = emit;

    const terminal = new HeadlessTerminal({
      cols: spec.cols,
      rows: spec.rows,
      scrollback: spec.scrollback,
      allowProposedApi: true,
    });
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);
    this.headlessTerminal = terminal;
    this.serializeAddon = serializeAddon;

    this.frameDetector = new SynchronizedFrameDetector(terminal, (snapshot) => {
      this.monitor?.onSynchronizedFrame(snapshot);
    });
    this.osc94Parser = new Osc94Parser({
      onWorking: (now) => this.monitor?.onOscProgressWorking(now),
      onIdle: (now) => this.monitor?.onOscProgressIdle(now),
    });

    if (spec.restore) {
      const result = restoreSessionFromFile(terminal, this.terminalId);
      if (result.restored) {
        this.restoreBannerStart = result.bannerStartMarker;
        this.restoreBannerEnd = result.bannerEndMarker;
        this.scheduleDigest();
      }
    }
  }

  feedChunk(
    data: string,
    flags: { agentLive: boolean; agentState?: AgentState },
    epoch?: number
  ): void {
    if (this.disposed || !this.headlessTerminal) return;
    // Data always belongs to this session's create-generation, but track the
    // per-message epoch defensively so acks always echo the live generation.
    if (epoch !== undefined) this.epoch = epoch;
    const now = Date.now();
    this.agentLive = flags.agentLive;
    this.agentState = flags.agentState;

    this.osc94Parser.feed(data, now);

    this.monitor?.onData(data);

    if (!this.agentLive && (data.includes("\x1b[6n") || data.includes("\x1b[5n"))) {
      this.ensureResponder();
    }

    this.headlessTerminal.write(data, () => {
      this.noteProcessed(data.length);
      this.noteAgentOutputActivity();
      this.scheduleDigest();
    });
  }

  feedPrelude(data: string): void {
    if (this.disposed || !this.headlessTerminal) return;
    this.headlessTerminal.write(data, () => {
      this.scheduleDigest();
    });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || !this.headlessTerminal) return;
    try {
      this.headlessTerminal.resize(cols, rows);
    } catch (error) {
      console.error(`[AnalysisSession] Failed to resize ${this.terminalId}:`, error);
      return;
    }
    this.monitor?.notifyResize();
    this.agentOutputTemperature.noteResize(Date.now());
    this.agentOutputContentSnapshot = undefined;
    this.scheduleDigest();
  }

  notifyInput(data: string): void {
    this.monitor?.onInput(data);
  }

  notifyFocus(): void {
    this.monitor?.notifyFocus();
    this.agentOutputTemperature.reset();
    this.agentOutputContentSnapshot = undefined;
  }

  notifySubmission(): void {
    this.monitor?.notifySubmission();
  }

  updateAgentContext(agentLive: boolean, agentState: AgentState | undefined): void {
    this.agentLive = agentLive;
    this.agentState = agentState;
  }

  updateProcessState(hasActiveChildren: boolean, cpuUsage: number): void {
    this.processState.hasActiveChildren = hasActiveChildren;
    this.processState.cpuUsage = cpuUsage;
  }

  startMonitor(spec: AnalysisMonitorStartSpec): void {
    if (this.disposed || this.monitor) return;

    const validator: ProcessStateValidator | undefined = spec.hasProcessValidator
      ? {
          hasActiveChildren: () => this.processState.hasActiveChildren,
          getDescendantsCpuUsage: () => this.processState.cpuUsage,
        }
      : undefined;

    this.monitor = new ActivityMonitor(
      this.terminalId,
      this.spawnedAt,
      (_termId, cbSpawnedAt, state, metadata) => {
        this.emit({
          type: "activity-state",
          terminalId: this.terminalId,
          spawnedAt: cbSpawnedAt,
          state,
          metadata,
        });
      },
      {
        ...buildActivityMonitorOptions(spec.agentId, {
          getVisibleLines: (n) => readVisibleActivityLines(this.headlessTerminal ?? undefined, n),
          getVisibleContentSnapshot: (n) =>
            readVisibleActivitySnapshot(this.headlessTerminal ?? undefined, n),
          getCursorLine: () => readCursorLine(this.headlessTerminal ?? undefined),
        }),
        processStateValidator: validator,
        initialState: spec.initialState,
        skipInitialStateEmit: spec.skipInitialStateEmit,
        onWaitingTimeout: (_id, cbSpawnedAt) => {
          this.emit({
            type: "waiting-timeout",
            terminalId: this.terminalId,
            spawnedAt: cbSpawnedAt,
          });
        },
        onBootComplete: (timestamp) => {
          this.emit({
            type: "boot-complete",
            terminalId: this.terminalId,
            spawnedAt: this.spawnedAt,
            timestamp,
          });
        },
      }
    );
    if (spec.pollingIntervalMs !== undefined) {
      this.monitor.setPollingInterval(spec.pollingIntervalMs);
    }
    this.monitor.startPolling();
  }

  stopMonitor(): void {
    if (this.monitor) {
      this.monitor.dispose();
      this.monitor = null;
    }
    this.osc94Parser.reset();
  }

  reconfigureMonitor(agentId: string): void {
    if (!this.monitor) return;
    const detection = getEffectiveAgentConfig(agentId)?.detection;
    const patternConfig = buildPatternConfig(detection, agentId);
    this.monitor.reconfigure(agentId, patternConfig);
  }

  setPollingInterval(intervalMs: number): void {
    this.monitor?.setPollingInterval(intervalMs);
  }

  hasMonitor(): boolean {
    return this.monitor !== null;
  }

  /** True when `epoch` matches this session's live slot generation. */
  matchesEpoch(epoch: number): boolean {
    return this.epoch === epoch;
  }

  setScrollback(lines: number): void {
    if (this.disposed || !this.headlessTerminal) return;
    this.headlessTerminal.options.scrollback = lines;
  }

  serialize(): Promise<string | null> {
    return this.drainThen(() => this.serializeFull());
  }

  serializeForPersistence(): Promise<string | null> {
    return this.drainThen(() => this.serializeBannerAware());
  }

  captureFinalSnapshot(): Promise<AnalysisFinalSnapshot> {
    return this.drainThen(() => ({
      snapshot: this.serializeFull(),
      persistence: this.serializeBannerAware(),
    }));
  }

  free(): void {
    if (this.disposed) return;
    // Final ack flush BEFORE marking disposed: parsed-but-unflushed bytes must
    // still drain the host's outstanding counter (an overflow-reset `create`
    // frees this session while its backend stays registered).
    this.flushAck();
    this.disposed = true;
    this.stopMonitor();
    if (this.agentOutputNoteTimer) {
      clearTimeout(this.agentOutputNoteTimer);
      this.agentOutputNoteTimer = null;
    }
    if (this.digestTimer) {
      clearTimeout(this.digestTimer);
      this.digestTimer = null;
    }
    if (this.responderDisposable) {
      try {
        this.responderDisposable.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.responderDisposable = null;
    }
    if (this.frameDetector) {
      try {
        this.frameDetector.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.frameDetector = null;
    }
    if (this.headlessTerminal) {
      try {
        this.headlessTerminal.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.headlessTerminal = null;
      this.serializeAddon = null;
    }
  }

  private noteProcessed(bytes: number): void {
    if (this.disposed || bytes <= 0) return;
    this.pendingAckBytes += bytes;
    if (this.pendingAckBytes >= ANALYSIS_ACK_FLUSH_BYTES) {
      this.flushAck();
      return;
    }
    if (!this.ackTimer) {
      this.ackTimer = setTimeout(() => {
        this.ackTimer = null;
        this.flushAck();
      }, ANALYSIS_ACK_FLUSH_INTERVAL_MS);
      this.ackTimer.unref?.();
    }
  }

  private flushAck(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.pendingAckBytes === 0) return;
    const bytes = this.pendingAckBytes;
    this.pendingAckBytes = 0;
    this.emit({ type: "data-ack", terminalId: this.terminalId, bytes, epoch: this.epoch });
  }

  // Runs `fn` after xterm's async parse queue has drained, so the tail of the
  // output is in the buffer before serialization. Falls back to immediate
  // execution when the buffer is already gone.
  private drainThen<T>(fn: () => T): Promise<T> {
    const terminal = this.headlessTerminal;
    if (this.disposed || !terminal) {
      return Promise.resolve(fn());
    }
    return new Promise<T>((resolve) => {
      terminal.write("", () => {
        resolve(fn());
      });
    });
  }

  private serializeFull(): string | null {
    if (!this.serializeAddon) return null;
    try {
      return this.serializeAddon.serialize();
    } catch (error) {
      console.error(`[AnalysisSession] Failed to serialize ${this.terminalId}:`, error);
      return null;
    }
  }

  // Banner-stripped serialize for persistence; mirrors
  // terminalSerialization.serializeForPersistence.
  private serializeBannerAware(): string | null {
    const addon = this.serializeAddon;
    const terminal = this.headlessTerminal;
    if (!addon || !terminal) return null;

    const startMarker = this.restoreBannerStart;
    const endMarker = this.restoreBannerEnd;
    if (!startMarker || !endMarker || startMarker.line < 0 || endMarker.line < 0) {
      return this.serializeFull();
    }

    try {
      const bufLen = terminal.buffer.active.length;
      const bannerStart = startMarker.line;
      const bannerEnd = endMarker.line;

      const beforePart =
        bannerStart > 0 ? addon.serialize({ range: { start: 0, end: bannerStart - 1 } }) : "";
      const afterPart =
        bannerEnd < bufLen - 1
          ? addon.serialize({ range: { start: bannerEnd, end: bufLen - 1 } })
          : "";

      if (beforePart && afterPart) return beforePart + "\r\n" + afterPart;
      return beforePart || afterPart || null;
    } catch {
      return this.serializeFull();
    }
  }

  private ensureResponder(): void {
    if (this.disposed || this.responderDisposable || !this.headlessTerminal) return;
    this.responderDisposable = installHeadlessResponder(this.headlessTerminal, (data) => {
      this.emit({ type: "pty-response", terminalId: this.terminalId, data });
    });
  }

  private getAgentOutputContentSnapshot(): VisibleContentSnapshot | undefined {
    if (!this.headlessTerminal) return undefined;
    return readVisibleActivitySnapshot(this.headlessTerminal, AGENT_OUTPUT_ACTIVITY_LINE_COUNT);
  }

  // Mirrors TerminalProcess.noteAgentOutputActivity: temperature-based
  // waiting→working promotion for agents whose FSM sits in a settled state.
  // Diffs against the stored baseline from the last accepted comparison
  // (per-chunk "before" viewport walks were dropped with #10919 — the second
  // full extraction per note bought only a marginally tighter diff window).
  private noteAgentOutputActivity(): void {
    if (this.disposed) return;
    if (!this.agentLive) {
      this.agentOutputTemperature.reset();
      this.agentOutputContentSnapshot = undefined;
      return;
    }

    const state = this.agentState;
    if (state !== "waiting" && state !== "idle" && state !== "completed") {
      return;
    }

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
    // Parallel promotion path: gate on the monitor's focus-suppression (#8865)
    // and recent-user-input (#10925) windows, mirroring the in-thread
    // TerminalProcess.noteAgentOutputActivity path, so a focus repaint or a
    // mouse-report-driven redraw from scrolling a TUI can't flip a settled
    // agent to busy.
    if (this.monitor?.isFocusSuppressed() || this.monitor?.isRecentUserInput()) {
      return;
    }
    if (result.stateHint === "busy" && this.agentState === state) {
      this.emit({
        type: "activity-state",
        terminalId: this.terminalId,
        spawnedAt: this.spawnedAt,
        state: "busy",
        metadata: { trigger: "output" },
      });
      // Arm the monitor's private busy state so its idle paths can transition
      // the FSM back to waiting (#9875 — same rationale as the in-thread path).
      this.monitor?.notifyExternalPromotion();
    }
  }

  private scheduleDigest(): void {
    if (this.disposed || this.digestTimer) return;
    this.digestTimer = setTimeout(() => {
      this.digestTimer = null;
      if (this.disposed || !this.headlessTerminal) return;
      this.emit({
        type: "viewport",
        terminalId: this.terminalId,
        lines: readViewportNonEmptyLines(this.headlessTerminal),
        cursorLine: readCursorLine(this.headlessTerminal),
      });
    }, VIEWPORT_DIGEST_THROTTLE_MS);
    this.digestTimer.unref?.();
  }
}

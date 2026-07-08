import type * as pty from "node-pty";
import type { TerminalInfo } from "./types.js";
import { OUTPUT_BUFFER_SIZE } from "./types.js";
import type { AnalysisBackend } from "./analysis/AnalysisBackend.js";
import type { SessionSnapshotter } from "./SessionSnapshotter.js";
import type { TerminalForensicsBuffer } from "./TerminalForensicsBuffer.js";
import type { IdentityWatcher } from "./IdentityWatcher.js";
import type { SemanticBufferManager } from "./SemanticBufferManager.js";
import { handleOscColorQueries } from "./OscResponder.js";
import { getLiveAgentId } from "./terminalTitle.js";

export interface PtyDataPipelineHost {
  readonly terminalInfo: TerminalInfo;
  readonly analysis: AnalysisBackend;
  readonly sessionSnapshotter: SessionSnapshotter;
  readonly forensicsBuffer: TerminalForensicsBuffer;
  readonly identityWatcher: IdentityWatcher;
  readonly semanticBufferManager: SemanticBufferManager;
  readonly isAgentLive: boolean;
  readonly shouldHandleOscColorQueries: boolean;
  emitData(data: string | Uint8Array): void;
  queueAgentOutput(agentId: string, data: string): void;
}

export class PtyDataPipeline {
  constructor(private readonly host: PtyDataPipelineHost) {}

  handlePtyData(ptyProcess: pty.IPty, data: string): void {
    const terminal = this.host.terminalInfo;
    if (terminal.ptyProcess !== ptyProcess) {
      return;
    }

    const now = Date.now();
    // One-shot startup metric: wall-clock time of the first PTY data byte.
    // Surfaces in `getPublicState()` and the `[AgentStartup]` structured log.
    if (terminal.firstByteAt === undefined) {
      terminal.firstByteAt = now;
    }
    terminal.lastOutputTime = now;

    // Hibernation removed: PTY output ALWAYS flows through the live parse
    // pipeline regardless of activity tier, so a backgrounded pane's renderer
    // buffer stays current instead of being held in a coalesce queue until
    // reveal. The agent-state poll cadence (50ms active / 500ms background, set
    // in setActivityMonitorTier) still throttles the headless poll loop.
    this.runPipeline(data);
  }

  /**
   * The per-chunk parse pipeline downstream of the OSC 9;4 tap and timestamp
   * bookkeeping. Runs immediately for every chunk regardless of activity tier.
   * `data` is the raw PTY string; the renderer-bound copy is derived here after
   * OSC color queries are answered.
   */
  private runPipeline(data: string): void {
    const terminal = this.host.terminalInfo;

    // OSC 10/11 color queries are answered whenever the terminal is agent-owned
    // (spawn-time agent panel OR runtime-promoted plain terminal). The
    // call-site gate and quick-test heuristic stay here; the responder logic
    // lives in OscResponder. See OscResponder.ts for the strip-on-success
    // contract that keeps the renderer's xterm.js from double-responding.
    // This is the ONLY stage that must precede the forward — it derives the
    // renderer-bound copy.
    let rendererData = data;
    if (this.host.shouldHandleOscColorQueries && data.includes("\x1b]1")) {
      rendererData = handleOscColorQueries(data, (response) => {
        terminal.ptyProcess.write(response);
      });
    }

    // Forward to the renderer before the analysis stages below: they are
    // bookkeeping the user never sees, and on the batcher's synchronous
    // threshold-flush path every pre-forward millisecond is a millisecond
    // added to the visible frame's latency.
    this.host.emitData(rendererData);

    // Analysis stack: OSC 9;4 tap, ActivityMonitor onData, headless mirror
    // write, agent-output temperature. In worker mode this is one postMessage.
    this.host.analysis.feedChunk(data, {
      agentLive: this.host.isAgentLive,
      agentState: terminal.agentState,
    });
    this.host.sessionSnapshotter.schedule();

    this.host.forensicsBuffer.capture(data);
    this.host.identityWatcher.observeOutput(data);
    this.host.semanticBufferManager.onData(data);

    // Output mirror for agent consumers: keep a rolling recent-output
    // buffer and emit agent:output whenever an agent is live (launched
    // hint or detection). Plain terminals skip both to save work.
    if (this.host.isAgentLive) {
      terminal.outputBuffer += data;
      if (terminal.outputBuffer.length > OUTPUT_BUFFER_SIZE) {
        terminal.outputBuffer = terminal.outputBuffer.slice(-OUTPUT_BUFFER_SIZE);
      }

      const liveId = getLiveAgentId(terminal);
      if (liveId) {
        this.host.queueAgentOutput(liveId, data);
      }
    }
  }
}

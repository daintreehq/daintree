import type { ExitReason, TerminalInfo } from "./types.js";
import { events } from "../events.js";
import type { AgentStateService } from "./AgentStateService.js";
import { classifyExitOutput, shouldTriggerFallback } from "./FallbackErrorClassifier.js";
import type { TerminalForensicsBuffer } from "./TerminalForensicsBuffer.js";
import { getLiveAgentId } from "./terminalTitle.js";

export interface TerminalExitObserversHost {
  readonly id: string;
  readonly terminalInfo: TerminalInfo;
  readonly forensicsBuffer: TerminalForensicsBuffer;
  readonly agentStateService: AgentStateService;
}

export interface TerminalExitArgs {
  code: number | null;
  signal?: number;
  reason: ExitReason;
  recentOutput: string;
}

/**
 * Owns the `terminal:exited` listener subscription and emission for one
 * terminal. Forensics, `agent:completed`, and fallback classification
 * subscribe via `terminal:exited` rather than running inline in the PTY
 * `onExit` callback.
 *
 * `emit()` is idempotent — subsequent calls after the first are no-ops.
 * The subscription is also self-disposing on first delivery; `dispose()`
 * tears it down if the terminal is destroyed without ever emitting.
 */
export class TerminalExitObservers {
  private emitted = false;
  private subscriptionDisposable: { dispose: () => void } | null = null;

  constructor(private readonly host: TerminalExitObserversHost) {
    this.subscribe();
  }

  get hasEmitted(): boolean {
    return this.emitted;
  }

  emit(args: TerminalExitArgs): void {
    if (this.emitted) return;
    this.emitted = true;

    const terminal = this.host.terminalInfo;
    const liveAgentAtExit = getLiveAgentId(terminal);
    const hadAgent = !!terminal.launchAgentId || !!terminal.everDetectedAgent;

    events.emit("terminal:exited", {
      terminalId: this.host.id,
      spawnedAt: terminal.spawnedAt,
      code: args.code,
      signal: args.signal,
      reason: args.reason,
      recentOutput: args.recentOutput,
      hadAgent,
      liveAgentAtExit,
      launchAgentId: terminal.launchAgentId,
      agentPresetId: terminal.agentPresetId,
      originalAgentPresetId: terminal.originalAgentPresetId,
      timestamp: Date.now(),
    });
  }

  dispose(): void {
    this.subscriptionDisposable?.dispose();
    this.subscriptionDisposable = null;
  }

  /**
   * Subscribe forensics logging, agent-completion emission, and fallback
   * classification to the `terminal:exited` event. Filters by `terminalId`
   * and the per-spawn session token so a stale exit from a respawned PTY
   * doesn't consume a new instance's listener.
   */
  private subscribe(): void {
    const sessionToken = this.host.terminalInfo.spawnedAt;
    const off = events.on("terminal:exited", (payload) => {
      if (payload.terminalId !== this.host.id || payload.spawnedAt !== sessionToken) return;

      // Forensics: log abnormal exits with the tail captured at exit time.
      // `wasKilled` is encoded in the reason — kill / graceful-shutdown
      // paths suppress the abnormal-exit log even if the exit code was
      // non-zero, matching the prior inline behaviour.
      this.host.forensicsBuffer.logForensics(
        this.host.id,
        payload.code ?? 0,
        this.host.terminalInfo,
        payload.hadAgent,
        payload.signal
      );

      // Agent state machine: only natural exits update agent state and
      // emit agent:completed. kill / graceful-shutdown route through the
      // kill path which has already emitted agent:killed before teardown.
      if (payload.reason === "natural" && payload.hadAgent) {
        this.host.agentStateService.updateAgentState(this.host.terminalInfo, {
          type: "exit",
          code: payload.code ?? 0,
          signal: payload.signal,
        });
      }

      if (payload.reason === "natural" && payload.hadAgent && payload.liveAgentAtExit) {
        this.host.agentStateService.emitAgentCompleted(this.host.terminalInfo, payload.code ?? 0);
      }

      // Fallback classification: only fires for natural exits of agent
      // terminals with a launched preset. Killed agents never trigger
      // fallback (the user explicitly stopped them).
      if (
        payload.reason === "natural" &&
        payload.launchAgentId &&
        payload.agentPresetId &&
        payload.code !== null
      ) {
        const cls = classifyExitOutput({
          recentOutput: payload.recentOutput,
          // Pass through as-is so a null/undefined code (crash, signal) does
          // NOT short-circuit the scan. Only an explicit exit 0 skips the tail.
          exitCode: payload.code,
          wasKilled: false,
        });
        if (shouldTriggerFallback(cls)) {
          events.emit("agent:fallback-triggered", {
            terminalId: this.host.id,
            agentId: payload.launchAgentId,
            fromPresetId: payload.agentPresetId,
            originalPresetId: payload.originalAgentPresetId ?? payload.agentPresetId,
            reason: cls as "connection" | "auth",
            exitCode: payload.code,
            timestamp: Date.now(),
          });
        }
      }

      this.subscriptionDisposable?.dispose();
      this.subscriptionDisposable = null;
    });

    this.subscriptionDisposable = { dispose: off };
  }
}

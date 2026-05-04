import { isBuiltInAgentId, type BuiltInAgentId } from "../../../shared/config/agentIds.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import type { DetectionResult, DetectionState } from "../ProcessDetector.js";
import { events } from "../events.js";
import type { ActivityMonitor } from "../ActivityMonitor.js";
import type { ActivityHeadlineGenerator } from "../ActivityHeadlineGenerator.js";
import type { AgentStateService } from "./AgentStateService.js";
import type { SemanticBufferManager } from "./SemanticBufferManager.js";
import type { TerminalInfo } from "./types.js";
import { computeDefaultTitle } from "./terminalTitle.js";
import { logIdentityDebug } from "./identityDebug.js";
import { buildPatternConfig } from "./terminalActivityPatterns.js";

export interface TerminalAgentDetectionHost {
  readonly id: string;
  readonly terminalInfo: TerminalInfo;
  readonly agentStateService: AgentStateService;
  readonly headlineGenerator: ActivityHeadlineGenerator;
  readonly semanticBufferManager: SemanticBufferManager;
  readonly activityMonitor: ActivityMonitor | null;
  lastDetectedProcessIconId: string | undefined;
  startActivityMonitor(): void;
  stopActivityMonitor(): void;
}

/**
 * Apply a `DetectionResult` from ProcessDetector to terminal identity:
 * promote/demote agent chrome, update process-icon, sync default title,
 * fan out `agent:detected`/`agent:exited`/`terminal:activity` events.
 *
 * Stale detections from a previous PTY incarnation (after respawn under
 * the same id) are rejected via `spawnedAt`. Killed terminals are no-ops.
 * `unknown`/`ambiguous` states are treated as HOLD — see #5809.
 */
export function handleAgentDetection(
  host: TerminalAgentDetectionHost,
  result: DetectionResult,
  spawnedAt: number
): void {
  if (host.terminalInfo.spawnedAt !== spawnedAt) {
    console.warn(
      `[TerminalProcess] Rejected stale detection from old ProcessDetector ${host.id} ` +
        `(session ${spawnedAt} vs current ${host.terminalInfo.spawnedAt})`
    );
    return;
  }

  const terminal = host.terminalInfo;

  if (terminal.wasKilled) {
    return;
  }

  // Normalize legacy callers that only set `detected`. Callers that set
  // `detectionState` win; fall back to mapping `detected: boolean` onto
  // the four-state enum. This preserves existing test call sites while
  // new code branches on the richer enum. #5809
  const state: DetectionState = result.detectionState ?? (result.detected ? "agent" : "no_agent");

  // `unknown` and `ambiguous` are HOLD states — no evidence change, no
  // committed-state transition. Skip all branches so a blind `ps` cycle
  // doesn't silently demote a confirmed agent every HYSTERESIS window,
  // and a two-source conflict holds rather than flips. Precedent:
  // #4153 — make uncertain events no-ops in the state machine. #5809
  if (state === "unknown" || state === "ambiguous") {
    return;
  }

  const isDetected = state === "agent";

  // Set when we clear a runtime agent detection on this tick so the block
  // below can suppress a same-tick shell-headline emission that would
  // otherwise overwrite the "Exited" completion cue emitted by
  // updateAgentState. The next detector poll emits the shell headline
  // instead. #5773
  let justClearedDetection = false;

  if (isDetected && result.agentType && isBuiltInAgentId(result.agentType)) {
    const detectedAgentId: BuiltInAgentId = result.agentType;
    const previous = terminal.detectedAgentId;
    terminal.everDetectedAgent = true;

    if (previous !== detectedAgentId) {
      if (terminal.agentState === "exited") {
        host.agentStateService.updateAgentState(terminal, { type: "respawn" });
      }

      terminal.detectedAgentId = detectedAgentId;

      const detection = getEffectiveAgentConfig(detectedAgentId)?.detection;
      const patternConfig = buildPatternConfig(detection, detectedAgentId);
      if (host.activityMonitor) {
        host.activityMonitor.reconfigure(detectedAgentId, patternConfig);
      } else {
        // Runtime promotion: plain terminal now hosts an agent. Start the
        // activity monitor immediately so the renderer sees state
        // transitions from the first tick forward.
        if (terminal.agentState === undefined) {
          terminal.agentState = "idle";
          terminal.lastStateChange = Date.now();
        }
        terminal.analysisEnabled = true;
        host.startActivityMonitor();
      }

      // Title sync: write the default-mode title so the renderer can pick
      // it up via the agent-detected event payload. User-renamed panels
      // (titleMode === "custom") are left alone.
      const nextTitle = computeDefaultTitle(terminal);
      if ((terminal.titleMode ?? "default") === "default") {
        terminal.title = nextTitle;
      }

      host.lastDetectedProcessIconId = result.processIconId;
      terminal.detectedProcessIconId = result.processIconId;
      events.emit("agent:detected", {
        terminalId: host.id,
        agentType: detectedAgentId,
        processIconId: result.processIconId,
        processName: result.processName || detectedAgentId,
        defaultTitle: nextTitle,
        timestamp: Date.now(),
      });
    }
  } else if (isDetected && !result.agentType && result.processIconId) {
    // Non-agent process detected (npm, python, docker, etc.)
    if (terminal.detectedAgentId) {
      logIdentityDebug(
        `[IdentityDebug] terminal-demote-hold term=${host.id.slice(-8)} ` +
          `reason=agent-requires-explicit-exit agent=${terminal.detectedAgentId} ` +
          `processIcon=${result.processIconId}`
      );
      return;
    }
    if (host.lastDetectedProcessIconId !== result.processIconId) {
      host.lastDetectedProcessIconId = result.processIconId;
      terminal.detectedProcessIconId = result.processIconId;
      events.emit("agent:detected", {
        terminalId: host.id,
        processIconId: result.processIconId,
        processName: result.processName || result.processIconId,
        timestamp: Date.now(),
      });
    }
  } else if (!isDetected && (terminal.detectedAgentId || host.lastDetectedProcessIconId)) {
    const previousAgent = terminal.detectedAgentId;
    if (previousAgent) {
      // The "agent-requires-explicit-exit" guard exists to keep durable
      // launch-affinity chrome stable through transient detection gaps —
      // process-tree blindness, blind-`ps` cycles, argv rewrites. It only
      // applies when the agent identity is anchored by `launchAgentId`
      // (toolbar/cold-launched). Runtime-promoted agents (user typed the
      // CLI into a plain shell) have no durable anchor: when `no_agent`
      // arrives we must demote regardless of evidence source, otherwise
      // a process-tree-absence tick after Ctrl+C can land here without
      // `evidenceSource: "shell_command"` and the chrome stays stuck on
      // `claude` until terminal teardown. Issue: v0.8.0 release E2E.
      if (terminal.launchAgentId && result.evidenceSource !== "shell_command") {
        logIdentityDebug(
          `[IdentityDebug] terminal-demote-hold term=${host.id.slice(-8)} ` +
            `reason=agent-requires-explicit-exit agent=${previousAgent}`
        );
        return;
      }
      logIdentityDebug(
        `[IdentityDebug] terminal-demote-apply term=${host.id.slice(-8)} ` +
          `reason=${result.evidenceSource === "shell_command" ? "prompt-return" : "no-agent-detected"} ` +
          `agent=${previousAgent} runtime=${terminal.launchAgentId ? "launch-anchored" : "runtime-promoted"}`
      );
      host.agentStateService.updateAgentState(terminal, { type: "exit", code: 0 });
      terminal.detectedAgentId = undefined;
      justClearedDetection = true;
    }

    host.lastDetectedProcessIconId = undefined;
    terminal.detectedProcessIconId = undefined;
    host.stopActivityMonitor();
    if (previousAgent) {
      terminal.analysisEnabled = false;
    }
    const nextTitle = computeDefaultTitle(terminal);
    if (previousAgent && (terminal.titleMode ?? "default") === "default") {
      terminal.title = nextTitle;
    }
    // Emit `agent:exited` to clear the renderer's live-detection fields
    // (`detectedAgentId`, `detectedProcessId`). Stamp `exitKind: "subcommand"`
    // only when an actual agent process exited so the renderer can distinguish
    // from plain process-icon clearings (npm/vite/etc.).
    events.emit("agent:exited", {
      terminalId: host.id,
      agentType: previousAgent,
      defaultTitle: previousAgent ? nextTitle : undefined,
      timestamp: Date.now(),
      ...(previousAgent ? { exitKind: "subcommand" as const } : {}),
    });
  }

  // Route to shell-style headlines when no agent is live. Covers plain
  // terminals (no launch hint, no detection) and agent-launched terminals
  // whose agent exited — which keep an active shell PTY and should surface
  // shell activity rather than a stale "Agent working" headline. Skip on
  // the exact tick we just emitted an "Exited" completion cue so it isn't
  // overwritten.
  const hasLiveAgent =
    !!terminal.detectedAgentId || (!!terminal.launchAgentId && terminal.agentState !== "exited");
  if (!justClearedDetection && !hasLiveAgent) {
    const lastCommand = result.currentCommand || host.semanticBufferManager.getLastCommand();

    const { headline, status, type } = host.headlineGenerator.generate({
      terminalId: host.id,
      activity: result.isBusy ? "busy" : "idle",
      lastCommand,
    });

    events.emit("terminal:activity", {
      terminalId: host.id,
      headline,
      status,
      type,
      confidence: 1.0,
      timestamp: Date.now(),
      lastCommand,
    });
  }
}

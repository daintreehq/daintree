import { afterEach, describe, expect, it } from "vitest";
import {
  handleAgentDetection,
  type TerminalAgentDetectionHost,
} from "../TerminalAgentDetection.js";
import { AgentStateService } from "../AgentStateService.js";
import { events } from "../../events.js";
import type { DetectionResult } from "../../ProcessDetector.js";
import type { TerminalInfo } from "../types.js";

/**
 * The relaunch the pty cannot see (#12535), driven through the real state
 * machine rather than a stubbed one — the count only moves on a transition the
 * service actually accepts, so a no-op stub would prove nothing.
 */

const SPAWNED_AT = 1_000;

function terminalInfo(): TerminalInfo {
  return {
    id: "term-1",
    cwd: "/repo",
    shell: "/bin/zsh",
    spawnedAt: SPAWNED_AT,
    analysisEnabled: true,
    lastInputTime: 0,
    lastOutputTime: 0,
    lastCheckTime: 0,
    agentIncarnation: 0,
    restartCount: 0,
    launchAgentId: "claude",
    agentState: "idle",
    ptyProcess: {} as never,
    outputBuffer: "",
    semanticBuffer: [],
  } as unknown as TerminalInfo;
}

function host(terminal: TerminalInfo): TerminalAgentDetectionHost {
  return {
    id: terminal.id,
    terminalInfo: terminal,
    agentStateService: new AgentStateService(),
    headlineGenerator: {
      generate: () => ({ headline: "", status: "idle", type: "shell" }),
    } as unknown as TerminalAgentDetectionHost["headlineGenerator"],
    semanticBufferManager: {
      getLastCommand: () => undefined,
    } as unknown as TerminalAgentDetectionHost["semanticBufferManager"],
    forensicsBuffer: {
      getRecentOutput: () => "",
    } as unknown as TerminalAgentDetectionHost["forensicsBuffer"],
    hasActivityMonitor: true,
    lastDetectedProcessIconId: undefined,
    reconfigureActivityMonitor: () => {},
    startActivityMonitor: () => {},
    stopActivityMonitor: () => {},
  };
}

const claudeRunning: DetectionResult = {
  detectionState: "agent",
  detected: true,
  agentType: "claude",
  processIconId: "claude",
  processName: "claude",
};

/** The shell the agent left behind, reported by its own prompt returning. */
const backAtShell: DetectionResult = {
  detectionState: "no_agent",
  detected: false,
  evidenceSource: "shell_command",
};

describe("agent incarnation across a same-pty relaunch", () => {
  afterEach(() => {
    events.removeAllListeners();
  });

  it("counts the second claude but leaves the pty generation alone", () => {
    const terminal = terminalInfo();
    const h = host(terminal);

    handleAgentDetection(h, claudeRunning, SPAWNED_AT);
    expect(terminal.detectedAgentId).toBe("claude");
    expect(terminal.agentIncarnation).toBe(0);

    // The user quits. The pty survives as the shell it was launched from.
    handleAgentDetection(h, backAtShell, SPAWNED_AT);
    expect(terminal.detectedAgentId).toBeUndefined();
    expect(terminal.agentState).toBe("exited");
    expect(terminal.agentIncarnation).toBe(0);

    // They run `claude` again in that shell. Nothing else about the terminal
    // moves — same id, same pty, same spawn stamp, same agent.
    handleAgentDetection(h, claudeRunning, SPAWNED_AT);
    expect(terminal.detectedAgentId).toBe("claude");
    expect(terminal.spawnedAt).toBe(SPAWNED_AT);
    expect(terminal.agentIncarnation).toBe(1);
  });

  it("counts each relaunch once, and repeat detections not at all", () => {
    const terminal = terminalInfo();
    const h = host(terminal);

    handleAgentDetection(h, claudeRunning, SPAWNED_AT);
    handleAgentDetection(h, claudeRunning, SPAWNED_AT);
    expect(terminal.agentIncarnation).toBe(0);

    for (let i = 1; i <= 3; i++) {
      handleAgentDetection(h, backAtShell, SPAWNED_AT);
      handleAgentDetection(h, claudeRunning, SPAWNED_AT);
      handleAgentDetection(h, claudeRunning, SPAWNED_AT);
      expect(terminal.agentIncarnation).toBe(i);
    }
  });

  it("carries the new count on the detection event", () => {
    const terminal = terminalInfo();
    const h = host(terminal);
    const counts: Array<number | undefined> = [];
    events.on("agent:detected", (payload) => counts.push(payload.agentIncarnation));

    handleAgentDetection(h, claudeRunning, SPAWNED_AT);
    handleAgentDetection(h, backAtShell, SPAWNED_AT);
    handleAgentDetection(h, claudeRunning, SPAWNED_AT);

    expect(counts).toEqual([0, 1]);
  });

  it("does not count a detection rejected as stale", () => {
    const terminal = terminalInfo();
    const h = host(terminal);

    handleAgentDetection(h, claudeRunning, SPAWNED_AT);
    handleAgentDetection(h, backAtShell, SPAWNED_AT);
    // A detector left over from a previous pty under this id.
    handleAgentDetection(h, claudeRunning, SPAWNED_AT - 1);

    expect(terminal.agentIncarnation).toBe(0);
    expect(terminal.detectedAgentId).toBeUndefined();
  });

  it("does not count an unknown or ambiguous read", () => {
    const terminal = terminalInfo();
    const h = host(terminal);

    handleAgentDetection(h, claudeRunning, SPAWNED_AT);
    handleAgentDetection(h, backAtShell, SPAWNED_AT);
    handleAgentDetection(h, { detectionState: "unknown", detected: false }, SPAWNED_AT);
    handleAgentDetection(h, { detectionState: "ambiguous", detected: false }, SPAWNED_AT);

    expect(terminal.agentIncarnation).toBe(0);
  });
});

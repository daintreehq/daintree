import { events } from "../events.js";
import { OUTPUT_BUFFER_SIZE, type TerminalInfo } from "./types.js";

// Coalescing window for host→main agent:output forwarding. Pending output is
// flushed synchronously before any agent state transition (and on exit) so
// turn-outcome classification still sees the tail in order.
const AGENT_OUTPUT_FLUSH_INTERVAL_MS = 50;

/**
 * Whether this terminal's raw output is forwarded to Main as `agent:output`.
 *
 * Main's only reader of those bytes is the Assistant's turn-outcome
 * classifier, which drops output from any terminal not bound to a help
 * session (#15667). The binding is made before the PTY is spawned and is
 * sealed onto the record as `isAssistantTerminal`, including on a tokenless
 * restart and a pty-host crash replay, so every other agent terminal would
 * only cost Main a deserialize per chunk for bytes it throws away.
 */
export function forwardsAgentOutput(terminal: Pick<TerminalInfo, "isAssistantTerminal">): boolean {
  return terminal.isAssistantTerminal === true;
}

export interface AgentOutputForwarderHost {
  readonly terminalId: string;
  readonly traceId: string | undefined;
}

export class AgentOutputForwarder {
  private pendingAgentOutput = "";
  private pendingAgentOutputAgentId: string | null = null;
  private agentOutputFlushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly host: AgentOutputForwarderHost) {}

  queue(agentId: string, data: string): void {
    if (this.pendingAgentOutputAgentId !== null && this.pendingAgentOutputAgentId !== agentId) {
      this.flush();
    }
    this.pendingAgentOutputAgentId = agentId;
    this.pendingAgentOutput += data;

    if (this.pendingAgentOutput.length >= OUTPUT_BUFFER_SIZE) {
      this.flush();
      return;
    }
    if (this.agentOutputFlushTimer) {
      return;
    }
    this.agentOutputFlushTimer = setTimeout(() => {
      this.agentOutputFlushTimer = null;
      this.flush();
    }, AGENT_OUTPUT_FLUSH_INTERVAL_MS);
  }

  flush(): void {
    if (this.agentOutputFlushTimer) {
      clearTimeout(this.agentOutputFlushTimer);
      this.agentOutputFlushTimer = null;
    }
    if (!this.pendingAgentOutput || this.pendingAgentOutputAgentId === null) {
      return;
    }
    const agentId = this.pendingAgentOutputAgentId;
    const data = this.pendingAgentOutput;
    this.pendingAgentOutput = "";
    this.pendingAgentOutputAgentId = null;
    events.emit("agent:output", {
      agentId,
      data,
      timestamp: Date.now(),
      traceId: this.host.traceId,
      terminalId: this.host.terminalId,
    });
  }
}

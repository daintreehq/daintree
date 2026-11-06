import type { TerminalInfo } from "./types.js";
import { decideTerminalExitForensics } from "./terminalForensics.js";
import { logError, logLocalOnly } from "../../utils/logger.js";

const FORENSIC_BUFFER_SIZE = 4000;

export class TerminalForensicsBuffer {
  private recentOutputBuffer = "";
  private textDecoder = new TextDecoder();

  capture(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : this.textDecoder.decode(data);
    this.recentOutputBuffer += text;
    if (this.recentOutputBuffer.length > FORENSIC_BUFFER_SIZE) {
      this.recentOutputBuffer = this.recentOutputBuffer.slice(-FORENSIC_BUFFER_SIZE);
    }
  }

  /**
   * Read the current forensic buffer snapshot without disturbing it. Used by
   * the fallback classifier to inspect exit-time output before teardown runs.
   */
  getRecentOutput(): string {
    return this.recentOutputBuffer;
  }

  logForensics(
    terminalId: string,
    exitCode: number,
    terminal: TerminalInfo,
    hadAgent: boolean,
    signal?: number
  ): void {
    if (!hadAgent) return;

    const decision = decideTerminalExitForensics({
      exitCode,
      signal,
      wasKilled: terminal.wasKilled,
      recentOutput: this.recentOutputBuffer,
    });

    if (!decision.shouldLog || decision.strippedOutput.trim().length === 0) {
      return;
    }

    const agentId = terminal.detectedAgentId ?? terminal.launchAgentId ?? "unknown";
    logError(`Terminal ${terminalId} exited abnormally (code ${exitCode})`, undefined, {
      terminalId,
      exitCode,
      signal: decision.normalizedSignal,
      agentId,
      cwd: terminal.cwd,
      lastOutput: decision.strippedOutput.slice(-1000),
    });

    // The tail is the agent's screen: code, prompts, plans. Anything printed
    // here reaches Main's console and from there Sentry breadcrumbs (#15558).
    if (process.env.DAINTREE_VERBOSE || exitCode !== 0) {
      logLocalOnly(
        "error",
        `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nTERMINAL CRASH FORENSICS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nTerminal ID: ${terminalId}\nAgent:       ${agentId}\nExit Code:   ${exitCode}\nSignal:      ${decision.normalizedSignal ?? "none"}\nCWD:         ${terminal.cwd}\nTimestamp:   ${new Date().toISOString()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nLAST OUTPUT (${decision.strippedOutput.length} chars):\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${decision.strippedOutput}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
      );
    }
  }
}

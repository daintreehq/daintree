import type { TerminalInfo } from "./types.js";
import { decideTerminalExitForensics } from "./terminalForensics.js";
import { logError } from "../../utils/logger.js";

export const FORENSIC_BUFFER_SIZE = 4000;

export class TerminalForensicsBuffer {
  private recentOutputBuffer = "";
  private textDecoder = new TextDecoder();
  private maxChars = FORENSIC_BUFFER_SIZE;

  /**
   * Retention hook: cap the forensics ring per the terminal's retention tier.
   * Lowering the cap trims the held tail immediately. Exit forensics read
   * whatever tail is retained at exit time — live (non-archived) tiers keep
   * the full ring so abnormal-exit diagnostics are unaffected.
   */
  setMaxChars(chars: number): void {
    if (!Number.isFinite(chars) || chars < 0) return;
    this.maxChars = Math.floor(chars);
    // Zero disables the ring — explicit because `slice(-0)` keeps everything.
    if (this.maxChars === 0) {
      this.recentOutputBuffer = "";
      return;
    }
    if (this.recentOutputBuffer.length > this.maxChars) {
      this.recentOutputBuffer = this.recentOutputBuffer.slice(-this.maxChars);
    }
  }

  capture(data: string | Uint8Array): void {
    if (this.maxChars === 0) return;
    const text = typeof data === "string" ? data : this.textDecoder.decode(data);
    this.recentOutputBuffer += text;
    if (this.recentOutputBuffer.length > this.maxChars) {
      this.recentOutputBuffer = this.recentOutputBuffer.slice(-this.maxChars);
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

    if (process.env.DAINTREE_VERBOSE || exitCode !== 0) {
      console.error(
        `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nTERMINAL CRASH FORENSICS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nTerminal ID: ${terminalId}\nAgent:       ${agentId}\nExit Code:   ${exitCode}\nSignal:      ${decision.normalizedSignal ?? "none"}\nCWD:         ${terminal.cwd}\nTimestamp:   ${new Date().toISOString()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nLAST OUTPUT (${decision.strippedOutput.length} chars):\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${decision.strippedOutput}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
      );
    }
  }
}

import type { TerminalInfo } from "./types.js";
import { decideTerminalExitForensics } from "./terminalForensics.js";
import { logError, logLocalOnly } from "../../utils/logger.js";

const FORENSIC_BUFFER_SIZE = 4000;

export class TerminalForensicsBuffer {
  // Every chunk is captured but the tail is read only at exit and detection,
  // so chunks are kept as they arrive and trimmed once they hold twice the
  // window, rather than re-copying the whole window on every chunk. The tail
  // of a concatenation depends only on the tail of its parts, so the result
  // is the same string per-chunk trimming would hold.
  private chunks: string[] = [];
  private bufferedLength = 0;
  private textDecoder = new TextDecoder();

  capture(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : this.textDecoder.decode(data);
    if (text.length === 0) return;
    if (text.length >= FORENSIC_BUFFER_SIZE) {
      this.chunks = [text.slice(-FORENSIC_BUFFER_SIZE)];
      this.bufferedLength = FORENSIC_BUFFER_SIZE;
      return;
    }
    this.chunks.push(text);
    this.bufferedLength += text.length;
    if (this.bufferedLength > 2 * FORENSIC_BUFFER_SIZE) {
      this.compact();
    }
  }

  /**
   * Read the current forensic buffer snapshot without disturbing it. Used by
   * the fallback classifier to inspect exit-time output before teardown runs.
   */
  getRecentOutput(): string {
    if (this.chunks.length > 1 || this.bufferedLength > FORENSIC_BUFFER_SIZE) {
      this.compact();
    }
    return this.chunks[0] ?? "";
  }

  private compact(): void {
    const joined = this.chunks.join("");
    const tail =
      joined.length > FORENSIC_BUFFER_SIZE ? joined.slice(-FORENSIC_BUFFER_SIZE) : joined;
    this.chunks = [tail];
    this.bufferedLength = tail.length;
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
      recentOutput: this.getRecentOutput(),
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

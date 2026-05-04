import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import {
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  GRACEFUL_SHUTDOWN_BUFFER_SIZE,
  GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS,
  type TerminalInfo,
} from "./types.js";
import { getLiveAgentId } from "./terminalTitle.js";

export interface TerminalGracefulShutdownHost {
  readonly terminalInfo: TerminalInfo;
  readonly isAgentLive: boolean;
  kill(reason: string): void;
}

/**
 * Issue the agent's `quitCommand` / `shutdownKeySequence`, optionally wait
 * for a `session-id` echo to land, then `kill("graceful-shutdown")`. Used
 * by Daintree's resume flow to capture a chat session ID before tearing
 * down the PTY. Returns the captured session id, or `null` if the agent
 * has no resume config, has already exited, demoted before shutdown, or
 * the timeout fires before a match.
 */
export async function gracefulShutdown(host: TerminalGracefulShutdownHost): Promise<string | null> {
  const terminal = host.terminalInfo;

  if (terminal.isExited || terminal.wasKilled) {
    return null;
  }

  // Don't inject quit into terminals whose agent already exited — e.g.
  // user typed /quit and the terminal demoted to a plain shell. The
  // launchAgentId persists for identity, but the agent is gone.
  if (!host.isAgentLive) {
    return null;
  }

  const liveAgentId = getLiveAgentId(terminal);
  const agentConfig = liveAgentId ? getEffectiveAgentConfig(liveAgentId) : undefined;
  const resume = agentConfig?.resume;

  // Nothing to send — agent has no resume config or the config supplies
  // neither a quit command nor a key sequence we can emit on shutdown.
  if (!resume) {
    return null;
  }
  const quitCommand = resume.quitCommand;
  const shutdownKeySequence = resume.shutdownKeySequence;
  if (!quitCommand && !shutdownKeySequence) {
    return null;
  }

  // Only `session-id` triggers the post-quit pattern-match capture loop —
  // other kinds (rolling-history, named-target, project-scoped) just send
  // the quit signal and resolve null. Lesson from #4781: never run the
  // capture loop for non-`session-id` agents — directory-scoped sessions
  // (Kiro) don't emit IDs and the ghost regex would either time out or
  // false-positive on unrelated output.
  const pattern = resume.kind === "session-id" ? new RegExp(resume.sessionIdPattern) : null;

  let shutdownBuffer = "";
  let resolved = false;

  return new Promise<string | null>((resolve) => {
    const finish = (sessionId: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      if (sessionId) {
        terminal.agentSessionId = sessionId;
      }

      host.kill("graceful-shutdown");
      resolve(sessionId);
    };

    const timer = setTimeout(() => finish(null), GRACEFUL_SHUTDOWN_TIMEOUT_MS);

    const origOnData = terminal.ptyProcess.onData((data: string) => {
      if (resolved) return;
      if (!pattern) return;

      shutdownBuffer += data;
      if (shutdownBuffer.length > GRACEFUL_SHUTDOWN_BUFFER_SIZE) {
        shutdownBuffer = shutdownBuffer.slice(-GRACEFUL_SHUTDOWN_BUFFER_SIZE);
      }

      const stripped = stripAnsiCodes(shutdownBuffer);
      const match = pattern.exec(stripped);
      if (match?.[1]) {
        origOnData.dispose();
        finish(match[1]);
      }
    });

    const origOnExit = terminal.ptyProcess.onExit(() => {
      origOnExit.dispose();
      origOnData.dispose();

      if (!pattern) {
        finish(null);
        return;
      }
      const stripped = stripAnsiCodes(shutdownBuffer);
      const match = pattern.exec(stripped);
      finish(match?.[1] ?? null);
    });

    // Clear any partial user input at the agent prompt before issuing the quit command.
    // Without this prelude, concatenated input (e.g. "half-typed/quit") is treated as a
    // chat message by the agent and the session-ID line is never emitted. See #5785.
    //   \x05 — Ctrl-E: move cursor to end of line
    //   \x15 — Ctrl-U: erase from cursor to beginning of line
    // ESC is avoided because it navigates/dismisses TUI state in bubbletea and ink CLIs.
    (async () => {
      try {
        terminal.ptyProcess.write("\x05\x15");
      } catch {
        origOnData.dispose();
        origOnExit.dispose();
        finish(null);
        return;
      }

      await new Promise<void>((r) => setTimeout(r, GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS));

      if (resolved) return;

      // Re-check liveness: if the agent demoted during the clear-delay
      // window (e.g. user typed /quit milliseconds before shutdown), the
      // pending write would land in a plain shell.
      if (!host.isAgentLive) {
        origOnData.dispose();
        origOnExit.dispose();
        finish(null);
        return;
      }

      try {
        if (shutdownKeySequence) {
          terminal.ptyProcess.write(shutdownKeySequence);
        }
        if (quitCommand) {
          terminal.ptyProcess.write(quitCommand + "\r");
        }
      } catch {
        origOnData.dispose();
        origOnExit.dispose();
        finish(null);
      }
    })();
  });
}

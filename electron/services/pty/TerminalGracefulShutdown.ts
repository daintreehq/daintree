import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import {
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  GRACEFUL_SHUTDOWN_BUFFER_SIZE,
  GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS,
  type TerminalInfo,
} from "./types.js";
import { getLiveAgentId } from "./terminalTitle.js";
import { normalizeSubmitEnterDelay } from "./terminalInput.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("pty:TerminalGracefulShutdown");

export interface TerminalGracefulShutdownHost {
  readonly terminalInfo: TerminalInfo;
  readonly isAgentLive: boolean;
  kill(reason: string): void;
}

/**
 * Which branch of `gracefulShutdown()` resolved this terminal. Logged so a
 * restore that falls through to a fresh launch can be traced back to a cause:
 * `timeout` points at the 2.5s budget, `agent-not-live` at state detection,
 * `exited-no-match` at the agent's `sessionIdPattern`, and the write/demotion
 * outcomes at the quit signal never landing (#11591).
 *
 * Success collapses into a single `captured` — whether the id arrived
 * mid-stream or on the last-chance match at exit doesn't explain anything,
 * because nothing went wrong. Failure stays granular for the opposite reason.
 */
export type GracefulShutdownOutcome =
  | "already-exited"
  | "agent-not-live"
  | "no-resume-config"
  | "no-quit-signal"
  | "captured"
  | "timeout"
  | "exited-no-pattern"
  | "exited-no-match"
  | "prelude-write-failed"
  | "demoted-during-clear-delay"
  | "demoted-during-submit-delay"
  | "quit-signal-write-failed";

/**
 * Issue the agent's `quitCommand` / `shutdownKeySequence`, optionally wait
 * for a `session-id` echo to land, then `kill("graceful-shutdown")`. Used
 * by Daintree's resume flow to capture a chat session ID before tearing
 * down the PTY. Returns the captured session id, or `null` if the agent
 * has no resume config, has already exited, demoted before shutdown, or
 * the timeout fires before a match.
 *
 * Every agent terminal emits exactly one `info` line naming its
 * {@link GracefulShutdownOutcome}; terminals with no agent identity stay
 * silent. Callers get the bare id back — the outcome rides the log rather
 * than the return type, so no caller signature has to widen for it.
 */
export async function gracefulShutdown(host: TerminalGracefulShutdownHost): Promise<string | null> {
  const startedAt = Date.now();
  const terminal = host.terminalInfo;

  // Scope gate: only agent terminals get an outcome line. A plain shell has
  // neither agent id, so `host.isAgentLive` is already false for it — without
  // this gate every non-agent pane would log `agent-not-live` on each quit.
  // Deliberately hoisted above the liveness gate: `getLiveAgentId` and
  // `isAgentLive` are both pure field reads, so the ordering swap is invisible
  // and both paths still return null. Don't "restore" the original order.
  const liveAgentId = getLiveAgentId(terminal);
  if (!liveAgentId) {
    return null;
  }

  // Never log the captured session id itself — it's a resume credential
  // (`--resume <id>`) and `logs.getAll` serves this buffer to agents verbatim.
  // `captured` carries everything the issue asked for.
  const logOutcome = (outcome: GracefulShutdownOutcome, captured: boolean): void => {
    logger.info("Graceful shutdown capture outcome", {
      terminalId: terminal.id,
      projectId: terminal.projectId ?? null,
      agentId: liveAgentId,
      outcome,
      captured,
      elapsedMs: Date.now() - startedAt,
    });
  };

  if (terminal.isExited || terminal.wasKilled) {
    logOutcome("already-exited", false);
    return null;
  }

  // Don't inject quit into terminals whose agent already exited — e.g.
  // user typed /quit and the terminal demoted to a plain shell. The
  // launchAgentId persists for identity, but the agent is gone.
  if (!host.isAgentLive) {
    logOutcome("agent-not-live", false);
    return null;
  }

  const agentConfig = getEffectiveAgentConfig(liveAgentId);
  const resume = agentConfig?.resume;

  // Nothing to send — agent has no resume config or the config supplies
  // neither a quit command nor a key sequence we can emit on shutdown.
  if (!resume) {
    logOutcome("no-resume-config", false);
    return null;
  }
  const quitCommand = resume.quitCommand;
  const shutdownKeySequence = resume.shutdownKeySequence;
  if (!quitCommand && !shutdownKeySequence) {
    logOutcome("no-quit-signal", false);
    return null;
  }
  const quitSubmitEnterDelayMs = normalizeSubmitEnterDelay(
    agentConfig?.capabilities?.submitEnterDelayMs
  );
  const quitSubmitMode = agentConfig?.capabilities?.quitSubmitMode ?? "split-write";

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
    // Pre-declared so finish() can dispose them centrally (forward reference).
    // No-op sentinel keeps disposal safe even on synchronous early-exit paths
    // before assignment. node-pty's IDisposable scan is idempotent, so the
    // existing branch-local dispose calls remain harmless double-disposes.
    let origOnData: { dispose(): void } = { dispose() {} };
    let origOnExit: { dispose(): void } = { dispose() {} };

    const finish = (sessionId: string | null, outcome: GracefulShutdownOutcome) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      // Dispose listeners before kill() so a synchronous onExit during teardown
      // can't re-enter this path. Lesson from #4974: order matters in shutdown.
      origOnData.dispose();
      origOnExit.dispose();

      if (sessionId) {
        terminal.agentSessionId = sessionId;
      }

      // Logged before kill() so a throwing kill can't erase the diagnostic, and
      // after the `resolved` guard so a losing racer never double-logs.
      logOutcome(outcome, sessionId !== null);

      host.kill("graceful-shutdown");
      resolve(sessionId);
    };

    const timer = setTimeout(() => finish(null, "timeout"), GRACEFUL_SHUTDOWN_TIMEOUT_MS);

    origOnData = terminal.ptyProcess.onData((data: string) => {
      if (resolved) return;
      if (!pattern) return;

      shutdownBuffer += data;
      if (shutdownBuffer.length > GRACEFUL_SHUTDOWN_BUFFER_SIZE) {
        shutdownBuffer = shutdownBuffer.slice(-GRACEFUL_SHUTDOWN_BUFFER_SIZE);
      }

      const stripped = stripAnsiCodes(shutdownBuffer);
      const match = pattern.exec(stripped);
      if (match?.[1]) {
        // Guard against truncated captures when the PTY delivers the
        // session-ID line in chunks. Every `sessionIdPattern` ends with a
        // greedy `[\w-]+` capture group — if that group ends at the buffer
        // tail, the regex's character class may still be consuming a token
        // that is mid-arrival. Wait for at least one trailing character
        // (newline, space, prompt glyph) that confirms the token boundary
        // has been seen. Without this, Gemini's resume hint can be captured
        // as "fc1c3a37-2294-4" instead of the full 36-char UUID, leaving
        // restore-on-restart to hand the agent an invalid identifier.
        const captureEnd = match.index + match[0].length;
        if (captureEnd < stripped.length) {
          finish(match[1], "captured");
        }
      }
    });

    origOnExit = terminal.ptyProcess.onExit(() => {
      if (!pattern) {
        finish(null, "exited-no-pattern");
        return;
      }
      const stripped = stripAnsiCodes(shutdownBuffer);
      const match = pattern.exec(stripped);
      const sessionId = match?.[1] ?? null;
      finish(sessionId, sessionId ? "captured" : "exited-no-match");
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
        finish(null, "prelude-write-failed");
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
        finish(null, "demoted-during-clear-delay");
        return;
      }

      try {
        if (shutdownKeySequence) {
          terminal.ptyProcess.write(shutdownKeySequence);
        }
        if (quitCommand) {
          if (quitSubmitMode === "single-write") {
            // Ink-based TUIs (e.g. Claude Code) require body + Enter in the
            // same PTY write so the slash-command parser sees them in one
            // event-loop tick. A non-zero gap is interpreted as deliberate
            // slow typing, so the command never submits and the
            // session-ID line is never echoed (issue #6981).
            terminal.ptyProcess.write(quitCommand + "\r");
          } else {
            terminal.ptyProcess.write(quitCommand);
            await new Promise<void>((r) => setTimeout(r, quitSubmitEnterDelayMs));

            if (resolved) return;

            if (!host.isAgentLive) {
              origOnData.dispose();
              origOnExit.dispose();
              finish(null, "demoted-during-submit-delay");
              return;
            }

            terminal.ptyProcess.write("\r");
          }
        }
      } catch {
        origOnData.dispose();
        origOnExit.dispose();
        finish(null, "quit-signal-write-failed");
      }
    })();
  });
}

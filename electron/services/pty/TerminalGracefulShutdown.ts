import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import type { AgentGatedKeyEscalation } from "../../../shared/config/agentRegistry.js";
import { supportsSessionIdAssignment } from "../../../shared/types/agentSettings.js";
import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
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
  /**
   * Take exclusive ownership of the terminal's input for the teardown and
   * return the release. Shutdown writes bypass the normal input path, so
   * anything still draining there would interleave with them (#11851).
   */
  acquireInputLock(): () => void;
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
 * because nothing went wrong. Failure stays granular for the opposite reason:
 * each bucket points at a different suspect.
 *
 * A stalled gated escalation (#11851) deliberately gets no bucket of its own.
 * Running out of gate matches or presses stops the ESCALATION, not the
 * teardown: the remaining budget is still spent listening, so the terminal
 * ends on whichever of `captured` / `exited-no-match` / `timeout` it earns.
 * How far the escalation got rides the same log line as `pressesSent` instead,
 * which keeps every outcome a distinct branch.
 *
 * `preassigned` is a third thing: not a capture that succeeded but a capture
 * that was never needed, because the id was chosen at launch (#11782). It stays
 * its own bucket so the outcome counts still say how the scrape itself is
 * doing — folding it into `captured` would inflate that rate with terminals the
 * scrape never ran for.
 */
export type GracefulShutdownOutcome =
  | "already-exited"
  | "already-killed"
  | "agent-not-live"
  | "no-resume-config"
  | "no-quit-signal"
  | "captured"
  | "preassigned"
  | "timeout"
  | "exited-no-pattern"
  | "exited-no-match"
  | "prelude-write-failed"
  | "demoted-during-clear-delay"
  | "demoted-during-submit-delay"
  | "demoted-during-gated-signal"
  | "quit-signal-write-failed"
  | "gated-signal-write-failed";

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
  // Presses the gated escalation actually got out (#11851). Zero for every
  // agent on the `quitCommand` path, which is what makes the field readable:
  // a Codex line reading `captured` with 1 press and one reading `timeout`
  // with 3 are different stories, and neither needs its own outcome bucket.
  let pressesSent = 0;
  const logOutcome = (outcome: GracefulShutdownOutcome, captured: boolean): void => {
    logger.info("Graceful shutdown capture outcome", {
      terminalId: terminal.id,
      projectId: terminal.projectId ?? null,
      agentId: liveAgentId,
      outcome,
      captured,
      pressesSent,
      elapsedMs: Date.now() - startedAt,
    });
  };

  // Split rather than folded into one bucket: `wasKilled` is set when a kill
  // is *requested*, while `isExited` means the process is actually gone. A
  // terminal that is only `wasKilled` has something else tearing it down
  // concurrently — a different suspect from one that had already exited.
  if (terminal.isExited) {
    logOutcome("already-exited", false);
    return null;
  }
  if (terminal.wasKilled) {
    logOutcome("already-killed", false);
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

  // The id was chosen at launch, so there is nothing to scrape (#11782). Kill
  // without writing a single byte into the PTY, which is what makes the whole
  // class of scrape failures unreachable for these agents: the quit signal
  // can't be swallowed by a modal, can't be steered into a running turn as
  // chat text (burning tokens and polluting the transcript), and can't be
  // over-sent to the point of killing the process before it prints anything.
  // It also gives back the timeout budget — this path costs no wall clock at
  // all, where the scrape spends up to GRACEFUL_SHUTDOWN_TIMEOUT_MS per
  // terminal, most expensively on app quit when they all run at once.
  //
  // Deliberately gated on the agent declaring `assignSessionIdArgs` rather than
  // on the id merely being present: agents that still mint their own id keep
  // the scrape as their only capture path, so skipping it for them would drop
  // an id that only teardown can observe.
  //
  // The id belongs to whatever this terminal LAUNCHED, so the live agent has to
  // still be that agent. A pane that launched one agent and now hosts another
  // (the user quit it and started a different CLI by hand) carries an id from
  // the previous conversation — returning it would file one agent's session
  // under another's and restore would resume the wrong thing.
  if (
    terminal.agentSessionId &&
    liveAgentId === terminal.launchAgentId &&
    supportsSessionIdAssignment(liveAgentId)
  ) {
    const preassignedId = terminal.agentSessionId;
    logOutcome("preassigned", true);
    host.kill("graceful-shutdown");
    return preassignedId;
  }
  // Structured escalation is `session-id`-only, so the union has to be narrowed
  // before the field exists. It REPLACES the quit-command path rather than
  // preceding it: the type makes them mutually exclusive, and falling back to
  // `quitCommand` after a stalled escalation would write the very text into the
  // transcript that the escalation exists to keep out (#11851).
  const shutdownSignal = resume.kind === "session-id" ? resume.shutdownSignal : undefined;
  const quitCommand = resume.quitCommand;
  const shutdownKeySequence = resume.shutdownKeySequence;
  if (!quitCommand && !shutdownKeySequence && !shutdownSignal) {
    logOutcome("no-quit-signal", false);
    return null;
  }
  const quitSubmitEnterDelayMs = normalizeSubmitEnterDelay(
    agentConfig?.capabilities?.submitEnterDelayMs
  );
  const quitSubmitMode = agentConfig?.capabilities?.quitSubmitMode ?? "split-write";

  // Only a declared `sessionIdPattern` triggers the post-quit capture loop.
  // Other kinds (rolling-history, named-target, project-scoped) just send the
  // quit signal and resolve null. Lesson from #4781: never run the capture loop
  // for non-`session-id` agents — directory-scoped sessions (Kiro) don't emit
  // IDs and the ghost regex would either time out or false-positive on
  // unrelated output. A `session-id` agent that omits the pattern is the same
  // case (#11851): it resumes by an id this tree can hold but never observes
  // one being printed, so a pattern would be a ghost regex too.
  const sessionIdPattern = resume.kind === "session-id" ? resume.sessionIdPattern : undefined;
  const pattern = sessionIdPattern ? new RegExp(sessionIdPattern) : null;

  let shutdownBuffer = "";
  let resolved = false;

  // The overall budget as an instant, not just a timer. A timer callback only
  // runs when the loop gets a turn, so an `onData` that began before the
  // deadline can settle a gate and have its continuation write AFTER it if the
  // pty-host stalls in between — on app quit, under load, which is exactly when
  // that happens. The timer wakes the teardown; this is what bounds the writes.
  const deadlineAt = startedAt + GRACEFUL_SHUTDOWN_TIMEOUT_MS;

  // Held for the whole teardown so nothing else can write between our bytes,
  // and released on every exit path by the `finally` below — including a
  // throwing `host.kill()`, which would otherwise strand the terminal's input.
  const releaseInputLock = host.acquireInputLock();
  try {
    return await new Promise<string | null>((resolve) => {
      // Pre-declared so finish() can dispose them centrally (forward reference).
      // No-op sentinel keeps disposal safe even on synchronous early-exit paths
      // before assignment. node-pty's IDisposable scan is idempotent, so the
      // existing branch-local dispose calls remain harmless double-disposes.
      let origOnData: { dispose(): void } = { dispose() {} };
      let origOnExit: { dispose(): void } = { dispose() {} };

      // At most one gate arm is live at a time, created immediately before each
      // press and settled by the first of: a fresh `gateText` match in
      // `gateProbe`, its own per-press timer, or `finish()`. `settled` is the
      // latch that makes Ratatui's full-frame redraws harmless — the footer is
      // repainted on every tick, so without it one press would keep re-arming
      // the escalation off a single stale frame.
      let gateArm: {
        settled: boolean;
        timer: NodeJS.Timeout | null;
        resolve: (matched: boolean) => void;
      } | null = null;
      // Output since the CURRENT press only. Reset per press rather than scanned
      // by offset into `shutdownBuffer`, whose tail truncation would shift any
      // stored index; accumulating also means a `gateText` split across two PTY
      // chunks still matches.
      let gateProbe = "";

      const settleGateArm = (matched: boolean): void => {
        const arm = gateArm;
        if (!arm || arm.settled) return;
        arm.settled = true;
        if (arm.timer) clearTimeout(arm.timer);
        gateArm = null;
        arm.resolve(matched);
      };

      const finish = (sessionId: string | null, outcome: GracefulShutdownOutcome) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        // Unblocks an escalation parked on its gate and clears that press's
        // timer; the loop re-checks `resolved` after every await, so it stops
        // rather than sending a press into a process that is already going.
        settleGateArm(false);

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

        // A throwing kill must not escape. `finish()` is reached from the
        // `onData`/`onExit` listeners, so an escaping throw unwinds into
        // node-pty's emitter instead of this promise — which would then never
        // settle, stranding the input lock the `finally` below releases and
        // hanging the caller's own timeout. Swallow it and resolve: the
        // terminal is still live, and `PtyManager.gracefulKill` already has a
        // fallback kill for exactly that observation.
        try {
          host.kill("graceful-shutdown");
        } catch (error) {
          logger.warn("Graceful shutdown kill threw; falling through to the caller", {
            terminalId: terminal.id,
            error: formatErrorMessage(error, "kill threw a non-Error"),
          });
        }
        resolve(sessionId);
      };

      const timer = setTimeout(() => finish(null, "timeout"), GRACEFUL_SHUTDOWN_TIMEOUT_MS);

      origOnData = terminal.ptyProcess.onData((data: string) => {
        if (resolved) return;

        // Gate first so the escalation is never starved by an early `return`
        // below, but settled only after the capture check — a frame that carries
        // both the footer and the resume hint must resolve as a capture, not as
        // permission to press again.
        if (gateArm && shutdownSignal) {
          gateProbe += data;
          if (gateProbe.length > GRACEFUL_SHUTDOWN_BUFFER_SIZE) {
            gateProbe = gateProbe.slice(-GRACEFUL_SHUTDOWN_BUFFER_SIZE);
          }
        }
        const gateMatched =
          gateArm !== null &&
          shutdownSignal !== undefined &&
          stripAnsiCodes(gateProbe).includes(shutdownSignal.gateText);

        if (!pattern) {
          if (gateMatched) settleGateArm(true);
          return;
        }

        shutdownBuffer += data;
        if (shutdownBuffer.length > GRACEFUL_SHUTDOWN_BUFFER_SIZE) {
          shutdownBuffer = shutdownBuffer.slice(-GRACEFUL_SHUTDOWN_BUFFER_SIZE);
        }

        const stripped = stripAnsiCodes(shutdownBuffer);
        const match = pattern.exec(stripped);
        if (match?.[1]) {
          // A session id in this chunk means the agent is already on its way
          // out, so this chunk must never also read as permission to press
          // again — including when the capture below turns out to be
          // provisional. A chunk ending exactly after the id (no trailing
          // boundary yet) would otherwise fall through to the gate and fire the
          // next press at the precise moment the hint is printing. Leaving the
          // arm pending is safe: the next chunk completes the capture, `onExit`
          // takes EOF as the boundary, or the per-press timer stops the
          // escalation without ending the teardown.
          if (gateArm) settleGateArm(false);
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
            return;
          }
        }

        if (gateMatched) settleGateArm(true);
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

      // Escalate one press at a time, gated on the agent's own confirm-to-quit
      // footer (#11851). Nothing else is written: no input-clear prelude (its
      // Ctrl-E/Ctrl-U readline assumption does not hold here, and Ctrl-C already
      // clears leftover composer text on its own) and no quit command.
      //
      // Running out of gate matches or presses ends the ESCALATION, never the
      // teardown. The measured resume hint lands 0.76-1.16s after the first
      // press, so killing at the first unanswered gate would throw away captures
      // the old code would have caught — a press that quit the agent outright,
      // or one that dismissed a modal without redrawing the footer, prints its
      // hint with no further footer ever appearing. Stop pressing, keep
      // listening, and let the normal outcomes decide.
      const runGatedEscalation = async (signal: AgentGatedKeyEscalation): Promise<void> => {
        while (pressesSent < signal.maxPresses) {
          if (resolved) return;
          if (Date.now() >= deadlineAt) return;

          // Same demotion guard the quit path uses between its writes: if the
          // agent exited between presses, the next one lands in a plain shell.
          if (!host.isAgentLive) {
            finish(null, "demoted-during-gated-signal");
            return;
          }

          // Armed BEFORE the write so a footer arriving in the same tick as the
          // press is still counted; `gateProbe` resets with it so only output
          // produced by THIS press can satisfy it.
          gateProbe = "";
          const armed = new Promise<boolean>((resolveArm) => {
            const arm = {
              settled: false,
              timer: null as NodeJS.Timeout | null,
              resolve: resolveArm,
            };
            arm.timer = setTimeout(() => settleGateArm(false), signal.perPressTimeoutMs);
            gateArm = arm;
          });

          try {
            terminal.ptyProcess.write(signal.keySequence);
          } catch {
            settleGateArm(false);
            finish(null, "gated-signal-write-failed");
            return;
          }
          pressesSent++;

          const matchedGate = await armed;
          if (resolved) return;

          // A press whose gate never matched is the end of the escalation: with
          // no positive proof the TUI is still holding raw mode, the next press
          // could be a real SIGINT that kills the process before it prints
          // anything (three ungated presses produced nothing at all after 12s).
          if (!matchedGate) return;
        }
      };

      (async () => {
        if (shutdownSignal) {
          await runGatedEscalation(shutdownSignal);
          return;
        }

        // Clear any partial user input at the agent prompt before issuing the quit command.
        // Without this prelude, concatenated input (e.g. "half-typed/quit") is treated as a
        // chat message by the agent and the session-ID line is never emitted. See #5785.
        //   \x05 — Ctrl-E: move cursor to end of line
        //   \x15 — Ctrl-U: erase from cursor to beginning of line
        // ESC is avoided because it navigates/dismisses TUI state in bubbletea and ink CLIs.
        // Not sent on the gated path above: Ctrl-E/Ctrl-U assume readline semantics that
        // the agents taking that path don't have, and Ctrl-C clears the composer anyway.
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
  } finally {
    releaseInputLock();
  }
}
